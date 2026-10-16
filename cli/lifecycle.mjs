// The lifecycle definition — the phases, steps and routes as one versioned JSON file (E134, the first row
// of the lifecycle spine; docs/roadmap-idea-1.md, "The lifecycle spine").
//
// WHERE THE LIFECYCLE LIVES NOW. yadflow ships its default as `cli/lifecycle/defaults/<n>.json`. Until
// E134 the same facts were lists written in `cli/epic-state.mjs` (`STEPS`, `LIFECYCLE_PROFILES`,
// `PHASES`, `PRODUCT_PHASES`, the Build order). Those names still exist, with the same contents, but they
// are now VIEWS of the default, built by the functions at the bottom of this file. A test compares each
// view, field by field and in key order, with a frozen copy of the lists as they stood before this row
// (`cli/fixtures/lifecycle-v4-catalogue.json`), so the move changed nothing the engine does.
//
// WHAT IS NOT READ YET. Nothing reads a team's own file in this row: `.sdlc/lifecycle.json` is E135. The
// validator below (`lifecycleProblems`) and the behaviour registry are built and tested now so the file
// format is settled before anyone can write one. Several fields of a step (`behaviours`, `inputs`,
// `extraPaths`, `provider`, `replaces`) are recorded in the default and read by later rows (E136, E141).
//
// A PAST DEFAULT NEVER CHANGES. A team's file will say which default it was copied from (`extends:
// "yadflow-default@<n>"`), and `yad lifecycle upgrade` (E141) compares the old default, the team's file
// and the new default. That only works if `1.json` stays exactly what it was on the day it shipped. A
// change to the default is a new file, `2.json`. The release check refuses a release that edits a
// default an earlier release carried (scripts/release-check.sh).
//
// IT IS JSON, NOT AN IMPORT. The file is read with `fs` rather than `import … with { type: 'json' }`,
// because the published package supports Node 18, where that import form is not stable on every release.
import fs from 'node:fs';

// The newest shipped default — the one every reader uses until a team file exists (E135).
export const DEFAULT_VERSION = 1;

const DEFAULTS_DIR = new URL('./lifecycle/defaults/', import.meta.url);

// Every default this package ships, oldest first, as numbers. E141's three-way upgrade needs the old ones.
export function shippedDefaults() {
  return fs.readdirSync(DEFAULTS_DIR).map((f) => /^([1-9]\d*)\.json$/.exec(f)?.[1]).filter(Boolean)
    .map(Number).sort((a, b) => a - b);
}

// One shipped default, exactly as the file says (not normalized).
export function loadDefault(n = DEFAULT_VERSION) {
  return JSON.parse(fs.readFileSync(new URL(`${n}.json`, DEFAULTS_DIR), 'utf8'));
}

// `currentStep` markers that are NOT steps: they never appear in `steps[]`, and no phase claims them.
// They stay in code on purpose (the roadmap's "What stays in code"): they describe an epic's state, not a
// step a team may define. They live in this file, not `epic-state.mjs`, because the validator needs them
// (a step may not be called `ready-for-build`) and `epic-state.mjs` imports this file; it re-exports
// them under the same name.
export const SENTINELS = ['ready-for-build', 'backfill-pending', 'backfill-done', 'discovery-done', 'foundation-done'];

// The values this release understands. A value outside these lists is not an error for the whole file:
// a team file may come from a newer yadflow, so a step using an unknown value is only marked unusable
// for new epics, and the rest of the file still loads (the roadmap's unknown-value rule).
export const STEP_KINDS = ['author', 'review'];
export const ARTIFACT_TYPES = ['file', 'folder', 'set'];
export const PHASE_RUNS = ['once', 'loop'];
export const PHASE_LEVELS = ['feature', 'product'];
export const PARTS = ['Shape', 'Build', 'Run'];

