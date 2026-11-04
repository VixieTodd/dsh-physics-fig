// L2 physics solver: derives force directions (angles) and relative magnitudes
// from the scene's constraint rules. Pure deterministic code; no LLM, no numerics
// beyond closed-form expressions. Angle convention: math standard, CCW from +x, degrees.
//   gravity: 270deg (down). incline angle theta (rise to the right).
//   For a block resting on the incline:
//     normal: perpendicular to the surface, pointing away from it => 90deg - ... in world frame:
//     surface tangent = theta above horizontal (unit (cos t, sin t)).
//     Surface normal (out of the slope, up-left) = (cos(t+90), sin(t+90)) = 90+theta... in math CCW terms.
// We use screen-independent math angles and convert to screen y-down in render.js.

const G = 9.8; // m/s^2, SI only (schema enforces units: SI)

const TOL = 1e-6;

function degToRad(d) { return (d * Math.PI) / 180; }
function radToDeg(r) { return (r * 180) / Math.PI; }

function fmt(x, digits = 2) {
  const v = Number.isFinite(x) ? x : 0;
  const s = v.toFixed(digits);
  return s === '-0' + (digits > 0 ? '.' + '0'.repeat(digits) : '') ? (0).toFixed(digits) : s;
}

// Solve a single-body scene: block on one surface (ground or incline).
// Returns { solved: SolvedScene } or { errors: [...] } with schemaPath-precise failures.
export function solveScene(scene) {
  const errors = [];
  const bodies = scene.bodies;
  if (bodies.length !== 1) {
    return { errors: [{ code: 'unsupported', schemaPath: '$.bodies', expected: 'exactly 1 body (v0.1 supports single-body free-body diagrams)', actual: `${bodies.length}`, hint: 'Split the problem into per-body free-body diagram scenes.' }] };
  }
  const body = bodies[0];
  const surfaces = new Map((scene.surfaces ?? []).map((s) => [s.id, s]));
  const surface = surfaces.get(body.position.on);
  if (!surface) {
    return { errors: [{ code: 'reference', schemaPath: '$.bodies[0].position.on', expected: 'known surface id', actual: body.position.on }] };
  }

  const theta = surface.kind === 'incline' ? surface.angle_deg : 0; // degrees
  const state = body.position.state ?? 'static';
  const mass = body.mass_kg ?? 1;
  const muStatic = surface.friction?.mu_static ?? 0;
  const muKinetic = surface.friction?.mu_kinetic ?? muStatic;

  // World-frame directions (math CCW, degrees):
  //  - gravity: 270
  //  - incline tangent (up-slope): theta
  //  - surface normal (outward): theta + 90
  const gravityAngle = 270;
  const upSlopeAngle = theta;
  const normalAngle = theta + 90;

  const forces = [];
  const addForce = (spec, angleDeg, magnitudeN, label, note) => {
    forces.push({
      type: spec.type,
      on: spec.on,
      from: spec.from,
      label: spec.label ?? label,
      angleDeg: ((angleDeg % 360) + 360) % 360,
      magnitudeN,
      note,
      origin: 'computed',
    });
  };

  // Gather declared forces; check for unknown/extra declarations the solver cannot honor.
  const declared = scene.forces;
  const has = (type) => declared.some((f) => f.type === type);
  const declOf = (type) => declared.filter((f) => f.type === type);

  const computed = [];

  // gravity
  const gravitySpecs = declOf('gravity');
  if (gravitySpecs.length > 0) {
    const W = mass * G;
    for (const spec of gravitySpecs) {
      addForce(spec, gravityAngle, W, 'G', `W = m·g = ${mass} kg × ${G} m/s² = ${fmt(W)} N`);
    }
  }

  // normal
  const normalSpecs = declOf('normal');
  if (normalSpecs.length > 0) {
    // For a block at rest on incline (no other vertical loads): N = m g cosθ
    const N = mass * G * Math.cos(degToRad(theta));
    for (const spec of normalSpecs) {
      addForce(spec, normalAngle, N, 'N', `N = m·g·cosθ = ${fmt(N)} N`);
    }
  }

  // friction
  const frictionSpecs = declOf('friction');
  if (frictionSpecs.length > 0) {
    if (muStatic === 0 && muKinetic === 0) {
      for (const [i, spec] of frictionSpecs.entries()) {
        errors.push({ code: 'physics-invariant', schemaPath: `$.forces[${declared.indexOf(spec)}]`, expected: 'no friction force on a frictionless surface (mu = 0)', actual: 'friction declared', hint: 'Remove the friction force, or set surfaces[].friction.mu_* above 0.' });
      }
    } else if (state === 'static') {
      // Static equilibrium on the incline: gravity component along slope = m g sinθ.
      // Friction must exactly balance it (magnitude m g sinθ, direction up-slope),
      // and must satisfy f <= mu_s * N; otherwise the "static" premise is inconsistent.
      const fNeeded = mass * G * Math.sin(degToRad(theta));
      const fMax = muStatic * (mass * G * Math.cos(degToRad(theta)));
      if (fNeeded > fMax + TOL) {
        errors.push({ code: 'physics-invariant', schemaPath: '$.bodies[0].position.state', expected: `mu_s >= tanθ (${fmt(Math.tan(degToRad(theta)))}) for static equilibrium`, actual: `mu_s = ${fmt(muStatic)} < tanθ — block would slide`, hint: 'Set state to "sliding", raise mu_static, or lower angle_deg.' });
      }
      for (const spec of frictionSpecs) {
        addForce(spec, upSlopeAngle, fNeeded, 'f', `f = m·g·sinθ = ${fmt(fNeeded)} N (balances gravity along slope)`);
      }
    } else {
      // sliding: kinetic friction opposes motion. Down-slope gravity (if theta>0) slides the
      // block down, so friction points up-slope with magnitude mu_k * N.
      const fKin = muKinetic * mass * G * Math.cos(degToRad(theta));
      for (const spec of frictionSpecs) {
        addForce(spec, upSlopeAngle, fKin, 'f', `f = μ_k·N = ${fmt(fKin)} N (kinetic, opposes sliding)`);
      }
    }
  }

  // applied / tension: v0.1 only supports a known-magnitude force along the slope
  const appliedSpecs = declOf('applied').concat(declOf('tension'));
  for (const spec of appliedSpecs) {
    const idx = declared.indexOf(spec);
    if (spec.magnitude === undefined) {
      errors.push({ code: 'required', schemaPath: `$.forces[${idx}].magnitude`, expected: 'present (N) for applied/tension forces', actual: 'missing', hint: 'v0.1 requires a known magnitude for applied/tension forces.' });
      continue;
    }
    const hintDir = spec.direction_hint === 'down-slope' ? theta + 180 : theta;
    addForce(spec, hintDir, spec.magnitude, spec.label ?? (spec.type === 'tension' ? 'T' : 'F'),
      `${spec.type === 'tension' ? 'T' : 'F'} = ${fmt(spec.magnitude)} N (given)`);
  }

  // Declared gravity missing but body has mass: gravity is mandatory for massive bodies.
  if ((body.mass_kg ?? 0) > 0 && !has('gravity')) {
    errors.push({ code: 'missing-force', schemaPath: '$.forces', expected: 'a gravity force on the massive body', actual: 'absent', hint: 'Every massive body must have gravity declared.' });
  }
  // Contact constraint without normal force.
  const contactOnSurface = (scene.constraints ?? []).some((c) => c.type === 'contact' && c.body === body.id);
  if (contactOnSurface && normalSpecs.length === 0) {
    errors.push({ code: 'missing-force', schemaPath: '$.forces', expected: `a normal force from ${surface.id}`, actual: 'absent', hint: 'Contact with a surface implies a normal force.' });
  }

  if (errors.length > 0) return { errors };

  return {
    solved: {
      schemaVersion: SCHEMA_VERSION_PLACEHOLDER(),
      questionType: scene.question_type,
      body: {
        id: body.id,
        label: body.label ?? body.id,
        massKg: body.mass_kg ?? null,
        state,
      },
      surface: {
        id: surface.id,
        kind: surface.kind,
        angleDeg: theta,
        muStatic,
        muKinetic,
      },
      forces,
    },
  };
}

