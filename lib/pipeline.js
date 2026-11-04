// Pipeline: scene JSON → (structure check) → solve → validate → layout → render → SVG.
// Deterministic end to end. Any failed assertion aborts before writing anything.

import { validateSceneStructure } from './schema.js';
import { solveScene } from './solve.js';
import { layoutScene } from './layout.js';
import { renderSvg } from './render.js';
import { validateSolved, validateLayout, allPassed } from './validate.js';

// Full deterministic pipeline. Returns:
//   { status: 'ok', svg, checks, solved }
//   { status: 'invalid', errors, checks }
export function pipeline(scene, renderOptions = {}) {
  const checks = [];

  // L1 structural validation
  const structure = validateSceneStructure(scene);
  for (const e of structure.errors) checks.push({ code: e.code, ok: false, detail: `${e.schemaPath}: ${e.hint ?? e.expected}` });
  if (structure.errors.length > 0) {
    return { status: 'invalid', errors: structure.errors, checks };
  }

  // L2 solve
  const solvedResult = solveScene(scene);
  if (solvedResult.errors) {
    for (const e of solvedResult.errors) checks.push({ code: e.code, ok: false, detail: `${e.schemaPath}: ${e.hint ?? e.expected}` });
    return { status: 'invalid', errors: solvedResult.errors, checks };
  }
  const solved = solvedResult.solved;

  // L5a solved-physics invariants
  const solvedChecks = validateSolved(solved);
  checks.push(...solvedChecks);
  if (!allPassed(solvedChecks)) {
    return { status: 'invalid', errors: solvedChecks.filter((c) => !c.ok).map((c) => ({ code: c.code, schemaPath: '$.forces', expected: 'physics invariant satisfied', actual: c.detail, hint: c.detail })), checks };
  }

  // L3 layout
  const plan = layoutScene(solved, renderOptions);

  // L5b layout invariants
  const layoutChecks = validateLayout(plan);
  checks.push(...layoutChecks);
  if (!allPassed(layoutChecks)) {
    return { status: 'invalid', errors: layoutChecks.filter((c) => !c.ok).map((c) => ({ code: c.code, schemaPath: '$', expected: 'layout invariant satisfied', actual: c.detail, hint: c.detail })), checks };
  }

  // L4 render
  const svg = renderSvg({ ...plan, solved }, renderOptions);

  return { status: 'ok', svg, checks, solved };
}
