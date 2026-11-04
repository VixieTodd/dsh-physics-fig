// dsh-physics-fig entry: registers three model-facing tools.
//   physics_fig_schema  — fetch the PhysicsScene JSON schema + vocabulary + example
//   physics_fig_check   — validate a scene without rendering
//   physics_fig_render  — solve, check, layout, render → SVG file + inline SVG code
//
// Design contract: the plugin is a deterministic backend. It never calls an LLM,
// never accepts coordinates/angles/arrow lengths from the model, and never writes
// a file unless every physics invariant passed.

import { createRequire } from 'node:module';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateSceneStructure, SCENE_JSON_SCHEMA, SCENE_EXAMPLE, VOCABULARY, SCHEMA_VERSION } from './schema.js';
import { solveScene } from './solve.js';
import { pipeline } from './pipeline.js';

const require = createRequire(import.meta.url);

function defineToolFallback() {
  throw new Error(
    'dsh-physics-fig: @deepseek-ai/dsh-tools is not resolvable. This plugin must run inside a DSH host (it is loaded as a profile bundle); for tests, run node --conditions=dsh-stub.',
  );
}

let defineTool = defineToolFallback;
try {
  ({ defineTool } = require('@deepseek-ai/dsh-tools'));
} catch {
  try {
    const mod = await import('#dsh-tools');
    ({ defineTool } = mod);
  } catch {
    // keep fallback; host must provide it
  }
}

// ---------- fs helpers (mirror dsh-office-tools access patterns) ----------

async function resolveWritePolicy(ctx, exec) {
  if (ctx.fs?.sandboxMode === undefined) return undefined;
  const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
  if (service === undefined || service === null) {
    throw new Error('physics-fig tools: the mounted filesystem confines but ctx.sandboxPolicy is missing');
  }
  if (typeof service.resolve !== 'function') return undefined;
  return service.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
}

function workspaceRootOf(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  if (cwd === undefined || cwd === '') {
    throw new Error('physics-fig tools require an active session with a working directory (session.header.cwd is empty)');
  }
  return resolve(cwd);
}

function displayPathOf(root, absolute) {
  const rel = relative(root, absolute);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute;
}

function assertLexicallyWithin(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${candidate}" escapes the session workspace "${root}"`);
  }
}

async function resolveFigPath(exec, ctx, rawPath, allowedExts, mustExist, writePolicy) {
  exec.signal.throwIfAborted();
  if (rawPath.trim() === '') throw new Error('path must be a non-empty string');
  const root = workspaceRootOf(exec);
  const effectiveRoot = writePolicy?.workspaceRoot ? resolve(writePolicy.workspaceRoot) : root;
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : join(effectiveRoot, rawPath));
  assertLexicallyWithin(effectiveRoot, candidate);
  const ext = extname(candidate).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(' or ')} file, got extension "${ext || '(none)'}"`);
  }
  const fs = ctx.fs;
  const rootTarget = await fs.resolve('.', { cwd: effectiveRoot, signal: exec.signal });
  const target = await fs.resolve(rawPath, { cwd: effectiveRoot, signal: exec.signal });
  if (!fs.contains(rootTarget, target)) {
    throw new Error(`path "${rawPath}" escapes the session workspace "${root}"`);
  }
  if (mustExist) {
    const info = await fs.stat(target, exec.signal);
    if (info === undefined) throw new Error(`"${rawPath}" does not exist`);
    if (info.type !== 'file') throw new Error(`"${rawPath}" is not a regular file`);
  }
  const absolute = fs.processPath(target);
  return { target, absolute, display: displayPathOf(root, absolute), ext };
}

async function assertMayCreate(exec, ctx, target, overwrite) {
  if (overwrite) return;
  const info = await ctx.fs.stat(target, exec.signal);
  if (info !== undefined) {
    throw new Error('the target already exists; pass overwrite: true to replace it');
  }
}

// ---------- tool 1: physics_fig_schema ----------

function registerSchemaTool(ctx) {
  return ctx.tools.register(defineTool({
    name: 'physics_fig_schema',
    description:
      'Get the PhysicsScene JSON schema, its controlled vocabulary, and a filled example for physics illustration rendering. Call this BEFORE building a scene, so every field and enum value is legal. The scene describes only topology and given quantities (bodies, surfaces, constraints, declared force types); the plugin computes all directions, angles, and magnitudes deterministically.',
    parameters: {
      topic: {
        type: 'string',
        enum: ['free_body'],
        description: 'Which scene family to fetch. v0.1 supports free_body (block on ground/incline).',
      },
    },
    output: {
      render: (_args, value) => [{
        type: 'text',
        text: `PhysicsScene schema v${SCHEMA_VERSION} (topic: ${value.topic}). Vocabulary: ${Object.entries(value.vocabulary).map(([k, v]) => `${k}=[${v.join('|')}]`).join(' ')}. Full JSON schema and example are in the structured output.`,
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Physics scene schema (${args.topic ?? 'free_body'})`,
      kind: 'read',
      locations: [],
    }),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return {
        topic: args.topic ?? 'free_body',
        schemaVersion: SCHEMA_VERSION,
        vocabulary: VOCABULARY,
        jsonSchema: SCENE_JSON_SCHEMA,
        example: SCENE_EXAMPLE,
        notes: [
          'Forces declare only their source type; direction/magnitude fields do not exist in the schema by design.',
          'Angles (e.g. incline angle) go in surfaces[].angle_deg; the solver derives everything else.',
          'Static scenes are checked for equilibrium closure (ΣF=0) and friction consistency (f≤μN).',
        ],
      };
    },
  }));
}

