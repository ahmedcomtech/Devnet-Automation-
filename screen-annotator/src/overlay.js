'use strict';

(() => {
  const api = window.annotator;
  const C = window.ANNOTATOR_CONFIG;
  const G = window.Geometry;

  const base = document.getElementById('base'); // committed annotations (+ board background)
  const live = document.getElementById('live'); // in-progress shape, eraser cursor, laser trail
  const bctx = base.getContext('2d');
  const lctx = live.getContext('2d');
  const textInput = document.getElementById('text-input');

  const LASER_LIFE_MS = 700;
  const MAX_HISTORY = 200;
  const FONT_FAMILY = "'Segoe UI', system-ui, -apple-system, sans-serif";

  let state = { mode: 'cursor', tool: 'pen', color: C.palette[0], size: 4, board: 'none', annotationsVisible: true };

  // The screen and the boards keep separate drawings, so switching to a whiteboard
  // and back does not lose what was drawn over the slides.
  const layers = { screen: newLayer(), board: newLayer() };
  let current = null; // shape being drawn
  let erasing = null; // { removed: Set } while the eraser is held down
  let pointer = null; // last pointer position, for eraser/laser cursors
  let text = null; // open text box
  let laser = []; // [{x, y, t}]
  let rafId = 0;

  function newLayer() {
    return { history: [[]], index: 0 };
  }
  function layer() {
    return layers[state.board === 'none' ? 'screen' : 'board'];
  }
  function shapes() {
    const l = layer();
    return l.history[l.index];
  }

  // ---------- history ----------

  function commit(next) {
    const l = layer();
    l.history = l.history.slice(0, l.index + 1);
    l.history.push(next);
    if (l.history.length > MAX_HISTORY) l.history.shift();
    l.index = l.history.length - 1;
    renderBase();
  }

  function undo() {
    finishStroke();
    const l = layer();
    if (l.index > 0) l.index--;
    renderBase();
  }

  function redo() {
    const l = layer();
    if (l.index < l.history.length - 1) l.index++;
    renderBase();
  }

  function clear() {
    finishStroke();
    if (shapes().length) commit([]);
  }

  // ---------- rendering ----------

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [base, live]) {
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    renderBase();
    renderLive();
  }

  function font(size) {
    return `600 ${size}px ${FONT_FAMILY}`;
  }

  function strokePath(ctx, pts) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Quadratic curves through segment midpoints give smooth strokes from raw mouse samples.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function drawArrow(ctx, s) {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(12, s.size * 4);
    // Stop the shaft inside the head so the round line cap does not poke through the tip.
    const shaft = Math.max(0, Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - head * 0.8);
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x1 + Math.cos(angle) * shaft, s.y1 + Math.sin(angle) * shaft);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  function drawShape(ctx, s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (s.type) {
      case 'pen':
        strokePath(ctx, s.points);
        break;
      case 'highlighter':
        // One path per stroke, so self-overlaps do not darken.
        ctx.globalAlpha = 0.35;
        strokePath(ctx, s.points);
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        break;
      case 'arrow':
        drawArrow(ctx, s);
        break;
      case 'rect':
        ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'text': {
        const lineHeight = s.fontSize * 1.25;
        ctx.font = font(s.fontSize);
        ctx.textBaseline = 'middle';
        s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeight + lineHeight / 2));
        break;
      }
    }
    ctx.restore();
  }

  function renderBase(skip) {
    bctx.clearRect(0, 0, innerWidth, innerHeight);
    if (state.board !== 'none') {
      bctx.fillStyle = C.boardColors[state.board];
      bctx.fillRect(0, 0, innerWidth, innerHeight);
    }
    for (const s of shapes()) {
      if (!skip || !skip.has(s)) drawShape(bctx, s);
    }
  }

  function eraserRadius() {
    return Math.max(6, state.size * 2.5);
  }

  function drawLaser() {
    const now = performance.now();
    laser = laser.filter((p) => now - p.t < LASER_LIFE_MS);
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
      const life = 1 - (now - b.t) / LASER_LIFE_MS;
      lctx.globalAlpha = life;
      lctx.lineWidth = width * (0.3 + 0.7 * life);
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

  function renderLive() {
    lctx.clearRect(0, 0, innerWidth, innerHeight);
    if (state.mode !== 'draw') return;
    if (current) drawShape(lctx, current);
    if (pointer && (state.tool === 'eraser' || erasing)) {
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
    if (laser.length || state.tool === 'laser') drawLaser();
  }

  function animateLaser() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderLive();
      if (laser.length) animateLaser();
    });
  }

  // ---------- text tool ----------

  function textFontSize() {
    return Math.round(14 + state.size * 3);
  }

  function autosizeText() {
    const lines = textInput.value.split('\n');
    bctx.save();
    bctx.font = font(text.fontSize);
    const width = Math.max(...lines.map((l) => bctx.measureText(l).width));
    bctx.restore();
    textInput.style.width = Math.ceil(width + text.fontSize) + 'px';
    textInput.style.height = Math.ceil(lines.length * text.fontSize * 1.25) + 'px';
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
    if (!value.trim()) return;
    const lines = value.split('\n');
    bctx.save();
    bctx.font = font(t.fontSize);
    const w = Math.max(...lines.map((l) => bctx.measureText(l).width));
    bctx.restore();
    commit([...shapes(), { type: 'text', ...t, size: 0, text: value, w, h: lines.length * t.fontSize * 1.25 }]);
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

  // ---------- pointer input ----------

  function pt(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function samples(e) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    return list.length ? list : [e];
  }

  function addPoint(points, p) {
    const last = points[points.length - 1];
    if (G.dist(last, p) >= 1.5) points.push(p);
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
    if (changed) renderBase(erasing.removed);
  }

  function finishStroke() {
    if (current) {
      const s = current;
      current = null;
      const meaningful = s.points || Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 3;
      if (meaningful) commit([...shapes(), s]);
    }
    if (erasing) {
      const removed = erasing.removed;
      erasing = null;
      if (removed.size) commit(shapes().filter((s) => !removed.has(s)));
      else renderBase();
    }
    renderLive();
  }

  // Keep focus where it is (e.g. in the text box) when clicking the canvas.
  live.addEventListener('mousedown', (e) => e.preventDefault());

  live.addEventListener('pointerdown', (e) => {
    // Button 5 is the eraser end of a pen tablet stylus.
    if (state.mode !== 'draw' || (e.button !== 0 && e.button !== 5)) return;
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
      case 'highlighter':
        current = { type: tool, color: state.color, size: tool === 'highlighter' ? state.size * 4 : state.size, points: [p] };
        break;
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        current = { type: tool, color: state.color, size: state.size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        break;
      case 'eraser':
        erasing = { removed: new Set() };
        eraseAt(p);
        break;
      case 'text':
        openText(p);
        break;
    }
    renderLive();
  });

  live.addEventListener('pointermove', (e) => {
    if (state.mode !== 'draw') return;
    pointer = pt(e);
    if (current && current.points) {
      for (const ev of samples(e)) addPoint(current.points, pt(ev));
    } else if (current) {
      const end = e.shiftKey ? G.constrain(current, pointer.x, pointer.y) : pointer;
      current.x2 = end.x;
      current.y2 = end.y;
    } else if (erasing) {
      for (const ev of samples(e)) eraseAt(pt(ev));
    }
    if (state.tool === 'laser') {
      const now = performance.now();
      for (const ev of samples(e)) laser.push({ ...pt(ev), t: now });
      animateLaser();
    }
    renderLive();
  });

  live.addEventListener('pointerup', finishStroke);
  live.addEventListener('pointercancel', finishStroke);
  live.addEventListener('pointerleave', () => {
    if (current || erasing) return;
    pointer = null;
    renderLive();
  });

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') e.shiftKey ? redo() : undo();
      else if (k === 'y') redo();
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (k === 'escape') api.update({ mode: 'cursor' });
    else if (k === 'delete' || k === 'backspace') clear();
    else if (C.toolKeys[k]) api.update({ tool: C.toolKeys[k], mode: 'draw' });
    else if (/^[1-8]$/.test(k)) api.update({ color: C.palette[Number(k) - 1] });
    else if (k === '[') api.update({ size: state.size - 1 });
    else if (k === ']') api.update({ size: state.size + 1 });
    else if (k === 'b') {
      const i = C.boards.indexOf(state.board);
      api.update({ board: C.boards[(i + 1) % C.boards.length] });
    } else return;
    e.preventDefault();
  });

  // ---------- main process wiring ----------

  api.onCommand((name) => {
    if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'clear') clear();
  });

  api.onState((next) => {
    const prev = state;
    if (next.mode !== 'draw' || next.tool !== prev.tool || next.board !== prev.board) {
      finishStroke();
      commitText();
    }
    state = next;
    if (state.tool !== 'laser' || state.mode !== 'draw') laser = [];
    if (state.mode !== 'draw') pointer = null;
    if (text && text.color !== state.color) {
      text.color = state.color;
      textInput.style.color = state.color;
    }
    document.body.dataset.mode = state.mode;
    document.body.dataset.tool = state.tool;
    document.body.classList.toggle('hidden', !state.annotationsVisible);
    renderBase();
    renderLive();
  });

  window.addEventListener('resize', resize);
  resize();
})();
