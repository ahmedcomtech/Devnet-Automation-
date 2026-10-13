'use strict';

// Pure geometry helpers: loaded as a <script> in the overlay and require()d by the unit tests.
(function (root) {
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

  // Does an eraser circle of radius r at p touch shape s?
  function hitShape(s, p, r) {
    const tolerance = r + s.size / 2;
    switch (s.type) {
      case 'pen':
      case 'highlighter':
        return polylineHit(p, s.points, tolerance, false);
      case 'line':
      case 'arrow':
        return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tolerance;
      case 'rect':
        return polylineHit(p, rectPoints(s), tolerance, true);
      case 'ellipse':
        return polylineHit(p, ellipsePoints(s), tolerance, true);
      case 'text':
        return p.x >= s.x - r && p.x <= s.x + s.w + r && p.y >= s.y - r && p.y <= s.y + s.h + r;
      default:
        return false;
    }
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

  const Geometry = { dist, distToSegment, polylineHit, rectPoints, ellipsePoints, hitShape, constrain };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geometry;
  else root.Geometry = Geometry;
})(typeof window !== 'undefined' ? window : globalThis);
