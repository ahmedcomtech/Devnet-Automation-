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
} = require('electron');
const path = require('path');
const fs = require('fs');

// Global hotkeys work even while another app (Zoom, PowerPoint, browser...) has focus.
const SHORTCUTS = {
  toggleMode: 'CommandOrControl+Alt+D',
  undo: 'CommandOrControl+Alt+Z',
  clear: 'CommandOrControl+Alt+C',
  toggleVisible: 'CommandOrControl+Alt+H',
  toggleToolbar: 'CommandOrControl+Alt+T',
  screenshot: 'CommandOrControl+Alt+S',
  quit: 'CommandOrControl+Alt+Q',
};

const TOOLS = ['pen', 'highlighter', 'eraser', 'laser', 'line', 'arrow', 'rect', 'ellipse', 'text'];
const BOARDS = ['none', 'white', 'black', 'green'];
const TOOLBAR_WIDTH = 100;

let overlay = null;
let toolbar = null;

// Single source of truth; both windows receive the full state on every change.
let state = {
  mode: 'cursor', // 'cursor' = clicks go to apps below, 'draw' = overlay captures the mouse
  tool: 'pen',
  color: '#ff3b30',
  size: 4,
  board: 'none',
  annotationsVisible: true,
  shortcuts: SHORTCUTS,
};

if (process.platform === 'linux') {
  // Transparent windows on Linux need a compositor plus this switch.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function alive(win) {
  return win && !win.isDestroyed();
}

function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (patch.mode === 'draw' || patch.mode === 'cursor') out.mode = patch.mode;
  if (TOOLS.includes(patch.tool)) out.tool = patch.tool;
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) out.color = patch.color;
  if (Number.isFinite(patch.size)) out.size = Math.min(40, Math.max(1, Math.round(patch.size)));
  if (BOARDS.includes(patch.board)) out.board = patch.board;
  if (typeof patch.annotationsVisible === 'boolean') out.annotationsVisible = patch.annotationsVisible;
  return out;
}

function broadcast() {
  for (const win of [overlay, toolbar]) {
    if (alive(win)) win.webContents.send('state', state);
  }
}

function applyMode() {
  if (!alive(overlay)) return;
  const drawing = state.mode === 'draw';
  overlay.setIgnoreMouseEvents(!drawing);
  if (drawing) overlay.focus();
  else overlay.blur();
  keepToolbarOnTop();
}

function setState(patch) {
  const clean = sanitize(patch);
  const modeChanged = clean.mode !== undefined && clean.mode !== state.mode;
  state = { ...state, ...clean };
  if (modeChanged) applyMode();
  broadcast();
}

function keepToolbarOnTop() {
  if (alive(toolbar) && toolbar.isVisible()) toolbar.moveTop();
}

// Clicking the toolbar takes keyboard focus; hand it back so overlay shortcuts keep working.
function refocusOverlay() {
  if (state.mode === 'draw' && alive(overlay)) overlay.focus();
}

function sendToOverlay(command) {
  if (alive(overlay)) overlay.webContents.send('command', command);
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...bounds,
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlay.webContents.on('did-finish-load', broadcast);
  overlay.once('ready-to-show', () => {
    overlay.showInactive();
    applyMode();
  });
  // On Windows all topmost windows share one band, so focusing the overlay can cover the toolbar.
  overlay.on('focus', keepToolbarOnTop);
  overlay.on('closed', () => {
    overlay = null;
    app.quit();
  });
}

function createToolbar() {
  const { workArea } = screen.getPrimaryDisplay();
  toolbar = new BrowserWindow({
    width: TOOLBAR_WIDTH,
    height: 640,
    x: workArea.x + 16,
    y: workArea.y + 80,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'Screen Annotator',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Relative level 1 keeps the toolbar above the overlay on macOS.
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
  const width = Math.max(40, Math.min(400, Math.ceil(size.width) || TOOLBAR_WIDTH));
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

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function notify(title, body, file) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (file) n.on('click', () => shell.showItemInFolder(file));
  n.show();
}

// Captures the real screen (apps + annotations) and saves it to Pictures/Screen Annotator.
async function screenshot() {
  const display = screen.getPrimaryDisplay();
  const toolbarWasVisible = alive(toolbar) && toolbar.isVisible();
  if (toolbarWasVisible) toolbar.hide();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('No screen image available (check screen-recording permission).');
    const dir = path.join(app.getPath('pictures'), 'Screen Annotator');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `annotation-${timestamp()}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    notify('Screenshot saved', file, file);
  } catch (err) {
    notify('Screenshot failed', err.message);
  } finally {
    if (toolbarWasVisible && alive(toolbar)) {
      toolbar.showInactive();
      keepToolbarOnTop();
    }
  }
}

function registerShortcuts() {
  const actions = {
    toggleMode: () => setState({ mode: state.mode === 'draw' ? 'cursor' : 'draw' }),
    undo: () => sendToOverlay('undo'),
    clear: () => sendToOverlay('clear'),
    toggleVisible: () => setState({ annotationsVisible: !state.annotationsVisible }),
    toggleToolbar,
    screenshot,
    quit: () => app.quit(),
  };
  for (const [name, accelerator] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.register(accelerator, actions[name])) {
      console.warn(`Could not register global shortcut ${accelerator} (${name}); it may be in use by another app.`);
    }
  }
}

ipcMain.on('state:update', (_event, patch) => {
  setState(patch);
  refocusOverlay();
});

ipcMain.on('command', (_event, name, arg) => {
  switch (name) {
    case 'undo':
    case 'redo':
    case 'clear':
      sendToOverlay(name);
      break;
    case 'screenshot':
      screenshot();
      break;
    case 'toolbar:resize':
      resizeToolbar(arg);
      return;
    case 'quit':
      app.quit();
      return;
    default:
      return;
  }
  refocusOverlay();
});

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
    // Linux compositors sometimes need a moment before transparent windows render correctly.
    const delay = process.platform === 'linux' ? 300 : 0;
    setTimeout(() => {
      createOverlay();
      createToolbar();
      registerShortcuts();
    }, delay);

    screen.on('display-metrics-changed', () => {
      if (alive(overlay)) overlay.setBounds(screen.getPrimaryDisplay().bounds);
    });
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
