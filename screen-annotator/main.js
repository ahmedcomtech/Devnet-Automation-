'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  desktopCapturer,
  Notification,
  shell,
  Menu,
  Tray,
  dialog,
  clipboard,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const S = require('./lib/settings');

const APP_NAME = 'Screen Annotator Pro';
const SESSION_FORMAT = 'screen-annotator-session';
const BOARD_NAMES = { none: 'Screen (no board)', white: 'Whiteboard', black: 'Blackboard', green: 'Chalkboard' };
const PATTERN_NAMES = { plain: 'Plain', grid: 'Grid', lines: 'Lined paper', dots: 'Dot grid' };
const MAX_PAGES = 200;

const ICON = path.join(__dirname, 'src', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'src', 'assets', 'tray.png');

let settings = null;
let state = null;
const overlays = new Map(); // display id -> BrowserWindow
let toolbar = null;
let settingsWin = null;
let tray = null;
let activeOverlay = null; // last overlay drawn on; receives undo/redo
let cursorTimer = null;
let lastCursor = null;
let saveTimer = null;

if (process.platform === 'linux') {
  // Transparent windows on Linux need a compositor plus this switch.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// ---------- helpers ----------

function alive(win) {
  return win && !win.isDestroyed();
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function notify(title, body, file) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  if (file) n.on('click', () => shell.showItemInFolder(file));
  n.show();
}

function outputDir() {
  const dir = settings.screenshotDir || path.join(app.getPath('pictures'), 'Screen Annotator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

// Overlays ordered left-to-right, top-to-bottom: the order used in session files.
function sortedOverlays() {
  return [...overlays.values()]
    .filter(alive)
    .sort((a, b) => a.getBounds().x - b.getBounds().x || a.getBounds().y - b.getBounds().y);
}

function overlayAtCursor() {
  const p = screen.getCursorScreenPoint();
  const list = sortedOverlays();
  return (
    list.find((w) => {
      const b = w.getBounds();
      return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    }) || list[0]
  );
}

function targetOverlay() {
  return alive(activeOverlay) ? activeOverlay : overlayAtCursor();
}

// ---------- state ----------

function publicState() {
  return { ...state, settings };
}

function broadcast() {
  const snapshot = publicState();
  for (const win of [...overlays.values(), toolbar, settingsWin]) {
    if (alive(win)) win.webContents.send('state', snapshot);
  }
  updateTray();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  try {
    S.saveSettings(settingsFile(), { ...settings, last: S.pickRemembered(state) });
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

function setState(patch, internal = {}) {
  const clean = { ...S.sanitizeState(patch), ...internal };
  const modeChanged = clean.mode !== undefined && clean.mode !== state.mode;
  state = { ...state, ...clean };
  state.pageCount = Math.max(1, Math.min(MAX_PAGES, state.pageCount));
  state.page = Math.max(0, Math.min(state.pageCount - 1, state.page));
  if (modeChanged) applyMode();
  updateCursorTracking();
  broadcast();
  saveSoon();
}

function toggleMode() {
  setState({ mode: state.mode === 'draw' ? 'cursor' : 'draw' });
}

// Shortcut for tools like the spotlight: first press turns it on, second press goes back to the mouse.
function toggleTool(tool) {
  if (state.mode === 'draw' && state.tool === tool) setState({ mode: 'cursor' });
  else setState({ tool, mode: 'draw' });
}

function changePage(delta) {
  if (state.board === 'none') {
    setState({ board: 'white', mode: 'draw' });
    return;
  }
  const page = state.page + delta;
  if (page < 0) return;
  const pageCount = Math.max(state.pageCount, page + 1);
  setState({}, { page, pageCount });
}

// ---------- windows ----------

function applyMode() {
  const drawing = state.mode === 'draw';
  for (const win of overlays.values()) {
    if (!alive(win)) continue;
    win.setIgnoreMouseEvents(!drawing);
    if (!drawing) win.blur();
  }
  if (drawing) {
    const win = overlayAtCursor();
    if (win) win.focus();
  }
  keepToolbarOnTop();
}

function keepToolbarOnTop() {
  if (alive(toolbar) && toolbar.isVisible()) toolbar.moveTop();
  if (alive(settingsWin) && settingsWin.isVisible()) settingsWin.moveTop();
}

// Clicking the toolbar takes keyboard focus; hand it back so overlay shortcuts keep working.
function refocusOverlay() {
  if (state.mode !== 'draw') return;
  const win = overlayAtCursor();
  if (win) win.focus();
}

function createOverlay(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(state.mode !== 'draw');
  win.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  win.webContents.on('did-finish-load', () => win.webContents.send('state', publicState()));
  win.once('ready-to-show', () => {
    win.setBounds(display.bounds); // some window managers ignore the initial position
    win.showInactive();
    keepToolbarOnTop();
  });
  // On Windows all topmost windows share one band, so focusing an overlay can cover the toolbar.
  win.on('focus', keepToolbarOnTop);
  win.on('closed', () => {
    for (const [id, w] of overlays) if (w === win) overlays.delete(id);
    if (activeOverlay === win) activeOverlay = null;
  });
  return win;
}

function syncOverlays() {
  const wanted = settings.allDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
  const ids = new Set(wanted.map((d) => d.id));
  for (const [id, win] of overlays) {
    if (!ids.has(id)) {
      overlays.delete(id);
      if (alive(win)) win.destroy();
    }
  }
  for (const display of wanted) {
    const win = overlays.get(display.id);
    if (alive(win)) win.setBounds(display.bounds);
    else overlays.set(display.id, createOverlay(display));
  }
}

function createToolbar() {
  const { workArea } = screen.getPrimaryDisplay();
  toolbar = new BrowserWindow({
    width: 150,
    height: 680,
    x: workArea.x + 16,
    y: workArea.y + 60,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: APP_NAME,
    icon: ICON,
    show: false,
    webPreferences: webPreferences(),
  });
  // Relative level 1 keeps the toolbar above the overlays on macOS.
  toolbar.setAlwaysOnTop(true, 'screen-saver', 1);
  toolbar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toolbar.loadFile(path.join(__dirname, 'src', 'toolbar.html'));
  toolbar.webContents.on('did-finish-load', broadcast);
  toolbar.once('ready-to-show', () => toolbar.show());
  toolbar.on('closed', () => {
    toolbar = null;
    app.quit();
  });
}

function resizeToolbar(size) {
  if (!alive(toolbar) || !size) return;
  const display = screen.getDisplayMatching(toolbar.getBounds());
  const width = Math.max(40, Math.min(400, Math.ceil(size.width) || 150));
  const height = Math.max(40, Math.min(display.workArea.height - 20, Math.ceil(size.height) || 0));
  const { x, y } = toolbar.getBounds();
  toolbar.setBounds({ x, y, width, height });
}

function toggleToolbar() {
  if (!alive(toolbar)) return;
  if (toolbar.isVisible()) toolbar.hide();
  else {
    toolbar.showInactive();
    keepToolbarOnTop();
  }
}

function openSettings() {
  if (alive(settingsWin)) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  setState({ mode: 'cursor' });
  settingsWin = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: `${APP_NAME} – Settings`,
    icon: ICON,
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#202124',
    show: false,
    webPreferences: webPreferences(),
  });
  settingsWin.setMenu(null);
  settingsWin.setAlwaysOnTop(true, 'screen-saver', 2);
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWin.webContents.on('did-finish-load', broadcast);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function showAbout() {
  setState({ mode: 'cursor' });
  dialog.showMessageBox(alive(toolbar) ? toolbar : undefined, {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: `Version ${app.getVersion()}\n\nDraw, highlight and present on top of any app while teaching online.`,
    icon: nativeImage.createFromPath(ICON),
  });
}

// ---------- renderer requests ----------

let requestId = 0;
const pending = new Map();

// Ask a renderer for data (e.g. its drawings) and wait for the answer.
function ask(win, name, arg) {
  return new Promise((resolve) => {
    if (!alive(win)) return resolve(null);
    const id = ++requestId;
    pending.set(id, resolve);
    win.webContents.send('request', id, name, arg);
    setTimeout(() => {
      if (pending.delete(id)) resolve(null);
    }, 5000);
  });
}

ipcMain.on('response', (_event, id, data) => {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(data);
  }
});

// ---------- capture, export, sessions ----------

async function captureDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
  const image = (source || sources[0])?.thumbnail;
  if (!image || image.isEmpty()) throw new Error('No screen image available (check the screen-recording permission).');
  return image;
}

async function screenshot({ toClipboard = false } = {}) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const toolbarWasVisible = alive(toolbar) && toolbar.isVisible();
  if (toolbarWasVisible) toolbar.hide();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const image = await captureDisplay(display);
    if (toClipboard) {
      clipboard.writeImage(image);
      notify('Screenshot copied', 'Paste it into your slides, chat or notes.');
    } else {
      const file = path.join(outputDir(), `screenshot-${timestamp()}.png`);
      fs.writeFileSync(file, image.toPNG());
      notify('Screenshot saved', file, file);
    }
  } catch (err) {
    notify('Screenshot failed', err.message);
  } finally {
    if (toolbarWasVisible && alive(toolbar)) {
      toolbar.showInactive();
      keepToolbarOnTop();
    }
  }
}

