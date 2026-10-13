'use strict';

// Persisted settings and validation of everything the renderers send to the main process.
const fs = require('fs');
const path = require('path');

const TOOLS = [
  'select',
  'pen',
  'highlighter',
  'eraser',
  'laser',
  'spotlight',
  'magnifier',
  'curtain',
  'text',
  'note',
  'line',
  'arrow',
  'arrow2',
  'rect',
  'ellipse',
  'triangle',
  'diamond',
  'callout',
  'badge',
  'stamp',
];
const STAMPS = ['check', 'cross', 'star', 'heart', 'question', 'smile'];
const BOARDS = ['none', 'white', 'black', 'green'];
const PATTERNS = ['plain', 'grid', 'lines', 'dots', 'axes'];
const TOGGLES = ['fill', 'dash', 'fadeInk', 'smartInk', 'cursorHighlight', 'annotationsVisible', 'frozen'];

const DEFAULT_SHORTCUTS = {
  toggleMode: 'CommandOrControl+Alt+D',
  undo: 'CommandOrControl+Alt+Z',
  clear: 'CommandOrControl+Alt+C',
  toggleVisible: 'CommandOrControl+Alt+H',
  toggleToolbar: 'CommandOrControl+Alt+T',
  board: 'CommandOrControl+Alt+W',
  freeze: 'CommandOrControl+Alt+F',
  spotlight: 'CommandOrControl+Alt+G',
  magnifier: 'CommandOrControl+Alt+M',
  cursorHighlight: 'CommandOrControl+Alt+L',
  record: 'CommandOrControl+Alt+R',
  webcam: 'CommandOrControl+Alt+K',
  timer: 'CommandOrControl+Alt+I',
  screenshot: 'CommandOrControl+Alt+S',
  quit: 'CommandOrControl+Alt+Q',
};

const SHORTCUT_LABELS = {
  toggleMode: 'Toggle draw / mouse mode',
  undo: 'Undo',
  clear: 'Clear',
  toggleVisible: 'Hide / show annotations',
  toggleToolbar: 'Hide / show toolbar',
  board: 'Toggle whiteboard',
  freeze: 'Freeze screen',
  spotlight: 'Spotlight',
  magnifier: 'Magnifier',
  cursorHighlight: 'Cursor highlight',
  record: 'Start / stop recording',
  webcam: 'Webcam bubble',
  timer: 'Class timer',
  screenshot: 'Save screenshot',
  quit: 'Quit',
};

const DEFAULT_PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#111111'];

const DEFAULT_SETTINGS = {
  shortcuts: DEFAULT_SHORTCUTS,
  palette: DEFAULT_PALETTE,
  // general
  startAtLogin: false,
  allDisplays: true,
  restoreLast: true,
  autosave: true,
  restoreDrawings: false,
  screenshotDir: '',
  // toolbar
  toolbarOrientation: 'vertical',
  toolbarScale: 1,
  toolbarOpacity: 0.94,
  theme: 'dark',
  // tools
  cursorHighlightColor: '#ffd60a',
  laserSeconds: 0.8,
  fadeSeconds: 3,
  spotlightRadius: 150,
  magnifierZoom: 2,
  // pen tablet (Huion, Wacom, XP-Pen, Surface...)
  penPressureCurve: 1,
  penMinWidth: 0.25,
  smoothing: 3,
  ignoreTouch: true,
  penButton: 'palette',
  // recording
  recordMic: true,
  micDeviceId: '',
  recordSystemAudio: true,
  recordCountdown: true,
  recordFps: 30,
  hideToolbarInRecording: true,
  // webcam
  cameraDeviceId: '',
  cameraShape: 'circle',
  cameraSize: 240,
  cameraMirror: true,
  last: {},
};

// The parts of the live state remembered between launches.
const REMEMBERED = ['tool', 'color', 'size', 'stamp', 'boardPattern', 'fill', 'dash', 'fadeInk', 'smartInk', 'cursorHighlight'];

function isColor(v) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

function clampNumber(v, min, max, fallback) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function oneOf(v, list, fallback) {
  return list.includes(v) ? v : fallback;
}