// THE BEHAVIOUR REGISTRY. A behaviour is something the engine does because of a step, not because of a
// step's name: the epic step is where the work-item type is read, the architecture step locks the
// contract, and so on. A team may rename, re-skill, move or make optional a step that carries one, but
// the rules below say what it may not do, because the engine and the CI checks depend on them.
// Only yadflow defines behaviours; a team cannot invent one.
//
//   where     which part of the lifecycle the step must sit in: `shape` (a Shape phase), `product` (the
//             Foundation level), or `lane` (the Build loop).
//   keepGate  the step must keep its review gate. Every Shape and Foundation behaviour does, except
//             `parallel-with-build`, whose step (test-cases) may drop it.
//   review    the step must be a standalone `review` step (the merge gate).
//   route     how many steps with this behaviour each route of that kind must hold: [min, max].
//
// What each behaviour DOES is still code in the engine (`advanceState`, the contract lock, …). E136 moves
// the engine from step ids to these names.
export const BEHAVIOURS = {
  'work-item-source': { where: 'shape', keepGate: true, route: [1, 1] },
  'locks-contract': { where: 'shape', keepGate: true, route: [0, 1] },
  'ends-shape': { where: 'shape', keepGate: true, route: [1, 1] },
  'parallel-with-build': { where: 'shape', keepGate: false, route: [0, 1] },
  'product-level': { where: 'product', keepGate: true, route: [1, 1] },
  'spec-source': { where: 'lane', keepGate: false, route: [1, 1] },
  'code-change': { where: 'lane', keepGate: false, route: [1, 1] },
  'ci-gates': { where: 'lane', keepGate: false, route: [1, 1] },
  'merge-gate': { where: 'lane', keepGate: false, review: true, route: [1, 1] },
};

// The artifact names the engine and the CI checks read by name, so a step carrying a behaviour keeps
// them. Keyed by the step's ORIGINAL id (`provider.origin`), not by behaviour: `product-level` is on both
// `foundation` (`foundation/`) and the retired `discovery` (`discovery/`), which have different names.
export const FIXED_ARTIFACTS = {
  epic: 'epic.md',
  architecture: 'architecture.md',
  stories: 'stories/',
  'test-cases': 'test-cases.md',
  foundation: 'foundation/',
  discovery: 'discovery/',
};

// The keys this release knows at each level. Anything else is kept as it is and reported as a warning,
// so a file from a newer yadflow still loads.
export const KNOWN_KEYS = {
  file: ['schemaVersion', 'extends', 'phases', 'steps', 'routes', 'plugins'],
  phase: ['id', 'name', 'description', 'part', 'level', 'runs', 'over', 'built'],
  step: ['id', 'name', 'description', 'phase', 'kind', 'artifact', 'optional', 'gate', 'skills', 'behaviours',
    'extraPaths', 'inputs', 'retired', 'replaces', 'provider'],
  route: ['id', 'name', 'description', 'steps', 'bindings', 'retired', 'provider'],
};

// The suffix the engine gives a gate it derives from an author step. It stays in code (rule 1 of the
// spine: a gate is never automatic, and its id is not something a team chooses).
export const GATE_SUFFIX = '-review';
export const gateIdOf = (id) => `${id}${GATE_SUFFIX}`;

const arr = (x) => (Array.isArray(x) ? x : []);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// The definition with every optional field filled in, so readers never have to ask "is it there". Unknown
// keys are kept as they are. The input is never changed; the result is a new object.
export function normalizeLifecycle(raw) {
  const def = isObj(raw) ? raw : {};
  return {
    ...def,
    phases: arr(def.phases).map((p) => ({
      ...p,
      runs: p?.runs ?? 'once',
      over: arr(p?.over),
      built: p?.built ?? true,
    })),
    steps: arr(def.steps).map((s) => ({
      ...s,
      artifact: s?.artifact ?? null,
      optional: !!s?.optional,
      gate: s?.gate ? { ...s.gate, riskTags: arr(s.gate.riskTags) } : null,
      skills: arr(s?.skills),
      behaviours: arr(s?.behaviours),
      extraPaths: arr(s?.extraPaths),
      inputs: arr(s?.inputs),
      retired: !!s?.retired,
    })),
    routes: arr(def.routes).map((r) => ({
      ...r,
      steps: arr(r?.steps).map((x) => (typeof x === 'string' ? { id: x } : { ...x })),
      bindings: isObj(r?.bindings) ? r.bindings : {},
      retired: !!r?.retired,
    })),
    plugins: arr(def.plugins),
  };
}

// Which kind of route this is, worked out from the phases of its steps (a route has no `level` field):
// `product` (the Foundation level), `lane` (the Build loop), `feature` (the Shape phases), or null when
// its steps mix two of those, or name a step or phase that does not exist.
export function routeKind(def, route) {
  const phase = new Map(def.phases.map((p) => [p.id, p]));
  const step = new Map(def.steps.map((s) => [s.id, s]));
  const kinds = new Set(route.steps.map((x) => {
    const p = phase.get(step.get(x.id)?.phase);
    if (!p) return null;
    if (p.level === 'product') return 'product';
    return p.runs === 'loop' ? 'lane' : 'feature';
  }));
  return kinds.size === 1 && !kinds.has(null) ? [...kinds][0] : null;
}

