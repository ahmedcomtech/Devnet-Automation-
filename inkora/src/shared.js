'use strict';

// Settings shared by the overlay and the toolbar. The color palette lives in the user settings.
window.ANNOTATOR_CONFIG = {
  sizes: [2, 4, 8, 14],
  boards: ['none', 'white', 'black', 'green'],
  boardColors: { white: '#ffffff', black: '#1d1f21', green: '#1e3b2c' },
  boardNames: { none: 'Screen', white: 'Whiteboard', black: 'Blackboard', green: 'Chalkboard' },
  patterns: ['plain', 'grid', 'lines', 'dots', 'axes'],
  stamps: ['check', 'cross', 'star', 'heart', 'question', 'smile'],
  stampNames: { check: 'Check mark', cross: 'Cross', star: 'Star', heart: 'Heart', question: 'Question', smile: 'Smiley' },
  // Single-key shortcuts while the overlay is in draw mode.
  toolKeys: {
    v: 'select',
    p: 'pen',
    h: 'highlighter',
    e: 'eraser',
    k: 'laser',
    g: 'spotlight',
    z: 'magnifier',
    u: 'curtain',
    t: 'text',
    y: 'note',
    l: 'line',
    a: 'arrow',
    x: 'arrow2',
    r: 'rect',
    o: 'ellipse',
    n: 'badge',
    m: 'stamp',
  },
  toggleKeys: { f: 'fill', d: 'dash', i: 'fadeInk', s: 'smartInk', c: 'cursorHighlight' },
  toggleNames: { fill: 'Fill shapes', dash: 'Dashed lines', fadeInk: 'Fading ink', smartInk: 'Smart shapes', cursorHighlight: 'Cursor highlight' },
  // Tools offered in the right-click / pen-button quick palette.
  quickTools: ['pen', 'highlighter', 'eraser', 'laser', 'arrow', 'rect', 'text', 'select'],
};
