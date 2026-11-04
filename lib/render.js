// L4 render: primitives library + SVG assembly. Each primitive takes explicit numeric
// parameters only. Pure string building; no LLM, no raster, no external calls.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FONT = 'sans-serif';

function polygon(points, attrs = {}) {
  const pts = points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
  return `<polygon points="${pts}"${attrStr(attrs)}/>`;
}

function rect(x, y, w, h, attrs = {}) {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}"${attrStr(attrs)}/>`;
}

function circle(cx, cy, r, attrs = {}) {
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}"${attrStr(attrs)}/>`;
}

function line(x0, y0, x1, y1, attrs = {}) {
  return `<line x1="${round(x0)}" y1="${round(y0)}" x2="${round(x1)}" y2="${round(y1)}"${attrStr(attrs)}/>`;
}

function text(x, y, content, attrs = {}) {
  const fontSize = attrs.fontSize ?? 16;
  const fill = attrs.fill ?? '#111';
  const anchor = attrs.textAnchor ?? 'middle';
  const extra = { ...attrs };
  delete extra.fontSize; delete extra.fill; delete extra.textAnchor;
  return `<text x="${round(x)}" y="${round(y)}" font-size="${fontSize}" font-family="${FONT}" fill="${fill}" text-anchor="${anchor}"${attrStr(extra)}>${esc(content)}</text>`;
}

function path(d, attrs = {}) {
  return `<path d="${d}"${attrStr(attrs)}/>`;
}

function attrStr(attrs) {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out += ` ${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${typeof v === 'string' ? esc(v) : round(v, 3)}"`;
  }
  return out;
}

function round(v, digits = 1) {
  const n = Number.isFinite(v) ? v : 0;
  const r = Number(n.toFixed(digits));
  return String(r);
}

// Force arrow: shaft + solid triangular head, drawn on canvas coordinates (y down).
function forceArrow(a, options) {
  const { x0, y0, x1, y1, label, magnitudeN } = a;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const ux = dx / len, uy = dy / len;
  const headLen = Math.min(14, len * 0.35);
  const headW = headLen * 0.7;
  const bx = x1 - ux * headLen, by = y1 - uy * headLen;
  const px = -uy, py = ux;
  const shaft = line(x0, y0, bx, by, { stroke: '#b3261e', strokeWidth: 2.5 });
  const head = polygon([
    { x: x1, y: y1 },
    { x: bx + px * headW / 2, y: by + py * headW / 2 },
    { x: bx - px * headW / 2, y: by - py * headW / 2 },
  ], { fill: '#b3261e' });
  // label placed beyond the tip
  const labelX = x1 + ux * 16 + px * 14;
  const labelY = y1 + uy * 16 + py * 14;
  const labelEl = text(labelX, labelY + 5, label, { fill: '#b3261e', fontSize: 15, fontWeight: 600 });
  return shaft + head + labelEl;
}

// Angle arc at vertex (canvas coords, y down): from direction `startDirDeg` sweeping
// `sweepDeg` (positive = clockwise on screen since y is down). Optional label at mid-arc.
function angleArc(x, y, startDirDeg, sweepDeg, radius, label = null, color = '#333') {
  const r = radius;
  const rad = (d) => (d * Math.PI) / 180;
  const p0 = { x: x + r * Math.cos(rad(startDirDeg)), y: y + r * Math.sin(rad(startDirDeg)) };
  const p1 = { x: x + r * Math.cos(rad(startDirDeg + sweepDeg)), y: y + r * Math.sin(rad(startDirDeg + sweepDeg)) };
  const largeArc = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const sweepFlag = sweepDeg > 0 ? 1 : 0;
  const d = `M ${round(p0.x)} ${round(p0.y)} A ${round(r)} ${round(r)} 0 ${largeArc} ${sweepFlag} ${round(p1.x)} ${round(p1.y)}`;
  const mid = startDirDeg + sweepDeg / 2;
  const lx = x + (r + 18) * Math.cos(rad(mid));
  const ly = y + (r + 18) * Math.sin(rad(mid));
  return path(d, { fill: 'none', stroke: color, strokeWidth: 1.5 }) +
    (label ? text(lx, ly + 4, label, { fill: color, fontSize: 13 }) : '');
}

// Assemble the full SVG document from a layout plan.
export function renderSvg(plan, options = {}) {
  const { canvas, surface, block, forces } = plan;
  const background = options.background ?? '#ffffff';
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`);
  parts.push(rect(0, 0, canvas.width, canvas.height, { fill: background }));

  // surface
  if (surface.kind === 'incline') {
    parts.push(polygon(surface.poly, { fill: '#e8e4dc', stroke: '#555', strokeWidth: 2 }));
    // hatch the inner edge (hypotenuse) is skipped; draw angle arc at the base-left vertex
    const [v0, v1] = surface.poly; // v0 = (0,0) world base-left, v1 = base-right
    // canvas angle of hypotenuse (v0 -> v2): compute from poly
    const v2 = surface.poly[2];
    const hypAngle = Math.atan2(v2.y - v0.y, v2.x - v0.x) * 180 / Math.PI; // canvas, y down
    parts.push(angleArc(v0.x, v0.y, 0, hypAngle, 34, `${surface.angleDeg}\u00b0`));
  } else {
    parts.push(polygon(surface.poly, { fill: '#e8e4dc', stroke: '#555', strokeWidth: 2 }));
    // hatch marks along the top edge
    const [a, b] = surface.poly;
    const n = 12;
    let hatch = '';
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const hx = a.x + (b.x - a.x) * t;
      const hy = a.y + (b.y - a.y) * t;
      hatch += line(hx, hy, hx - 10, hy + 10, { stroke: '#777', strokeWidth: 1.2 });
    }
    parts.push(hatch);
  }

  // block
  parts.push(polygon(block.poly, { fill: '#9fc2e8', stroke: '#23486b', strokeWidth: 2 }));
  const massLabel = plan.solved?.body?.label;
  parts.push(text(block.center.x, block.center.y + 5, massLabel ?? '', { fill: '#123', fontSize: 15, fontWeight: 600 }));

  // forces
  for (const f of forces) {
    parts.push(forceArrow(f, options));
  }

  parts.push('</svg>');
  return parts.join('\n');
}