// Where a step sits, in the registry's words: `product`, `lane` or `shape`. Null when its phase is unknown.
function stepWhere(def, s) {
  const p = def.phases.find((x) => x.id === s.phase);
  if (!p) return null;
  if (p.level === 'product') return 'product';
  if (p.runs === 'loop') return 'lane';
  return p.part === 'Shape' ? 'shape' : null;
}

// THE VALIDATOR. Every problem with a lifecycle definition, as a list. An empty list means the file can
// be used as it is. Hand-written on purpose: the package has no runtime dependencies, and each rule says
// why it exists in a sentence a person can act on.
//
// Each problem is `{ level, where, message }`:
//   error     the file cannot be used.
//   unusable  one step (or route) uses a value this release does not know; it cannot be used for new
//             epics, and the rest of the file still loads.
//   warn      an unknown key, kept as it is.
// `where` names the place: `file`, `phase <id>`, `step <id>` or `route <id>`.
export function lifecycleProblems(raw) {
  const out = [];
  const add = (level, where, message) => out.push({ level, where, message });
  if (!isObj(raw)) {
    add('error', 'file', 'the lifecycle definition must be a JSON object');
    return out;
  }
  const def = normalizeLifecycle(raw);

  // The file.
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.file.includes(k)) add('warn', 'file', `unknown key "${k}" is kept and not read`);
  if (!Number.isInteger(raw.schemaVersion)) add('error', 'file', '"schemaVersion" must be a whole number (the project\'s file shape)');
  if (raw.extends !== undefined && !/^yadflow-default@[1-9]\d*$/.test(String(raw.extends))) {
    add('error', 'file', '"extends" must look like "yadflow-default@<n>", naming the shipped default the file was copied from');
  }
  for (const key of ['phases', 'steps', 'routes']) {
    if (!Array.isArray(raw[key])) add('error', 'file', `"${key}" must be a list`);
  }

  // Phases.
  const phaseIds = new Set();
  for (const [i, p] of arr(raw.phases).entries()) {
    const where = `phase ${p?.id ?? `#${i + 1}`}`;
    if (!isObj(p) || typeof p.id !== 'string' || !p.id) { add('error', where, 'a phase needs an "id"'); continue; }
    for (const k of Object.keys(p)) if (!KNOWN_KEYS.phase.includes(k)) add('warn', where, `unknown key "${k}" is kept and not read`);
    if (typeof p.name !== 'string' || !p.name) add('error', where, 'a phase needs a "name"');
    if (phaseIds.has(p.id)) add('error', where, 'two phases share this id');
    phaseIds.add(p.id);
    if (!PHASE_LEVELS.includes(p.level)) add('error', where, `"level" must be one of: ${PHASE_LEVELS.join(', ')}`);
    if (p.level === 'feature' && !PARTS.includes(p.part)) add('error', where, `a feature phase needs a "part": ${PARTS.join(', ')}`);
    if (p.level === 'product' && p.part !== undefined) add('error', where, 'a product phase belongs to no part, so it has no "part"');
    if (p.runs !== undefined && !PHASE_RUNS.includes(p.runs)) add('unusable', where, `"runs" is "${p.runs}", which this yadflow does not know; its steps cannot be used for new epics`);
    if (p.runs === 'loop' && arr(p.over).length === 0) add('error', where, 'a loop phase needs "over" (what it loops over, such as "story" and "repo")');
  }
  const unknownRuns = new Set(def.phases.filter((p) => !PHASE_RUNS.includes(p.runs)).map((p) => p.id));

  // Steps.
  const stepById = new Map();
  const artifactOwner = new Map();
  for (const [i, s] of arr(raw.steps).entries()) {
    const where = `step ${s?.id ?? `#${i + 1}`}`;
    if (!isObj(s) || typeof s.id !== 'string') { add('error', where, 'a step needs an "id"'); continue; }
    const n = def.steps[i];
    for (const k of Object.keys(s)) if (!KNOWN_KEYS.step.includes(k)) add('warn', where, `unknown key "${k}" is kept and not read`);
    if (!/^[a-z][a-z0-9-]*$/.test(s.id)) add('error', where, 'a step id is lower-case letters, digits and dashes, starting with a letter');
    if (/-s\d+$/.test(s.id)) add('error', where, 'a step id must not end like a story id (-s01)');
    if (SENTINELS.includes(s.id)) add('error', where, `"${s.id}" is a word the engine uses for an epic's state, not a step`);
    if (typeof s.name !== 'string' || !s.name) add('error', where, 'a step needs a "name"');
    if (stepById.has(s.id)) add('error', where, 'two steps share this id');
    stepById.set(s.id, n);
    if (!phaseIds.has(s.phase)) add('error', where, `its phase "${s.phase}" does not exist`);
    else if (unknownRuns.has(s.phase)) add('unusable', where, `its phase "${s.phase}" uses a "runs" value this yadflow does not know`);

    if (s.kind === undefined) add('error', where, `a step needs a "kind": ${STEP_KINDS.join(' or ')}`);
    else if (!STEP_KINDS.includes(s.kind)) {
      add('unusable', where, `"kind" is "${s.kind}", which this yadflow does not know; the step cannot be used for new epics`);
    } else if (s.kind === 'author' && s.id.endsWith(GATE_SUFFIX)) {
      add('error', where, `an author step id must not end in "${GATE_SUFFIX}": that ending belongs to the gate the engine adds`);
    }
    if (s.kind === 'review' && n.gate) add('error', where, 'a review step is a gate on its own, so its "gate" must be null');
    if (s.gate !== undefined && s.gate !== null && (!isObj(s.gate) || (s.gate.riskTags !== undefined && !Array.isArray(s.gate.riskTags)))) {
      add('error', where, '"gate" must be null or { "riskTags": [ … ] }');
    }

    if (n.artifact !== null) {
      const a = n.artifact;
      if (!isObj(a) || typeof a.path !== 'string' || !a.path) add('error', where, '"artifact" must be null or { "type", "path", … }');
      else {
        if (!ARTIFACT_TYPES.includes(a.type)) add('unusable', where, `artifact type "${a.type}" is one this yadflow does not know; the step cannot be used for new epics`);
        if (a.type === 'set' && !Array.isArray(a.files)) add('error', where, 'a "set" artifact lists its "files"');
        // A review branch is found by its artifact's name, so two steps with one name would share a gate.
        if (artifactOwner.has(a.path)) add('error', where, `its artifact "${a.path}" is also step ${artifactOwner.get(a.path)}'s; two steps cannot share one, or they would share one review`);
        else artifactOwner.set(a.path, s.id);
      }
    }

    // Behaviours.
    const origin = n.provider?.origin ?? s.id;
    const at = stepWhere(def, n);
    for (const b of n.behaviours) {
      const rule = BEHAVIOURS[b];
      if (!rule) { add('unusable', where, `behaviour "${b}" is one this yadflow does not know; the step cannot be used for new epics`); continue; }
      if (at !== rule.where) add('error', where, `behaviour "${b}" belongs in ${rule.where === 'shape' ? 'a Shape phase' : rule.where === 'product' ? 'the product level' : 'the Build loop'}`);
      if (rule.keepGate && !n.gate) add('error', where, `behaviour "${b}" needs the step to keep its review gate`);
      if (rule.review && s.kind !== 'review') add('error', where, `behaviour "${b}" must stay a "review" step: it is the merge gate`);
    }
    const fixed = FIXED_ARTIFACTS[origin];
    if (fixed && n.behaviours.length && n.artifact?.path !== fixed) {
      add('error', where, `its artifact must stay "${fixed}": the engine and the CI checks read it by that name`);
    }
  }
  // The gate the engine derives must not take a name another step already has.
  for (const s of def.steps) {
    if (s.kind === 'author' && s.gate && stepById.has(gateIdOf(s.id))) {
      add('error', `step ${s.id}`, `its gate would be called "${gateIdOf(s.id)}", which is already a step`);
    }
    if (s.replaces !== undefined && !stepById.has(s.replaces)) add('error', `step ${s.id}`, `it replaces "${s.replaces}", which is not a step`);
  }

  // Routes.
  const routeIds = new Set();
  let lanes = 0;
  for (const [i, r] of arr(raw.routes).entries()) {
    const where = `route ${r?.id ?? `#${i + 1}`}`;
    if (!isObj(r) || typeof r.id !== 'string' || !r.id) { add('error', where, 'a route needs an "id"'); continue; }
    const n = def.routes[i];
    for (const k of Object.keys(r)) if (!KNOWN_KEYS.route.includes(k)) add('warn', where, `unknown key "${k}" is kept and not read`);
    if (typeof r.name !== 'string' || !r.name) add('error', where, 'a route needs a "name"');
    if (routeIds.has(r.id)) add('error', where, 'two routes share this id');
    routeIds.add(r.id);
    if (n.steps.length === 0) { add('error', where, 'a route needs at least one step'); continue; }
    const seen = new Set();
    let missing = false;
    for (const x of n.steps) {
      if (!stepById.has(x.id)) { add('error', where, `step "${x.id}" does not exist`); missing = true; }
      if (seen.has(x.id)) add('error', where, `step "${x.id}" is listed twice`);
      seen.add(x.id);
    }
    if (missing) continue;
    const kind = routeKind(def, n);
    if (!kind) { add('error', where, 'its steps mix the product level, the Shape phases and the Build loop; a route stays in one'); continue; }
    if (kind === 'lane') lanes += 1;
    // Each behaviour's route rule, for the routes of its kind.
    const scope = { shape: 'feature', product: 'product', lane: 'lane' };
    for (const [b, rule] of Object.entries(BEHAVIOURS)) {
      if (scope[rule.where] !== kind) continue;
      const count = n.steps.filter((x) => stepById.get(x.id).behaviours.includes(b)).length;
      const [min, max] = rule.route;
      if (count < min || count > max) {
        const want = min === max ? `exactly ${min}` : `at most ${max}`;
        add('error', where, `a ${kind} route needs ${want} step with behaviour "${b}"; it has ${count}`);
      }
    }
  }
  if (lanes !== 1) add('error', 'file', `there must be exactly one Build lane route (a route whose steps are in the Build loop); there are ${lanes}`);
  return out;
}

