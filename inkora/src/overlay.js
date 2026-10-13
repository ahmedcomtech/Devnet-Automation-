'use strict';

(() => {
  const api = window.annotator;
  const C = window.ANNOTATOR_CONFIG;
  const G = window.Geometry;
  const R = window.Render;

  const base = document.getElementById('base'); // committed annotations (+ board / frozen screen)
  const ink = document.getElementById('ink'); // the stroke being drawn, rendered incrementally
  const live = document.getElementById('live'); // previews, selection, eraser, laser, spotlight, magnifier, curtain
  const fx = document.getElementById('fx'); // cursor highlight
  const bctx = base.getContext('2d');
  const ictx = ink.getContext('2d');
  const lctx = live.getContext('2d');
  const fctx = fx.getContext('2d');
  const textInput = document.getElementById('text-input');
  const pagePill = document.getElementById('page-pill');
  const hintEl = document.getElementById('hint');
  const countdownEl = document.getElementById('countdown');
  const quick = document.getElementById('quick');

  const MAX_HISTORY = 200;
  const SELECT_COLOR = '#8ab4f8';
  const FADING_TYPES = ['pen', 'highlighter', 'line', 'arrow', 'arrow2', 'rect', 'ellipse', 'triangle', 'diamond', 'callout', 'polygon'];
  const CLIP_FORMAT = 'inkora-shapes';

  let state = {
    mode: 'cursor',
    tool: 'pen',
    stamp: 'check',
    color: '#ff3b30',
    size: 4,
    board: 'none',
    boardPattern: 'plain',
    fill: false,
    dash: false,
    fadeInk: false,
    smartInk: false,
    cursorHighlight: false,
    annotationsVisible: true,
    frozen: false,
    page: 0,
    pageCount: 1,
    settings: {
      palette: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#111111'],
      laserSeconds: 0.8,
      fadeSeconds: 3,
      spotlightRadius: 150,
      magnifierZoom: 2,
      cursorHighlightColor: '#ffd60a',
      penPressureCurve: 1,
      penMinWidth: 0.25,
      smoothing: 3,
      ignoreTouch: true,
      penButton: 'palette',
    },
  };

  // The screen and the board pages keep separate drawings, so switching to a whiteboard
  // and back does not lose what was drawn over the slides.
  let screenLayer = newLayer();
  let pages = [newLayer()];

  let current = null; // shape being drawn
  let activePointer = null; // pointer drawing the current stroke; other pointers (palm, touch) are ignored
  let smoothed = null; // stabilized pen position and pressure
  let predicted = []; // predicted pointer positions, drawn as a preview to hide input latency
  let erasing = null; // { removed: Set } while the eraser is held down
  let drag = null; // select / curtain dragging state
  let selection = []; // selected shapes (select tool)
  let pointer = null; // last pointer position over this overlay (draw mode)
  let cursorPos = null; // cursor position reported by the main process (any mode)
  let text = null; // open text or note editor
  let laser = []; // [{x, y, t}]
  let fading = []; // fading-ink shapes: [{ shape, born }]
  let rafId = 0;
  let spotlightRadius = null; // wheel overrides of the settings values
  let magnifierZoom = null;
  let snapshot = null; // screen image for the magnifier
  let frozenImage = null; // screen image shown while the screen is frozen
  let capturing = false;
  let curtainY = null;
  let hintTimer = 0;

  const W = () => innerWidth;
  const H = () => innerHeight;
  const settings = () => state.settings;

  function newLayer(list = []) {
    return { history: [list], index: 0 };
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

  const round1 = (v) => Math.round(v * 10) / 10;
  const round2 = (v) => Math.round(v * 100) / 100;

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

  function scaleHandle() {
    const b = selectionBox();
    return b ? { x: b.x + b.w + 4 - 6, y: b.y + b.h + 4 - 6, w: 12, h: 12 } : null;
  }

  function topShapeAt(p, filter) {
    const list = shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      if ((!filter || filter(list[i])) && G.hitShape(list[i], p, 6)) return list[i];
    }
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

  function reorderSelection(toFront) {
    if (!selection.length) return;
    const chosen = new Set(selection);
    const picked = shapes().filter((s) => chosen.has(s));
    const others = shapes().filter((s) => !chosen.has(s));
    commit(toFront ? [...others, ...picked] : [...picked, ...others], selection);
    hint(toFront ? 'Brought to front' : 'Sent to back');
  }

  function selectAll() {
    selection = [...shapes()];
    if (state.tool !== 'select' || state.mode !== 'draw') api.update({ tool: 'select', mode: 'draw' });
    renderLive();
  }

  function copySelection(cut) {
    if (!selection.length) return;
    api.invoke('clipboard-write-text', JSON.stringify({ format: CLIP_FORMAT, shapes: selection }));
    if (cut) deleteSelection();
    hint(cut ? 'Cut' : 'Copied');
  }

  function startSelect(p, additive) {
    const box = selectionBox();
    const handle = scaleHandle();
    if (handle && G.inside(p, handle, 4)) {
      drag = { kind: 'scale', ox: box.x, oy: box.y, bw: Math.max(1, box.w), bh: Math.max(1, box.h), f: 1, moving: new Set(selection) };
      renderBase();
      return;
    }
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
    for (const canvas of [base, ink, live, fx]) {
      canvas.width = Math.round(W() * dpr);
      canvas.height = Math.round(H() * dpr);
      canvas.style.width = W() + 'px';
      canvas.style.height = H() + 'px';
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (curtainY === null) curtainY = Math.round(H() * 0.35);
    renderBase();
    renderLive();
    renderFx();
  }

  // Shapes temporarily drawn elsewhere (being erased, moved, scaled or edited) are left out of the base layer.
  function hiddenShapes() {
    const hidden = new Set();
    if (erasing) for (const s of erasing.removed) hidden.add(s);
    if (drag && drag.moving) for (const s of drag.moving) hidden.add(s);
    if (text && text.editing) hidden.add(text.editing);
    return hidden;
  }

  function renderBase() {
    bctx.clearRect(0, 0, W(), H());
    if (state.board !== 'none') R.drawBoard(bctx, W(), H(), C.boardColors[state.board], state.boardPattern);
    else if (frozenImage) bctx.drawImage(frozenImage, 0, 0, W(), H());
    const hidden = hiddenShapes();
    for (const s of shapes()) {
      if (!hidden.has(s)) R.drawShape(bctx, s, renderBase);
    }
  }

  function eraserRadius() {
    return Math.max(6, state.size * 2.5);
  }
  function spotRadius() {
    return spotlightRadius ?? settings().spotlightRadius;
  }
  function zoomLevel() {
    return magnifierZoom ?? settings().magnifierZoom;
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

  function drawCurtain() {
    const y = curtainY;
    lctx.save();
    lctx.fillStyle = '#1d1f21';
    lctx.fillRect(0, y, W(), H() - y);
    lctx.fillStyle = 'rgba(232,234,237,0.9)';
    lctx.beginPath();
    lctx.roundRect(W() / 2 - 50, y - 5, 100, 10, 5);
    lctx.fill();
    lctx.fillStyle = 'rgba(232,234,237,0.7)';
    lctx.font = R.font(13);
    lctx.textAlign = 'center';
    lctx.fillText('Drag or scroll to reveal', W() / 2, y + 30);
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
    const life = settings().laserSeconds * 1000;
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
    const total = settings().fadeSeconds * 1000;
    fading = fading.filter((f) => now - f.born < total);
    for (const f of fading) {
      lctx.save();
      lctx.globalAlpha = Math.min(1, (total - (now - f.born)) / (total * 0.4));
      R.drawShape(lctx, f.shape);
      lctx.restore();
    }
  }

  function transformForDrag(s) {
    if (drag && drag.kind === 'move') return G.translate(s, drag.dx, drag.dy);
    if (drag && drag.kind === 'scale') return G.scaleShape(s, drag.ox, drag.oy, drag.f);
    return s;
  }

  function drawSelection() {
    if (!selection.length) return;
    const moved = selection.map(transformForDrag);
    if (drag && (drag.kind === 'move' || drag.kind === 'scale')) for (const s of moved) R.drawShape(lctx, s, renderLive);
    const box = G.unionBox(moved.map(G.bbox));
    lctx.save();
    lctx.strokeStyle = SELECT_COLOR;
    lctx.lineWidth = 1.5;
    lctx.setLineDash([6, 4]);
    lctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    lctx.setLineDash([]);
    lctx.fillStyle = '#ffffff';
    lctx.fillRect(box.x + box.w - 2, box.y + box.h - 2, 12, 12);
    lctx.strokeRect(box.x + box.w - 2, box.y + box.h - 2, 12, 12);
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

  // Thin preview from the last real sample through the predicted ones: makes fast pen strokes feel attached.
  function drawPrediction() {
    const pts = current.points;
    if (!predicted.length || !pts.length) return;
    lctx.save();
    lctx.strokeStyle = current.color;
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';
    lctx.lineWidth = current.pressure ? G.pressureWidth(current.size, pts[pts.length - 1].p, current.pmin) : current.size;
    if (current.type === 'highlighter') lctx.globalAlpha = 0.35;
    lctx.beginPath();
    lctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    for (const p of predicted) lctx.lineTo(p.x, p.y);
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
    if (state.tool === 'curtain') drawCurtain();
    if (current && current.points) drawPrediction();
    else if (current) R.drawShape(lctx, current);
    if (state.tool === 'select') drawSelection();
    if (drag && drag.kind === 'marquee') drawMarquee();
    if (pointer && (state.tool === 'eraser' || erasing)) drawEraserCursor();
    if (laser.length || state.tool === 'laser') drawLaser(now);
    if (state.tool === 'magnifier') drawMagnifier();
  }

  function renderFx() {
    fctx.clearRect(0, 0, W(), H());
    if (!state.cursorHighlight || !cursorPos || state.tool === 'magnifier') return;
    const color = settings().cursorHighlightColor;
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

  // ---------- ink: tablet-optimized freehand strokes ----------

  // Stabilizer: each sample moves the pen only part of the way to the real position (0 = off).
  function smoothingFactor() {
    return 1 / (1 + settings().smoothing * 0.5);
  }

  function startStroke(e, p, tool) {
    const pressure = tool === 'pen' && e.pointerType === 'pen';
    current = { type: tool, color: state.color, size: tool === 'highlighter' ? state.size * 4 : state.size, points: [] };
    if (pressure) {
      current.pressure = true;
      current.pmin = settings().penMinWidth;
    }
    smoothed = null;
    ictx.clearRect(0, 0, W(), H());
    ictx.strokeStyle = ictx.fillStyle = current.color;
    ictx.lineCap = 'round';
    ictx.lineJoin = 'round';
    addSample(e, p);
    drawInk();
  }

  function addSample(e, raw) {
    const pts = current.points;
    const a = smoothingFactor();
    const pos = smoothed ? { x: smoothed.x + (raw.x - smoothed.x) * a, y: smoothed.y + (raw.y - smoothed.y) * a } : raw;
    let p = smoothed ? smoothed.p : null;
    if (current.pressure) {
      const curved = G.applyPressureCurve(e.pressure, settings().penPressureCurve);
      p = p === null ? curved : p + (curved - p) * 0.5;
    }
    smoothed = { ...pos, p };
    const last = pts[pts.length - 1];
    if (last && G.dist(last, pos) < 1.2) return;
    const q = { x: round1(pos.x), y: round1(pos.y) };
    if (current.pressure) q.p = round2(p);
    pts.push(q);
  }

  // Draws the new pieces of the stroke on the ink canvas instead of repainting the whole stroke.
  function drawInk(final = false) {
    const pts = current.points;
    if (current.type === 'highlighter') {
      ictx.clearRect(0, 0, W(), H());
      R.drawShape(ictx, current);
      return;
    }
    if (pts.length === 1) {
      if (!current.dot) R.drawShape(ictx, current);
      current.dot = true;
      return;
    }
    if (current.dot) {
      ictx.clearRect(0, 0, W(), H()); // replace the starting dot by the real stroke
      current.dot = false;
    }
    const upTo = final ? pts.length - 1 : pts.length - 2; // a piece needs its next point, except the last one
    for (let i = (current.drawn || 0) + 1; i <= upTo; i++) {
      R.pressureSegment(ictx, pts, i, current.size, current.pmin, !current.pressure);
      current.drawn = i;
    }
  }

  function finishStroke(e) {
    const s = current;
    current = null;
    predicted = [];
    if (e && s.points.length > 1) {
      // Close the gap the stabilizer leaves behind the pen tip.
      const last = s.points[s.points.length - 1];
      const end = pt(e);
      if (G.dist(last, end) >= 1.2) s.points.push({ x: round1(end.x), y: round1(end.y), ...(s.pressure ? { p: last.p } : {}) });
    }
    delete s.drawn;
    delete s.dot;
    ictx.clearRect(0, 0, W(), H());
    let shape = s;
    if (state.smartInk && s.type === 'pen') {
      const found = G.recognizeStroke(s.points);
      if (found) {
        shape = { ...found, color: s.color, size: s.size };
        if (state.dash) shape.dash = true;
        if (state.fill && G.FILLABLE.includes(found.type)) shape.fill = true;
        hint(`Smart shape: ${{ line: 'line', rect: 'rectangle', ellipse: 'ellipse', polygon: 'triangle' }[found.type]}`);
      }
    }
    addShape(shape);
  }

  // ---------- magnifier & freeze ----------

  function nextFrames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))));
  }

  async function grabScreen(hideAll) {
    const cls = hideAll ? 'capturing-all' : 'capturing';
    document.body.classList.add(cls);
    await nextFrames(); // let the compositor drop the hidden layers before the screen is grabbed
    let img = null;
    try {
      const url = await api.invoke('capture-display');
      if (url) {
        img = new Image();
        img.src = url;
        await img.decode();
      }
    } catch {
      img = null;
    }
    document.body.classList.remove(cls);
    return img;
  }

  async function captureSnapshot() {
    if (capturing) return;
    capturing = true;
    const img = await grabScreen(false);
    if (state.tool === 'magnifier' && img) snapshot = img;
    capturing = false;
    renderLive();
  }

  async function freeze() {
    capturing = true;
    const img = await grabScreen(true);
    capturing = false;
    if (state.frozen) frozenImage = img;
    if (!img) hint('Could not capture the screen');
    renderBase();
  }

  // ---------- text & sticky notes ----------

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

  function noteSize(value, fontSize) {
    const m = measureText(value, fontSize);
    const pad = G.notePadding(fontSize);
    return { w: Math.max(fontSize * 6, m.w + 2 * pad), h: Math.max(fontSize * 2.25, m.h + 2 * pad) };
  }

  function makeTextShape(kind, x, y, value, color, fontSize) {
    const box = kind === 'note' ? noteSize(value, fontSize) : measureText(value, fontSize);
    return { type: kind, x, y, color, fontSize, size: 0, text: value, ...box };
  }

  function autosizeText() {
    if (!text) return;
    const box = text.kind === 'note' ? noteSize(textInput.value, text.fontSize) : measureText(textInput.value, text.fontSize);
    const extra = text.kind === 'note' ? 0 : text.fontSize;
    textInput.style.width = Math.ceil(box.w + extra) + 'px';
    textInput.style.height = Math.ceil(box.h) + 'px';
  }

  function styleEditor() {
    const isNote = text.kind === 'note';
    textInput.classList.toggle('note', isNote);
    Object.assign(textInput.style, {
      display: 'block',
      left: text.x + 'px',
      top: text.y + 'px',
      color: isNote ? (R.isLight(text.color) ? '#1d1d1f' : '#ffffff') : text.color,
      background: isNote ? text.color : 'transparent',
      padding: isNote ? G.notePadding(text.fontSize) + 'px' : '0',
      fontSize: text.fontSize + 'px',
      lineHeight: text.fontSize * 1.25 + 'px',
    });
  }

  // Opens the editor for a new text/note at p, or for an existing one.
  function openEditor(p, kind, existing) {
    text = existing
      ? { kind: existing.type, x: existing.x, y: existing.y, color: existing.color, fontSize: existing.fontSize, editing: existing }
      : { kind, x: p.x, y: p.y, color: state.color, fontSize: textFontSize(), editing: null };
    styleEditor();
    textInput.value = existing ? existing.text : '';
    autosizeText();
    renderBase();
    textInput.focus();
    if (existing) textInput.select();
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
    const next = value.trim() ? makeTextShape(t.kind, t.x, t.y, value, t.color, t.fontSize) : null;
    if (t.editing) commit(shapes().flatMap((s) => (s === t.editing ? (next ? [next] : []) : [s])));
    else if (next) commit([...shapes(), next]);
    else renderBase();
  }

  textInput.addEventListener('input', autosizeText);
  textInput.addEventListener('blur', commitText);
  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeText();
      renderBase();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  });

  // ---------- paste & insert ----------

  function placeAt() {
    return pointer || cursorPos || { x: W() / 2, y: H() / 2 };
  }

  async function imageShape(src, at) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const dpr = window.devicePixelRatio || 1;
    let w = img.naturalWidth / dpr;
    let h = img.naturalHeight / dpr;
    const scale = Math.min(1, (W() * 0.6) / w, (H() * 0.6) / h);
    w *= scale;
    h *= scale;
    return { type: 'image', color: state.color, size: 0, src, x: at.x - w / 2, y: at.y - h / 2, w, h };
  }

  function addAndSelect(list) {
    commit([...shapes(), ...list], list);
    api.update({ tool: 'select', mode: 'draw' });
  }

  function pasteShapes(json, at) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return false;
    }
    if (!data || data.format !== CLIP_FORMAT || !Array.isArray(data.shapes)) return false;
    const list = data.shapes.map(G.sanitizeShape).filter(Boolean);
    if (!list.length) return true;
    const box = G.unionBox(list.map(G.bbox));
    const dx = at.x - (box.x + box.w / 2);
    const dy = at.y - (box.y + box.h / 2);
    addAndSelect(list.map((s) => G.translate(s, dx, dy)));
    return true;
  }

  async function paste() {
    const data = await api.invoke('clipboard-read').catch(() => null);
    if (!data) return;
    const at = placeAt();
    if (data.image) {
      addAndSelect([await imageShape(data.image, at)]);
    } else if (data.text) {
      if (data.text.includes(CLIP_FORMAT) && pasteShapes(data.text, at)) return;
      addAndSelect([makeTextShape('text', at.x, at.y, data.text.replace(/\r\n/g, '\n'), state.color, textFontSize())]);
    }
  }

  // Appends images (e.g. PDF pages) as new board pages after the last page that has content.
  function appendPages(images) {
    while (pages.length < state.pageCount) pages.push(newLayer());
    let last = -1;
    pages.forEach((l, i) => {
      if (currentShapes(l).length) last = i;
    });
    const start = last + 1;
    while (pages.length < start) pages.push(newLayer());
    images.forEach((img, i) => {
      const scale = Math.min((W() * 0.96) / img.w, (H() * 0.96) / img.h);
      const w = img.w * scale;
      const h = img.h * scale;
      pages[start + i] = newLayer([{ type: 'image', color: '#000000', size: 0, src: img.src, x: (W() - w) / 2, y: (H() - h) / 2, w, h, frame: true }]);
    });
    return { start, count: images.length };
  }

  // Renders every board page (background, pattern, drawings) for PDF export.
  async function exportPages() {
    while (pages.length < state.pageCount) pages.push(newLayer());
    let last = -1;
    pages.forEach((l, i) => {
      if (currentShapes(l).length) last = i;
    });
    if (last < 0) return [];
    const dpr = window.devicePixelRatio || 1;
    const color = C.boardColors[state.board === 'none' ? 'white' : state.board];
    const out = [];
    for (const l of pages.slice(0, last + 1)) {
      const list = currentShapes(l);
      await Promise.all(list.filter((s) => s.type === 'image').map((s) => R.loadImage(s.src)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(W() * dpr);
      canvas.height = Math.round(H() * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      R.drawBoard(ctx, W(), H(), color, state.boardPattern);
      for (const s of list) R.drawShape(ctx, s);
      out.push(canvas.toDataURL('image/png'));
    }
    return out;
  }

  // ---------- quick palette (right click / pen button) ----------

  const quickTools = document.getElementById('quick-tools');
  const quickColors = document.getElementById('quick-colors');
  const quickSizes = document.getElementById('quick-sizes');

  function quickButton(parent, html, title, onClick) {
    const b = document.createElement('button');
    b.innerHTML = html;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      closeQuick();
    });
    parent.appendChild(b);
    return b;
  }

  function buildQuick() {
    quickTools.textContent = '';
    quickColors.textContent = '';
    quickSizes.textContent = '';
    for (const tool of C.quickTools) {
      quickButton(quickTools, window.svgIcon(tool), tool, () => api.update({ tool, mode: 'draw' })).classList.toggle('active', state.tool === tool);
    }
    for (const color of settings().palette) {
      const b = quickButton(quickColors, '<span class="swatch"></span>', color, () => api.update({ color }));
      b.firstChild.style.background = color;
      b.firstChild.classList.toggle('active', color === state.color);
    }
    for (const size of C.sizes) {
      const d = Math.min(18, size + 3);
      quickButton(quickSizes, `<span class="dot" style="width:${d}px;height:${d}px"></span>`, `Size ${size}`, () => api.update({ size })).classList.toggle('active', size === state.size);
    }
  }

  function openQuick(p) {
    buildQuick();
    quick.classList.add('show');
    const w = quick.offsetWidth;
    const h = quick.offsetHeight;
    quick.style.left = Math.max(8, Math.min(W() - w - 8, p.x - w / 2)) + 'px';
    quick.style.top = Math.max(8, Math.min(H() - h - 8, p.y - h / 2)) + 'px';
  }

  function closeQuick() {
    quick.classList.remove('show');
  }

  const quickOpen = () => quick.classList.contains('show');

  // ---------- pointer input ----------

  function pt(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function samples(e) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    return list.length ? list : [e];
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

  // Ends whatever the pointer was doing: commits a stroke, a shape, an erase, a move or a resize.
  function finishInteraction(e) {
    activePointer = null;
    if (current && current.points) finishStroke(e);
    else if (current) {
      const s = current;
      current = null;
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 3) addShape(s);
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
      else if (d.kind === 'scale' && d.f !== 1) replaceSelected((s) => G.scaleShape(s, d.ox, d.oy, d.f));
      else renderBase();
    }
    renderLive();
  }

  // Keep focus where it is (e.g. in the text box) when clicking the canvas.
  live.addEventListener('mousedown', (e) => e.preventDefault());
  // Right click, the pen barrel button and Windows Ink press-and-hold must not open a context menu.
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  live.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'draw') return;
    if (settings().ignoreTouch && e.pointerType === 'touch') return; // palm rejection
    if (activePointer !== null && e.pointerId !== activePointer) return;
    if (quickOpen()) {
      closeQuick();
      return;
    }
    const p = pt(e);
    let tool = state.tool;
    if (e.button === 2) {
      // Right mouse button or pen barrel button.
      const action = e.pointerType === 'pen' ? settings().penButton : 'palette';
      if (action === 'palette') openQuick(p);
      if (action !== 'eraser') return;
      tool = 'eraser';
    } else if (e.button === 5) {
      tool = 'eraser'; // eraser end of the stylus
    } else if (e.button !== 0) {
      return;
    }
    api.setActive();
    if (text) {
      commitText(); // a click outside an open text box just finishes it
      return;
    }
    pointer = p;
    activePointer = e.pointerId;
    try {
      live.setPointerCapture(e.pointerId);
    } catch {
      // Some tablet drivers report pointers the browser cannot capture; drawing still works without it.
    }
    switch (tool) {
      case 'pen':
      case 'highlighter':
        startStroke(e, p, tool);
        break;
      case 'line':
      case 'arrow':
      case 'arrow2':
      case 'rect':
      case 'ellipse':
      case 'triangle':
      case 'diamond':
      case 'callout':
        current = { type: tool, color: state.color, size: state.size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        if (state.dash) current.dash = true;
        if (state.fill && G.FILLABLE.includes(tool)) current.fill = true;
        break;
      case 'eraser':
        erasing = { removed: new Set() };
        eraseAt(p);
        break;
      case 'text':
      case 'note': {
        activePointer = null;
        const existing = topShapeAt(p, (s) => s.type === tool);
        openEditor(p, tool, existing);
        break;
      }
      case 'badge':
        placeBadge(p);
        break;
      case 'stamp':
        commit([...shapes(), { type: 'stamp', kind: state.stamp, color: state.color, size: state.size, x: p.x, y: p.y }]);
        break;
      case 'select':
        startSelect(p, e.shiftKey);
        break;
      case 'curtain':
        drag = { kind: 'curtain' };
        curtainY = p.y;
        break;
      case 'magnifier':
        captureSnapshot(); // refresh the image, e.g. after the content below changed
        break;
    }
    renderLive();
  });

  live.addEventListener('pointermove', (e) => {
    if (state.mode !== 'draw') return;
    if (settings().ignoreTouch && e.pointerType === 'touch') return;
    if (activePointer !== null && e.pointerId !== activePointer) return;
    pointer = pt(e);
    if (state.cursorHighlight) {
      cursorPos = pointer;
      renderFx();
    }
    if (current && current.points) {
      for (const ev of samples(e)) addSample(ev, pt(ev));
      predicted = e.getPredictedEvents ? e.getPredictedEvents().map(pt) : [];
      drawInk();
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
    } else if (drag && drag.kind === 'scale') {
      drag.f = Math.max(0.05, ((pointer.x - drag.ox) / drag.bw + (pointer.y - drag.oy) / drag.bh) / 2);
    } else if (drag && drag.kind === 'marquee') {
      drag.x2 = pointer.x;
      drag.y2 = pointer.y;
      const box = G.dragBox(drag);
      const picked = shapes().filter((s) => !drag.base.includes(s) && G.boxesIntersect(G.bbox(s), box));
      selection = [...drag.base, ...picked];
    } else if (drag && drag.kind === 'curtain') {
      curtainY = Math.max(0, Math.min(H(), pointer.y));
    } else if (state.tool === 'select') {
      const box = selectionBox();
      const handle = scaleHandle();
      const overHandle = !!(handle && G.inside(pointer, handle, 4));
      live.classList.toggle('over-handle', overHandle);
      live.classList.toggle('over-shape', !overHandle && !!(topShapeAt(pointer) || (box && G.inside(pointer, box, 4))));
    }
    if (state.tool === 'laser') {
      const now = performance.now();
      for (const ev of samples(e)) laser.push({ ...pt(ev), t: now });
      animate();
    }
    if (state.tool === 'magnifier' && !snapshot) captureSnapshot();
    renderLive();
  });

  function pointerEnd(e) {
    if (activePointer !== null && e.pointerId !== activePointer) return;
    finishInteraction(e);
  }
  live.addEventListener('pointerup', pointerEnd);
  live.addEventListener('pointercancel', pointerEnd);
  live.addEventListener('pointerleave', () => {
    if (current || erasing || drag) return;
    pointer = null;
    renderLive();
  });

  live.addEventListener('dblclick', (e) => {
    if (state.mode !== 'draw' || !['select', 'text', 'note'].includes(state.tool)) return;
    const target = topShapeAt(pt(e), (s) => s.type === 'text' || s.type === 'note');
    if (target) {
      selection = [];
      openEditor(pt(e), target.type, target);
    }
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
      } else if (state.tool === 'curtain') {
        curtainY = Math.max(0, Math.min(H(), curtainY + (up ? -40 : 40)));
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
      else if (k === 'c') copySelection(false);
      else if (k === 'x') copySelection(true);
      else if (k === 'v') paste();
      else if (k === 'a') selectAll();
      else if (k === 'd') duplicateSelection();
      else if (k === ']') reorderSelection(true);
      else if (k === '[') reorderSelection(false);
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
      if (quickOpen()) closeQuick();
      else if (selection.length) {
        selection = [];
        renderLive();
      } else api.update({ mode: 'cursor' });
    } else if (k === 'delete' || k === 'backspace') {
      if (selection.length) deleteSelection();
      else clear();
    } else if (k === 'enter' && selection.length === 1 && ['text', 'note'].includes(selection[0].type)) {
      const target = selection[0];
      selection = [];
      openEditor(null, target.type, target);
    } else if (C.toolKeys[k]) api.update({ tool: C.toolKeys[k], mode: 'draw' });
    else if (C.toggleKeys[k]) {
      const key = C.toggleKeys[k];
      api.update({ [key]: !state[key] });
      hint(`${C.toggleNames[key]} ${state[key] ? 'off' : 'on'}`);
    } else if (/^[1-8]$/.test(k)) api.update({ color: settings().palette[Number(k) - 1] });
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

  function showCountdown(n) {
    countdownEl.classList.remove('show');
    if (!n) return;
    countdownEl.textContent = String(n);
    void countdownEl.offsetWidth; // restart the animation
    countdownEl.classList.add('show');
  }

  api.onCommand(async (name, arg) => {
    if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'clear') clear();
    else if (name === 'import-session') importSession(arg);
    else if (name === 'countdown') showCountdown(arg);
    else if (name === 'insert-image' && arg && typeof arg.src === 'string') {
      try {
        addAndSelect([await imageShape(arg.src, { x: W() / 2, y: H() / 2 })]);
      } catch {
        hint('Could not open that image');
      }
    }
  });

  api.onRequest((name, arg) => {
    if (name === 'export-session') return { screen: currentShapes(screenLayer), pages: pages.map(currentShapes) };
    if (name === 'export-png') return shapes().length || frozenImage ? base.toDataURL('image/png') : null;
    if (name === 'export-pages') return exportPages();
    if (name === 'append-pages' && arg && Array.isArray(arg.images)) return appendPages(arg.images);
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
      closeQuick();
    }
    const recolor = selection.length && next.tool === 'select' && next.color !== prev.color && !layerChanged;
    if (layerChanged || next.tool !== 'select') selection = [];
    if (next.tool !== 'magnifier' || next.mode !== 'draw') snapshot = null;
    if (next.tool !== 'laser' || next.mode !== 'draw') laser = [];
    if (layerChanged) fading = [];
    const startFreeze = next.frozen && !prev.frozen;
    if (!next.frozen) frozenImage = null;

    state = next;
    if (state.mode !== 'draw') pointer = null;
    if (!state.cursorHighlight) cursorPos = null;
    if (recolor) replaceSelected((s) => ({ ...s, color: state.color }));
    if (text && text.color !== state.color && !text.editing) {
      text.color = state.color;
      styleEditor();
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
    if (startFreeze) freeze();
  });

  window.addEventListener('resize', resize);
  resize();
})();
