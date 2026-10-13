'use strict';

(() => {
  const api = window.annotator;
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let labels = {};
  let failed = new Set();
  let recording = null; // shortcut name being recorded

  const UNITS = { laserSeconds: (v) => `${v}s`, fadeSeconds: (v) => `${v}s`, spotlightRadius: (v) => `${v}px`, magnifierZoom: (v) => `${v}×` };

  async function save(patch) {
    const result = await api.invoke('settings:update', patch);
    failed = new Set((result && result.failed) || []);
    renderShortcuts();
  }

  // ---------- simple fields ----------

  for (const id of ['startAtLogin', 'allDisplays', 'restoreLast']) {
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }
  for (const id of ['toolbarOpacity', 'laserSeconds', 'fadeSeconds', 'spotlightRadius', 'magnifierZoom']) {
    const input = $(id);
    input.addEventListener('input', () => {
      const out = document.querySelector(`output[for="${id}"]`);
      if (out) out.textContent = UNITS[id](Number(input.value));
    });
    input.addEventListener('change', () => save({ [id]: Number(input.value) }));
  }
  $('cursorHighlightColor').addEventListener('change', (e) => save({ cursorHighlightColor: e.target.value }));

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

  function render() {
    for (const id of ['startAtLogin', 'allDisplays', 'restoreLast']) $(id).checked = settings[id];
    for (const id of ['toolbarOpacity', 'laserSeconds', 'fadeSeconds', 'spotlightRadius', 'magnifierZoom']) {
      $(id).value = settings[id];
      const out = document.querySelector(`output[for="${id}"]`);
      if (out) out.textContent = UNITS[id](settings[id]);
    }
    $('cursorHighlightColor').value = settings.cursorHighlightColor;
    $('screenshotDir').textContent = settings.screenshotDir || 'Pictures/Screen Annotator';
    $('screenshotDir').title = settings.screenshotDir || '';
    settings.palette.forEach((c, i) => (paletteInputs[i].value = c));
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
