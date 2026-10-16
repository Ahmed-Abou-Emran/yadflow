// The lifecycle definition (E134). The rules each test pins:
//   - the five lists the engine reads (STEPS, LIFECYCLE_PROFILES, PHASES, PRODUCT_PHASES, the Build order)
//     are views of cli/lifecycle/defaults/1.json and equal, key for key and in order, a FROZEN copy of the
//     lists as they stood before the move — comparing a view with itself would prove nothing;
//   - the shipped default passes the validator, and each validator rule fires on a file broken that way;
//   - a value this release does not know makes one step unusable, never the whole file;
//   - the editor schema and the code agree on every list of allowed values;
//   - skills/sdlc/config.yaml carries exactly what the default generates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The #280 guard (cli/test.mjs): printed lines go to stderr while the runner owns stdout.
if (process.env.NODE_TEST_CONTEXT) {
  const write = process.stdout.write;
  for (const k of ['log', 'info']) {
    const orig = console[k];
    console[k] = (...a) => (process.stdout.write === write ? console.error(...a) : orig(...a));
  }
}

const {
  ARTIFACT_TYPES, BEHAVIOURS, DEFAULT_LIFECYCLE, DEFAULT_VERSION, FIXED_ARTIFACTS, KNOWN_KEYS, PARTS, PHASE_LEVELS,
  PHASE_RUNS, SENTINELS, STEP_KINDS, applyConfigRegions, configRegions, expandRoutes, expandSteps, featurePhases,
  laneAuthorSteps, laneOrder, lifecycleProblems, loadDefault, normalizeLifecycle, productPhases, routeKind,
  shippedDefaults,
} = await import('./lifecycle.mjs');
const ES = await import('./epic-state.mjs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli', 'fixtures', 'lifecycle-v4-catalogue.json'), 'utf8'));
const fresh = () => loadDefault(1);
const messages = (def, level = 'error') => lifecycleProblems(def).filter((p) => p.level === level);

// ---- the views equal the lists they replaced -----------------------------------------------------------

test('every view equals the frozen pre-E134 list, field by field, in key order and array order', () => {
  // deepEqual ignores key order; JSON.stringify does not. Both are checked, because a printed list (a
  // `--json` answer) would change if the keys moved even with equal contents.
  const views = {
    STEPS: ES.STEPS,
    LIFECYCLE_PROFILES: ES.LIFECYCLE_PROFILES,
    PHASES: ES.PHASES,
    PRODUCT_PHASES: ES.PRODUCT_PHASES,
    SENTINELS: ES.SENTINELS,
    BUILD_STEP_ORDER: laneOrder(DEFAULT_LIFECYCLE),
  };
  assert.deepEqual(Object.keys(views).sort(), Object.keys(FROZEN).sort(), 'the fixture and the views name the same lists');
  for (const [name, view] of Object.entries(views)) {
    assert.deepEqual(view, FROZEN[name], `${name} differs from the frozen list`);
    assert.equal(JSON.stringify(view), JSON.stringify(FROZEN[name]), `${name} has the same contents but a different key order`);
  }
});

test('the frozen fixture is still what default 1 expands to (a past default never changes)', () => {
  // Once a 2.json exists the engine's lists may move on; this pins 1.json itself to the lists it shipped with.
  const d = normalizeLifecycle(loadDefault(1));
  assert.deepEqual(expandSteps(d), FROZEN.STEPS);
  assert.deepEqual(expandRoutes(d), FROZEN.LIFECYCLE_PROFILES);
  assert.deepEqual(featurePhases(d), FROZEN.PHASES);
  assert.deepEqual(productPhases(d), FROZEN.PRODUCT_PHASES);
  assert.deepEqual(laneOrder(d), FROZEN.BUILD_STEP_ORDER);
});

test('the view mapping: a gate row follows its step, the merge gate has no "reviews", the lane is no profile', () => {
  const rows = expandSteps(DEFAULT_LIFECYCLE);
  const at = (id) => rows.findIndex((r) => r.id === id);
  assert.equal(at('architecture-review'), at('architecture') + 1);
  assert.deepEqual(rows[at('architecture')].risk_tags, [], 'the author row carries no tags');
  assert.deepEqual(rows[at('architecture-review')].risk_tags, ['contract'], 'the gate row carries gate.riskTags');
  assert.ok(!('reviews' in rows[at('engineer-review')]), 'engineer-review gates nothing');
  assert.equal(rows[at('engineer-review')].skill, 'yad-engineer-review');
  assert.ok(!('skill' in rows[at('epic-review')]), 'a Shape gate has no skill: yad gate drives it');
  assert.ok(!ES.LIFECYCLE_PROFILES.some((p) => p.id === 'lane'));
  assert.equal(routeKind(DEFAULT_LIFECYCLE, DEFAULT_LIFECYCLE.routes.find((r) => r.id === 'lane')), 'lane');
  assert.deepEqual(laneAuthorSteps(DEFAULT_LIFECYCLE), ['spec', 'tasks', 'implement', 'checks']);
});

