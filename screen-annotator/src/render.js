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
    // Quadratic curves through segment midpoints give smooth strokes from raw mouse samples.
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

  // Same curve as strokePath, but each piece gets the width of its pen pressure.
  function pressurePath(ctx, pts, size) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, G.pressureWidth(size, pts[0].p) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let from = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const ctrl = pts[i];
      const next = pts[i + 1];
      const to = next ? { x: (ctrl.x + next.x) / 2, y: (ctrl.y + next.y) / 2 } : ctrl;
      ctx.lineWidth = G.pressureWidth(size, ((pts[i - 1].p ?? 0.5) + (ctrl.p ?? 0.5)) / 2);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y);
      ctx.stroke();
      from = to;
    }
  }

  function drawArrow(ctx, s) {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = G.arrowHead(s.size);
    // Stop the shaft inside the head so the round line cap does not poke through the tip.
    const shaft = Math.max(0, Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - head * 0.8);
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x1 + Math.cos(angle) * shaft, s.y1 + Math.sin(angle) * shaft);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
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
        if (s.pressure) pressurePath(ctx, s.points, s.size);
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
        drawArrow(ctx, s);
        break;
      case 'rect':
        ctx.beginPath();
        ctx.rect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
        fillThenStroke(ctx, s);
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        fillThenStroke(ctx, s);
        break;
      case 'text': {
        const lineHeight = s.fontSize * 1.25;
        ctx.font = font(s.fontSize);
        ctx.textBaseline = 'middle';
        s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeight + lineHeight / 2));
        break;
      }
      case 'badge':
        drawBadge(ctx, s);
        break;
      case 'image': {
        const img = getImage(s.src, onImageLoad);
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
    if (pattern === 'grid') {
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

  root.Render = { font, drawShape, drawBoard, getImage, isLight };
})(window);
