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
  session,
  systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const S = require('./lib/settings');

const APP_NAME = 'Inkora';
const SESSION_FORMAT = 'inkora-session';
// Sessions saved by the earlier 'Screen Annotator' builds open too.
const SESSION_FORMATS = [SESSION_FORMAT, 'screen-annotator-session'];
const BOARD_NAMES = { none: 'Screen (no board)', white: 'Whiteboard', black: 'Blackboard', green: 'Chalkboard' };
const PATTERN_NAMES = { plain: 'Plain', grid: 'Grid', lines: 'Lined paper', dots: 'Dot grid', axes: 'Coordinate axes' };
const STAMP_NAMES = { check: 'Check mark ✓', cross: 'Cross ✗', star: 'Star ★', heart: 'Heart ♥', question: 'Question ?', smile: 'Smiley ☺' };
const MAX_PAGES = 200;
const MAX_PDF_PAGES = 100;
const AUTOSAVE_MS = 30000;

const ICON = path.join(__dirname, 'src', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'src', 'assets', 'tray.png');

let settings = null;
let state = null;
const overlays = new Map(); // display id -> BrowserWindow
let toolbar = null;
let settingsWin = null;
let cameraWin = null;
let timerWin = null;
let tray = null;
let activeOverlay = null; // last overlay drawn on; receives undo/redo
let cursorTimer = null;
let lastCursor = null;
let saveTimer = null;
let recorder = null; // { win, stream, file, done }
let recordDisplay = null;
let lastAutosave = '';
let quitting = false;