// Electron accelerators: modifiers and a key joined by '+'. Empty string disables a shortcut.
function isAccelerator(v) {
  return typeof v === 'string' && v.length <= 60 && (v === '' || /^([A-Za-z0-9]+\+)*([A-Za-z0-9]+|[=\-[\];',./`\\])$/.test(v));
}

function isDeviceId(v) {
  return typeof v === 'string' && v.length <= 512 && /^[\w\-=+/.]*$/.test(v);
}

function sanitizeState(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (patch.mode === 'draw' || patch.mode === 'cursor') out.mode = patch.mode;
  if (TOOLS.includes(patch.tool)) out.tool = patch.tool;
  if (STAMPS.includes(patch.stamp)) out.stamp = patch.stamp;
  if (isColor(patch.color)) out.color = patch.color.toLowerCase();
  if (Number.isFinite(patch.size)) out.size = Math.round(clampNumber(patch.size, 1, 40, 4));
  if (BOARDS.includes(patch.board)) out.board = patch.board;
  if (PATTERNS.includes(patch.boardPattern)) out.boardPattern = patch.boardPattern;
  for (const key of TOGGLES) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  return out;
}

function pickRemembered(state) {
  const out = {};
  for (const key of REMEMBERED) if (key in state) out[key] = state[key];
  return sanitizeState(out);
}

// Copies the valid fields of `input` over `base`; invalid or missing fields keep the base value.
function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...base, shortcuts: { ...base.shortcuts }, palette: [...base.palette], last: { ...base.last } };

  if (src.shortcuts && typeof src.shortcuts === 'object') {
    for (const name of Object.keys(DEFAULT_SHORTCUTS)) {
      if (isAccelerator(src.shortcuts[name])) out.shortcuts[name] = src.shortcuts[name];
    }
  }
  if (Array.isArray(src.palette)) {
    out.palette = out.palette.map((c, i) => (isColor(src.palette[i]) ? src.palette[i].toLowerCase() : c));
  }
  const booleans = ['startAtLogin', 'allDisplays', 'restoreLast', 'autosave', 'restoreDrawings', 'ignoreTouch', 'recordMic', 'recordSystemAudio', 'recordCountdown', 'hideToolbarInRecording', 'cameraMirror'];
  for (const key of booleans) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  if (isColor(src.cursorHighlightColor)) out.cursorHighlightColor = src.cursorHighlightColor.toLowerCase();
  out.toolbarOrientation = oneOf(src.toolbarOrientation, ['vertical', 'horizontal'], out.toolbarOrientation);
  out.theme = oneOf(src.theme, ['dark', 'light'], out.theme);
  out.penButton = oneOf(src.penButton, ['palette', 'eraser', 'none'], out.penButton);
  out.cameraShape = oneOf(src.cameraShape, ['circle', 'rounded'], out.cameraShape);
  out.recordFps = oneOf(src.recordFps, [15, 24, 30, 60], out.recordFps);
  out.toolbarScale = clampNumber(src.toolbarScale, 0.75, 1.5, out.toolbarScale);
  out.toolbarOpacity = clampNumber(src.toolbarOpacity, 0.3, 1, out.toolbarOpacity);
  out.laserSeconds = clampNumber(src.laserSeconds, 0.2, 5, out.laserSeconds);
  out.fadeSeconds = clampNumber(src.fadeSeconds, 1, 30, out.fadeSeconds);
  out.spotlightRadius = Math.round(clampNumber(src.spotlightRadius, 40, 600, out.spotlightRadius));
  out.magnifierZoom = clampNumber(src.magnifierZoom, 1.5, 8, out.magnifierZoom);
  out.penPressureCurve = clampNumber(src.penPressureCurve, 0.3, 3, out.penPressureCurve);
  out.penMinWidth = clampNumber(src.penMinWidth, 0.05, 1, out.penMinWidth);
  out.smoothing = Math.round(clampNumber(src.smoothing, 0, 10, out.smoothing));
  out.cameraSize = Math.round(clampNumber(src.cameraSize, 120, 480, out.cameraSize));
  if (isDeviceId(src.micDeviceId)) out.micDeviceId = src.micDeviceId;
  if (isDeviceId(src.cameraDeviceId)) out.cameraDeviceId = src.cameraDeviceId;
  if (typeof src.screenshotDir === 'string' && src.screenshotDir.length < 1024) out.screenshotDir = src.screenshotDir;
  if (src.last && typeof src.last === 'object') out.last = pickRemembered(src.last);
  return out;
}

function loadSettings(file) {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return sanitizeSettings({});
  }
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  TOOLS,
  STAMPS,
  BOARDS,
  PATTERNS,
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  isAccelerator,
  sanitizeState,
  sanitizeSettings,
  pickRemembered,
  loadSettings,
  saveSettings,
};
