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

const jitter = (p, i) => ({ x: p.x + Math.sin(i * 1.7) * 2, y: p.y + Math.cos(i * 2.3) * 2 });
const edge = (a, b, n) => Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));

test('smart ink recognizes rough lines, boxes, circles and triangles', () => {
  const line = Array.from({ length: 40 }, (_, i) => jitter({ x: 10 + i * 5, y: 20 + i * 2 }, i));
  const circle = Array.from({ length: 60 }, (_, i) => jitter({ x: 200 + 80 * Math.cos((i / 59) * 2 * Math.PI), y: 200 + 50 * Math.sin((i / 59) * 2 * Math.PI) }, i));
  const square = [
    ...edge({ x: 50, y: 0 }, { x: 100, y: 0 }, 10),
    ...edge({ x: 100, y: 0 }, { x: 100, y: 100 }, 20),
    ...edge({ x: 100, y: 100 }, { x: 0, y: 100 }, 20),
    ...edge({ x: 0, y: 100 }, { x: 0, y: 0 }, 20),
    ...edge({ x: 0, y: 0 }, { x: 48, y: 2 }, 10),
  ].map(jitter);
  const triangle = [...edge({ x: 0, y: 100 }, { x: 60, y: 0 }, 20), ...edge({ x: 60, y: 0 }, { x: 120, y: 100 }, 20), ...edge({ x: 120, y: 100 }, { x: 2, y: 98 }, 20)].map(jitter);
  const zigzag = Array.from({ length: 50 }, (_, i) => ({ x: i * 4, y: (i % 2) * 40 }));
  assert.equal(G.recognizeStroke(line).type, 'line');
  assert.equal(G.recognizeStroke(circle).type, 'ellipse');
  assert.equal(G.recognizeStroke(square).type, 'rect');
  const tri = G.recognizeStroke(triangle);
  assert.equal(tri.type, 'polygon');
  assert.equal(tri.points.length, 3);
  assert.equal(G.recognizeStroke(zigzag), null);
  assert.equal(G.recognizeStroke([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
});

test('scaleShape scales geometry and text but keeps stroke width', () => {
  const rect = G.scaleShape({ type: 'rect', size: 4, x1: 10, y1: 10, x2: 30, y2: 20 }, 10, 10, 2);
  assert.deepEqual(rect, { type: 'rect', size: 4, x1: 10, y1: 10, x2: 50, y2: 30 });
  const note = G.scaleShape({ type: 'note', size: 0, x: 0, y: 0, w: 100, h: 50, fontSize: 20, text: 'hi' }, 0, 0, 0.5);
  assert.deepEqual([note.w, note.h, note.fontSize], [50, 25, 10]);
});

test('triangles, diamonds and speech bubbles are hit on their outline (or inside when filled)', () => {
  const tri = { type: 'triangle', size: 2, x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.ok(G.hitShape(tri, { x: 50, y: 100 }, 3));
  assert.ok(!G.hitShape(tri, { x: 50, y: 60 }, 3));
  assert.ok(G.hitShape({ ...tri, fill: true }, { x: 50, y: 60 }, 3));
  assert.ok(G.hitShape({ type: 'diamond', size: 2, x1: 0, y1: 0, x2: 100, y2: 100 }, { x: 25, y: 25 }, 3));
  assert.ok(G.hitShape({ type: 'stamp', kind: 'star', size: 4, x: 0, y: 0 }, { x: 15, y: 0 }, 0));
  assert.equal(G.shapePolygon({ type: 'callout', x1: 0, y1: 0, x2: 100, y2: 100 }).length, 7);
});

test('pressure curve: soft and firm responses, clamped input', () => {
  assert.equal(G.applyPressureCurve(0.25, 1), 0.25);
  assert.ok(G.applyPressureCurve(0.25, 0.5) > 0.25);
  assert.ok(G.applyPressureCurve(0.25, 2) < 0.25);
  assert.equal(G.applyPressureCurve(5, 1), 1);
  assert.equal(G.applyPressureCurve(undefined, 1), 0.5);
  assert.equal(G.pressureWidth(10, 0, 0.1), 1);
  assert.equal(G.pressureWidth(10, 1, 0.1), 17.5);
});

test('sanitizeShape handles stamps, notes, polygons and arrows', () => {
  assert.deepEqual(G.sanitizeShape({ type: 'stamp', kind: 'heart', color: '#ff0000', size: 4, x: 1, y: 2 }), { type: 'stamp', kind: 'heart', color: '#ff0000', size: 4, x: 1, y: 2 });
  assert.equal(G.sanitizeShape({ type: 'stamp', kind: 'skull', x: 1, y: 2 }), null);
  assert.equal(G.sanitizeShape({ type: 'note', text: 'hi', x: 0, y: 0, w: 10, h: 10, fontSize: 20 }).text, 'hi');
  assert.equal(G.sanitizeShape({ type: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), null);
  assert.equal(G.sanitizeShape({ type: 'arrow2', x1: 0, y1: 0, x2: 1, y2: 1 }).type, 'arrow2');
  assert.equal(G.sanitizeShape({ type: 'line', fill: true, x1: 0, y1: 0, x2: 1, y2: 1 }).fill, undefined);
});
