'use strict';

// Settings shared by the overlay and the toolbar. The color palette lives in the user settings.
window.ANNOTATOR_CONFIG = {
  sizes: [2, 4, 8, 14],
  boards: ['none', 'white', 'black', 'green'],
  boardColors: { white: '#ffffff', black: '#1d1f21', green: '#1e3b2c' },
  boardNames: { none: 'Screen', white: 'Whiteboard', black: 'Blackboard', green: 'Chalkboard' },
  patterns: ['plain', 'grid', 'lines', 'dots'],
  // Single-key shortcuts while the overlay is in draw mode.
  toolKeys: {
    v: 'select',
    p: 'pen',
    h: 'highlighter',
    e: 'eraser',
    k: 'laser',
    g: 'spotlight',
    z: 'magnifier',
    l: 'line',
    a: 'arrow',
    r: 'rect',
    o: 'ellipse',
    t: 'text',
    n: 'badge',
  },
  toggleKeys: { f: 'fill', d: 'dash', i: 'fadeInk', c: 'cursorHighlight' },
};
