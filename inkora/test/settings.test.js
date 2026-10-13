'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/settings.js');

test('sanitizeState keeps only valid fields', () => {
  assert.deepEqual(S.sanitizeState({ mode: 'draw', tool: 'spotlight', color: '#ABCDEF', size: 99, board: 'green', fill: true, evil: 1 }), {
    mode: 'draw', tool: 'spotlight', color: '#abcdef', size: 40, board: 'green', fill: true,
  });
  assert.deepEqual(S.sanitizeState({ mode: 'x', tool: 'rm -rf', color: 'red', fill: 'yes' }), {});
});

test('sanitizeSettings merges valid values over the base and clamps numbers', () => {
  const s = S.sanitizeSettings({
    shortcuts: { undo: 'Alt+F1', clear: '', quit: 'not a valid accelerator!' },
    palette: ['#000000', 'nope'],
    toolbarOpacity: 5,
    magnifierZoom: 3,
    allDisplays: false,
  });
  assert.equal(s.shortcuts.undo, 'Alt+F1');
  assert.equal(s.shortcuts.clear, '');
  assert.equal(s.shortcuts.quit, S.DEFAULT_SHORTCUTS.quit);
  assert.equal(s.palette[0], '#000000');
  assert.equal(s.palette[1], S.DEFAULT_PALETTE[1]);
  assert.equal(s.toolbarOpacity, 1);
  assert.equal(s.magnifierZoom, 3);
  assert.equal(s.allDisplays, false);
});

test('accelerators are validated', () => {
  assert.ok(S.isAccelerator('CommandOrControl+Shift+Z'));
  assert.ok(S.isAccelerator('F5'));
  assert.ok(S.isAccelerator(''));
  assert.ok(!S.isAccelerator('Ctrl+'));
  assert.ok(!S.isAccelerator(42));
});

test('settings survive a save/load round trip and bad files fall back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotator-'));
  const file = path.join(dir, 'settings.json');
  const s = S.sanitizeSettings({ fadeSeconds: 7, last: { tool: 'arrow', color: '#123456', mode: 'draw' } });
  S.saveSettings(file, s);
  const loaded = S.loadSettings(file);
  assert.equal(loaded.fadeSeconds, 7);
  assert.deepEqual(loaded.last, { tool: 'arrow', color: '#123456' });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(S.loadSettings(file), S.sanitizeSettings({}));
  fs.rmSync(dir, { recursive: true });
});

test('pen tablet, recording and toolbar settings are validated', () => {
  const s = S.sanitizeSettings({
    penPressureCurve: 9,
    smoothing: 4.6,
    penButton: 'explode',
    recordFps: 60,
    toolbarOrientation: 'horizontal',
    theme: 'neon',
    micDeviceId: 'abc123==',
    cameraDeviceId: '<script>',
  });
  assert.equal(s.penPressureCurve, 3);
  assert.equal(s.smoothing, 5);
  assert.equal(s.penButton, 'palette');
  assert.equal(s.recordFps, 60);
  assert.equal(s.toolbarOrientation, 'horizontal');
  assert.equal(s.theme, 'dark');
  assert.equal(s.micDeviceId, 'abc123==');
  assert.equal(s.cameraDeviceId, '');
  assert.deepEqual(S.sanitizeState({ tool: 'stamp', stamp: 'star', smartInk: true, frozen: true }), { tool: 'stamp', stamp: 'star', smartInk: true, frozen: true });
});