async function exportPng() {
  const list = sortedOverlays();
  const images = await Promise.all(list.map((win) => ask(win, 'export-png')));
  const stamp = timestamp();
  let saved = null;
  images.forEach((dataUrl, i) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return;
    const suffix = list.length > 1 ? `-display${i + 1}` : '';
    saved = path.join(outputDir(), `annotations-${stamp}${suffix}.png`);
    fs.writeFileSync(saved, Buffer.from(dataUrl.split(',')[1], 'base64'));
  });
  if (saved) notify('Annotations exported', saved, saved);
  else notify('Nothing to export', 'Draw something first.');
}

async function saveSession() {
  setState({ mode: 'cursor' });
  const { canceled, filePath } = await dialog.showSaveDialog(alive(toolbar) ? toolbar : undefined, {
    title: 'Save annotation session',
    defaultPath: path.join(app.getPath('documents'), `lesson-${timestamp()}.annotations.json`),
    filters: [{ name: 'Annotation session', extensions: ['json'] }],
  });
  if (canceled || !filePath) return;
  const displays = await Promise.all(sortedOverlays().map((win) => ask(win, 'export-session')));
  const data = {
    format: SESSION_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    pageCount: state.pageCount,
    displays: displays.map((d) => d || { screen: [], pages: [] }),
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data));
    notify('Session saved', filePath, filePath);
  } catch (err) {
    dialog.showErrorBox('Could not save session', err.message);
  }
}

