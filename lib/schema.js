// PhysicsScene schema v1.0 — free_body subset (block on incline / horizontal surface).
// Controlled vocabulary: the model may only use these enum values.
// This module is pure data + pure validation; no geometry, no LLM.

export const SCHEMA_VERSION = '1.0.0';

export const VOCABULARY = {
  body_kinds: ['block'],
  surface_kinds: ['ground', 'incline', 'wall'],
  constraint_types: ['contact'],
  force_types: ['gravity', 'normal', 'friction', 'applied', 'tension'],
  question_types: ['free_body'],
  states: ['static', 'sliding'],
  coord_conventions: ['x-along-incline', 'x-horizontal'],
};

export const FORCE_LABELS = {
  gravity: 'G',
  normal: 'N',
  friction: 'f',
  applied: 'F',
  tension: 'T',
};

// Direction convention: all angles are math-standard (counterclockwise from +x axis,
// degrees), computed exclusively by solve.js. The model never writes angles.

export const SCENE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'PhysicsScene',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'frame', 'bodies', 'forces', 'question_type'],
  properties: {
    schema_version: { type: 'string', const: '1.0' },
    frame: {
      type: 'object',
      additionalProperties: false,
      required: ['units', 'gravity', 'coord'],
      properties: {
        units: { type: 'string', enum: ['SI'] },
        gravity: { type: 'string', enum: ['down'] },
        coord: { type: 'string', enum: VOCABULARY.coord_conventions },
      },
    },
    bodies: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'position'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          kind: { type: 'string', enum: VOCABULARY.body_kinds },
          mass_kg: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
          label: { type: 'string', maxLength: 16 },
          position: {
            type: 'object',
            additionalProperties: false,
            required: ['on'],
            properties: {
              on: { type: 'string', minLength: 1 },
              state: { type: 'string', enum: VOCABULARY.states },
            },
          },
        },
      },
    },
    surfaces: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          kind: { type: 'string', enum: VOCABULARY.surface_kinds },
          angle_deg: {
            type: 'number',
            minimum: 0,
            exclusiveMaximum: 90,
            description: 'Incline angle above horizontal. Required for kind=incline; must be absent otherwise.',
          },
          friction: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mu_static: { type: 'number', minimum: 0, maximum: 10 },
              mu_kinetic: { type: 'number', minimum: 0, maximum: 10 },
            },
          },
        },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'body', 'surface'],
        properties: {
          type: { type: 'string', enum: VOCABULARY.constraint_types },
          body: { type: 'string', minLength: 1 },
          surface: { type: 'string', minLength: 1 },
        },
      },
    },
    forces: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'on'],
        properties: {
          type: { type: 'string', enum: VOCABULARY.force_types },
          on: { type: 'string', minLength: 1 },
          from: { type: 'string', minLength: 1 },
          direction_hint: {
            type: 'string',
            enum: ['up-slope', 'down-slope'],
            description: 'Optional for applied forces along a slope; ignored for computed forces.',
          },
          magnitude: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Known magnitude in N for applied/tension forces only.',
          },
          label: { type: 'string', maxLength: 16 },
        },
      },
    },
    given_quantities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          value: { type: 'number' },
          unit: { type: 'string', enum: ['deg', 'kg', 'N', 'm/s2', 'kg-m'] },
        },
      },
    },
    question_type: { type: 'string', enum: VOCABULARY.question_types },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['angle_arc', 'force_label'] },
          ref: { type: 'string', maxLength: 128 },
        },
      },
    },
  },
};

export const SCENE_EXAMPLE = {
  schema_version: '1.0',
  frame: { units: 'SI', gravity: 'down', coord: 'x-along-incline' },
  bodies: [
    { id: 'block1', kind: 'block', mass_kg: 2.0, position: { on: 'incline1', state: 'static' } },
  ],
  surfaces: [
    { id: 'incline1', kind: 'incline', angle_deg: 30, friction: { mu_static: 0.7 } },
  ],
  constraints: [
    { type: 'contact', body: 'block1', surface: 'incline1' },
  ],
  forces: [
    { type: 'gravity', on: 'block1' },
    { type: 'normal', on: 'block1', from: 'incline1' },
    { type: 'friction', on: 'block1', from: 'incline1' },
  ],
  given_quantities: [{ name: 'theta', value: 30, unit: 'deg' }],
  question_type: 'free_body',
};

// ---- structural validation (hand-rolled; no external deps) ----

const DEG = '\u00b0';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pushError(errors, path, code, expected, actual, hint) {
  errors.push({ code, schemaPath: path, expected, actual: actual === undefined ? undefined : String(actual), hint });
}

function checkEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    pushError(errors, path, 'enum', `one of: ${allowed.join(', ')}`, value);
  }
}

function checkType(value, type, path, errors) {
  const ok =
    (type === 'object' && isPlainObject(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value));
  if (!ok) {
    pushError(errors, path, 'type', type, typeof value);
    return false;
  }
  return true;
}

function checkRequired(obj, keys, path, errors) {
  for (const key of keys) {
    if (obj[key] === undefined) {
      pushError(errors, `${path}.${key}`, 'required', 'present', 'missing');
    }
  }
}

