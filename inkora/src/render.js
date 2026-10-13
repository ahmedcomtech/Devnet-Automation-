'use strict';

// Canvas drawing of shapes and board backgrounds.
(function (root) {
  const G = root.Geometry;
  const FONT_FAMILY = "'Segoe UI', system-ui, -apple-system, sans-serif";
  const images = new Map(); // data URL -> HTMLImageElement

  function font(size, weight = 600) {
    return `${weight} ${size}px ${FONT_FAMILY}`;
  }

  // Loads (and caches) a pasted image; calls onLoad once it can be drawn.
  function getImage(src, onLoad) {
    let img = images.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => onLoad && onLoad();
      img.src = src;
      images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // Resolves once an image can be drawn (or failed), e.g. before rendering pages for export.
  function loadImage(src) {
    return new Promise((resolve) => {
      const ready = getImage(src);
      if (ready) return resolve(ready);
      const img = images.get(src);
      img.addEventListener('load', () => resolve(img), { once: true });
      img.addEventListener('error', () => resolve(null), { once: true });
    });
  }

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  }

  function strokePath(ctx, pts) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Quadratic curves through segment midpoints give smooth strokes from raw input samples.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  // One piece of a pressure stroke: the curve through point i, from the previous midpoint to the next.
  // Drawing pieces one at a time lets the overlay render a live stroke incrementally.
  function pressureSegment(ctx, pts, i, size, min, fixedWidth = false) {
    const ctrl = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const from = i === 1 ? prev : { x: (prev.x + ctrl.x) / 2, y: (prev.y + ctrl.y) / 2 };
    const to = next ? { x: (ctrl.x + next.x) / 2, y: (ctrl.y + next.y) / 2 } : ctrl;
    ctx.lineWidth = fixedWidth ? size : G.pressureWidth(size, ((prev.p ?? 0.5) + (ctrl.p ?? 0.5)) / 2, min);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y);
    ctx.stroke();
  }

  function pressurePath(ctx, pts, size, min) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, G.pressureWidth(size, pts[0].p, min) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) pressureSegment(ctx, pts, i, size, min);
  }

  function arrowHeadAt(ctx, x, y, angle, head) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - head * Math.cos(angle - Math.PI / 7), y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x - head * Math.cos(angle + Math.PI / 7), y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  function drawArrow(ctx, s, both) {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = G.arrowHead(s.size);
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    // Stop the shaft inside the heads so the round line cap does not poke through the tips.
    const start = both ? Math.min(len / 2, head * 0.8) : 0;
    const end = Math.max(start, len - head * 0.8);
    ctx.beginPath();
    ctx.moveTo(s.x1 + Math.cos(angle) * start, s.y1 + Math.sin(angle) * start);
    ctx.lineTo(s.x1 + Math.cos(angle) * end, s.y1 + Math.sin(angle) * end);
    ctx.stroke();
    ctx.setLineDash([]);
    arrowHeadAt(ctx, s.x2, s.y2, angle, head);
    if (both) arrowHeadAt(ctx, s.x1, s.y1, angle + Math.PI, head);
  }

  function fillThenStroke(ctx, s) {
    if (s.fill) {
      ctx.save();
      ctx.globalAlpha *= 0.3;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
  }

  function polygonPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  }

  function drawBadge(ctx, s) {
    const r = G.badgeRadius(s.size);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = isLight(s.color) ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.fillStyle = isLight(s.color) ? '#111111' : '#ffffff';
    ctx.font = font(Math.round(r * (s.n > 9 ? 0.95 : 1.15)), 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.n), s.x, s.y + r * 0.06);
  }

  function drawStamp(ctx, s) {
    const r = G.stampRadius(s.size);
    ctx.translate(s.x, s.y);
    ctx.lineWidth = r * 0.26;
    switch (s.kind) {
      case 'check':
        ctx.beginPath();
        ctx.moveTo(-0.62 * r, 0.02 * r);
        ctx.lineTo(-0.18 * r, 0.48 * r);
        ctx.lineTo(0.66 * r, -0.5 * r);
        ctx.stroke();
        break;
      case 'cross':
        ctx.beginPath();
        ctx.moveTo(-0.5 * r, -0.5 * r);
        ctx.lineTo(0.5 * r, 0.5 * r);
        ctx.moveTo(0.5 * r, -0.5 * r);
        ctx.lineTo(-0.5 * r, 0.5 * r);
        ctx.stroke();
        break;
      case 'star': {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 ? r * 0.42 : r;
          i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'heart':
        ctx.beginPath();
        ctx.moveTo(0, 0.85 * r);
        ctx.bezierCurveTo(-1.25 * r, 0, -0.75 * r, -1.05 * r, 0, -0.38 * r);
        ctx.bezierCurveTo(0.75 * r, -1.05 * r, 1.25 * r, 0, 0, 0.85 * r);
        ctx.fill();
        break;
      case 'question':
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = isLight(s.color) ? '#111111' : '#ffffff';
        ctx.font = font(Math.round(r * 1.35), 800);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, r * 0.08);
        break;
      case 'smile':
        ctx.lineWidth = r * 0.14;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-0.33 * r, -0.25 * r, r * 0.11, 0, Math.PI * 2);
        ctx.arc(0.33 * r, -0.25 * r, r * 0.11, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0.05 * r, r * 0.5, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        break;
    }
  }

  function drawText(ctx, s, color, x, y) {
    const lineHeight = s.fontSize * 1.25;
    ctx.fillStyle = color;
    ctx.font = font(s.fontSize);
    ctx.textBaseline = 'middle';
    s.text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight + lineHeight / 2));
  }

  function drawNote(ctx, s) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, s.w, s.h, 10);
    ctx.fill();
    ctx.restore();
    const padding = G.notePadding(s.fontSize);
    drawText(ctx, s, isLight(s.color) ? '#1d1d1f' : '#ffffff', s.x + padding, s.y + padding);
  }

  function drawShape(ctx, s, onImageLoad) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.dash && s.type !== 'pen' && s.type !== 'highlighter') ctx.setLineDash([s.size * 3, s.size * 2.5]);
    switch (s.type) {
      case 'pen':
        if (s.pressure) pressurePath(ctx, s.points, s.size, s.pmin);
        else strokePath(ctx, s.points);
        break;
      case 'highlighter':
        // One path per stroke, so self-overlaps do not darken.
        ctx.globalAlpha *= 0.35;
        strokePath(ctx, s.points);
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        break;
      case 'arrow':
      case 'arrow2':
        drawArrow(ctx, s, s.type === 'arrow2');
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        fillThenStroke(ctx, s);
        break;
      case 'rect':
      case 'triangle':
      case 'diamond':
      case 'callout':
      case 'polygon':
        polygonPath(ctx, G.shapePolygon(s));
        fillThenStroke(ctx, s);
        break;
      case 'text':
        drawText(ctx, s, s.color, s.x, s.y);
        break;
      case 'note':
        drawNote(ctx, s);
        break;
      case 'badge':
        drawBadge(ctx, s);
        break;
      case 'stamp':
        drawStamp(ctx, s);
        break;
      case 'image': {
        const img = getImage(s.src, onImageLoad);
        if (s.frame) {
          // Imported document pages get a paper-like shadow so the page edge shows on a white board.
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.25)';
          ctx.shadowBlur = 12;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(s.x, s.y, s.w, s.h);
          ctx.restore();
        }
        if (img) ctx.drawImage(img, s.x, s.y, s.w, s.h);
        break;
      }
    }
    ctx.restore();
  }

  function drawBoard(ctx, w, h, color, pattern) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    const ink = isLight(color) ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1;
    if (pattern === 'grid' || pattern === 'axes') {
      ctx.beginPath();
      for (let x = 40; x < w; x += 40) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 40; y < h; y += 40) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }
    if (pattern === 'axes') {
      // Cartesian axes through the grid line nearest the center, with arrow tips and tick labels.
      const cx = Math.round(w / 2 / 40) * 40 + 0.5;
      const cy = Math.round(h / 2 / 40) * 40 + 0.5;
      const axis = isLight(color) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
      ctx.strokeStyle = axis;
      ctx.fillStyle = axis;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(10, cy);
      ctx.lineTo(w - 10, cy);
      ctx.moveTo(cx, h - 10);
      ctx.lineTo(cx, 10);
      ctx.stroke();
      arrowHeadAt(ctx, w - 6, cy, 0, 12);
      arrowHeadAt(ctx, cx, 6, -Math.PI / 2, 12);
      ctx.font = font(11, 500);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let x = cx - 40, n = -1; x > 20; x -= 40, n--) ctx.fillText(String(n), x, cy + 4);
      for (let x = cx + 40, n = 1; x < w - 20; x += 40, n++) ctx.fillText(String(n), x, cy + 4);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let y = cy - 40, n = 1; y > 20; y -= 40, n++) ctx.fillText(String(n), cx - 5, y);
      for (let y = cy + 40, n = -1; y < h - 20; y += 40, n--) ctx.fillText(String(n), cx - 5, y);
      ctx.font = font(14, 700);
      ctx.fillText('x', w - 12, cy - 14);
      ctx.fillText('y', cx - 8, 14);
    } else if (pattern === 'lines') {
      ctx.beginPath();
      for (let y = 80; y < h; y += 36) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,59,48,0.35)';
      ctx.beginPath();
      ctx.moveTo(100.5, 0);
      ctx.lineTo(100.5, h);
      ctx.stroke();
    } else if (pattern === 'dots') {
      for (let x = 30; x < w; x += 30) {
        for (let y = 30; y < h; y += 30) ctx.fillRect(x - 1, y - 1, 2.5, 2.5);
      }
    }
    ctx.restore();
  }

  root.Render = { font, drawShape, drawBoard, getImage, loadImage, isLight, strokePath, pressureSegment };
})(window);
