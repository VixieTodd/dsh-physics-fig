// Unit tests for the deterministic pipeline (no host required).
// Run: node --conditions=dsh-stub --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSceneStructure, SCENE_EXAMPLE } from '../lib/schema.js';
import { solveScene } from '../lib/solve.js';
import { pipeline } from '../lib/pipeline.js';

const theta30 = structuredClone(SCENE_EXAMPLE);

test('example scene passes structural validation', () => {
  const { errors } = validateSceneStructure(theta30);
  assert.deepEqual(errors, []);
});

test('example scene solves: three forces, static equilibrium closure', () => {
  const result = solveScene(theta30);
  assert.equal(result.errors, undefined);
  const { solved } = result;
  assert.equal(solved.forces.length, 3);
  const byType = Object.fromEntries(solved.forces.map((f) => [f.type, f]));
  // gravity down (270), normal at theta+90=120, friction up-slope (30)
  assert.equal(byType.gravity.angleDeg, 270);
  assert.equal(byType.normal.angleDeg, 120);
  assert.equal(byType.friction.angleDeg, 30);
  // N = mg cos30, f = mg sin30 for m=2, g=9.8
  assert.ok(Math.abs(byType.normal.magnitudeN - 2 * 9.8 * Math.cos(Math.PI / 6)) < 1e-9);
  assert.ok(Math.abs(byType.friction.magnitudeN - 2 * 9.8 * 0.5) < 1e-9);
  // closure: sum of vectors ~ 0
  let fx = 0, fy = 0;
  for (const f of solved.forces) {
    fx += f.magnitudeN * Math.cos((f.angleDeg * Math.PI) / 180);
    fy += f.magnitudeN * Math.sin((f.angleDeg * Math.PI) / 180);
  }
  assert.ok(Math.hypot(fx, fy) < 1e-9);
});

test('full pipeline renders SVG', () => {
  const result = pipeline(theta30);
  assert.equal(result.status, 'ok');
  assert.ok(result.svg.startsWith('<svg'));
  assert.ok(result.svg.includes('</svg>'));
  assert.ok(result.checks.length >= 3);
  assert.ok(result.checks.every((c) => c.ok), JSON.stringify(result.checks));
});

test('missing friction on rough static incline is an error (mu >= tanθ)', () => {
  // mu=0.5, θ=30°: tan30 = 0.577 > 0.5 → static premise fails
  const scene = structuredClone(theta30);
  scene.surfaces[0].friction = { mu_static: 0.5 };
  // (already 0.5) — so make angle steep instead
  scene.surfaces[0].angle_deg = 40;
  scene.given_quantities = [{ name: 'theta', value: 40, unit: 'deg' }];
  const result = solveScene(scene);
  assert.ok(result.errors);
  assert.equal(result.errors[0].code, 'physics-invariant');
  assert.ok(result.errors[0].schemaPath.includes('state'));
});

test('friction declared on frictionless surface is rejected', () => {
  const scene = structuredClone(theta30);
  scene.surfaces[0].friction = {};
  const result = solveScene(scene);
  assert.ok(result.errors);
  assert.equal(result.errors[0].code, 'physics-invariant');
});

test('missing gravity on massive body is rejected', () => {
  const scene = structuredClone(theta30);
  scene.forces = scene.forces.filter((f) => f.type !== 'gravity');
  const result = pipeline(scene);
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.code === 'missing-force'));
});

test('structural errors are schemaPath-precise', () => {
  const scene = structuredClone(theta30);
  scene.forces[1].from = 'nonexistent';
  const { errors } = validateSceneStructure(scene);
  assert.ok(errors.some((e) => e.schemaPath === '$.forces[1].from' && e.code === 'reference'));
});

test('unknown enum value is rejected', () => {
  const scene = structuredClone(theta30);
  scene.bodies[0].kind = 'sphere';
  const { errors } = validateSceneStructure(scene);
  assert.ok(errors.some((e) => e.code === 'enum'));
});

test('angle_deg forbidden on ground surface', () => {
  const scene = structuredClone(theta30);
  scene.surfaces[0].kind = 'ground';
  const { errors } = validateSceneStructure(scene);
  assert.ok(errors.some((e) => e.code === 'forbidden' && e.schemaPath === '$.surfaces[0].angle_deg'));
});

test('contact without normal force is rejected', () => {
  const scene = structuredClone(theta30);
  scene.forces = scene.forces.filter((f) => f.type !== 'normal');
  const result = pipeline(scene);
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.code === 'missing-force'));
});

test('sliding scene renders with kinetic friction up-slope', () => {
  const scene = structuredClone(theta30);
  scene.bodies[0].position.state = 'sliding';
  scene.surfaces[0].friction = { mu_kinetic: 0.3 };
  scene.forces = scene.forces.filter((f) => f.type === 'friction' || true);
  const result = solveScene(scene);
  assert.equal(result.errors, undefined);
  const f = result.solved.forces.find((x) => x.type === 'friction');
  assert.equal(f.angleDeg, 30); // up-slope
  assert.ok(Math.abs(f.magnitudeN - 0.3 * 2 * 9.8 * Math.cos(Math.PI / 6)) < 1e-9);
});

test('flat ground scene: gravity 270, normal 90, no angle arc', () => {
  const scene = {
    schema_version: '1.0',
    frame: { units: 'SI', gravity: 'down', coord: 'x-horizontal' },
    bodies: [{ id: 'b1', kind: 'block', mass_kg: 3, position: { on: 'g1', state: 'static' } }],
    surfaces: [{ id: 'g1', kind: 'ground', friction: {} }],
    constraints: [{ type: 'contact', body: 'b1', surface: 'g1' }],
    forces: [
      { type: 'gravity', on: 'b1' },
      { type: 'normal', on: 'b1', from: 'g1' },
    ],
    given_quantities: [],
    question_type: 'free_body',
  };
  const result = pipeline(scene);
  assert.equal(result.status, 'ok');
  const byType = Object.fromEntries(result.solved.forces.map((f) => [f.type, f]));
  assert.equal(byType.gravity.angleDeg, 270);
  assert.equal(byType.normal.angleDeg, 90);
});