async function openSession() {
  setState({ mode: 'cursor' });
  const { canceled, filePaths } = await dialog.showOpenDialog(alive(toolbar) ? toolbar : undefined, {
    title: 'Open annotation session',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Annotation session', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (data.format !== SESSION_FORMAT || !Array.isArray(data.displays)) throw new Error('This is not a Screen Annotator session file.');
  } catch (err) {
    dialog.showErrorBox('Could not open session', err.message);
    return;
  }
  const pageCount = Number.isInteger(data.pageCount) ? data.pageCount : 1;
  setState({}, { page: 0, pageCount });
  sortedOverlays().forEach((win, i) => win.webContents.send('command', 'import-session', data.displays[i] || null));
}

// ---------- cursor highlight ----------

function updateCursorTracking() {
  const want = state.cursorHighlight && state.annotationsVisible;
  if (want && !cursorTimer) {
    cursorTimer = setInterval(sendCursor, 25);
  } else if (!want && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
    lastCursor = null;
    for (const win of overlays.values()) if (alive(win)) win.webContents.send('cursor', null);
  }
}

function sendCursor() {
  const p = screen.getCursorScreenPoint();
  if (lastCursor && p.x === lastCursor.x && p.y === lastCursor.y) return;
  lastCursor = p;
  for (const win of overlays.values()) {
    if (!alive(win)) continue;
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside) {
      win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
      win.hasCursor = true;
    } else if (win.hasCursor) {
      win.webContents.send('cursor', null);
      win.hasCursor = false;
    }
  }
}