test('a step optional by default is optional on every route, and a route row overrides it (the route wins)', () => {
  const d = fresh();
  d.steps.find((s) => s.id === 'test-cases').optional = true;
  d.routes.find((r) => r.id === 'chore').steps = ['epic', 'stories', { id: 'test-cases', optional: false }];
  const p = Object.fromEntries(expandRoutes(normalizeLifecycle(d)).map((r) => [r.id, r.steps]));
  assert.deepEqual(p.classic.slice(-2), [{ id: 'test-cases', optional: true }, { id: 'test-cases-review', optional: true }]);
  assert.deepEqual(p.chore.slice(-2), ['test-cases', 'test-cases-review']);
});

test('the set artifacts list the same files the engine checks', () => {
  const art = (id) => DEFAULT_LIFECYCLE.steps.find((s) => s.id === id).artifact;
  assert.deepEqual(art('foundation').files, ES.FOUNDATION_FILES);
  assert.deepEqual(art('foundation').optional, ES.FOUNDATION_SECTIONS.filter((s) => s.optional).map((s) => s.file));
  assert.deepEqual(art('discovery').files, ES.DISCOVERY_FILES);
});

test('the shipped defaults are numbered 1..N, the newest is DEFAULT_VERSION, and each says which it is', () => {
  const ns = shippedDefaults();
  assert.deepEqual(ns, ns.map((_, i) => i + 1), 'no gap in the numbering');
  assert.equal(ns.at(-1), DEFAULT_VERSION);
  for (const n of ns) assert.equal(loadDefault(n).extends, `yadflow-default@${n}`);
});

