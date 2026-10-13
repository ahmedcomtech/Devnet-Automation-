'use strict';

// Settings shared by the overlay and the toolbar.
window.ANNOTATOR_CONFIG = {
  palette: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#111111'],
  sizes: [2, 4, 8, 14],
  boards: ['none', 'white', 'black', 'green'],
  boardColors: { white: '#ffffff', black: '#1d1f21', green: '#1e3b2c' },
  boardNames: { none: 'Screen', white: 'Whiteboard', black: 'Blackboard', green: 'Chalkboard' },
  // Single-key shortcuts while the overlay is in draw mode.
  toolKeys: { p: 'pen', h: 'highlighter', e: 'eraser', k: 'laser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' },
};