// ---------- tool 2: physics_fig_check ----------

function registerCheckTool(ctx) {
  return ctx.tools.register(defineTool({
    name: 'physics_fig_check',
    description:
      'Validate a PhysicsScene without rendering: structural schema checks plus physics solving (equilibrium closure, friction consistency). Returns a list of passed/failed checks; failures carry a schemaPath so the model can patch the scene minimally. Use before physics_fig_render to save a round trip.',
    parameters: {
      scene: {
        type: 'object',
        required: true,
        description: 'The PhysicsScene object (see physics_fig_schema).',
      },
    },
    output: {
      render: (_args, value) => [{
        type: 'text',
        text: value.valid
          ? `Scene valid: ${value.checks.filter((c) => c.ok).length} check(s) passed.`
          : `Scene invalid (${value.errors.length} error(s)):\n` + value.errors.map((e) => `- [${e.code}] ${e.schemaPath}: ${e.hint ?? e.expected}${e.actual ? ` (got: ${e.actual})` : ''}`).join('\n'),
      }],
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Check physics scene',
      kind: 'read',
      locations: [],
    }),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const structure = validateSceneStructure(args.scene);
      const checks = [];
      for (const e of structure.errors) checks.push({ code: e.code, ok: false, detail: `${e.schemaPath}: ${e.hint ?? e.expected}` });
      if (structure.errors.length === 0) {
        const solved = solveScene(args.scene);
        if (solved.errors) {
          for (const e of solved.errors) checks.push({ code: e.code, ok: false, detail: `${e.schemaPath}: ${e.hint ?? e.expected}` });
        } else {
          checks.push({ code: 'solve', ok: true, detail: 'scene solved; all declared forces derived' });
        }
      }
      // run full pipeline checks without writing anything
      const result = pipeline(args.scene);
      const valid = result.status === 'ok';
      return {
        valid,
        errors: valid ? [] : result.errors,
        checks: result.checks,
      };
    },
  }));
}

// ---------- tool 3: physics_fig_render ----------

function registerRenderTool(ctx) {
  return ctx.tools.register(defineTool({
    name: 'physics_fig_render',
    description:
      'Render a PhysicsScene into a physics-correct SVG force diagram and write it to a .svg file in the session workspace. The plugin deterministically computes every force direction, magnitude, and geometry; the model supplies only the scene (bodies/surfaces/constraints/declared forces). Returns the SVG source inline so it can be embedded directly into documents or chat replies. On any failed physics check, nothing is written and structured errors with schemaPath are returned instead.',
    parameters: {
      scene: {
        type: 'object',
        required: true,
        description: 'The PhysicsScene object (see physics_fig_schema).',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Output .svg path, relative to the session workspace.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false.',
      },
      options: {
        type: 'object',
        description: 'Rendering options (canvas size, colors). Never includes physics-affecting parameters.',
        properties: {
          width: { type: 'integer', description: 'Canvas width in px (default 640).' },
          height: { type: 'integer', description: 'Canvas height in px (default 480).' },
          background: { type: 'string', description: 'Canvas background color (default #ffffff).' },
        },
        additionalProperties: false,
      },
    },
    output: {
      render: (_args, value) => {
        if (value.status === 'ok') {
          return [{ type: 'text', text: `Rendered physics diagram to ${value.path} (${value.sizeBytes} bytes; ${value.checks.filter((c) => c.ok).length}/${value.checks.length} checks passed). SVG source is in the structured output for direct embedding.` }];
        }
        return [{ type: 'text', text: `Render refused (${value.errors.length} error(s)) — no file written:\n` + value.errors.map((e) => `- [${e.code}] ${e.schemaPath}: ${e.hint ?? e.expected}${e.actual ? ` (got: ${e.actual})` : ''}`).join('\n') }];
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Render physics figure ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec) {
      const writePolicy = await resolveWritePolicy(ctx, exec);
      const target = await resolveFigPath(exec, ctx, args.path, ['.svg'], false, writePolicy);
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false);
      exec.signal.throwIfAborted();

      const result = pipeline(args.scene, args.options ?? {});
      if (result.status !== 'ok') {
        return { status: 'invalid', errors: result.errors, checks: result.checks };
      }

      exec.signal.throwIfAborted();
      await ctx.fs.writeText(target.target, result.svg, undefined, exec.signal, writePolicy);
      const sizeBytes = Buffer.byteLength(result.svg, 'utf-8');
      return {
        status: 'ok',
        path: target.display,
        sizeBytes,
        svgCode: result.svg,
        checks: result.checks,
        sceneDigest: {
          bodies: result.solved.body ? [result.solved.body.id] : [],
          surface: result.solved.surface?.id,
          forceCount: result.solved.forces?.length ?? 0,
        },
      };
    },
  }));
}

// ---------- cordis entry ----------

var name = 'dsh-physics-fig';
var inject = ['tools', 'fs'];
var Config = null; // no configuration yet; schemastery z when needed

function apply(ctx, _config) {
  ctx.effect(() => {
    const disposers = [
      registerSchemaTool(ctx),
      registerCheckTool(ctx),
      registerRenderTool(ctx),
    ];
    return () => disposers.forEach((dispose) => dispose());
  });
}

export { name, inject, Config, apply };