// ---- the views ---------------------------------------------------------------------------------------
//
// The shapes the engine has always read, built from a definition. Each one keeps the fields, the key
// order and the array order of the list it replaces, which the frozen-fixture test holds.

// The step catalogue, as `STEPS` (cli/epic-state.mjs). An author step with a gate becomes two rows: the
// step, then its gate `<id>-review` right after it. The gate row carries `reviews` (the step it gates) and
// the gate's risk tags; it has no skill, because `yad gate` drives Shape reviews. A standalone review step
// (`engineer-review`) is one row with its skill and no `reviews`.
export function expandSteps(def) {
  const level = new Map(def.phases.map((p) => [p.id, p.level]));
  const rows = [];
  for (const s of def.steps) {
    const artifact = s.artifact ? s.artifact.path : null;
    const row = { id: s.id, phase: s.phase, kind: s.kind, artifact };
    if (s.skills.length) row.skill = s.skills[0];
    rows.push({ ...row, level: level.get(s.phase), risk_tags: [] });
    if (s.kind === 'author' && s.gate) {
      rows.push({ id: gateIdOf(s.id), phase: s.phase, kind: 'review', artifact, reviews: s.id, level: level.get(s.phase), risk_tags: [...s.gate.riskTags] });
    }
  }
  return rows;
}

