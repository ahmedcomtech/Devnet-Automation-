'use strict';

// Pure geometry helpers: loaded as a <script> in the pages and require()d by the unit tests.
(function (root) {
  const SHAPE_TYPES = ['pen', 'highlighter', 'line', 'arrow', 'arrow2', 'rect', 'ellipse', 'triangle', 'diamond', 'callout', 'polygon', 'text', 'note', 'badge', 'stamp', 'image'];
  // Shapes defined by a drag rectangle (x1, y1)-(x2, y2).
  const BOX_TYPES = ['line', 'arrow', 'arrow2', 'rect', 'ellipse', 'triangle', 'diamond', 'callout'];
  const FILLABLE = ['rect', 'ellipse', 'triangle', 'diamond', 'callout', 'polygon'];
  const STAMPS = ['check', 'cross', 'star', 'heart', 'question', 'smile'];

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

  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
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

  // Outline of the polygon-like shapes, in drawing order.
  function shapePolygon(s) {
    if (s.type === 'polygon') return s.points;
    const l = Math.min(s.x1, s.x2);
    const r = Math.max(s.x1, s.x2);
    const t = Math.min(s.y1, s.y2);
    const b = Math.max(s.y1, s.y2);
    const w = r - l;
    const h = b - t;
    switch (s.type) {
      case 'triangle':
        return [{ x: l + w / 2, y: t }, { x: r, y: b }, { x: l, y: b }];
      case 'diamond':
        return [{ x: l + w / 2, y: t }, { x: r, y: t + h / 2 }, { x: l + w / 2, y: b }, { x: l, y: t + h / 2 }];
      case 'callout': {
        // Speech bubble: a box with a tail at the bottom left.
        const body = t + h * 0.78;
        return [
          { x: l, y: t },
          { x: r, y: t },
          { x: r, y: body },
          { x: l + w * 0.4, y: body },
          { x: l + w * 0.15, y: b },
          { x: l + w * 0.22, y: body },
          { x: l, y: body },
        ];
      }
      default:
        return rectPoints(s);
    }
  }

  // Inner padding of a sticky note; proportional so scaled notes keep their look.
  function notePadding(fontSize) {
    return fontSize * 0.5;
  }

  function badgeRadius(size) {
    return 12 + size * 1.5;
  }

  function stampRadius(size) {
    return 14 + size * 2;
  }

  function arrowHead(size) {
    return Math.max(12, size * 4);
  }

  // Maps raw pen pressure (0..1) through the user's response curve: <1 is softer, >1 is firmer.
  function applyPressureCurve(p, gamma = 1) {
    const v = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0.5));
    return Math.pow(v, gamma);
  }

  // Width of a pressure-sensitive stroke at (already curved) pressure p.
  function pressureWidth(size, p, min = 0.25) {
    return size * (min + (1.75 - min) * (p ?? 0.5));
  }

  function inside(p, b, pad = 0) {
    return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
  }

  function pointsBox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function pad(b, n) {
    return { x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n };
  }

  // Bounding box {x, y, w, h} of a shape, including its stroke width.
  function bbox(s) {
    switch (s.type) {
      case 'pen':
      case 'highlighter':
      case 'polygon':
        return pad(pointsBox(s.points), s.pressure ? pressureWidth(s.size, 1, s.pmin) / 2 : s.size / 2);
      case 'badge':
      case 'stamp': {
        const r = s.type === 'badge' ? badgeRadius(s.size) : stampRadius(s.size);
        return { x: s.x - r, y: s.y - r, w: 2 * r, h: 2 * r };
      }
      case 'text':
      case 'note':
      case 'image':
        return { x: s.x, y: s.y, w: s.w, h: s.h };
      default: {
        const n = s.type === 'arrow' || s.type === 'arrow2' ? arrowHead(s.size) : s.size / 2;
        return pad(dragBox(s), n);
      }
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
        return polylineHit(p, s.points, s.pressure ? r + pressureWidth(s.size, 1, s.pmin) / 2 : tolerance, false);
      case 'line':
      case 'arrow':
      case 'arrow2':
        return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tolerance;
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
      case 'rect':
      case 'triangle':
      case 'diamond':
      case 'callout':
      case 'polygon': {
        const pts = shapePolygon(s);
        if (s.fill && pointInPolygon(p, pts)) return true;
        return polylineHit(p, pts, tolerance, true);
      }
      case 'badge':
        return dist(p, s) <= badgeRadius(s.size) + r;
      case 'stamp':
        return dist(p, s) <= stampRadius(s.size) + r;
      case 'text':
      case 'note':
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

  // Returns a copy scaled by factor f around the origin (ox, oy). Stroke widths stay the same.
  function scaleShape(s, ox, oy, f) {
    const sx = (x) => ox + (x - ox) * f;
    const sy = (y) => oy + (y - oy) * f;
    const t = { ...s };
    if (s.points) t.points = s.points.map((p) => ({ ...p, x: sx(p.x), y: sy(p.y) }));
    if ('x1' in s) {
      t.x1 = sx(s.x1);
      t.y1 = sy(s.y1);
      t.x2 = sx(s.x2);
      t.y2 = sy(s.y2);
    }
    if ('x' in s) {
      t.x = sx(s.x);
      t.y = sy(s.y);
    }
    if ('w' in s) {
      t.w = s.w * f;
      t.h = s.h * f;
    }
    if ('fontSize' in s) t.fontSize = s.fontSize * f;
    if (s.type === 'badge' || s.type === 'stamp') t.size = Math.max(1, s.size * f);
    return t;
  }

  // Shift-drag: square boxes / circles, and lines snapped to 45° steps.
  function constrain(s, x, y) {
    const dx = x - s.x1;
    const dy = y - s.y1;
    if (!['line', 'arrow', 'arrow2'].includes(s.type)) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: s.x1 + Math.sign(dx || 1) * m, y: s.y1 + Math.sign(dy || 1) * m };
    }
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return { x: s.x1 + Math.cos(angle) * len, y: s.y1 + Math.sin(angle) * len };
  }

  // Ramer–Douglas–Peucker polyline simplification.
  function simplify(points, epsilon) {
    if (points.length < 3) return points.slice();
    const first = points[0];
    const last = points[points.length - 1];
    let index = 0;
    let max = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = distToSegment(points[i], first, last);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (max <= epsilon) return [first, last];
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }

  // Smart ink: turns a rough freehand stroke into a clean line, rectangle, ellipse or triangle.
  // Returns the geometry of the recognized shape, or null to keep the stroke as drawn.
  function recognizeStroke(points) {
    if (points.length < 5) return null;
    const box = pointsBox(points);
    const diag = Math.hypot(box.w, box.h);
    if (diag < 30) return null;
    const first = points[0];
    const last = points[points.length - 1];
    const ends = dist(first, last);

    let maxDev = 0;
    for (const p of points) maxDev = Math.max(maxDev, distToSegment(p, first, last));
    if (ends > diag * 0.8 && maxDev < Math.max(6, ends * 0.06)) {
      return { type: 'line', x1: first.x, y1: first.y, x2: last.x, y2: last.y };
    }
    if (ends > diag * 0.3) return null; // open curve: keep it freehand

    let verts = simplify([...points, first], diag * 0.08).slice(0, -1);
    // Drop vertices where the outline barely turns (e.g. the start point in the middle of a side).
    verts = verts.filter((v, i) => {
      const a = verts[(i - 1 + verts.length) % verts.length];
      const b = verts[(i + 1) % verts.length];
      const angle = Math.abs(Math.atan2(a.y - v.y, a.x - v.x) - Math.atan2(b.y - v.y, b.x - v.x));
      const turn = Math.min(angle, 2 * Math.PI - angle);
      return turn < (155 * Math.PI) / 180;
    });
    const rect = { x1: box.x, y1: box.y, x2: box.x + box.w, y2: box.y + box.h };
    if (verts.length === 3) return { type: 'polygon', points: verts.map((v) => ({ x: v.x, y: v.y })) };
    if (verts.length === 4) return { type: 'rect', ...rect };

    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let error = 0;
    for (const p of points) error += Math.abs(Math.hypot((p.x - cx) / (box.w / 2 || 1), (p.y - cy) / (box.h / 2 || 1)) - 1);
    if (error / points.length < 0.2) return { type: 'ellipse', ...rect };
    return null;
  }

  // Validates a shape loaded from a session file or the clipboard; returns a clean copy or null.
  function sanitizeShape(s) {
    if (!s || typeof s !== 'object' || !SHAPE_TYPES.includes(s.type)) return null;
    const num = (v) => Number.isFinite(v) && Math.abs(v) < 1e6;
    const color = typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ff3b30';
    const size = num(s.size) ? Math.min(200, Math.max(0, s.size)) : 4;
    const base = { type: s.type, color, size };
    if (s.fill === true && FILLABLE.includes(s.type)) base.fill = true;
    if (s.dash === true) base.dash = true;
    const cleanPoints = (list, withPressure) => {
      if (!Array.isArray(list) || !list.length || list.length > 100000) return null;
      const points = [];
      for (const p of list) {
        if (!p || !num(p.x) || !num(p.y)) return null;
        const q = { x: p.x, y: p.y };
        if (withPressure && num(p.p)) q.p = Math.min(1, Math.max(0, p.p));
        points.push(q);
      }
      return points;
    };
    const textFields = () => {
      if (typeof s.text !== 'string' || ![s.x, s.y, s.w, s.h, s.fontSize].every(num)) return null;
      return { x: s.x, y: s.y, w: s.w, h: s.h, fontSize: s.fontSize, text: s.text.slice(0, 5000) };
    };
    switch (s.type) {
      case 'pen':
      case 'highlighter': {
        const points = cleanPoints(s.points, true);
        if (!points) return null;
        const out = { ...base, points };
        if (s.pressure === true) {
          out.pressure = true;
          if (num(s.pmin)) out.pmin = Math.min(1, Math.max(0.05, s.pmin));
        }
        return out;
      }
      case 'polygon': {
        const points = cleanPoints(s.points, false);
        return points && points.length >= 3 ? { ...base, points } : null;
      }
      case 'text':
      case 'note': {
        const t = textFields();
        return t ? { ...base, ...t } : null;
      }
      case 'badge':
        if (![s.x, s.y].every(num) || !Number.isInteger(s.n)) return null;
        return { ...base, x: s.x, y: s.y, n: s.n };
      case 'stamp':
        if (![s.x, s.y].every(num) || !STAMPS.includes(s.kind)) return null;
        return { ...base, x: s.x, y: s.y, kind: s.kind };
      case 'image':
        if (typeof s.src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(s.src)) return null;
        if (![s.x, s.y, s.w, s.h].every(num) || s.w <= 0 || s.h <= 0) return null;
        return { ...base, x: s.x, y: s.y, w: s.w, h: s.h, src: s.src, ...(s.frame === true ? { frame: true } : {}) };
      default:
        if (!BOX_TYPES.includes(s.type) || ![s.x1, s.y1, s.x2, s.y2].every(num)) return null;
        return { ...base, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
    }
  }

  const Geometry = {
    SHAPE_TYPES,
    BOX_TYPES,
    FILLABLE,
    STAMPS,
    notePadding,
    dist,
    distToSegment,
    polylineHit,
    pointInPolygon,
    rectPoints,
    ellipsePoints,
    shapePolygon,
    badgeRadius,
    stampRadius,
    arrowHead,
    applyPressureCurve,
    pressureWidth,
    inside,
    pointsBox,
    bbox,
    unionBox,
    boxesIntersect,
    dragBox,
    hitShape,
    translate,
    scaleShape,
    constrain,
    simplify,
    recognizeStroke,
    sanitizeShape,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geometry;
  else root.Geometry = Geometry;
})(typeof window !== 'undefined' ? window : globalThis);
