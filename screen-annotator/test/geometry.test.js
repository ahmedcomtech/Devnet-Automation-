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