// The routes an epic can take, as `LIFECYCLE_PROFILES`. The Build lane is not one of them: an epic does not
// walk it, each story walks it in each repo. A step is optional on a route when the route says so, or,
// when the route says nothing, when the step says so (decision 2: the route wins). A non-optional step is
// written as its bare id, an optional one as `{ id, optional: true }`, and its gate follows the same way.
export function expandRoutes(def) {
  const step = new Map(def.steps.map((s) => [s.id, s]));
  return def.routes.filter((r) => routeKind(def, r) !== 'lane').map((r) => ({
    id: r.id,
    title: r.name,
    level: routeKind(def, r),
    steps: r.steps.flatMap((x) => {
      const s = step.get(x.id);
      const optional = x.optional ?? s.optional;
      const ids = s.kind === 'author' && s.gate ? [s.id, gateIdOf(s.id)] : [s.id];
      return ids.map((id) => (optional ? { id, optional: true } : id));
    }),
  }));
}

// The feature phases, as `PHASES`: the six-phase strip, Discover to Operate.
export const featurePhases = (def) => def.phases.filter((p) => p.level === 'feature')
  .map((p) => ({ id: p.id, name: p.name, part: p.part, built: p.built }));

// The product level's phases, as `PRODUCT_PHASES`: the Foundation.
export const productPhases = (def) => def.phases.filter((p) => p.level === 'product')
  .map((p) => ({ id: p.id, name: p.name, level: p.level, built: p.built }));

