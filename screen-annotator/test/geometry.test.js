'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry.js');

test('distToSegment measures to the nearest point, clamped to the ends', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.equal(G.distToSegment({ x: 5, y: 3 }, a, b), 3);
  assert.equal(G.distToSegment({ x: -4, y: 3 }, a, b), 5);
  assert.equal(G.distToSegment({ x: 2, y: 2 }, a, a), Math.hypot(2, 2));
});

test('eraser hits a pen stroke near its path but not far away', () => {
  const stroke = { type: 'pen', size: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  assert.ok(G.hitShape(stroke, { x: 50, y: 8 }, 6));
  assert.ok(!G.hitShape(stroke, { x: 50, y: 20 }, 6));
});

test('rectangles and ellipses are hit on their outline only', () => {
  const rect = { type: 'rect', size: 2, x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.ok(G.hitShape(rect, { x: 50, y: 2 }, 4));
  assert.ok(!G.hitShape(rect, { x: 50, y: 50 }, 4));

  const ellipse = { type: 'ellipse', size: 2, x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.ok(G.hitShape(ellipse, { x: 100, y: 50 }, 4));
  assert.ok(!G.hitShape(ellipse, { x: 50, y: 50 }, 4));
});

test('text is hit anywhere inside its box', () => {
  const text = { type: 'text', size: 0, x: 10, y: 10, w: 80, h: 30 };
  assert.ok(G.hitShape(text, { x: 50, y: 25 }, 4));
  assert.ok(!G.hitShape(text, { x: 200, y: 25 }, 4));
});

test('constrain makes squares and snaps lines to 45 degrees', () => {
  assert.deepEqual(G.constrain({ type: 'rect', x1: 0, y1: 0 }, 30, -10), { x: 30, y: -30 });
  const end = G.constrain({ type: 'line', x1: 0, y1: 0 }, 100, 10);
  assert.equal(Math.round(end.y), 0);
  assert.equal(Math.round(end.x), Math.round(Math.hypot(100, 10)));
});

test('bounding boxes include stroke width and badge radius', () => {
  assert.deepEqual(G.bbox({ type: 'rect', size: 4, x1: 10, y1: 10, x2: 50, y2: 30 }), { x: 8, y: 8, w: 44, h: 24 });
  const r = G.badgeRadius(4);
  assert.deepEqual(G.bbox({ type: 'badge', size: 4, x: 100, y: 100, n: 1 }), { x: 100 - r, y: 100 - r, w: 2 * r, h: 2 * r });
});

test('filled shapes are hit inside, badges and images by area', () => {
  const rect = { type: 'rect', size: 2, fill: true, x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.ok(G.hitShape(rect, { x: 50, y: 50 }, 2));
  const ellipse = { type: 'ellipse', size: 2, fill: true, x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.ok(G.hitShape(ellipse, { x: 50, y: 50 }, 2));
  assert.ok(!G.hitShape(ellipse, { x: 3, y: 3 }, 2));
  assert.ok(G.hitShape({ type: 'badge', size: 4, x: 0, y: 0, n: 1 }, { x: 10, y: 0 }, 0));
  assert.ok(G.hitShape({ type: 'image', size: 0, x: 0, y: 0, w: 40, h: 40 }, { x: 20, y: 20 }, 0));
});

test('translate returns a moved copy without touching the original', () => {
  const pen = { type: 'pen', size: 2, points: [{ x: 1, y: 1 }] };
  const moved = G.translate(pen, 5, -1);
  assert.deepEqual(moved.points, [{ x: 6, y: 0 }]);
  assert.deepEqual(pen.points, [{ x: 1, y: 1 }]);
  assert.deepEqual(G.translate({ type: 'line', size: 2, x1: 0, y1: 0, x2: 1, y2: 1 }, 2, 2), { type: 'line', size: 2, x1: 2, y1: 2, x2: 3, y2: 3 });
});

test('selection helpers: union and intersection of boxes', () => {
  const u = G.unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 5, h: 20 }]);
  assert.deepEqual(u, { x: 0, y: 0, w: 25, h: 25 });
  assert.ok(G.boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!G.boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 1, h: 1 }));
});

test('sanitizeShape accepts valid session data and rejects junk', () => {
  assert.deepEqual(G.sanitizeShape({ type: 'line', color: '#00ff00', size: 3, x1: 0, y1: 0, x2: 5, y2: 5, extra: 'x' }), {
    type: 'line', color: '#00ff00', size: 3, x1: 0, y1: 0, x2: 5, y2: 5,
  });
  assert.equal(G.sanitizeShape({ type: 'script', x: 1 }), null);
  assert.equal(G.sanitizeShape({ type: 'line', x1: 'a', y1: 0, x2: 0, y2: 0 }), null);
  assert.equal(G.sanitizeShape({ type: 'image', src: 'https://evil.example/x.png', x: 0, y: 0, w: 1, h: 1 }), null);
  const pen = G.sanitizeShape({ type: 'pen', color: 'red', size: 2, pressure: true, points: [{ x: 0, y: 0, p: 2 }] });
  assert.equal(pen.color, '#ff3b30');
  assert.deepEqual(pen.points, [{ x: 0, y: 0, p: 1 }]);
});