// ---------- menus, tray, shortcuts ----------

function buildMenu() {
  const check = (label, key) => ({ label, type: 'checkbox', checked: !!state[key], click: () => setState({ [key]: !state[key] }) });
  const accel = (name) => (settings.shortcuts[name] ? { accelerator: settings.shortcuts[name], registerAccelerator: false } : {});
  const onBoard = state.board !== 'none';
  return Menu.buildFromTemplate([
    { label: state.mode === 'draw' ? 'Switch to Mouse Mode' : 'Switch to Draw Mode', ...accel('toggleMode'), click: toggleMode },
    { type: 'separator' },
    {
      label: 'Board',
      submenu: S.BOARDS.map((board) => ({
        label: BOARD_NAMES[board],
        type: 'radio',
        checked: state.board === board,
        click: () => setState({ board, mode: board === 'none' ? state.mode : 'draw' }),
      })),
    },
    {
      label: 'Board Pattern',
      submenu: S.PATTERNS.map((boardPattern) => ({
        label: PATTERN_NAMES[boardPattern],
        type: 'radio',
        checked: state.boardPattern === boardPattern,
        click: () => setState({ boardPattern }),
      })),
    },
    { label: `Previous Page (${state.page + 1}/${state.pageCount})`, enabled: onBoard && state.page > 0, click: () => changePage(-1) },
    { label: 'Next / New Page', enabled: onBoard, click: () => changePage(1) },
    { type: 'separator' },
    check('Fill Shapes', 'fill'),
    check('Dashed Lines', 'dash'),
    check('Fading Ink', 'fadeInk'),
    check('Highlight Cursor', 'cursorHighlight'),
    check('Show Annotations', 'annotationsVisible'),
    { type: 'separator' },
    { label: 'Save Screenshot', ...accel('screenshot'), click: () => screenshot() },
    { label: 'Copy Screenshot to Clipboard', click: () => screenshot({ toClipboard: true }) },
    { label: 'Export Annotations as PNG', click: exportPng },
    { label: 'Open Output Folder', click: () => shell.openPath(outputDir()) },
    { type: 'separator' },
    { label: 'Save Session…', click: saveSession },
    { label: 'Open Session…', click: openSession },
    { type: 'separator' },
    { label: alive(toolbar) && toolbar.isVisible() ? 'Hide Toolbar' : 'Show Toolbar', ...accel('toggleToolbar'), click: toggleToolbar },
    { label: 'Settings…', click: openSettings },
    { label: `About ${APP_NAME}`, click: showAbout },
    { type: 'separator' },
    { label: 'Quit', ...accel('quit'), click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip(APP_NAME);
    tray.on('click', toggleToolbar);
    updateTray();
  } catch (err) {
    console.warn('Tray icon unavailable:', err.message);
  }
}

function updateTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

function registerShortcuts() {
  const actions = {
    toggleMode,
    undo: () => sendToOverlay(targetOverlay(), 'undo'),
    clear: () => sendToAll('clear'),
    toggleVisible: () => setState({ annotationsVisible: !state.annotationsVisible }),
    toggleToolbar,
    board: () => setState({ board: state.board === 'none' ? 'white' : 'none', mode: state.board === 'none' ? 'draw' : state.mode }),
    spotlight: () => toggleTool('spotlight'),
    magnifier: () => toggleTool('magnifier'),
    screenshot: () => screenshot(),
    quit: () => app.quit(),
  };
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [name, accelerator] of Object.entries(settings.shortcuts)) {
    if (!accelerator || !actions[name]) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, actions[name]);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(name);
  }
  if (failed.length) console.warn('Could not register shortcuts:', failed.join(', '));
  return failed;
}