// The Build lane's order, as `BUILD_STEP_ORDER`: the steps one story walks in one repo.
export function laneOrder(def) {
  const lane = def.routes.find((r) => routeKind(def, r) === 'lane');
  return lane ? lane.steps.map((x) => x.id) : [];
}

// The lane steps that may ever be automated: every one but the review steps (the merge gate is locked to a
// human). `config.yaml`'s `automation.back_steps` is generated from this.
export function laneAuthorSteps(def) {
  const step = new Map(def.steps.map((s) => [s.id, s]));
  return laneOrder(def).filter((id) => step.get(id)?.kind === 'author');
}

// The shipped default, normalized — what every reader uses in this release.
export const DEFAULT_LIFECYCLE = normalizeLifecycle(loadDefault(DEFAULT_VERSION));

// ---- the copy in skills/sdlc/config.yaml ---------------------------------------------------------------
//
// `config.yaml` carries the phase table, the route ids, the sentinels and the steps that may be automated,
// for the skills and for people to read. They are GENERATED from the default, never typed: each generated
// part sits between two marker lines, and only the lines between them are ever replaced
// (`scripts/lifecycle-config.mjs`). A test fails when the file and the default disagree.
//
//   # >>> generated: <name> — …       the begin marker, with a note saying not to edit by hand
//   # <<< generated: <name>            the end marker
//
// The markers bound the region, so nothing has to guess where a YAML block ends.
export const CONFIG_REGIONS = ['lifecycle', 'back_steps'];
const BEGIN = (name) => `# >>> generated: ${name} — from cli/lifecycle/defaults/${DEFAULT_VERSION}.json by scripts/lifecycle-config.mjs; do not edit by hand`;
const END = (name) => `# <<< generated: ${name}`;

// Inline YAML maps in aligned columns, one per line, the way the table has always been laid out.
function alignedRows(rows) {
  const keys = Object.keys(rows[0] ?? {});
  const cell = (k, v) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`;
  const width = Object.fromEntries(keys.map((k) => [k, Math.max(...rows.map((r) => cell(k, r[k]).length))]));
  return rows.map((r) => `- { ${keys.map((k, i) => (i === keys.length - 1 ? cell(k, r[k]) : `${cell(k, r[k])},`.padEnd(width[k] + 1))).join(' ')} }`);
}

// Each region's lines, without indentation, for one definition.
export function configRegions(def) {
  const rows = expandSteps(def).filter((r) => !r.reviews);
  const stepsOf = (phase) => rows.filter((r) => r.phase === phase).map((r) => r.id);
  const features = featurePhases(def);
  return {
    lifecycle: [
      `parts: [${[...new Set(features.map((p) => p.part))].join(', ')}]`,
      `profiles: [${expandRoutes(def).map((r) => r.id).join(', ')}]`,
      'product_phases:',
      ...alignedRows(productPhases(def).map((p) => ({ ...p, steps: stepsOf(p.id) }))).map((l) => `  ${l}`),
      'phases:',
      ...alignedRows(features.map((p) => ({ ...p, steps: stepsOf(p.id) }))).map((l) => `  ${l}`),
      `sentinels: [${SENTINELS.join(', ')}]`,
    ],
    back_steps: [`back_steps: [${laneAuthorSteps(def).join(', ')}]`],
  };
}

// The file's text with every region rewritten from `def`. Returns the new text, the regions whose lines
// changed (`stale`), and why a region could not be found (`refused`). A refused file is returned unchanged.
export function applyConfigRegions(text, def = DEFAULT_LIFECYCLE) {
  const lines = text.split('\n');
  const regions = configRegions(def);
  const stale = [];
  const refused = [];
  for (const name of CONFIG_REGIONS) {
    const begins = lines.flatMap((l, i) => (l.trim().startsWith(`# >>> generated: ${name} `) ? [i] : []));
    const ends = lines.flatMap((l, i) => (l.trim() === END(name) ? [i] : []));
    if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
      refused.push(`the "${name}" region needs exactly one begin marker followed by one end marker ("${END(name)}")`);
      continue;
    }
    const [b, e] = [begins[0], ends[0]];
    const indent = lines[b].match(/^\s*/)[0];
    const want = [`${indent}${BEGIN(name)}`, ...regions[name].map((l) => `${indent}${l}`), `${indent}${END(name)}`];
    if (lines.slice(b, e + 1).join('\n') !== want.join('\n')) stale.push(name);
    lines.splice(b, e - b + 1, ...want);
  }
  return refused.length ? { text, stale, refused } : { text: lines.join('\n'), stale, refused };
}
