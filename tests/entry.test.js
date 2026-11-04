// Smoke test: load the plugin entry with the dsh-stub condition, register tools into
// a mock cordis ctx, and drive physics_fig_render end-to-end (mock ctx.fs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('plugin registers 3 tools and renders via mock ctx', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'dsh-physics-fig');
  assert.deepEqual(mod.inject, ['tools', 'fs']);

  const registered = [];
  const written = new Map(); // raw path -> text
  const targetCache = new Map(); // path -> stable fs target object
  const targetFor = (raw) => {
    if (!targetCache.has(raw)) targetCache.set(raw, { target: raw });
    return targetCache.get(raw);
  };
  const keyOf = (p) => (typeof p === 'object' && p !== null ? p.target : p);
  const workspace = mkdtempSync(join(tmpdir(), 'physfig-'));
  mkdirSync(join(workspace, 'sub'), { recursive: true });

  const ctx = {
    tools: {
      register(def) {
        registered.push(def.name);
        return () => {};
      },
    },
    fs: {
      sandboxMode: 'workspace-write',
      resolve: async (raw) => targetFor(raw),
      processPath: (t) => resolve(workspace, t.target ?? t),
      contains: () => true,
      stat: async (p) => (written.has(keyOf(p)) ? { type: 'file', size: written.get(keyOf(p)).length } : undefined),
      writeText: async (p, text) => { written.set(keyOf(p), text); },
    },
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => undefined } : undefined),
    effect: (fn) => fn(),
  };

  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: workspace } } },
  };

  mod.apply(ctx, undefined);
  assert.deepEqual([...registered].sort(), ['physics_fig_check', 'physics_fig_render', 'physics_fig_schema']);

  // drive the render tool manually through the same defineTool stub path
  const renderDef = registered.find((n) => n === 'physics_fig_render');
  assert.ok(renderDef && typeof renderDef === 'string');
  // fetch definitions from the mock register (we stored names; re-register capturing defs)
  const defs = [];
  ctx.tools.register = (def) => { defs.push(def); return () => {}; };
  mod.apply(ctx, undefined);
  const render = defs.find((d) => d.name === 'physics_fig_render');
  const check = defs.find((d) => d.name === 'physics_fig_check');
  const schema = defs.find((d) => d.name === 'physics_fig_schema');

  // schema tool
  const schemaOut = await schema.execute({ topic: 'free_body' }, exec);
  assert.equal(schemaOut.schemaVersion, '1.0.0');
  assert.ok(schemaOut.jsonSchema.properties.forces);

  // check tool: valid scene
  const scene = structuredClone(schemaOut.example);
  const checkOut = await check.execute({ scene }, exec);
  assert.equal(checkOut.valid, true);

  // render tool: writes the svg file (mock keys by the raw path)
  const out = await render.execute({ scene, path: 'fig.svg' }, exec);
  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.ok(out.svgCode.startsWith('<svg'));
  assert.equal(written.size, 1);
  assert.ok([...written.values()][0].startsWith('<svg'));

  // render tool: invalid scene → no write
  const badScene = structuredClone(scene);
  badScene.bodies[0].kind = 'sphere';
  const badOut = await render.execute({ scene: badScene, path: 'bad.svg' }, exec);
  assert.equal(badOut.status, 'invalid');
  assert.ok(badOut.errors.length > 0);
  assert.equal(written.size, 1);

  // render tool: refuses to overwrite without flag
  await assert.rejects(
    async () => render.execute({ scene, path: 'fig.svg' }, exec),
    /already exists/,
  );
  const out2 = await render.execute({ scene, path: 'fig.svg', overwrite: true }, exec);
  assert.equal(out2.status, 'ok');
});
