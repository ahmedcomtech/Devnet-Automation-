'use strict';

// Pure geometry helpers: loaded as a <script> in the overlay and require()d by the unit tests.
(function (root) {
  const SHAPE_TYPES = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse', 'text', 'badge', 'image'];

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function polylineHit(p, points, tolerance, closed) {
    if (points.length === 1) return dist(p, points[0]) <= tolerance;
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
      if (distToSegment(p, points[i], points[(i + 1) % points.length]) <= tolerance) return true;
    }
    return false;
  }

  function rectPoints(s) {
    return [
      { x: s.x1, y: s.y1 },
      { x: s.x2, y: s.y1 },
      { x: s.x2, y: s.y2 },
      { x: s.x1, y: s.y2 },
    ];
  }

  function ellipsePoints(s, steps = 48) {
    const cx = (s.x1 + s.x2) / 2;
    const cy = (s.y1 + s.y2) / 2;
    const rx = Math.abs(s.x2 - s.x1) / 2;
    const ry = Math.abs(s.y2 - s.y1) / 2;
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
    return pts;
  }

  function badgeRadius(size) {
    return 12 + size * 1.5;
  }

  function arrowHead(size) {
    return Math.max(12, size * 4);
  }

  // Width of a pressure-sensitive stroke at pressure p (0..1).
  function pressureWidth(size, p) {
    return size * (0.25 + 1.5 * (p ?? 0.5));
  }

  function inside(p, b, pad = 0) {
    return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
  }

  // Bounding box {x, y, w, h} of a shape, including its stroke width.
  function bbox(s) {
    switch (s.type) {
      case 'pen':
      case 'highlighter': {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of s.points) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
        const h = s.pressure ? pressureWidth(s.size, 1) / 2 : s.size / 2;
        return { x: minX - h, y: minY - h, w: maxX - minX + 2 * h, h: maxY - minY + 2 * h };
      }
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse': {
        const pad = s.type === 'arrow' ? arrowHead(s.size) : s.size / 2;
        const x = Math.min(s.x1, s.x2);
        const y = Math.min(s.y1, s.y2);
        return { x: x - pad, y: y - pad, w: Math.abs(s.x2 - s.x1) + 2 * pad, h: Math.abs(s.y2 - s.y1) + 2 * pad };
      }
      case 'badge': {
        const r = badgeRadius(s.size);
        return { x: s.x - r, y: s.y - r, w: 2 * r, h: 2 * r };
      }
      default:
        return { x: s.x, y: s.y, w: s.w, h: s.h };
    }
  }

  function unionBox(boxes) {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function boxesIntersect(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
  }

  // Normalizes a drag rectangle (x1,y1)-(x2,y2) to {x, y, w, h}.
  function dragBox(d) {
    return { x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) };
  }

  // Does a circle of radius r at p touch shape s? Used by the eraser and the select tool.
  function hitShape(s, p, r) {
    const tolerance = r + (s.size || 0) / 2;
    switch (s.type) {
      case 'pen':
      case 'highlighter':
        return polylineHit(p, s.points, s.pressure ? r + pressureWidth(s.size, 1) / 2 : tolerance, false);
      case 'line':
      case 'arrow':
        return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tolerance;
      case 'rect':
        if (s.fill && inside(p, dragBox(s))) return true;
        return polylineHit(p, rectPoints(s), tolerance, true);
      case 'ellipse': {
        if (s.fill) {
          const rx = Math.abs(s.x2 - s.x1) / 2 || 1;
          const ry = Math.abs(s.y2 - s.y1) / 2 || 1;
          const nx = (p.x - (s.x1 + s.x2) / 2) / rx;
          const ny = (p.y - (s.y1 + s.y2) / 2) / ry;
          if (nx * nx + ny * ny <= 1) return true;
        }
        return polylineHit(p, ellipsePoints(s), tolerance, true);
      }
      case 'badge':
        return dist(p, s) <= badgeRadius(s.size) + r;
      case 'text':
      case 'image':
        return inside(p, s, r);
      default:
        return false;
    }
  }

  // Returns a moved copy of the shape; shapes are never mutated so undo history stays intact.
  function translate(s, dx, dy) {
    const t = { ...s };
    if (s.points) t.points = s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    if ('x1' in s) {
      t.x1 += dx;
      t.y1 += dy;
      t.x2 += dx;
      t.y2 += dy;
    }
    if ('x' in s) {
      t.x += dx;
      t.y += dy;
    }
    return t;
  }

  // Shift-drag: square rectangles / circles, and lines snapped to 45° steps.
  function constrain(s, x, y) {
    const dx = x - s.x1;
    const dy = y - s.y1;
    if (s.type === 'rect' || s.type === 'ellipse') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: s.x1 + Math.sign(dx || 1) * m, y: s.y1 + Math.sign(dy || 1) * m };
    }
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return { x: s.x1 + Math.cos(angle) * len, y: s.y1 + Math.sin(angle) * len };
  }

  // Validates a shape loaded from a session file; returns a clean copy or null.
  function sanitizeShape(s) {
    if (!s || typeof s !== 'object' || !SHAPE_TYPES.includes(s.type)) return null;
    const num = (v) => Number.isFinite(v) && Math.abs(v) < 1e6;
    const color = typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ff3b30';
    const size = num(s.size) ? Math.min(200, Math.max(0, s.size)) : 4;
    const base = { type: s.type, color, size };
    if (s.fill === true) base.fill = true;
    if (s.dash === true) base.dash = true;
    switch (s.type) {
      case 'pen':
      case 'highlighter': {
        if (!Array.isArray(s.points) || !s.points.length || s.points.length > 100000) return null;
        const points = [];
        for (const p of s.points) {
          if (!p || !num(p.x) || !num(p.y)) return null;
          const q = { x: p.x, y: p.y };
          if (num(p.p)) q.p = Math.min(1, Math.max(0, p.p));
          points.push(q);
        }
        return { ...base, points, ...(s.pressure === true ? { pressure: true } : {}) };
      }
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        if (![s.x1, s.y1, s.x2, s.y2].every(num)) return null;
        return { ...base, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
      case 'text':
        if (typeof s.text !== 'string' || ![s.x, s.y, s.w, s.h, s.fontSize].every(num)) return null;
        return { ...base, x: s.x, y: s.y, w: s.w, h: s.h, fontSize: s.fontSize, text: s.text.slice(0, 5000) };
      case 'badge':
        if (![s.x, s.y].every(num) || !Number.isInteger(s.n)) return null;
        return { ...base, x: s.x, y: s.y, n: s.n };
      case 'image':
        if (typeof s.src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(s.src)) return null;
        if (![s.x, s.y, s.w, s.h].every(num) || s.w <= 0 || s.h <= 0) return null;
        return { ...base, x: s.x, y: s.y, w: s.w, h: s.h, src: s.src };
      default:
        return null;
    }
  }

  const Geometry = {
    SHAPE_TYPES,
    dist,
    distToSegment,
    polylineHit,
    rectPoints,
    ellipsePoints,
    badgeRadius,
    arrowHead,
    pressureWidth,
    inside,
    bbox,
    unionBox,
    boxesIntersect,
    dragBox,
    hitShape,
    translate,
    constrain,
    sanitizeShape,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geometry;
  else root.Geometry = Geometry;
})(typeof window !== 'undefined' ? window : globalThis);