test('loading never changes the file: normalizing returns a new object and keeps unknown keys', () => {
  const raw = fresh();
  raw.futureKey = { a: 1 };
  raw.steps[0].futureField = true;
  const before = JSON.stringify(raw);
  const n = normalizeLifecycle(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(n.futureKey, { a: 1 });
  assert.equal(n.steps[0].futureField, true);
  assert.deepEqual(normalizeLifecycle(null).steps, []);
});

// ---- the validator -------------------------------------------------------------------------------------

test('the shipped default has no problems at all', () => {
  for (const n of shippedDefaults()) assert.deepEqual(lifecycleProblems(loadDefault(n)), [], `default ${n}`);
});

// Each case breaks a fresh copy of the default one way and names the words its problem must contain.
const step = (d, id) => d.steps.find((s) => s.id === id);
const route = (d, id) => d.routes.find((r) => r.id === id);
const CASES = [
  ['not an object', () => 'x', /must be a JSON object/],
  ['schemaVersion missing', (d) => { delete d.schemaVersion; }, /"schemaVersion" must be a whole number/],
  ['extends malformed', (d) => { d.extends = 'mine'; }, /"extends" must look like/],
  ['steps not a list', (d) => { d.steps = {}; }, /"steps" must be a list/],
  ['phase without id', (d) => { d.phases.push({ name: 'X' }); }, /a phase needs an "id"/],
  ['phase without name', (d) => { delete d.phases[1].name; }, /a phase needs a "name"/],
  ['phase id twice', (d) => { d.phases.push({ ...d.phases[1] }); }, /two phases share this id/],
  ['phase level unknown', (d) => { d.phases[1].level = 'team'; }, /"level" must be one of/],
  ['feature phase without part', (d) => { delete d.phases[1].part; }, /a feature phase needs a "part"/],
  ['product phase with part', (d) => { d.phases[0].part = 'Shape'; }, /a product phase belongs to no part/],
  ['loop without over', (d) => { d.phases[4].over = []; }, /a loop phase needs "over"/],
  ['step without id', (d) => { d.steps.push({ name: 'X' }); }, /a step needs an "id"/],
  ['step without name', (d) => { delete step(d, 'epic').name; }, /a step needs a "name"/],
  ['step id shape', (d) => { step(d, 'tasks').id = 'Tasks'; route(d, 'lane').steps[1] = 'Tasks'; }, /lower-case letters, digits and dashes/],
  ['step id like a story', (d) => { step(d, 'tasks').id = 'tasks-s01'; route(d, 'lane').steps[1] = 'tasks-s01'; }, /must not end like a story id/],
  ['step id is a sentinel', (d) => { step(d, 'tasks').id = 'ready-for-build'; route(d, 'lane').steps[1] = 'ready-for-build'; }, /a word the engine uses for an epic's state/],
  ['step id twice', (d) => { d.steps.push({ ...step(d, 'tasks') }); }, /two steps share this id/],
  ['step without kind', (d) => { delete step(d, 'analysis').kind; }, /a step needs a "kind"/],
  ['step phase missing', (d) => { step(d, 'analysis').phase = 'nowhere'; }, /its phase "nowhere" does not exist/],
  ['author id ends in -review', (d) => { step(d, 'tasks').id = 'tasks-review'; route(d, 'lane').steps[1] = 'tasks-review'; }, /must not end in "-review"/],
  ['review step with a gate', (d) => { step(d, 'engineer-review').gate = { riskTags: [] }; }, /a review step is a gate on its own/],
  ['gate malformed', (d) => { step(d, 'analysis').gate = { riskTags: 'contract' }; }, /"gate" must be null or/],
  ['artifact malformed', (d) => { step(d, 'analysis').artifact = { type: 'file' }; }, /"artifact" must be null or/],
  ['set without files', (d) => { delete step(d, 'foundation').artifact.files; }, /a "set" artifact lists its "files"/],
  ['artifact shared', (d) => { step(d, 'analysis').artifact.path = 'ui-design.md'; }, /two steps cannot share one/],
  ['behaviour in the wrong part', (d) => { step(d, 'analysis').behaviours = ['spec-source']; }, /belongs in the Build loop/],
  ['behaviour step loses its gate', (d) => { step(d, 'architecture').gate = null; }, /needs the step to keep its review gate/],
  ['merge gate made an author step', (d) => { step(d, 'engineer-review').kind = 'author'; step(d, 'engineer-review').id = 'merge'; route(d, 'lane').steps[4] = 'merge'; }, /must stay a "review" step/],
  ['fixed artifact renamed', (d) => { step(d, 'epic').artifact.path = 'brief.md'; }, /its artifact must stay "epic.md"/],
  ['derived gate id taken', (d) => { d.steps.push({ ...step(d, 'engineer-review'), id: 'analysis-review', behaviours: [], provider: undefined }); }, /would be called "analysis-review", which is already a step/],
  ['replaces nothing', (d) => { step(d, 'foundation').replaces = 'ghost'; }, /it replaces "ghost", which is not a step/],
  ['route without id', (d) => { d.routes.push({ name: 'x', steps: ['epic'] }); }, /a route needs an "id"/],
  ['route without name', (d) => { delete route(d, 'chore').name; }, /a route needs a "name"/],
  ['route id twice', (d) => { d.routes.push({ ...route(d, 'chore') }); }, /two routes share this id/],
  ['route empty', (d) => { route(d, 'chore').steps = []; }, /a route needs at least one step/],
  ['route step missing', (d) => { route(d, 'chore').steps.push('ghost'); }, /step "ghost" does not exist/],
  ['route step twice', (d) => { route(d, 'chore').steps.push('epic'); }, /step "epic" is listed twice/],
  ['route mixes levels', (d) => { route(d, 'chore').steps.push('spec'); }, /mix the product level, the Shape phases and the Build loop/],
  ['feature route without ends-shape', (d) => { route(d, 'chore').steps = ['epic']; }, /exactly 1 step with behaviour "ends-shape"; it has 0/],
  ['product route with two product-level steps', (d) => { route(d, 'foundation').steps.push('discovery'); }, /exactly 1 step with behaviour "product-level"; it has 2/],
  ['feature route with two contract steps', (d) => {
    d.steps.push({ ...step(d, 'architecture'), id: 'api', name: 'API', artifact: { type: 'file', path: 'api.md' }, provider: { origin: 'api' } });
    route(d, 'classic').steps.push('api');
  }, /at most 1 step with behaviour "locks-contract"; it has 2/],
  ['no lane', (d) => { d.routes = d.routes.filter((r) => r.id !== 'lane'); }, /exactly one Build lane route/],
];
for (const [name, breakIt, want] of CASES) {
  test(`validator: ${name}`, () => {
    const d = fresh();
    const r = breakIt(d);
    const found = messages(r === undefined ? d : r);
    assert.ok(found.some((p) => want.test(p.message)), `wanted ${want}, got ${JSON.stringify(found.map((p) => `${p.where}: ${p.message}`))}`);
  });
}

test('a value this release does not know makes the step unusable, and the rest of the file still loads', () => {
  const d = fresh();
  step(d, 'analysis').kind = 'checkpoint';
  step(d, 'ui-design').artifact.type = 'canvas';
  step(d, 'test-cases').behaviours.push('future-thing');
  d.phases.find((p) => p.id === 'operate').runs = 'forever';
  d.steps.push({ id: 'watch', name: 'Watch', phase: 'operate', kind: 'author', artifact: null, gate: null });
  d.futureKey = 1;
  step(d, 'epic').futureField = 1;
  const all = lifecycleProblems(d);
  assert.deepEqual(all.filter((p) => p.level === 'error'), [], 'no error: an unknown value never breaks the file');
  const unusable = all.filter((p) => p.level === 'unusable').map((p) => p.where);
  for (const w of ['step analysis', 'step ui-design', 'step test-cases', 'phase operate', 'step watch']) assert.ok(unusable.includes(w), w);
  const warns = all.filter((p) => p.level === 'warn').map((p) => `${p.where}: ${p.message}`);
  assert.ok(warns.includes('file: unknown key "futureKey" is kept and not read'));
  assert.ok(warns.includes('step epic: unknown key "futureField" is kept and not read'));
});

test('the registry fixes the names the CI checks read, keyed by the original id', () => {
  for (const [origin, name] of Object.entries(FIXED_ARTIFACTS)) {
    assert.equal(DEFAULT_LIFECYCLE.steps.find((s) => s.provider?.origin === origin).artifact.path, name, origin);
  }
  // A renamed step keeps its origin, so the rule still finds it.
  const d = fresh();
  Object.assign(step(d, 'epic'), { id: 'brief', name: 'Brief' });
  for (const r of d.routes) r.steps = r.steps.map((x) => (x === 'epic' ? 'brief' : x));
  assert.deepEqual(messages(d), [], 'a rename alone is allowed');
  step(d, 'brief').artifact.path = 'brief.md';
  assert.ok(messages(d).some((p) => /must stay "epic.md"/.test(p.message)));
});

// ---- the editor schema ---------------------------------------------------------------------------------

test('the editor schema agrees with the code on every list of allowed values and every known key', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli', 'lifecycle', 'lifecycle.schema.json'), 'utf8'));
  const $ = schema.$defs;
  const artifactObj = $.artifact.oneOf.find((x) => x.type === 'object');
  assert.deepEqual($.step.properties.kind.enum, STEP_KINDS);
  assert.deepEqual(artifactObj.properties.type.enum, ARTIFACT_TYPES);
  assert.deepEqual($.phase.properties.runs.enum, PHASE_RUNS);
  assert.deepEqual($.phase.properties.level.enum, PHASE_LEVELS);
  assert.deepEqual($.phase.properties.part.enum, PARTS);
  assert.deepEqual($.step.properties.behaviours.items.enum, Object.keys(BEHAVIOURS));
  assert.deepEqual(Object.keys(schema.properties), KNOWN_KEYS.file);
  assert.deepEqual(Object.keys($.phase.properties), KNOWN_KEYS.phase);
  assert.deepEqual(Object.keys($.step.properties), KNOWN_KEYS.step);
  assert.deepEqual(Object.keys($.route.properties), KNOWN_KEYS.route);
  // Every key the schema requires is one whose absence the validator reports as an error.
  for (const [where, required] of [['file', schema.required], ['phase', $.phase.required], ['step', $.step.required], ['route', $.route.required]]) {
    for (const key of required) {
      const d = fresh();
      if (where === 'file') delete d[key];
      else delete { phase: d.phases, step: d.steps, route: d.routes }[where][1][key];
      assert.ok(messages(d).length > 0, `removing ${where}.${key} is reported`);
    }
  }
  // The default uses only keys the schema names.
  const d = loadDefault(DEFAULT_VERSION);
  assert.deepEqual(messages(d, 'warn'), []);
});

// ---- the copy in config.yaml ---------------------------------------------------------------------------

test('skills/sdlc/config.yaml carries exactly what the default generates', () => {
  const file = path.join(ROOT, 'skills', 'sdlc', 'config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const r = applyConfigRegions(text);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.stale, [], 'stale — run node scripts/lifecycle-config.mjs');
  assert.equal(r.text, text);
  // A hand edit inside a region is found, and rewriting puts it back.
  const edited = text.replace('back_steps: [spec, tasks, implement, checks]', 'back_steps: [spec]');
  const fixed = applyConfigRegions(edited);
  assert.deepEqual(fixed.stale, ['back_steps']);
  assert.equal(fixed.text, text);
  // A missing end marker is refused, and the text comes back unchanged.
  const broken = text.replace('# <<< generated: lifecycle', '');
  const refused = applyConfigRegions(broken);
  assert.equal(refused.refused.length, 1);
  assert.equal(refused.text, broken);
  // The script's --check agrees.
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lifecycle-config.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(Object.keys(configRegions(DEFAULT_LIFECYCLE)), ['lifecycle', 'back_steps']);
  assert.ok(SENTINELS.every((s) => text.includes(s)));
});
