'use strict';

(() => {
  const api = window.annotator;
  const G = window.Geometry;
  const isMac = api.platform === 'darwin';
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let labels = {};
  let failed = new Set();
  let recording = null; // shortcut name being recorded

  const CHECKBOXES = ['startAtLogin', 'allDisplays', 'restoreLast', 'autosave', 'restoreDrawings', 'ignoreTouch', 'recordMic', 'recordSystemAudio', 'recordCountdown', 'hideToolbarInRecording', 'cameraMirror'];
  const SELECTS = ['toolbarOrientation', 'theme', 'penButton', 'cameraShape', 'recordFps', 'micDeviceId', 'cameraDeviceId'];
  const RANGES = {
    toolbarScale: (v) => `${Math.round(v * 100)}%`,
    toolbarOpacity: null,
    laserSeconds: (v) => `${v}s`,
    fadeSeconds: (v) => `${v}s`,
    spotlightRadius: (v) => `${v}px`,
    magnifierZoom: (v) => `${v}×`,
    penPressureCurve: (v) => (v < 0.9 ? `soft (${v})` : v > 1.1 ? `firm (${v})` : `linear (${v})`),
    penMinWidth: (v) => `${Math.round(v * 100)}%`,
    smoothing: (v) => (Number(v) === 0 ? 'off' : String(v)),
    cameraSize: (v) => `${v}px`,
  };

  async function save(patch) {
    const result = await api.invoke('settings:update', patch);
    failed = new Set((result && result.failed) || []);
    renderShortcuts();
  }

  // ---------- simple fields ----------

  for (const id of CHECKBOXES) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  for (const id of SELECTS) {
    $(id).addEventListener('change', (e) => save({ [id]: id === 'recordFps' ? Number(e.target.value) : e.target.value }));
  }
  for (const [id, fmt] of Object.entries(RANGES)) {
    const input = $(id);
    const out = document.querySelector(`output[for="${id}"]`);
    input.addEventListener('input', () => {
      if (out && fmt) out.textContent = fmt(Number(input.value));
    });
    input.addEventListener('change', () => save({ [id]: Number(input.value) }));
  }
  $('cursorHighlightColor').addEventListener('change', (e) => save({ cursorHighlightColor: e.target.value }));
  if (api.platform !== 'win32') $('system-audio-row').style.display = 'none';

  $('choose-dir').addEventListener('click', async () => {
    const dir = await api.invoke('settings:choose-dir');
    if (dir) save({ screenshotDir: dir });
  });
  $('open-dir').addEventListener('click', () => api.invoke('settings:open-dir'));
  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset all settings, shortcuts and colors to their defaults?')) return;
    const result = await api.invoke('settings:reset');
    failed = new Set((result && result.failed) || []);
  });

  const paletteEl = $('palette');
  const paletteInputs = Array.from({ length: 8 }, (_, i) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.title = `Color ${i + 1}`;
    input.addEventListener('change', () => save({ palette: paletteInputs.map((p) => p.value) }));
    paletteEl.appendChild(input);
    return input;
  });

  // ---------- devices ----------

  async function listDevices() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      devices = [];
    }
    const fill = (select, kind, current, noun) => {
      select.textContent = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = `Default ${noun}`;
      select.appendChild(def);
      devices
        .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
        .forEach((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `${noun[0].toUpperCase()}${noun.slice(1)} ${i + 1}`;
          select.appendChild(o);
        });
      select.value = [...select.options].some((o) => o.value === current) ? current : '';
    };
    fill($('micDeviceId'), 'audioinput', settings.micDeviceId, 'microphone');
    fill($('cameraDeviceId'), 'videoinput', settings.cameraDeviceId, 'camera');
  }

  $('detect').addEventListener('click', async () => {
    // Asking for access once makes the device names visible.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      for (const t of stream.getTracks()) t.stop();
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of stream.getTracks()) t.stop();
      } catch {
        // no devices at all
      }
    }
    listDevices();
  });

  // ---------- pen test pad ----------

  const pad = $('pad');
  const pctx = pad.getContext('2d');
  const padInfo = $('pad-info');
  let padStroke = null;

  function sizePad() {
    const dpr = window.devicePixelRatio || 1;
    pad.width = pad.clientWidth * dpr;
    pad.height = pad.clientHeight * dpr;
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    padStroke = { last: { x: e.offsetX, y: e.offsetY }, smooth: { x: e.offsetX, y: e.offsetY } };
  });
  pad.addEventListener('pointermove', (e) => {
    const p = G.applyPressureCurve(e.pressure, settings.penPressureCurve);
    const kind = e.pointerType === 'pen' ? 'Pen' : e.pointerType === 'touch' ? 'Touch' : 'Mouse (no pressure)';
    padInfo.textContent = `${kind} · raw pressure ${e.pressure.toFixed(2)} → ${p.toFixed(2)}${e.pointerType === 'pen' && e.pressure === 0.5 && e.buttons ? ' · if this never changes, enable Windows Ink' : ''}`;
    if (!padStroke) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const a = 1 / (1 + settings.smoothing * 0.5);
    for (const ev of events.length ? events : [e]) {
      const s = padStroke.smooth;
      const next = { x: s.x + (ev.offsetX - s.x) * a, y: s.y + (ev.offsetY - s.y) * a };
      const width = e.pointerType === 'pen' ? G.pressureWidth(6, G.applyPressureCurve(ev.pressure, settings.penPressureCurve), settings.penMinWidth) : 6;
      pctx.strokeStyle = '#1a73e8';
      pctx.lineCap = 'round';
      pctx.lineWidth = width;
      pctx.beginPath();
      pctx.moveTo(s.x, s.y);
      pctx.lineTo(next.x, next.y);
      pctx.stroke();
      padStroke.smooth = next;
    }
  });
  const endPad = () => (padStroke = null);
  pad.addEventListener('pointerup', endPad);
  pad.addEventListener('pointercancel', endPad);
  $('pad-clear').addEventListener('click', () => pctx.clearRect(0, 0, pad.width, pad.height));
  window.addEventListener('resize', sizePad);
  sizePad();

  // ---------- shortcut recorder ----------

  const KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };

  function keyName(e) {
    if (/^F\d{1,2}$/.test(e.key)) return e.key;
    if (KEY_NAMES[e.key]) return KEY_NAMES[e.key];
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Tab'].includes(e.key)) return e.key;
    return e.key.length === 1 ? e.key.toUpperCase() : null;
  }

  function display(accel) {
    if (!accel) return 'Disabled';
    return accel.replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl').replace(/\+/g, ' + ');
  }

  function renderShortcuts() {
    const root = $('shortcuts');
    root.textContent = '';
    for (const [name, label] of Object.entries(labels)) {
      const row = document.createElement('div');
      row.className = 'row shortcut' + (failed.has(name) ? ' failed' : '');
      const text = document.createElement('span');
      text.textContent = label;
      if (failed.has(name)) {
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = 'In use by another app – pick another combination';
        text.appendChild(err);
      }
      const input = document.createElement('input');
      input.readOnly = true;
      input.value = recording === name ? 'Press keys…' : display(settings.shortcuts[name]);
      input.addEventListener('focus', () => {
        recording = name;
        input.value = 'Press keys…';
      });
      input.addEventListener('blur', () => {
        recording = null;
        input.value = display(settings.shortcuts[name]);
      });
      input.addEventListener('keydown', (e) => {
        e.preventDefault();
        if (e.key === 'Escape') return input.blur();
        if (e.key === 'Backspace' || e.key === 'Delete') {
          recording = null;
          return save({ shortcuts: { ...settings.shortcuts, [name]: '' } });
        }
        const key = keyName(e);
        if (!key) return; // only modifiers so far
        const mods = [];
        if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (!mods.length && !/^F\d+$/.test(key)) {
          input.value = 'Add Ctrl, Alt or Shift';
          return;
        }
        recording = null;
        save({ shortcuts: { ...settings.shortcuts, [name]: [...mods, key].join('+') } });
      });
      row.append(text, input);
      root.appendChild(row);
    }
  }

  // ---------- state ----------

  let devicesListed = false;
  function render() {
    for (const id of CHECKBOXES) $(id).checked = settings[id];
    for (const id of SELECTS) if (id !== 'micDeviceId' && id !== 'cameraDeviceId') $(id).value = String(settings[id]);
    for (const [id, fmt] of Object.entries(RANGES)) {
      $(id).value = settings[id];
      const out = document.querySelector(`output[for="${id}"]`);
      if (out && fmt) out.textContent = fmt(settings[id]);
    }
    $('cursorHighlightColor').value = settings.cursorHighlightColor;
    $('screenshotDir').textContent = settings.screenshotDir || 'Pictures/Inkora';
    $('screenshotDir').title = settings.screenshotDir || '';
    settings.palette.forEach((c, i) => (paletteInputs[i].value = c));
    if (!devicesListed) {
      devicesListed = true;
      listDevices();
    } else {
      $('micDeviceId').value = settings.micDeviceId;
      $('cameraDeviceId').value = settings.cameraDeviceId;
    }
    if (!recording) renderShortcuts();
  }

  api.invoke('settings:labels').then((l) => {
    labels = l;
    if (settings) renderShortcuts();
  });

  api.onState((state) => {
    settings = state.settings;
    render();
  });
})();