function SCHEMA_VERSION_PLACEHOLDER() { return '1.0'; }

// Static-equilibrium closure check: sum of force vectors must close (within tolerance).
// Returns { ok, residualN, detail }.
export function checkEquilibriumClosure(solvedScene) {
  if (solvedScene.body.state !== 'static') return { ok: true, residualN: 0, detail: 'not a static scene; closure check skipped' };
  let fx = 0, fy = 0;
  for (const f of solvedScene.forces) {
    fx += f.magnitudeN * Math.cos(degToRad(f.angleDeg));
    fy += f.magnitudeN * Math.sin(degToRad(f.angleDeg));
  }
  const residual = Math.hypot(fx, fy);
  const total = solvedScene.forces.reduce((s, f) => s + f.magnitudeN, 0) || 1;
  const relative = residual / total;
  const ok = relative < 1e-3;
  return {
    ok,
    residualN: residual,
    detail: ok
      ? `ΣF = 0 (residual ${fmt(residual, 3)} N, relative ${fmt(relative, 5)})`
      : `ΣF ≠ 0: residual ${fmt(residual, 3)} N (relative ${fmt(relative, 5)}); forces do not close`,
  };
}

// Friction self-consistency: f <= mu*N, and presence pairing.
export function checkFrictionConsistency(solvedScene) {
  const out = { ok: true, detail: [] };
  const friction = solvedScene.forces.filter((f) => f.type === 'friction');
  const normal = solvedScene.forces.filter((f) => f.type === 'normal');
  if (friction.length > 0 && normal.length === 0) {
    out.ok = false;
    out.detail.push('friction without a normal force on the same body');
  }
  for (const f of friction) {
    const n = normal[0]?.magnitudeN ?? 0;
    const mu = solvedScene.body.state === 'static' ? solvedScene.surface.muStatic : solvedScene.surface.muKinetic;
    if (f.magnitudeN > mu * n + 1e-9) {
      out.ok = false;
      out.detail.push(`f = ${fmt(f.magnitudeN)} N > μ·N = ${fmt(mu * n)} N`);
    }
  }
  if (out.ok && friction.length > 0) {
    out.detail.push(`f ≤ μ·N holds (${fmt(friction[0].magnitudeN)} N ≤ ${fmt((solvedScene.body.state === 'static' ? solvedScene.surface.muStatic : solvedScene.surface.muKinetic) * (normal[0]?.magnitudeN ?? 0))} N)`);
  }
  return out;
}

export const SOLVER_CONSTANTS = { G };
