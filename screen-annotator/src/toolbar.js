'use strict';

(() => {
  const api = window.annotator;
  const C = window.ANNOTATOR_CONFIG;
  const svg = window.svgIcon;

  const TOOLS = [
    ['select', 'Select & move (V) – drag to box-select, Shift adds, Del deletes'],
    ['pen', 'Pen (P) – pressure sensitive with a pen tablet'],
    ['highlighter', 'Highlighter (H)'],
    ['eraser', 'Eraser (E)'],
    ['laser', 'Laser pointer (K)'],
    ['spotlight', 'Spotlight (G) – scroll to resize'],
    ['magnifier', 'Magnifier (Z) – scroll to zoom, click to refresh'],
    ['line', 'Line (L) – Shift snaps to 45°'],
    ['arrow', 'Arrow (A) – Shift snaps to 45°'],
    ['rect', 'Rectangle (R) – Shift for square'],
    ['ellipse', 'Ellipse (O) – Shift for circle'],
    ['text', 'Text (T) – Enter to finish, Shift+Enter for new line'],
    ['badge', 'Numbered step badge (N)'],
  ];

  const TOGGLES = [
    ['fill', 'fill', 'Fill shapes (F)'],
    ['dash', 'dash', 'Dashed lines (D)'],
    ['fadeInk', 'fade', 'Fading ink (I) – strokes disappear after a few seconds'],
    ['cursorHighlight', 'cursorHighlight', 'Highlight cursor (C)'],
  ];

  const bar = document.getElementById('bar');
  let state = null;
  let paletteKey = '';

  function button(parent, icon, title, onClick, className = '') {
    const b = document.createElement('button');
    b.className = className;
    b.title = title;
    b.innerHTML = svg(icon);
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  function shortcut(name) {
    const accel = state && state.settings.shortcuts[name];
    return accel ? ` (${accel.replace('CommandOrControl', 'Ctrl')})` : '';
  }

  // ---------- build ----------

  const modes = document.getElementById('modes');
  const cursorBtn = button(modes, 'cursor', '', () => api.update({ mode: 'cursor' }));
  const drawBtn = button(modes, 'draw', '', () => api.update({ mode: 'draw' }));
  button(modes, 'menu', 'More: boards, pages, export, sessions, settings…', () => api.command('menu'));

  const toolsEl = document.getElementById('tools');
  const toolBtns = {};
  for (const [tool, title] of TOOLS) {
    toolBtns[tool] = button(toolsEl, tool, title, () => api.update({ tool, mode: 'draw' }));
  }

  const togglesEl = document.getElementById('toggles');
  const toggleBtns = {};
  for (const [key, icon, title] of TOGGLES) {
    toggleBtns[key] = button(togglesEl, icon, title, () => api.update({ [key]: !state[key] }));
  }

  const colorsEl = document.getElementById('colors');
  let swatches = [];
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Custom color';
  const picker = document.createElement('input');
  picker.type = 'color';
  // 'change' fires when the picker closes, so refocusing the overlay does not dismiss it.
  picker.addEventListener('change', () => api.update({ color: picker.value }));
  custom.appendChild(picker);

  function buildSwatches(palette) {
    colorsEl.textContent = '';
    swatches = palette.map((color, i) => {
      const s = document.createElement('div');
      s.className = 'swatch';
      s.style.background = color;
      s.title = `Color ${i + 1} (${i + 1})`;
      s.addEventListener('click', () => api.update({ color }));
      colorsEl.appendChild(s);
      return s;
    });
    colorsEl.appendChild(custom);
  }

  const sizesEl = document.getElementById('sizes');
  const sizeBtns = C.sizes.map((size) => {
    const b = document.createElement('button');
    const dot = document.createElement('span');
    const d = Math.min(16, size + 2);
    dot.className = 'dot';
    dot.style.width = dot.style.height = d + 'px';
    b.appendChild(dot);
    b.title = `Size ${size} ([ ] or mouse wheel to fine-tune)`;
    b.addEventListener('click', () => api.update({ size }));
    sizesEl.appendChild(b);
    return b;
  });

  const actions = document.getElementById('actions');
  button(actions, 'undo', 'Undo (Ctrl+Z)', () => api.command('undo'));
  button(actions, 'redo', 'Redo (Ctrl+Y)', () => api.command('redo'));
  const clearBtn = button(actions, 'clear', '', () => api.command('clear'), 'danger');
  const boardBtn = button(actions, 'board', '', () => {
    const next = C.boards[(C.boards.indexOf(state.board) + 1) % C.boards.length];
    api.update({ board: next, mode: next === 'none' ? state.mode : 'draw' });
  });
  const eyeBtn = button(actions, 'eye', '', () => api.update({ annotationsVisible: !state.annotationsVisible }));
  const cameraBtn = button(actions, 'camera', '', () => api.command('screenshot'));

  const pagePrev = document.getElementById('page-prev');
  const pageNext = document.getElementById('page-next');
  const pageLabel = document.getElementById('page-label');
  pagePrev.innerHTML = svg('left');
  pagePrev.addEventListener('click', () => api.command('page-prev'));
  pageNext.addEventListener('click', () => api.command('page-next'));

  const footer = document.getElementById('footer');
  const collapseBtn = button(footer, 'collapse', 'Collapse toolbar', () => {
    bar.classList.toggle('collapsed');
    const collapsed = bar.classList.contains('collapsed');
    collapseBtn.innerHTML = svg(collapsed ? 'expand' : 'collapse');
    collapseBtn.title = collapsed ? 'Expand toolbar' : 'Collapse toolbar';
    reportSize();
  });
  button(footer, 'settings', 'Settings', () => api.command('settings'));
  const quitBtn = button(footer, 'close', '', () => api.command('quit'), 'danger');

  // ---------- sync with main process ----------

  let lastHeight = 0;
  function reportSize() {
    requestAnimationFrame(() => {
      const r = bar.getBoundingClientRect();
      if (Math.round(r.height) === lastHeight) return;
      lastHeight = Math.round(r.height);
      api.command('toolbar:resize', { width: r.width, height: r.height });
    });
  }

  function sync() {
    const s = state.settings;
    const drawing = state.mode === 'draw';
    const onBoard = state.board !== 'none';
    document.body.classList.toggle('cursor-mode', !drawing);
    document.body.classList.toggle('on-board', onBoard);
    bar.style.setProperty('--panel-alpha', s.toolbarOpacity);

    cursorBtn.classList.toggle('active', !drawing);
    drawBtn.classList.toggle('active', drawing);
    cursorBtn.title = `Mouse mode – click through to your apps (Esc)${shortcut('toggleMode')}`;
    drawBtn.title = `Draw mode${shortcut('toggleMode')}`;
    for (const [tool, b] of Object.entries(toolBtns)) b.classList.toggle('active', tool === state.tool);
    for (const [key, b] of Object.entries(toggleBtns)) b.classList.toggle('active', !!state[key]);

    const key = s.palette.join();
    if (key !== paletteKey) {
      paletteKey = key;
      buildSwatches(s.palette);
    }
    const color = state.color.toLowerCase();
    swatches.forEach((el, i) => el.classList.toggle('active', s.palette[i] === color));
    const isCustom = !s.palette.includes(color);
    custom.classList.toggle('active', isCustom);
    custom.style.background = isCustom ? color : '';
    picker.value = color;

    sizeBtns.forEach((b, i) => b.classList.toggle('active', C.sizes[i] === state.size));

    const nextBoard = C.boards[(C.boards.indexOf(state.board) + 1) % C.boards.length];
    boardBtn.classList.toggle('active', onBoard);
    boardBtn.title = `${C.boardNames[state.board]} – click for ${C.boardNames[nextBoard]} (B)`;
    pageLabel.textContent = `${state.page + 1} / ${state.pageCount}`;
    pagePrev.disabled = state.page === 0;
    const atEnd = state.page === state.pageCount - 1;
    pageNext.innerHTML = svg(atEnd ? 'plus' : 'right');
    pageNext.title = atEnd ? 'New page (Page Down)' : 'Next page (Page Down)';

    eyeBtn.innerHTML = svg(state.annotationsVisible ? 'eye' : 'eyeOff');
    eyeBtn.classList.toggle('active', !state.annotationsVisible);
    eyeBtn.title = (state.annotationsVisible ? 'Hide annotations' : 'Show annotations') + shortcut('toggleVisible');

    clearBtn.title = `Clear all (Delete)${shortcut('clear')}`;
    cameraBtn.title = `Save screenshot${shortcut('screenshot')} – more export options in the ⋯ menu`;
    quitBtn.title = `Quit${shortcut('quit')}`;
    reportSize();
  }

  api.onState((next) => {
    state = next;
    sync();
  });

  reportSize();
})();
