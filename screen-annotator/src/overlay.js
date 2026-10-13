'use strict';

(() => {
  const api = window.annotator;
  const C = window.ANNOTATOR_CONFIG;
  const G = window.Geometry;
  const R = window.Render;

  const base = document.getElementById('base'); // committed annotations (+ board background)
  const live = document.getElementById('live'); // in-progress shape, selection, eraser, laser, spotlight, magnifier
  const fx = document.getElementById('fx'); // cursor highlight
  const bctx = base.getContext('2d');
  const lctx = live.getContext('2d');
  const fctx = fx.getContext('2d');
  const textInput = document.getElementById('text-input');
  const pagePill = document.getElementById('page-pill');
  const hintEl = document.getElementById('hint');

  const MAX_HISTORY = 200;
  const SELECT_COLOR = '#8ab4f8';
  const FADING_TYPES = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'];

  let state = {
    mode: 'cursor',
    tool: 'pen',
    color: '#ff3b30',
    size: 4,
    board: 'none',
    boardPattern: 'plain',
    fill: false,
    dash: false,
    fadeInk: false,
    cursorHighlight: false,
    annotationsVisible: true,
    page: 0,
    pageCount: 1,
    settings: {
      palette: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#111111'],
      laserSeconds: 0.8,
      fadeSeconds: 3,
      spotlightRadius: 150,
      magnifierZoom: 2,
      cursorHighlightColor: '#ffd60a',
    },
  };

  // The screen and the board pages keep separate drawings, so switching to a whiteboard
  // and back does not lose what was drawn over the slides.
  let screenLayer = newLayer();
  let pages = [newLayer()];

  let current = null; // shape being drawn
  let erasing = null; // { removed: Set } while the eraser is held down
  let drag = null; // select tool: { kind: 'move', start, dx, dy, moving } or { kind: 'marquee', x1, y1, x2, y2, base }
  let selection = []; // selected shapes (select tool)
  let pointer = null; // last pointer position over this overlay (draw mode)
  let cursorPos = null; // cursor position reported by the main process (any mode)
  let text = null; // open text box
  let laser = []; // [{x, y, t}]
  let fading = []; // fading-ink shapes: [{ shape, born }]
  let rafId = 0;
  let spotlightRadius = null; // wheel overrides of the settings values
  let magnifierZoom = null;
  let snapshot = null; // screen image for the magnifier
  let capturing = false;
  let hintTimer = 0;

  const W = () => innerWidth;
  const H = () => innerHeight;

  function newLayer(shapes = []) {
    return { history: [shapes], index: 0 };
  }
  function currentShapes(l) {
    return l.history[l.index];
  }
  function layer() {
    if (state.board === 'none') return screenLayer;
    while (pages.length < state.pageCount) pages.push(newLayer());
    return pages[Math.min(state.page, pages.length - 1)];
  }
  function shapes() {
    return currentShapes(layer());
  }

  function hint(message) {
    hintEl.textContent = message;
    hintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), 1200);
  }

  // ---------- history ----------

  function commit(next, nextSelection = []) {
    const l = layer();
    l.history = l.history.slice(0, l.index + 1);
    l.history.push(next);
    if (l.history.length > MAX_HISTORY) l.history.shift();
    l.index = l.history.length - 1;
    selection = nextSelection;
    renderBase();
    renderLive();
  }

  function undo() {
    finishInteraction();
    const l = layer();
    if (l.index > 0) l.index--;
    selection = [];
    renderBase();
    renderLive();
  }

  function redo() {
    const l = layer();
    if (l.index < l.history.length - 1) l.index++;
    selection = [];
    renderBase();
    renderLive();
  }

  function clear() {
    finishInteraction();
    fading = [];
    if (shapes().length) commit([]);
    else renderLive();
  }

  function addShape(s) {
    if (state.fadeInk && FADING_TYPES.includes(s.type)) {
      fading.push({ shape: s, born: performance.now() });
      animate();
    } else {
      commit([...shapes(), s]);
    }
  }

  // ---------- selection ----------

  function selectionBox() {
    return selection.length ? G.unionBox(selection.map(G.bbox)) : null;
  }

  function topShapeAt(p) {
    const list = shapes();
    for (let i = list.length - 1; i >= 0; i--) if (G.hitShape(list[i], p, 6)) return list[i];
    return null;
  }

  function replaceSelected(fn) {
    if (!selection.length) return;
    const changed = new Map(selection.map((s) => [s, fn(s)]));
    commit(
      shapes().map((s) => changed.get(s) || s),
      [...changed.values()],
    );
  }

  function moveSelection(dx, dy) {
    replaceSelected((s) => G.translate(s, dx, dy));
  }

  function deleteSelection() {
    const doomed = new Set(selection);
    commit(shapes().filter((s) => !doomed.has(s)));
  }

  function duplicateSelection() {
    if (!selection.length) return;
    const copies = selection.map((s) => G.translate(s, 20, 20));
    commit([...shapes(), ...copies], copies);
  }

  function selectAll() {
    selection = [...shapes()];
    if (state.tool !== 'select' || state.mode !== 'draw') api.update({ tool: 'select', mode: 'draw' });
    renderLive();
  }

  function startSelect(p, additive) {
    const box = selectionBox();
    const target = topShapeAt(p);
    if (box && G.inside(p, box, 4) && (!target || selection.includes(target))) {
      beginMove(p);
    } else if (target) {
      if (additive && selection.includes(target)) {
        selection = selection.filter((s) => s !== target);
        return;
      }
      selection = additive ? [...selection, target] : [target];
      beginMove(p);
    } else {
      drag = { kind: 'marquee', x1: p.x, y1: p.y, x2: p.x, y2: p.y, base: additive ? selection : [] };
      selection = [...drag.base];
    }
  }

  function beginMove(p) {
    drag = { kind: 'move', start: p, dx: 0, dy: 0, moving: new Set(selection) };
    renderBase();
  }

  // ---------- rendering ----------

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [base, live, fx]) {
      canvas.width = Math.round(W() * dpr);
      canvas.height = Math.round(H() * dpr);
      canvas.style.width = W() + 'px';
      canvas.style.height = H() + 'px';
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    renderBase();
    renderLive();
    renderFx();
  }

  // Shapes temporarily drawn elsewhere (being erased or moved) are left out of the base layer.
  function hiddenShapes() {
    if (erasing) return erasing.removed;
    if (drag && drag.kind === 'move') return drag.moving;
    return null;
  }

  function renderBase() {
    bctx.clearRect(0, 0, W(), H());
    if (state.board !== 'none') R.drawBoard(bctx, W(), H(), C.boardColors[state.board], state.boardPattern);
    const hidden = hiddenShapes();
    for (const s of shapes()) {
      if (!hidden || !hidden.has(s)) R.drawShape(bctx, s, renderBase);
    }
  }

  function eraserRadius() {
    return Math.max(6, state.size * 2.5);
  }
  function spotRadius() {
    return spotlightRadius ?? state.settings.spotlightRadius;
  }
  function zoomLevel() {
    return magnifierZoom ?? state.settings.magnifierZoom;
  }

  function drawSpotlight() {
    const p = pointer || cursorPos;
    const r = spotRadius();
    lctx.save();
    lctx.fillStyle = 'rgba(0,0,0,0.72)';
    lctx.fillRect(0, 0, W(), H());
    if (p) {
      lctx.globalCompositeOperation = 'destination-out';
      const g = lctx.createRadialGradient(p.x, p.y, r * 0.82, p.x, p.y, r);
      g.addColorStop(0, '#000');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      lctx.fill();
    }
    lctx.restore();
  }

  function drawMagnifier() {
    const p = pointer;
    if (!p) return;
    const r = 120;
    const zoom = zoomLevel();
    lctx.save();
    lctx.beginPath();
    lctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    lctx.fillStyle = 'rgba(32,33,36,0.92)';
    lctx.fill();
    if (snapshot) {
      lctx.clip();
      const scale = snapshot.naturalWidth / W();
      const half = r / zoom;
      lctx.imageSmoothingQuality = 'high';
      lctx.drawImage(snapshot, (p.x - half) * scale, (p.y - half) * scale, 2 * half * scale, 2 * half * scale, p.x - r, p.y - r, 2 * r, 2 * r);
    } else {
      lctx.fillStyle = '#e8eaed';
      lctx.font = R.font(14);
      lctx.textAlign = 'center';
      lctx.fillText('Capturing…', p.x, p.y);
    }
    lctx.restore();
    lctx.save();
    lctx.lineWidth = 4;
    lctx.strokeStyle = 'rgba(255,255,255,0.95)';
    lctx.beginPath();
    lctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    lctx.stroke();
    lctx.lineWidth = 1.5;
    lctx.strokeStyle = 'rgba(0,0,0,0.5)';
    lctx.beginPath();
    lctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
    lctx.stroke();
    lctx.restore();
  }

  function drawLaser(now) {
    const life = state.settings.laserSeconds * 1000;
    laser = laser.filter((p) => now - p.t < life);
    const width = Math.max(3, state.size * 1.5);
    lctx.save();
    lctx.lineCap = 'round';
    lctx.strokeStyle = state.color;
    lctx.fillStyle = state.color;
    lctx.shadowColor = state.color;
    lctx.shadowBlur = 14;
    for (let i = 1; i < laser.length; i++) {
      const a = laser[i - 1];
      const b = laser[i];
      const left = 1 - (now - b.t) / life;
      lctx.globalAlpha = left;
      lctx.lineWidth = width * (0.3 + 0.7 * left);
      lctx.beginPath();
      lctx.moveTo(a.x, a.y);
      lctx.lineTo(b.x, b.y);
      lctx.stroke();
    }
    if (pointer && state.tool === 'laser') {
      lctx.globalAlpha = 1;
      lctx.beginPath();
      lctx.arc(pointer.x, pointer.y, width, 0, Math.PI * 2);
      lctx.fill();
      lctx.shadowBlur = 0;
      lctx.fillStyle = 'rgba(255,255,255,0.85)';
      lctx.beginPath();
      lctx.arc(pointer.x, pointer.y, width * 0.4, 0, Math.PI * 2);
      lctx.fill();
    }
    lctx.restore();
  }

  function drawFading(now) {
    const total = state.settings.fadeSeconds * 1000;
    fading = fading.filter((f) => now - f.born < total);
    for (const f of fading) {
      lctx.save();
      lctx.globalAlpha = Math.min(1, (total - (now - f.born)) / (total * 0.4));
      R.drawShape(lctx, f.shape);
      lctx.restore();
    }
  }

  function drawSelection() {
    let box = selectionBox();
    if (!box) return;
    if (drag && drag.kind === 'move') {
      for (const s of selection) R.drawShape(lctx, G.translate(s, drag.dx, drag.dy), renderLive);
      box = { ...box, x: box.x + drag.dx, y: box.y + drag.dy };
    }
    lctx.save();
    lctx.strokeStyle = SELECT_COLOR;
    lctx.lineWidth = 1.5;
    lctx.setLineDash([6, 4]);
    lctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    lctx.restore();
  }

  function drawMarquee() {
    const b = G.dragBox(drag);
    lctx.save();
    lctx.fillStyle = 'rgba(138,180,248,0.15)';
    lctx.strokeStyle = SELECT_COLOR;
    lctx.lineWidth = 1;
    lctx.fillRect(b.x, b.y, b.w, b.h);
    lctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    lctx.restore();
  }

  function drawEraserCursor() {
    const r = eraserRadius();
    lctx.save();
    lctx.lineWidth = 3;
    lctx.strokeStyle = 'rgba(0,0,0,0.6)';
    lctx.beginPath();
    lctx.arc(pointer.x, pointer.y, r, 0, Math.PI * 2);
    lctx.stroke();
    lctx.lineWidth = 1.5;
    lctx.strokeStyle = '#ffffff';
    lctx.stroke();
    lctx.restore();
  }

  function renderLive() {
    const now = performance.now();
    lctx.clearRect(0, 0, W(), H());
    const drawing = state.mode === 'draw';
    if (drawing && state.tool === 'spotlight') drawSpotlight();
    drawFading(now); // fading ink keeps fading after switching to the mouse
    if (!drawing) return;
    if (current) R.drawShape(lctx, current);
    if (state.tool === 'select') drawSelection();
    if (drag && drag.kind === 'marquee') drawMarquee();
    if (pointer && (state.tool === 'eraser' || erasing)) drawEraserCursor();
    if (laser.length || state.tool === 'laser') drawLaser(now);
    if (state.tool === 'magnifier') drawMagnifier();
  }

  function renderFx() {
    fctx.clearRect(0, 0, W(), H());
    if (!state.cursorHighlight || !cursorPos || state.tool === 'magnifier') return;
    const color = state.settings.cursorHighlightColor;
    fctx.save();
    fctx.fillStyle = color;
    fctx.strokeStyle = color;
    fctx.globalAlpha = 0.3;
    fctx.beginPath();
    fctx.arc(cursorPos.x, cursorPos.y, 26, 0, Math.PI * 2);
    fctx.fill();
    fctx.globalAlpha = 0.85;
    fctx.lineWidth = 2;
    fctx.stroke();
    fctx.restore();
  }

  function animate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderLive();
      if (laser.length || fading.length) animate();
    });
  }

  // ---------- magnifier ----------

  async function captureSnapshot() {
    if (capturing) return;
    capturing = true;
    document.body.classList.add('capturing');
    // Let the compositor drop the lens and cursor layers before the screen is grabbed.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))));
    try {
      const url = await api.invoke('capture-display');
      if (url) {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (state.tool === 'magnifier') snapshot = img;
      }
    } catch {
      // Leave the lens showing "Capturing…"; the next click retries.
    }
    document.body.classList.remove('capturing');
    capturing = false;
    renderLive();
  }

  // ---------- text ----------

  function textFontSize() {
    return Math.round(14 + state.size * 3);
  }

  function measureText(value, fontSize) {
    const lines = value.split('\n');
    bctx.save();
    bctx.font = R.font(fontSize);
    const w = Math.max(...lines.map((l) => bctx.measureText(l).width));
    bctx.restore();
    return { w, h: lines.length * fontSize * 1.25 };
  }

  function makeText(x, y, value, color, fontSize) {
    return { type: 'text', x, y, color, fontSize, size: 0, text: value, ...measureText(value, fontSize) };
  }

  function autosizeText() {
    const { w, h } = measureText(textInput.value, text.fontSize);
    textInput.style.width = Math.ceil(w + text.fontSize) + 'px';
    textInput.style.height = Math.ceil(h) + 'px';
  }

  function openText(p) {
    text = { x: p.x, y: p.y, color: state.color, fontSize: textFontSize() };
    Object.assign(textInput.style, {
      display: 'block',
      left: p.x + 'px',
      top: p.y + 'px',
      color: text.color,
      fontSize: text.fontSize + 'px',
      lineHeight: text.fontSize * 1.25 + 'px',
    });
    textInput.value = '';
    autosizeText();
    textInput.focus();
  }

  function closeText() {
    text = null;
    // Blur explicitly: a hidden but still focused textarea would swallow the keyboard shortcuts.
    textInput.blur();
    textInput.style.display = 'none';
    textInput.value = '';
  }

  function commitText() {
    if (!text) return;
    const t = text;
    const value = textInput.value.replace(/\s+$/, '');
    closeText();
    if (value.trim()) commit([...shapes(), makeText(t.x, t.y, value, t.color, t.fontSize)]);
  }

  textInput.addEventListener('input', autosizeText);
  textInput.addEventListener('blur', commitText);
  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeText();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  });

  // ---------- paste ----------

  async function paste() {
    const data = await api.invoke('clipboard-read').catch(() => null);
    if (!data) return;
    const at = pointer || cursorPos || { x: W() / 2, y: H() / 2 };
    let shape;
    if (data.image) {
      const img = new Image();
      img.src = data.image;
      await img.decode();
      const dpr = window.devicePixelRatio || 1;
      let w = img.naturalWidth / dpr;
      let h = img.naturalHeight / dpr;
      const scale = Math.min(1, (W() * 0.6) / w, (H() * 0.6) / h);
      w *= scale;
      h *= scale;
      shape = { type: 'image', color: state.color, size: 0, src: data.image, x: at.x - w / 2, y: at.y - h / 2, w, h };
    } else if (data.text) {
      shape = makeText(at.x, at.y, data.text.replace(/\r\n/g, '\n'), state.color, textFontSize());
    } else {
      return;
    }
    commit([...shapes(), shape], [shape]);
    api.update({ tool: 'select', mode: 'draw' });
  }

  // ---------- pointer input ----------

  function pt(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function samples(e) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    return list.length ? list : [e];
  }

  function addPoint(points, e, pressure) {
    const p = pt(e);
    const last = points[points.length - 1];
    if (G.dist(last, p) < 1.5) return;
    if (pressure) p.p = Math.round(e.pressure * 100) / 100;
    points.push(p);
  }

  function eraseAt(p) {
    const r = eraserRadius();
    let changed = false;
    for (const s of shapes()) {
      if (!erasing.removed.has(s) && G.hitShape(s, p, r)) {
        erasing.removed.add(s);
        changed = true;
      }
    }
    if (changed) renderBase();
  }

  function placeBadge(p) {
    const n = shapes().reduce((max, s) => (s.type === 'badge' ? Math.max(max, s.n) : max), 0) + 1;
    commit([...shapes(), { type: 'badge', color: state.color, size: state.size, x: p.x, y: p.y, n }]);
  }

  // Ends whatever the pointer was doing: commits a stroke, an erase, or a move.
  function finishInteraction() {
    if (current) {
      const s = current;
      current = null;
      const meaningful = s.points || Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 3;
      if (meaningful) addShape(s);
    }
    if (erasing) {
      const removed = erasing.removed;
      erasing = null;
      if (removed.size) commit(shapes().filter((s) => !removed.has(s)));
      else renderBase();
    }
    if (drag) {
      const d = drag;
      drag = null;
      if (d.kind === 'move' && (d.dx || d.dy)) moveSelection(d.dx, d.dy);
      else renderBase();
    }
    renderLive();
  }

  // Keep focus where it is (e.g. in the text box) when clicking the canvas.
  live.addEventListener('mousedown', (e) => e.preventDefault());

  live.addEventListener('pointerdown', (e) => {
    // Button 5 is the eraser end of a pen tablet stylus.
    if (state.mode !== 'draw' || (e.button !== 0 && e.button !== 5)) return;
    api.setActive();
    if (text) {
      commitText(); // a click outside an open text box just finishes it
      return;
    }
    const p = pt(e);
    const tool = e.button === 5 ? 'eraser' : state.tool;
    pointer = p;
    live.setPointerCapture(e.pointerId);
    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const pressure = tool === 'pen' && e.pointerType === 'pen';
        current = { type: tool, color: state.color, size: tool === 'highlighter' ? state.size * 4 : state.size, points: [p] };
        if (pressure) {
          current.pressure = true;
          p.p = Math.round(e.pressure * 100) / 100;
        }
        break;
      }
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        current = { type: tool, color: state.color, size: state.size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        if (state.dash) current.dash = true;
        if (state.fill && (tool === 'rect' || tool === 'ellipse')) current.fill = true;
        break;
      case 'eraser':
        erasing = { removed: new Set() };
        eraseAt(p);
        break;
      case 'text':
        openText(p);
        break;
      case 'badge':
        placeBadge(p);
        break;
      case 'select':
        startSelect(p, e.shiftKey);
        break;
      case 'magnifier':
        captureSnapshot(); // refresh the image, e.g. after the content below changed
        break;
    }
    renderLive();
  });

  live.addEventListener('pointermove', (e) => {
    if (state.mode !== 'draw') return;
    pointer = pt(e);
    if (state.cursorHighlight) {
      cursorPos = pointer;
      renderFx();
    }
    if (current && current.points) {
      for (const ev of samples(e)) addPoint(current.points, ev, current.pressure);
    } else if (current) {
      const end = e.shiftKey ? G.constrain(current, pointer.x, pointer.y) : pointer;
      current.x2 = end.x;
      current.y2 = end.y;
    } else if (erasing) {
      for (const ev of samples(e)) eraseAt(pt(ev));
    } else if (drag && drag.kind === 'move') {
      let dx = pointer.x - drag.start.x;
      let dy = pointer.y - drag.start.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      drag.dx = dx;
      drag.dy = dy;
    } else if (drag && drag.kind === 'marquee') {
      drag.x2 = pointer.x;
      drag.y2 = pointer.y;
      const box = G.dragBox(drag);
      const picked = shapes().filter((s) => !drag.base.includes(s) && G.boxesIntersect(G.bbox(s), box));
      selection = [...drag.base, ...picked];
    } else if (state.tool === 'select') {
      const box = selectionBox();
      live.classList.toggle('over-shape', !!(topShapeAt(pointer) || (box && G.inside(pointer, box, 4))));
    }
    if (state.tool === 'laser') {
      const now = performance.now();
      for (const ev of samples(e)) laser.push({ ...pt(ev), t: now });
      animate();
    }
    if (state.tool === 'magnifier' && !snapshot) captureSnapshot();
    renderLive();
  });

  live.addEventListener('pointerup', finishInteraction);
  live.addEventListener('pointercancel', finishInteraction);
  live.addEventListener('pointerleave', () => {
    if (current || erasing || drag) return;
    pointer = null;
    renderLive();
  });

  live.addEventListener(
    'wheel',
    (e) => {
      if (state.mode !== 'draw') return;
      e.preventDefault();
      const up = e.deltaY < 0;
      if (state.tool === 'spotlight') {
        spotlightRadius = Math.round(Math.min(600, Math.max(40, spotRadius() * (up ? 1.1 : 0.9))));
        hint(`Spotlight ${spotlightRadius}px`);
      } else if (state.tool === 'magnifier') {
        magnifierZoom = Math.min(8, Math.max(1.5, zoomLevel() + (up ? 0.5 : -0.5)));
        hint(`Zoom ${magnifierZoom}×`);
      } else {
        const size = Math.min(40, Math.max(1, state.size + (up ? 1 : -1)));
        api.update({ size });
        hint(`Size ${size}`);
      }
      renderLive();
    },
    { passive: false },
  );

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') e.shiftKey ? redo() : undo();
      else if (k === 'y') redo();
      else if (k === 'v') paste();
      else if (k === 'a') selectAll();
      else if (k === 'd') duplicateSelection();
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (k.startsWith('arrow') && selection.length) {
      const step = e.shiftKey ? 10 : 1;
      const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
      moveSelection(d[0], d[1]);
    } else if (k === 'escape') {
      if (selection.length) {
        selection = [];
        renderLive();
      } else api.update({ mode: 'cursor' });
    } else if (k === 'delete' || k === 'backspace') {
      if (selection.length) deleteSelection();
      else clear();
    } else if (C.toolKeys[k]) api.update({ tool: C.toolKeys[k], mode: 'draw' });
    else if (C.toggleKeys[k]) {
      const key = C.toggleKeys[k];
      api.update({ [key]: !state[key] });
      hint(`${{ fill: 'Fill shapes', dash: 'Dashed lines', fadeInk: 'Fading ink', cursorHighlight: 'Cursor highlight' }[key]} ${state[key] ? 'off' : 'on'}`);
    } else if (/^[1-8]$/.test(k)) api.update({ color: state.settings.palette[Number(k) - 1] });
    else if (k === '[') api.update({ size: state.size - 1 });
    else if (k === ']') api.update({ size: state.size + 1 });
    else if (k === 'b') {
      const i = C.boards.indexOf(state.board);
      api.update({ board: C.boards[(i + 1) % C.boards.length] });
    } else if (k === 'pageup') api.command('page-prev');
    else if (k === 'pagedown') api.command('page-next');
    else return;
    e.preventDefault();
  });

  // ---------- main process wiring ----------

  function importSession(data) {
    finishInteraction();
    commitText();
    selection = [];
    fading = [];
    const clean = (list) => (Array.isArray(list) ? list.map(G.sanitizeShape).filter(Boolean) : []);
    screenLayer = newLayer(clean(data && data.screen));
    const list = data && Array.isArray(data.pages) && data.pages.length ? data.pages : [[]];
    pages = list.map((p) => newLayer(clean(p)));
    renderBase();
    renderLive();
  }

  api.onCommand((name, arg) => {
    if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'clear') clear();
    else if (name === 'import-session') importSession(arg);
  });

  api.onRequest((name) => {
    if (name === 'export-session') return { screen: currentShapes(screenLayer), pages: pages.map(currentShapes) };
    if (name === 'export-png') return shapes().length ? base.toDataURL('image/png') : null;
    return null;
  });

  api.onCursor((p) => {
    cursorPos = p;
    renderFx();
    if (state.mode === 'draw' && state.tool === 'spotlight' && !pointer) renderLive();
  });

  api.onState((next) => {
    const prev = state;
    const onBoard = (s) => s.board !== 'none';
    const layerChanged = onBoard(prev) !== onBoard(next) || (onBoard(next) && prev.page !== next.page);
    if (next.mode !== 'draw' || next.tool !== prev.tool || layerChanged) {
      finishInteraction();
      commitText();
    }
    const recolor = selection.length && next.tool === 'select' && next.color !== prev.color && !layerChanged;
    if (layerChanged || next.tool !== 'select') selection = [];
    if (next.tool !== 'magnifier' || next.mode !== 'draw') snapshot = null;
    if (next.tool !== 'laser' || next.mode !== 'draw') laser = [];
    if (layerChanged) fading = [];

    state = next;
    if (state.mode !== 'draw') pointer = null;
    if (!state.cursorHighlight) cursorPos = null;
    if (recolor) replaceSelected((s) => ({ ...s, color: state.color }));
    if (text && text.color !== state.color) {
      text.color = state.color;
      textInput.style.color = state.color;
    }

    document.body.dataset.mode = state.mode;
    document.body.dataset.tool = state.tool;
    document.body.style.setProperty('--accent', state.color);
    document.body.classList.toggle('hidden', !state.annotationsVisible);
    document.body.classList.toggle('on-board', state.board !== 'none');
    pagePill.textContent = `${C.boardNames[state.board]} · Page ${state.page + 1} / ${state.pageCount}`;
    renderBase();
    renderLive();
    renderFx();
  });

  window.addEventListener('resize', resize);
  resize();
})();
