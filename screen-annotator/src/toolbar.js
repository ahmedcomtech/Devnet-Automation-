'use strict';

(() => {
  const api = window.annotator;
  const C = window.ANNOTATOR_CONFIG;

  const ICONS = {
    cursor: '<path d="M5 3l14 8-6 2-2 6z"/>',
    draw: '<path d="M3 17c3-6 5-6 7-2s4 4 7-2 3-3 4-1"/>',
    pen: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>',
    highlighter: '<path d="M9 11l-5 5v4h4l5-5"/><path d="M9 11l6-6 4 4-6 6z"/>',
    eraser: '<path d="M7 21h12"/><path d="M5 15l9-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-8 8H9z"/><path d="M9 11l5 5"/>',
    laser: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
    text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    clear: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    board: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 21l4-5 4 5"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    collapse: '<path d="M6 15l6-6 6 6"/>',
    expand: '<path d="M6 9l6 6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };

  const TOOLS = [
    ['pen', 'Pen (P)'],
    ['highlighter', 'Highlighter (H)'],
    ['eraser', 'Eraser (E)'],
    ['laser', 'Laser pointer (K)'],
    ['line', 'Line (L) - Shift snaps to 45°'],
    ['arrow', 'Arrow (A) - Shift snaps to 45°'],
    ['rect', 'Rectangle (R) - Shift for square'],
    ['ellipse', 'Ellipse (O) - Shift for circle'],
    ['text', 'Text (T) - Enter to finish, Shift+Enter for new line'],
  ];

  const bar = document.getElementById('bar');
  let state = null;

  function svg(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  }

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
    return state ? ` (${state.shortcuts[name].replace('CommandOrControl', 'Ctrl')})` : '';
  }

  // ---------- build ----------

  const modes = document.getElementById('modes');
  const cursorBtn = button(modes, 'cursor', 'Mouse mode - click through to apps', () => api.update({ mode: 'cursor' }));
  const drawBtn = button(modes, 'draw', 'Draw mode', () => api.update({ mode: 'draw' }));

  const toolsEl = document.getElementById('tools');
  const toolBtns = {};
  for (const [tool, title] of TOOLS) {
    toolBtns[tool] = button(toolsEl, tool, title, () => api.update({ tool, mode: 'draw' }));
  }

  const colorsEl = document.getElementById('colors');
  const swatches = C.palette.map((color, i) => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = color;
    s.title = `Color ${i + 1}`;
    s.addEventListener('click', () => api.update({ color }));
    colorsEl.appendChild(s);
    return s;
  });
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Custom color';
  const picker = document.createElement('input');
  picker.type = 'color';
  // 'change' fires when the picker closes, so refocusing the overlay does not dismiss it.
  picker.addEventListener('change', () => api.update({ color: picker.value }));
  custom.appendChild(picker);
  colorsEl.appendChild(custom);

  const sizesEl = document.getElementById('sizes');
  const sizeBtns = C.sizes.map((size) => {
    const b = document.createElement('button');
    const dot = document.createElement('span');
    const d = Math.min(16, size + 2);
    dot.className = 'dot';
    dot.style.width = dot.style.height = d + 'px';
    b.appendChild(dot);
    b.title = `Size ${size} ([ and ] to fine-tune)`;
    b.addEventListener('click', () => api.update({ size }));
    sizesEl.appendChild(b);
    return b;
  });

  const actions = document.getElementById('actions');
  button(actions, 'undo', 'Undo (Ctrl+Z)', () => api.command('undo'));
  button(actions, 'redo', 'Redo (Ctrl+Y)', () => api.command('redo'));
  const clearBtn = button(actions, 'clear', 'Clear all (Delete)', () => api.command('clear'), 'danger');
  const boardBtn = button(actions, 'board', '', () => {
    const next = C.boards[(C.boards.indexOf(state.board) + 1) % C.boards.length];
    api.update({ board: next, mode: next === 'none' ? state.mode : 'draw' });
  });
  const eyeBtn = button(actions, 'eye', '', () => api.update({ annotationsVisible: !state.annotationsVisible }));
  const cameraBtn = button(actions, 'camera', '', () => api.command('screenshot'));

  const footer = document.getElementById('footer');
  const collapseBtn = button(footer, 'collapse', 'Collapse toolbar', () => {
    bar.classList.toggle('collapsed');
    const collapsed = bar.classList.contains('collapsed');
    collapseBtn.innerHTML = svg(collapsed ? 'expand' : 'collapse');
    collapseBtn.title = collapsed ? 'Expand toolbar' : 'Collapse toolbar';
    reportSize();
  });
  const quitBtn = button(footer, 'close', '', () => api.command('quit'), 'danger');

  // ---------- sync with main process ----------

  function reportSize() {
    requestAnimationFrame(() => {
      const r = bar.getBoundingClientRect();
      api.command('toolbar:resize', { width: r.width, height: r.height });
    });
  }

  function sync() {
    const drawing = state.mode === 'draw';
    document.body.classList.toggle('cursor-mode', !drawing);
    cursorBtn.classList.toggle('active', !drawing);
    drawBtn.classList.toggle('active', drawing);
    drawBtn.title = `Draw mode${shortcut('toggleMode')}`;
    cursorBtn.title = `Mouse mode - click through to apps${shortcut('toggleMode')}`;
    for (const [tool, b] of Object.entries(toolBtns)) b.classList.toggle('active', tool === state.tool);

    const color = state.color.toLowerCase();
    swatches.forEach((s, i) => s.classList.toggle('active', C.palette[i] === color));
    const isCustom = !C.palette.includes(color);
    custom.classList.toggle('active', isCustom);
    custom.style.background = isCustom ? color : '';
    picker.value = color;

    sizeBtns.forEach((b, i) => b.classList.toggle('active', C.sizes[i] === state.size));

    const nextBoard = C.boards[(C.boards.indexOf(state.board) + 1) % C.boards.length];
    boardBtn.classList.toggle('active', state.board !== 'none');
    boardBtn.title = `${C.boardNames[state.board]} - click for ${C.boardNames[nextBoard]} (B)`;

    eyeBtn.innerHTML = svg(state.annotationsVisible ? 'eye' : 'eyeOff');
    eyeBtn.classList.toggle('active', !state.annotationsVisible);
    eyeBtn.title = (state.annotationsVisible ? 'Hide annotations' : 'Show annotations') + shortcut('toggleVisible');

    clearBtn.title = `Clear all (Delete)${shortcut('clear')}`;
    cameraBtn.title = `Save screenshot to Pictures${shortcut('screenshot')}`;
    quitBtn.title = `Quit${shortcut('quit')}`;
  }

  api.onState((next) => {
    state = next;
    sync();
  });

  reportSize();
})();
