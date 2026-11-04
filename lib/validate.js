// L5 validate: post-solve physics invariants + post-layout geometry assertions.
// Every check returns { code, ok, detail } and is independently executable.

import { checkEquilibriumClosure, checkFrictionConsistency } from './solve.js';

export function validateSolved(solved) {
  const checks = [];
  const closure = checkEquilibriumClosure(solved);
  checks.push({ code: 'equilibrium-closure', ok: closure.ok, detail: closure.detail });
  const friction = checkFrictionConsistency(solved);
  checks.push({ code: 'friction-consistency', ok: friction.ok, detail: friction.detail.join('; ') });
  // applied forces must have finite positive magnitude
  for (const f of solved.forces) {
    if (!Number.isFinite(f.magnitudeN) || f.magnitudeN <= 0) {
      checks.push({ code: 'force-magnitude', ok: false, detail: `force ${f.label} has non-positive/non-finite magnitude ${f.magnitudeN}` });
    }
  }
  return checks;
}

export function validateLayout(plan) {
  const checks = [];
  const { canvas, forces, block, surface } = plan;
  // labels within canvas
  for (const f of forces) {
    if (f.x1 < 0 || f.x1 > canvas.width || f.y1 < 0 || f.y1 > canvas.height) {
      checks.push({ code: 'label-in-canvas', ok: false, detail: `force ${f.label} arrow tip (${f.x1.toFixed(0)}, ${f.y1.toFixed(0)}) leaves the ${canvas.width}x${canvas.height} canvas` });
    }
  }
  // arrow length monotonicity: longer arrow <=> larger magnitude (within rounding)
  const sortedByMag = [...forces].sort((a, b) => a.magnitudeN - b.magnitudeN);
  const sortedByLen = [...forces].sort((a, b) => a.canvasLen - b.canvasLen);
  let monotonic = true;
  for (let i = 0; i < forces.length; i++) {
    if (sortedByMag[i].label !== sortedByLen[i].label) { monotonic = false; break; }
  }
  // equal-magnitude forces may tie in length; only strict ordering violations fail
  for (let i = 1; i < forces.length; i++) {
    const a = sortedByMag[i - 1], b = sortedByMag[i];
    const la = sortedByLen[i - 1].canvasLen, lb = sortedByLen[i].canvasLen;
    if (b.magnitudeN > a.magnitudeN && lb < la) { monotonic = false; break; }
  }
  checks.push({ code: 'arrow-length-monotonic', ok: monotonic, detail: monotonic ? 'arrow length strictly respects magnitude ordering' : 'arrow length ordering contradicts magnitude ordering' });
  // force origin at block center
  for (const f of forces) {
    const d = Math.hypot(f.x0 - block.center.x, f.y0 - block.center.y);
    if (d > 0.5) {
      checks.push({ code: 'force-origin', ok: false, detail: `force ${f.label} originates ${d.toFixed(1)}px away from the block center` });
    }
  }
  return checks;
}

export function allPassed(checks) {
  return checks.every((c) => c.ok);
}