function checkAdditionalProperties(obj, schema, path, errors) {
  if (schema.additionalProperties === false) {
    const allowed = Object.keys(schema.properties ?? {});
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        pushError(errors, `${path}.${key}`, 'additionalProperties', 'absent (unknown field)', 'present');
      }
    }
  }
}

function validateAgainst(value, schema, path, errors) {
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      pushError(errors, path, 'const', schema.const, value);
    }
    return;
  }
  if (schema.enum !== undefined) {
    checkEnum(value, schema.enum, path, errors);
    return;
  }
  if (!checkType(value, schema.type, path, errors)) return;
  if (schema.type === 'object') {
    checkRequired(value, schema.required ?? [], path, errors);
    checkAdditionalProperties(value, schema, path, errors);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) validateAgainst(value[key], sub, `${path}.${key}`, errors);
    }
  } else if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      pushError(errors, path, 'minItems', `>= ${schema.minItems} item(s)`, `${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      pushError(errors, path, 'maxItems', `<= ${schema.maxItems} item(s)`, `${value.length}`);
    }
    const items = schema.items;
    if (items) {
      value.forEach((item, i) => validateAgainst(item, items, `${path}[${i}]`, errors));
    }
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      pushError(errors, path, 'minLength', `>= ${schema.minLength}`, `${value.length}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      pushError(errors, path, 'maxLength', `<= ${schema.maxLength}`, `${value.length}`);
    }
  } else if (schema.type === 'number') {
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) {
      pushError(errors, path, 'exclusiveMinimum', `> ${schema.exclusiveMinimum}`, value);
    }
    if (schema.minimum !== undefined && !(value >= schema.minimum)) {
      pushError(errors, path, 'minimum', `>= ${schema.minimum}`, value);
    }
    if (schema.exclusiveMaximum !== undefined && !(value < schema.exclusiveMaximum)) {
      pushError(errors, path, 'exclusiveMaximum', `< ${schema.exclusiveMaximum}`, value);
    }
    if (schema.maximum !== undefined && !(value <= schema.maximum)) {
      pushError(errors, path, 'maximum', `<= ${schema.maximum}`, value);
    }
  }
}

// Full validation: JSON-Schema-style structure + cross-field semantic rules.
// Returns { errors: [] } — empty errors means structurally valid.
export function validateSceneStructure(scene) {
  const errors = [];
  if (!isPlainObject(scene)) {
    pushError(errors, '$', 'type', 'object', typeof scene);
    return { errors };
  }
  validateAgainst(scene, SCENE_JSON_SCHEMA, '$', errors);
  if (errors.length > 0) return { errors }; // cross-field rules assume structure

  // Cross-field semantic rules (path-precise, fixable by minimal patches):
  const surfaces = new Map(scene.surfaces?.map((s) => [s.id, s]) ?? []);
  const bodies = new Map(scene.bodies.map((b) => [b.id, b]));

  // bodies[i].position.on must reference a known surface
  for (const [i, body] of scene.bodies.entries()) {
    if (!surfaces.has(body.position.on)) {
      pushError(errors, `$.bodies[${i}].position.on`, 'reference', `known surface id (surfaces[].id)`, body.position.on,
        'Add a surfaces[] entry with this id, or point position.on at an existing surface.');
    }
  }
  // constraints reference known body + surface
  for (const [i, c] of (scene.constraints ?? []).entries()) {
    if (!bodies.has(c.body)) {
      pushError(errors, `$.constraints[${i}].body`, 'reference', 'known body id', c.body);
    }
    if (!surfaces.has(c.surface)) {
      pushError(errors, `$.constraints[${i}].surface`, 'reference', 'known surface id', c.surface);
    }
  }
  // forces: on references a body; from (when present) references a surface
  for (const [i, f] of scene.forces.entries()) {
    if (!bodies.has(f.on)) {
      pushError(errors, `$.forces[${i}].on`, 'reference', 'known body id', f.on);
    }
    if (f.from !== undefined && !surfaces.has(f.from)) {
      pushError(errors, `$.forces[${i}].from`, 'reference', 'known surface id', f.from);
    }
    // normal and friction require `from`
    if ((f.type === 'normal' || f.type === 'friction') && f.from === undefined) {
      pushError(errors, `$.forces[${i}].from`, 'required', 'present (surface id for normal/friction)', 'missing',
        'normal and friction forces must name the surface they come from.');
    }
  }
  // incline must carry angle_deg; non-incline must not
  for (const [i, s] of (scene.surfaces ?? []).entries()) {
    if (s.kind === 'incline' && s.angle_deg === undefined) {
      pushError(errors, `$.surfaces[${i}].angle_deg`, 'required', 'present (0 < angle < 90)', 'missing');
    }
    if (s.kind !== 'incline' && s.angle_deg !== undefined) {
      pushError(errors, `$.surfaces[${i}].angle_deg`, 'forbidden', 'absent for non-incline surfaces', s.angle_deg);
    }
  }
  return { errors };
}
