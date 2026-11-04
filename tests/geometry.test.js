// Geometric assertions on the rendered SVG plan (canvas coordinates, y down):
// the *picture* must agree with the *physics*. This is the "golden" visual regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pipeline } from '../lib/pipeline.js';
import { layoutScene } from '../lib/layout.js';
import { SCENE_EXAMPLE } from '../lib/schema.js';

const DEG = Math.PI / 180;

test('rendered arrow geometry matches physics (canvas frame)', () => {
  const r = pipeline(structuredClone(SCENE_EXAMPLE));
  assert.equal(r.status, 'ok');
  // Re-derive layout to inspect canvas coordinates
  const plan2 = layoutScene(r.solved);
  const byType = Object.fromEntries(plan2.forces.map((f) => [f.type, f]));

  // gravity: straight down on canvas => dx = 0, dy > 0
  const g = byType.gravity;
  assert.ok(Math.abs(g.x1 - g.x0) < 1e-6, 'gravity must be vertical on canvas');
  assert.ok(g.y1 > g.y0, 'gravity must point down (canvas y grows downward)');

  // normal: perpendicular to the incline surface. Surface direction on canvas:
  const [s0, , s2] = plan2.surface.poly;
  const surfDx = s2.x - s0.x, surfDy = s2.y - s0.y;
  const n = byType.normal;
  const nDx = n.x1 - n.x0, nDy = n.y1 - n.y0;
  const dot = surfDx * nDx + surfDy * nDy;
  const nLen = Math.hypot(nDx, nDy) * Math.hypot(surfDx, surfDy);
  assert.ok(Math.abs(dot / nLen) < 1e-6, 'normal must be perpendicular to the surface');

  // friction: parallel to surface, pointing up-slope (away from the wedge interior)
  const f = byType.friction;
  const fDx = f.x1 - f.x0, fDy = f.y1 - f.y0;
  const cross = surfDx * fDy - surfDy * fDx;
  assert.ok(Math.abs(cross) < 1e-6 * Math.hypot(surfDx, surfDy) * Math.hypot(fDx, fDy) + 1e-6, 'friction must be parallel to the surface');

  // arrows originate at block center
  for (const a of plan2.forces) {
    assert.ok(Math.hypot(a.x0 - plan2.block.center.x, a.y0 - plan2.block.center.y) < 0.5);
  }
});

test('SVG contains all three force labels and the angle annotation', () => {
  const r = pipeline(structuredClone(SCENE_EXAMPLE));
  assert.equal(r.status, 'ok');
  for (const label of ['>G<', '>N<', '>f<']) {
    assert.ok(r.svg.includes(label), `SVG must label force ${label}`);
  }
  assert.ok(r.svg.includes('30\u00b0'), 'SVG must annotate the incline angle');
});