if (process.platform === 'linux') {
  // Transparent windows on Linux need a compositor plus this switch.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// ---------- helpers ----------

function alive(win) {
  return win && !win.isDestroyed();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userFile(name) {
  return path.join(app.getPath('userData'), name);
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
  const dir = settings.screenshotDir || path.join(app.getPath('pictures'), 'Inkora');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function webPreferences(extra = {}) {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    ...extra,
  };
}

function dialogParent() {
  return alive(toolbar) ? toolbar : undefined;
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

function allWindows() {
  return [...overlays.values(), toolbar, settingsWin, cameraWin, timerWin].filter(alive);
}

// ---------- state ----------

function publicState() {
  return { ...state, settings };
}

function broadcast() {
  const snapshot = publicState();
  for (const win of allWindows()) win.webContents.send('state', snapshot);
  updateTray();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  try {
    S.saveSettings(userFile('settings.json'), { ...settings, last: S.pickRemembered(state) });
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

// `patch` comes from renderers and is validated; `internal` is trusted state owned by this process.
function setState(patch, internal = {}) {
  const clean = { ...S.sanitizeState(patch), ...internal };
  // Freezing only makes sense while drawing; going back to the mouse unfreezes the screen.
  if (clean.frozen === true) clean.mode = 'draw';
  if (clean.mode === 'cursor' && state.frozen && clean.frozen === undefined) clean.frozen = false;
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
  setState({}, { page, pageCount: Math.max(state.pageCount, page + 1) });
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
  for (const win of [cameraWin, timerWin, toolbar, settingsWin]) {
    if (alive(win) && win.isVisible()) win.moveTop();
  }
}

// Clicking the toolbar takes keyboard focus; hand it back so overlay shortcuts keep working.
function refocusOverlay() {
  if (state.mode !== 'draw') return;
  const win = overlayAtCursor();
  if (win) win.focus();
}

function floatingWindow(options, level = 1) {
  const win = new BrowserWindow({
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    icon: ICON,
    show: false,
    webPreferences: webPreferences(),
    ...options,
  });
  // Relative levels keep floating windows above the overlays on macOS.
  win.setAlwaysOnTop(true, 'screen-saver', level);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('did-finish-load', () => win.webContents.send('state', publicState()));
  return win;
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
  win.loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
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
  toolbar = floatingWindow({ width: 160, height: 600, x: workArea.x + 16, y: workArea.y + 60, title: APP_NAME });
  toolbar.loadFile(path.join(__dirname, 'src', 'toolbar.html'));
  toolbar.webContents.on('did-finish-load', () => toolbar.webContents.setZoomFactor(settings.toolbarScale));
  toolbar.once('ready-to-show', () => toolbar.show());
  toolbar.on('closed', () => {
    toolbar = null;
    app.quit();
  });
}

function resizeToolbar(size) {
  if (!alive(toolbar) || !size) return;
  const display = screen.getDisplayMatching(toolbar.getBounds());
  const scale = settings.toolbarScale;
  const width = Math.max(40, Math.min(display.workArea.width - 20, Math.ceil((size.width || 150) * scale)));
  const height = Math.max(40, Math.min(display.workArea.height - 20, Math.ceil((size.height || 0) * scale)));
  const b = toolbar.getBounds();
  // Keep the toolbar on screen when it grows (e.g. switching to the horizontal layout).
  const x = Math.min(b.x, display.workArea.x + display.workArea.width - width);
  const y = Math.min(b.y, display.workArea.y + display.workArea.height - height);
  toolbar.setBounds({ x: Math.max(display.workArea.x, x), y: Math.max(display.workArea.y, y), width, height });
}

function toggleToolbar() {
  if (!alive(toolbar)) return;
  if (toolbar.isVisible()) toolbar.hide();
  else {
    toolbar.showInactive();
    keepToolbarOnTop();
  }
  updateTray();
}

function openSettings() {
  if (alive(settingsWin)) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  setState({ mode: 'cursor' });
  settingsWin = new BrowserWindow({
    width: 660,
    height: 760,
    minWidth: 520,
    minHeight: 420,
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
  dialog.showMessageBox(dialogParent(), {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: `Version ${app.getVersion()}\n\nDraw, highlight, record and present on top of any app while teaching online.`,
    icon: nativeImage.createFromPath(ICON),
  });
}

async function askMediaAccess(kind) {
  if (process.platform !== 'darwin') return true;
  try {
    return await systemPreferences.askForMediaAccess(kind);
  } catch {
    return false;
  }
}

function cameraBounds() {
  const size = settings.cameraSize;
  const width = settings.cameraShape === 'circle' ? size : Math.round((size * 4) / 3);
  return { width: width + 12, height: size + 12 }; // + the bubble's margin for its shadow
}

async function toggleWebcam() {
  if (alive(cameraWin)) {
    cameraWin.destroy();
    return;
  }
  await askMediaAccess('camera');
  const { workArea } = screen.getPrimaryDisplay();
  const b = cameraBounds();
  cameraWin = floatingWindow({
    ...b,
    x: workArea.x + workArea.width - b.width - 24,
    y: workArea.y + workArea.height - b.height - 24,
    skipTaskbar: true,
    title: 'Webcam',
  });
  cameraWin.loadFile(path.join(__dirname, 'src', 'camera.html'));
  cameraWin.once('ready-to-show', () => {
    cameraWin.showInactive();
    keepToolbarOnTop();
  });
  cameraWin.on('closed', () => {
    cameraWin = null;
    if (!quitting) setState({}, { cameraOpen: false });
  });
  setState({}, { cameraOpen: true });
}

function toggleTimer() {
  if (alive(timerWin)) {
    timerWin.destroy();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  timerWin = floatingWindow({
    width: 276,
    height: 210,
    x: workArea.x + workArea.width - 276 - 24,
    y: workArea.y + 24,
    skipTaskbar: true,
    title: 'Class Timer',
  });
  timerWin.loadFile(path.join(__dirname, 'src', 'timer.html'));
  timerWin.once('ready-to-show', () => {
    timerWin.showInactive();
    keepToolbarOnTop();
  });
  timerWin.on('closed', () => {
    timerWin = null;
    if (!quitting) setState({}, { timerOpen: false });
  });
  setState({}, { timerOpen: true });
}

// Hidden helper page (recorder, PDF renderer). Resolves `ready` once its script is running.
function createHelper(file) {
  const win = new BrowserWindow({ show: false, webPreferences: webPreferences({ backgroundThrottling: false }) });
  const ready = new Promise((resolve) => {
    const onReady = (event) => {
      if (event.sender !== win.webContents) return;
      ipcMain.removeListener('renderer:ready', onReady);
      resolve();
    };
    ipcMain.on('renderer:ready', onReady);
  });
  win.loadFile(path.join(__dirname, 'src', file));
  return { win, ready };
}

// ---------- renderer requests ----------

let requestId = 0;
const pending = new Map();

// Ask a renderer for data (e.g. its drawings) and wait for the answer.
function ask(win, name, arg, timeout = 5000) {
  return new Promise((resolve) => {
    if (!alive(win)) return resolve(null);
    const id = ++requestId;
    pending.set(id, resolve);
    win.webContents.send('request', id, name, arg);
    setTimeout(() => {
      if (pending.delete(id)) resolve(null);
    }, timeout);
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
  await delay(200);
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

// Board pages → a landscape A4 PDF, e.g. as a handout after class.
async function exportPdf() {
  setState({ mode: 'cursor' });
  const pagesData = await ask(targetOverlay(), 'export-pages', null, 60000);
  if (!Array.isArray(pagesData) || !pagesData.length) {
    notify('Nothing to export', 'Draw on a whiteboard page first (B or the board button).');
    return;
  }
  const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
    title: 'Export board pages as PDF',
    defaultPath: path.join(app.getPath('documents'), `lesson-${timestamp()}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return;
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'annotator-pdf-'));
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    pagesData.forEach((src, i) => {
      if (typeof src === 'string' && src.startsWith('data:image/png;base64,')) {
        fs.writeFileSync(path.join(dir, `page${i}.png`), Buffer.from(src.split(',')[1], 'base64'));
      }
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: A4 landscape; margin: 0; }
      html, body { margin: 0; }
      .page { width: 297mm; height: 210mm; display: flex; align-items: center; justify-content: center; break-after: page; }
      .page:last-child { break-after: auto; }
      img { max-width: 100%; max-height: 100%; }
    </style></head><body>${pagesData.map((_, i) => `<div class="page"><img src="page${i}.png"></div>`).join('')}</body></html>`;
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    await printer.loadFile(path.join(dir, 'index.html'));
    const pdf = await printer.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    fs.writeFileSync(filePath, pdf);
    notify('PDF exported', `${pagesData.length} page(s) → ${filePath}`, filePath);
  } catch (err) {
    dialog.showErrorBox('Could not export PDF', err.message);
  } finally {
    printer.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function renderPdf(file, width, height) {
  const { win, ready } = createHelper('pdf.html');
  try {
    await Promise.race([ready, delay(15000)]);
    const data = new Uint8Array(fs.readFileSync(file));
    const result = await ask(win, 'render-pdf', { data, maxPages: MAX_PDF_PAGES, width, height }, 180000);
    if (!result || !Array.isArray(result.pages)) throw new Error('The PDF could not be read.');
    if (result.total > MAX_PDF_PAGES) notify('Large PDF', `Imported the first ${MAX_PDF_PAGES} of ${result.total} pages.`);
    return result.pages;
  } finally {
    win.destroy();
  }
}

// PDFs and images → new board pages (one page per PDF page / image), ready to annotate.
async function openAsPages() {
  setState({ mode: 'cursor' });
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(), {
    title: 'Open PDF or images as board pages',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'PDF or images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return;
  const win = overlayAtCursor();
  const display = screen.getDisplayMatching(win.getBounds());
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const images = [];
  for (const file of filePaths) {
    try {
      if (/\.pdf$/i.test(file)) {
        images.push(...(await renderPdf(file, width, height)));
      } else {
        const img = nativeImage.createFromPath(file);
        if (img.isEmpty()) throw new Error('Unsupported image.');
        const size = img.getSize();
        images.push({ src: img.toDataURL(), w: size.width, h: size.height });
      }
    } catch (err) {
      dialog.showErrorBox(`Could not open ${path.basename(file)}`, err.message);
    }
  }
  if (!images.length) return;
  const result = await ask(win, 'append-pages', { images: images.slice(0, MAX_PAGES) }, 60000);
  if (!result) return;
  setState(
    { board: state.board === 'none' ? 'white' : state.board, mode: 'draw' },
    { page: result.start, pageCount: Math.max(state.pageCount, result.start + result.count) },
  );
  notify('Pages added', `${result.count} page(s) added to the board. Use Page Up / Page Down to move between them.`);
}

async function insertImage() {
  setState({ mode: 'cursor' });
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(), {
    title: 'Insert image',
    defaultPath: app.getPath('pictures'),
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  const img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) {
    dialog.showErrorBox('Could not open image', 'This image format is not supported.');
    return;
  }
  const win = overlayAtCursor();
  setState({ mode: 'draw' });
  if (win) win.webContents.send('command', 'insert-image', { src: img.toDataURL() });
}

async function collectSession() {
  const displays = await Promise.all(sortedOverlays().map((win) => ask(win, 'export-session')));
  return { format: SESSION_FORMAT, version: 1, pageCount: state.pageCount, displays: displays.map((d) => d || { screen: [], pages: [] }) };
}

function applySession(data) {
  const pageCount = Number.isInteger(data.pageCount) ? data.pageCount : 1;
  setState({}, { page: 0, pageCount });
  sortedOverlays().forEach((win, i) => win.webContents.send('command', 'import-session', data.displays[i] || null));
}

function readSessionFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!SESSION_FORMATS.includes(data.format) || !Array.isArray(data.displays)) throw new Error('This is not an Inkora lesson file.');
  return data;
}

// Opening a .inkora file (double-click, drag onto the app icon) loads that lesson.
let pendingLesson = null;

function lessonFromArgv(argv) {
  return argv.find((arg) => /\.inkora$/i.test(arg) && fs.existsSync(arg)) || null;
}

async function openLessonFile(file) {
  try {
    await Promise.all(sortedOverlays().map((w) => w.loaded));
    applySession(readSessionFile(file));
  } catch (err) {
    dialog.showErrorBox('Could not open lesson', err.message);
  }
}

async function saveSession() {
  setState({ mode: 'cursor' });
  const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
    title: 'Save lesson',
    defaultPath: path.join(app.getPath('documents'), `lesson-${timestamp()}.inkora`),
    filters: [{ name: 'Inkora lesson', extensions: ['inkora'] }],
  });
  if (canceled || !filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify({ ...(await collectSession()), savedAt: new Date().toISOString() }));
    notify('Lesson saved', filePath, filePath);
  } catch (err) {
    dialog.showErrorBox('Could not save lesson', err.message);
  }
}

async function openSession() {
  setState({ mode: 'cursor' });
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(), {
    title: 'Open lesson',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Inkora lesson', extensions: ['inkora', 'json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  try {
    applySession(readSessionFile(filePaths[0]));
  } catch (err) {
    dialog.showErrorBox('Could not open lesson', err.message);
  }
}

// ---------- autosave ----------

function isEmptySession(data) {
  return data.displays.every((d) => !d.screen.length && d.pages.every((p) => !p.length));
}

async function autosave() {
  if (!settings.autosave || !overlays.size) return;
  const data = await collectSession();
  const body = JSON.stringify(data);
  if (body === lastAutosave) return;
  // Nothing drawn yet in this run: keep the previous run's autosave for "Restore Last Autosave".
  if (!lastAutosave && isEmptySession(data)) return;
  lastAutosave = body;
  try {
    writeAtomic(userFile('autosave.json'), JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
  } catch (err) {
    console.error('Autosave failed:', err);
  }
}

async function restoreAutosave(silent = false) {
  const file = userFile('autosave.json');
  try {
    await Promise.all(sortedOverlays().map((w) => w.loaded));
    applySession(readSessionFile(file));
    if (!silent) notify('Drawings restored', 'Your last autosaved drawings are back.');
  } catch {
    if (!silent) dialog.showMessageBox(dialogParent(), { type: 'info', message: 'No autosaved drawings found yet.' });
  }
}

// ---------- recording ----------

function protectFromCapture(on) {
  // Keeps the toolbar and settings out of the video (Windows and macOS).
  for (const win of [toolbar, settingsWin]) {
    if (alive(win)) win.setContentProtection(on && settings.hideToolbarInRecording);
  }
}

async function startRecording() {
  if (state.recording !== 'idle') return;
  recordDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (settings.recordMic) await askMediaAccess('microphone');
  setState({}, { recording: 'countdown' });
  const overlay = overlays.get(recordDisplay.id);
  if (settings.recordCountdown) {
    for (const n of [3, 2, 1]) {
      if (alive(overlay)) overlay.webContents.send('command', 'countdown', n);
      await delay(1000);
      if (state.recording !== 'countdown') break;
    }
    if (alive(overlay)) overlay.webContents.send('command', 'countdown', null);
    if (state.recording !== 'countdown') return; // cancelled during the countdown
    await delay(150); // let the countdown bubble disappear before capturing
  }
  const { win, ready } = createHelper('recorder.html');
  let finished;
  recorder = { win, stream: null, file: null, done: new Promise((resolve) => (finished = resolve)) };
  recorder.finished = finished;
  await ready;
  win.webContents.send('command', 'start', {
    fps: settings.recordFps,
    mic: settings.recordMic,
    micDeviceId: settings.micDeviceId,
    systemAudio: settings.recordSystemAudio && process.platform === 'win32',
  });
}

function finishRecording(saved) {
  const r = recorder;
  recorder = null;
  if (!r) return;
  protectFromCapture(false);
  setState({}, { recording: 'idle', recordStartedAt: 0, recordElapsed: 0 });
  const done = () => {
    if (saved && r.file) notify('Recording saved', r.file, r.file);
    r.finished();
  };
  if (r.stream) r.stream.end(done);
  else done();
  if (alive(r.win)) r.win.destroy();
}

function stopRecording() {
  if (state.recording === 'countdown') {
    setState({}, { recording: 'idle' });
    return;
  }
  if (recorder && alive(recorder.win)) recorder.win.webContents.send('command', 'stop');
}

function toggleRecording() {
  if (state.recording === 'idle') startRecording();
  else stopRecording();
}

function togglePauseRecording() {
  if (!recorder || !alive(recorder.win)) return;
  if (state.recording === 'recording') {
    recorder.win.webContents.send('command', 'pause');
    setState({}, { recording: 'paused', recordElapsed: state.recordElapsed + (Date.now() - state.recordStartedAt) });
  } else if (state.recording === 'paused') {
    recorder.win.webContents.send('command', 'resume');
    setState({}, { recording: 'recording', recordStartedAt: Date.now() });
  }
}

ipcMain.on('recorder:event', (event, type, data) => {
  if (!recorder || event.sender !== recorder.win.webContents) return;
  switch (type) {
    case 'started': {
      const ext = String(data && data.mimeType).includes('mp4') ? 'mp4' : 'webm';
      recorder.file = path.join(outputDir(), `recording-${timestamp()}.${ext}`);
      recorder.stream = fs.createWriteStream(recorder.file);
      protectFromCapture(true);
      setState({}, { recording: 'recording', recordStartedAt: Date.now(), recordElapsed: 0 });
      break;
    }
    case 'chunk':
      if (recorder.stream && data instanceof Uint8Array) recorder.stream.write(Buffer.from(data));
      break;
    case 'warning':
      notify('Recording', String(data));
      break;
    case 'error':
      notify('Recording failed', String(data));
      finishRecording(false);
      break;
    case 'stopped':
      finishRecording(true);
      break;
  }
});

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

function stampMenu() {
  return S.STAMPS.map((stamp) => ({
    label: STAMP_NAMES[stamp],
    type: 'radio',
    checked: state.stamp === stamp,
    click: () => setState({ stamp, tool: 'stamp', mode: 'draw' }),
  }));
}

function buildMenu() {
  const check = (label, key) => ({ label, type: 'checkbox', checked: !!state[key], click: () => setState({ [key]: !state[key] }) });
  const accel = (name) => (settings.shortcuts[name] ? { accelerator: settings.shortcuts[name], registerAccelerator: false } : {});
  const onBoard = state.board !== 'none';
  const recording = state.recording !== 'idle';
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
    { label: 'Open PDF or Images as Pages…', click: openAsPages },
    { type: 'separator' },
    { label: 'Stamp', submenu: stampMenu() },
    check('Smart Shapes', 'smartInk'),
    check('Fill Shapes', 'fill'),
    check('Dashed Lines', 'dash'),
    check('Fading Ink', 'fadeInk'),
    { label: 'Insert Image…', click: insertImage },
    { type: 'separator' },
    { label: 'Freeze Screen', type: 'checkbox', checked: !!state.frozen, ...accel('freeze'), click: () => setState({ frozen: !state.frozen }) },
    { label: 'Highlight Cursor', type: 'checkbox', checked: !!state.cursorHighlight, ...accel('cursorHighlight'), click: () => setState({ cursorHighlight: !state.cursorHighlight }) },
    { label: 'Webcam Bubble', type: 'checkbox', checked: alive(cameraWin), ...accel('webcam'), click: toggleWebcam },
    { label: 'Class Timer', type: 'checkbox', checked: alive(timerWin), ...accel('timer'), click: toggleTimer },
    check('Show Annotations', 'annotationsVisible'),
    { type: 'separator' },
    { label: recording ? 'Stop Recording' : 'Start Recording', ...accel('record'), click: toggleRecording },
    { label: state.recording === 'paused' ? 'Resume Recording' : 'Pause Recording', enabled: state.recording === 'recording' || state.recording === 'paused', click: togglePauseRecording },
    { label: 'Save Screenshot', ...accel('screenshot'), click: () => screenshot() },
    { label: 'Copy Screenshot to Clipboard', click: () => screenshot({ toClipboard: true }) },
    { label: 'Export Annotations as PNG', click: exportPng },
    { label: 'Export Board Pages as PDF…', click: exportPdf },
    { label: 'Open Output Folder', click: () => shell.openPath(outputDir()) },
    { type: 'separator' },
    { label: 'Save Lesson…', click: saveSession },
    { label: 'Open Lesson…', click: openSession },
    { label: 'Restore Last Autosave', click: () => restoreAutosave(false) },
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
    freeze: () => setState({ frozen: !state.frozen }),
    spotlight: () => toggleTool('spotlight'),
    magnifier: () => toggleTool('magnifier'),
    cursorHighlight: () => setState({ cursorHighlight: !state.cursorHighlight }),
    record: toggleRecording,
    webcam: toggleWebcam,
    timer: toggleTimer,
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
  if (alive(toolbar) && prev.toolbarScale !== settings.toolbarScale) toolbar.webContents.setZoomFactor(settings.toolbarScale);
  if (alive(cameraWin) && (prev.cameraSize !== settings.cameraSize || prev.cameraShape !== settings.cameraShape)) {
    const { x, y } = cameraWin.getBounds();
    cameraWin.setBounds({ x, y, ...cameraBounds() });
  }
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

const COMMANDS = {
  clear: () => sendToAll('clear'),
  'page-prev': () => changePage(-1),
  'page-next': () => changePage(1),
  screenshot: () => screenshot(),
  freeze: () => setState({ frozen: !state.frozen }),
  record: toggleRecording,
  'record-pause': togglePauseRecording,
  'record-stop': stopRecording,
  webcam: toggleWebcam,
  timer: toggleTimer,
  'insert-image': insertImage,
  'open-pages': openAsPages,
  'export-pdf': exportPdf,
};

ipcMain.on('command', (event, name, arg) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (name === 'undo' || name === 'redo') {
    // From an overlay's own keyboard: that overlay. From the toolbar: the one last drawn on.
    sendToOverlay([...overlays.values()].includes(sender) ? sender : targetOverlay(), name);
  } else if (name === 'toolbar:resize') {
    if (sender === toolbar) resizeToolbar(arg);
    return;
  } else if (name === 'menu' || name === 'stamp-menu') {
    if (alive(toolbar)) (name === 'menu' ? buildMenu() : Menu.buildFromTemplate(stampMenu())).popup({ window: toolbar });
    return;
  } else if (name === 'settings') {
    openSettings();
    return;
  } else if (name === 'quit') {
    app.quit();
    return;
  } else if (COMMANDS[name]) {
    COMMANDS[name]();
  } else {
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
  return text ? { text: text.slice(0, 50e6) } : null;
});

ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string' && text.length < 50e6) clipboard.writeText(text);
});

ipcMain.handle('settings:update', (_event, patch) => updateSettings(S.sanitizeSettings(patch, settings)));

ipcMain.handle('settings:reset', () => updateSettings(S.sanitizeSettings({ last: settings.last })));

ipcMain.handle('settings:choose-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(alive(settingsWin) ? settingsWin : undefined, {
    title: 'Choose where screenshots, recordings and exports are saved',
    defaultPath: outputDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('settings:open-dir', () => shell.openPath(outputDir()));

ipcMain.handle('settings:labels', () => S.SHORTCUT_LABELS);

// ---------- lifecycle ----------

function setupMediaPermissions() {
  // Only the app's own local pages are ever loaded, so camera, microphone and screen capture are allowed.
  const allowed = ['media', 'display-capture', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
  // The recorder's getDisplayMedia() call records the display the recording was started on.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const display = recordDisplay || screen.getPrimaryDisplay();
      const video = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      const loopback = settings.recordSystemAudio && process.platform === 'win32';
      callback(loopback ? { video, audio: 'loopback' } : { video });
    } catch {
      callback({});
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const lesson = lessonFromArgv(argv);
    if (lesson) openLessonFile(lesson);
    if (alive(toolbar)) {
      toolbar.show();
      keepToolbarOnTop();
    }
  });

  // macOS delivers opened files as events instead of command-line arguments.
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (overlays.size) openLessonFile(file);
    else pendingLesson = file;
  });

  app.whenReady().then(() => {
    settings = S.loadSettings(userFile('settings.json'));
    const last = settings.restoreLast ? settings.last : {};
    state = {
      tool: 'pen',
      stamp: 'check',
      color: settings.palette[0],
      size: 4,
      boardPattern: 'plain',
      fill: false,
      dash: false,
      fadeInk: false,
      smartInk: false,
      cursorHighlight: false,
      ...last,
      mode: 'cursor', // never start by blocking the screen
      board: 'none',
      annotationsVisible: true,
      frozen: false,
      page: 0,
      pageCount: 1,
      recording: 'idle',
      recordStartedAt: 0,
      recordElapsed: 0,
      cameraOpen: false,
      timerOpen: false,
    };
    setupMediaPermissions();

    // Linux compositors sometimes need a moment before transparent windows render correctly.
    const startDelay = process.platform === 'linux' ? 300 : 0;
    setTimeout(() => {
      syncOverlays();
      createToolbar();
      createTray();
      registerShortcuts();
      applyLoginItem();
      updateCursorTracking();
      const lesson = pendingLesson || lessonFromArgv(process.argv);
      pendingLesson = null;
      if (lesson) openLessonFile(lesson);
      else if (settings.restoreDrawings) restoreAutosave(true);
      setInterval(autosave, AUTOSAVE_MS);
    }, startDelay);

    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, syncOverlays);
    }
  });

  // Finish a running recording and autosave the drawings before quitting.
  app.on('before-quit', (event) => {
    if (quitting || !state) return;
    event.preventDefault();
    quitting = true;
    const work = [];
    if (recorder) {
      stopRecording();
      work.push(recorder.done);
    }
    work.push(autosave());
    Promise.race([Promise.all(work), delay(5000)]).finally(() => app.quit());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (state) saveNow();
  });
  app.on('window-all-closed', () => app.quit());
}