function applyLoginItem() {
  // Only meaningful for the installed app; in development it would register the Electron binary.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin });
}

function updateSettings(next) {
  const prev = settings;
  settings = next;
  const failed = registerShortcuts();
  if (prev.startAtLogin !== settings.startAtLogin) applyLoginItem();
  if (prev.allDisplays !== settings.allDisplays) syncOverlays();
  broadcast();
  saveNow();
  return { failed };
}

function sendToOverlay(win, command, arg) {
  if (alive(win)) win.webContents.send('command', command, arg);
}

function sendToAll(command, arg) {
  for (const win of overlays.values()) sendToOverlay(win, command, arg);
}

// ---------- IPC ----------

ipcMain.on('state:update', (_event, patch) => {
  setState(patch);
  refocusOverlay();
});

ipcMain.on('overlay:active', (event) => {
  activeOverlay = BrowserWindow.fromWebContents(event.sender);
});

ipcMain.on('command', (event, name, arg) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  switch (name) {
    case 'undo':
    case 'redo':
      // From an overlay's own keyboard: that overlay. From the toolbar: the one last drawn on.
      sendToOverlay([...overlays.values()].includes(sender) ? sender : targetOverlay(), name);
      break;
    case 'clear':
      sendToAll('clear');
      break;
    case 'page-prev':
      changePage(-1);
      break;
    case 'page-next':
      changePage(1);
      break;
    case 'screenshot':
      screenshot();
      break;
    case 'toolbar:resize':
      resizeToolbar(arg);
      return;
    case 'menu':
      if (alive(toolbar)) buildMenu().popup({ window: toolbar });
      return;
    case 'settings':
      openSettings();
      return;
    case 'quit':
      app.quit();
      return;
    default:
      return;
  }
  refocusOverlay();
});

ipcMain.handle('capture-display', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  try {
    const image = await captureDisplay(screen.getDisplayMatching(win.getBounds()));
    return image.toDataURL();
  } catch {
    return null;
  }
});

ipcMain.handle('clipboard-read', () => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) return { image: image.toDataURL() };
  const text = clipboard.readText();
  return text ? { text: text.slice(0, 5000) } : null;
});

ipcMain.handle('settings:update', (_event, patch) => updateSettings(S.sanitizeSettings(patch, settings)));

ipcMain.handle('settings:reset', () => updateSettings(S.sanitizeSettings({ last: settings.last })));

ipcMain.handle('settings:choose-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(alive(settingsWin) ? settingsWin : undefined, {
    title: 'Choose where screenshots and exports are saved',
    defaultPath: outputDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('settings:open-dir', () => shell.openPath(outputDir()));

ipcMain.handle('settings:labels', () => S.SHORTCUT_LABELS);

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (alive(toolbar)) {
      toolbar.show();
      keepToolbarOnTop();
    }
  });

  app.whenReady().then(() => {
    settings = S.loadSettings(settingsFile());
    const last = settings.restoreLast ? settings.last : {};
    state = {
      tool: 'pen',
      color: settings.palette[0],
      size: 4,
      boardPattern: 'plain',
      fill: false,
      dash: false,
      fadeInk: false,
      cursorHighlight: false,
      ...last,
      mode: 'cursor', // never start by blocking the screen
      board: 'none',
      annotationsVisible: true,
      page: 0,
      pageCount: 1,
    };

    // Linux compositors sometimes need a moment before transparent windows render correctly.
    const delay = process.platform === 'linux' ? 300 : 0;
    setTimeout(() => {
      syncOverlays();
      createToolbar();
      createTray();
      registerShortcuts();
      applyLoginItem();
      updateCursorTracking();
    }, delay);

    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, syncOverlays);
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (state) saveNow();
  });
  app.on('window-all-closed', () => app.quit());
}
