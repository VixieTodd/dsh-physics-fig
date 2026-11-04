// L3 layout: assigns world coordinates to bodies/surfaces, then maps world → canvas
// via a uniform affine transform. Deterministic: same scene in, same coordinates out.
// World frame: x right, y UP (math frame); surface incline rises to the right.
// Canvas frame: y down (SVG). The transform flips y once, here, and nowhere else.

import { FORCE_LABELS } from './schema.js';

const WORLD_MARGIN = 1.0; // world units of padding around content
const CANVAS_DEFAULT = { width: 640, height: 480 };

function degToRad(d) { return (d * Math.PI) / 180; }

export function layoutScene(solved, options = {}) {
  const canvas = { width: options.width ?? CANVAS_DEFAULT.width, height: options.height ?? CANVAS_DEFAULT.height };

  // Scene geometry in world units (meters-ish, arbitrary but consistent):
  //   ground: horizontal segment from (0,0) to (L,0)
  //   incline: right triangle, base (0,0)-(B,0), apex (0? ) — rise to the RIGHT:
  //     hypotenuse from (x0,0) to (x0 + run, rise); we draw the wedge under the hypotenuse.
  const L = 8;
  const blockW = 1.6, blockH = 1.0;
  const theta = degToRad(solved.surface.angleDeg);

  let surfacePoly, contactPoint, blockCenter, blockPoly;

  if (solved.surface.kind === 'incline') {
    const run = L;
    const rise = run * Math.tan(theta);
    // wedge polygon: (0,0) -> (run,0) -> (run, rise) — hypotenuse from (0,0) to (run, rise)
    surfacePoly = [{ x: 0, y: 0 }, { x: run, y: 0 }, { x: run, y: rise }];
    const t = 0.55; // block sits at 55% along the hypotenuse
    contactPoint = { x: run * t, y: rise * t };
  } else {
    surfacePoly = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: -0.6 }, { x: 0, y: -0.6 }]; // thick ground strip
    contactPoint = { x: L * 0.5, y: 0 };
  }

  // block center: offset from contact point along surface normal (inward = +normal)
  const normal = { x: Math.cos(theta + Math.PI / 2), y: Math.sin(theta + Math.PI / 2) };
  // block is a rotated rectangle: half-diagonal approach — center is contact + h/2 along normal
  const center = { x: contactPoint.x + normal.x * (blockH / 2), y: contactPoint.y + normal.y * (blockH / 2) };
  blockCenter = center;
  // block corners in world: rectangle rotated by theta around center
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const hw = blockW / 2, hh = blockH / 2;
  const corners = [
    { dx: -hw, dy: -hh }, { dx: hw, dy: -hh }, { dx: hw, dy: hh }, { dx: -hw, dy: hh },
  ].map(({ dx, dy }) => ({
    x: center.x + dx * cosT - dy * sinT,
    y: center.y + dx * sinT + dy * cosT,
  }));
  blockPoly = corners;

  // Force arrows: all originate at the block's center of mass (standard FBD convention).
  const forceArrows = solved.forces.map((f) => ({
    ...f,
    from: { x: blockCenter.x, y: blockCenter.y },
    angleDeg: f.angleDeg, // world math frame
  }));

  // ---- world → canvas affine ----
  // Collect all points needing bounds, including arrow tips.
  const pts = [...surfacePoly, ...blockPoly];
  for (const a of forceArrows) {
    const len = arrowWorldLength(a, forceArrows);
    pts.push({ x: a.from.x + len * Math.cos(degToRad(a.angleDeg)), y: a.from.y + len * Math.sin(degToRad(a.angleDeg)) });
  }
  let minX = Math.min(...pts.map((p) => p.x)) - WORLD_MARGIN;
  let maxX = Math.max(...pts.map((p) => p.x)) + WORLD_MARGIN;
  let minY = Math.min(...pts.map((p) => p.y)) - WORLD_MARGIN;
  let maxY = Math.max(...pts.map((p) => p.y)) + WORLD_MARGIN;

  // Reserve top band for labels; add extra margin.
  const labelBand = (maxY - minY) * 0.18;
  maxY += labelBand; minY -= 0.2;

  const spanX = maxX - minX, spanY = maxY - minY;
  const scale = Math.min(canvas.width / spanX, canvas.height / spanY);
  const toCanvas = (p) => ({
    x: (p.x - minX) * scale + (canvas.width - spanX * scale) / 2,
    y: canvas.height - ((p.y - minY) * scale + (canvas.height - spanY * scale) / 2),
  });

  return {
    canvas,
    scale,
    surface: { poly: surfacePoly.map(toCanvas), kind: solved.surface.kind, angleDeg: solved.surface.angleDeg, id: solved.surface.id },
    block: { poly: blockPoly.map(toCanvas), center: toCanvas(blockCenter), contact: toCanvas(contactPoint) },
    forces: forceArrows.map((a) => {
      const len = arrowWorldLength(a, forceArrows);
      const worldTip = { x: a.from.x + len * Math.cos(degToRad(a.angleDeg)), y: a.from.y + len * Math.sin(degToRad(a.angleDeg)) };
      const c0 = toCanvas(a.from);
      const c1 = toCanvas(worldTip);
      return {
        ...a,
        x0: c0.x, y0: c0.y, x1: c1.x, y1: c1.y,
        canvasLen: Math.hypot(c1.x - c0.x, c1.y - c0.y),
      };
    }),
  };
}

// Arrow length policy: length ∝ |F| with a single global scale, plus minimum visible
// length. The ONLY source of length is magnitude — no manual tweaking possible.
function arrowWorldLength(force, all) {
  const maxMag = Math.max(...all.map((f) => f.magnitudeN), 1e-9);
  const maxLen = 2.2; // world units for the largest force
  const minLen = 0.9;
  return Math.max(minLen, (force.magnitudeN / maxMag) * maxLen);
}
