// `yad build start|step|trust|ship|done` (issue #346): one command per Build record. The spine test drives
// a story from its first lane to `shipped` through the real CLI, then asks the EXISTING readers — `yad next`,
// the epic seal, `yad doctor`, `yad tidy` — whether they agree it shipped: the user's decision was that
// `build done` makes the three "shipped" signals agree.
import './fixtures/git-quiet.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const YAD = path.join(ROOT, 'bin/yad.mjs');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^GIT_(AUTHOR|COMMITTER)_/.test(k) && !/^(CI|GITLAB_CI|GITHUB_ACTIONS|SDLC_BASE|SDLC_HUB_CONFIG|SDLC_PRODUCT_CONFIG)$/.test(k) && !/^(CI_|GITHUB_)/.test(k)));
ENV.GIT_CONFIG_GLOBAL = '/dev/null';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: ENV }).toString().trim();
const yad = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [YAD, ...args], { cwd, env: { ...ENV, PWD: cwd, YAD_NO_REPORT: '1', YAD_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};
const json = (r) => JSON.parse(r.stdout);

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'alice');
  git(dir, 'config', 'user.email', 'alice@corp.io');
}

// A Product (W/product) with one epic whose stories review passed, one story declaring api and web, and the
// api repo (W/api) on its origin with the story's tasks.md merged. No platform: ships are recorded by flag.
function workspace({ tasks = '# Tasks\n\n- [ ] T01 — create the order\n- [ ] T02 — list orders\n' } = {}) {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yad-build-')));
  fs.writeFileSync(path.join(W, '.yad-workspace.json'), JSON.stringify({ version: 1, product: 'product' }));
  const P = path.join(W, 'product');
  const dir = path.join(P, 'epics/EP-l');
  const st = (id, type, status) => ({ id, type, artifact: id.startsWith('stories') ? 'stories/' : 'epic.md', status, risk_tags: [] });
  write(P, {
    '.sdlc/product.json': JSON.stringify({ name: 'p' }),
    '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api' }, { name: 'web', path: '../web' }] }),
    'epics/EP-l/epic.md': '---\nid: EP-l\ntype: chore\nstatus: approved\n---\n# EP-l\n',
    'epics/EP-l/.sdlc/state.json': JSON.stringify({
      epicId: 'EP-l', profile: 'chore', currentStep: 'ready-for-build',
      steps: [st('epic', 'author', 'done'), st('epic-review', 'review+approve', 'done'), st('stories', 'author', 'done'), st('stories-review', 'review+approve', 'done')],
    }),
    'epics/EP-l/.sdlc/approvals.json': '[]',
    'epics/EP-l/.sdlc/comments.json': '[]',
    'epics/EP-l/stories/EP-l-S01.md': '---\nid: EP-l-S01\nepic: EP-l\nstatus: approved\nrepos: [api, web]\n---\n# S01\n',
  });
  initRepo(P);
  git(P, 'add', '-A');
  git(P, 'commit', '-q', '-m', 'chore: seed');
  const api = path.join(W, 'api');
  initRepo(api);
  write(api, { [`specs/EP-l-S01/tasks.md`]: tasks, 'a.txt': 'a\n' });
  git(api, 'add', '-A');
  git(api, 'commit', '-q', '-m', 'docs: tasks');
  git(W, 'init', '-q', '--bare', '-b', 'main', 'api.git');
  git(api, 'remote', 'add', 'origin', path.join(W, 'api.git'));
  git(api, 'push', '-q', '-u', 'origin', 'main');
  git(api, 'remote', 'set-head', 'origin', 'main');
  return { W, P, dir, api };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const status = (dir) => (fs.readFileSync(path.join(dir, 'stories/EP-l-S01.md'), 'utf8').match(/^status:\s*(\S+)/m) || [])[1];

test('yad build: start → step → trust → ship → done, and every reader agrees the story shipped (#346)', () => {
  const { W, P, dir } = workspace();
  try {
    let r = yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /EP-l-S01 \/ api lane started at spec/);
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    const lane = read(file).repos.api;
    assert.deepEqual(lane.steps.map((s) => s.id), ['spec', 'tasks', 'implement', 'checks', 'engineer-review']);
    assert.ok(lane.steps.every((s) => s.status === 'todo' && s.advance === 'human' && s.automation === 'human_approve'));
    assert.equal(lane.steps.find((s) => s.id === 'engineer-review').locked, true);
    // The web lane is set aside: the story needs no change there.
    r = yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    assert.equal(r.code, 0, r.out);

    for (const step of ['spec', 'tasks', 'implement', 'checks']) {
      const signal = { spec: 'human_edited_spec=false', tasks: 'task_rescoped=false', implement: 'scope_overrun=false', checks: 'checks=pass' }[step];
      r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', step, '--verdict', 'approved-unchanged', '--signal', signal, '--json');
      assert.equal(r.code, 0, r.out);
      const { uid } = json(r);
      assert.match(uid, /^[0-9a-f]{8}$/);
      r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', step, 'done', '--run', uid);
      assert.equal(r.code, 0, r.out);
    }
    const closed = read(file).repos.api.steps.find((s) => s.id === 'checks').closed;
    assert.deepEqual([closed.via, typeof closed.run], ['human', 'string']);
    assert.equal(read(file).repos.api.currentStep, 'engineer-review');

    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'a'.repeat(40), '--approver', 'bob');
    assert.equal(r.code, 0, r.out);
    assert.equal(status(dir), 'in-build', 'a first ship puts an approved story in Build');
    // Not every task shipped: refused, naming what is missing.
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no ship yet for: api\/T02/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T02', '--repo', 'api', '--merge-commit', 'b'.repeat(40));
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /EP-l-S01 is shipped — engineer-review closed in 1 lane/);
    assert.match(r.out, /EP-l is now sealed: every story shipped/);

    // The three signals agree.
    assert.equal(status(dir), 'shipped');
    assert.ok(read(file).repos.api.steps.every((s) => s.status === 'done'));
    const ships = fs.readdirSync(path.join(dir, '.sdlc/build-log')).sort();
    assert.deepEqual(ships, ['EP-l-S01-T01-api.json', 'EP-l-S01-T02-api.json']);
    const ship = read(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json'));
    assert.deepEqual([ship.story, ship.task, ship.repo, ship.mergeCommit, ship.engineer_review[0].approver], ['EP-l-S01', 'T01', 'api', 'a'.repeat(40), 'bob']);
    assert.equal(fs.readdirSync(path.join(dir, '.sdlc/trust-log')).length, 4);

    // And every reader says so.
    r = yad(P, 'next', 'EP-l', '--json');
    assert.equal(r.code, 0, r.out);
    const flat = JSON.stringify(json(r));
    assert.match(flat, /Build — every story\/repo lane is shipped or skipped/, flat.slice(0, 600));
    assert.match(flat, /"repo":"api"[^}]*"shipped":true|"shipped":true[^}]*"repo":"api"/, flat.slice(0, 600));
    // What yad checkpoint would commit: the Build ledgers and the story's status line, nothing else.
    r = yad(P, 'checkpoint', '--dry-run', '--json');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(json(r).files.sort(), [
      'epics/EP-l/.sdlc/build-log/EP-l-S01-T01-api.json', 'epics/EP-l/.sdlc/build-log/EP-l-S01-T02-api.json',
      'epics/EP-l/.sdlc/build-state/EP-l-S01.json', ...fs.readdirSync(path.join(dir, '.sdlc/trust-log')).map((n) => `epics/EP-l/.sdlc/trust-log/${n}`),
      'epics/EP-l/stories/EP-l-S01.md',
    ].sort());
    r = yad(P, 'doctor', '--json');
    const lanesWarn = JSON.stringify(json(r)).match(/lane:[^"]*|step:no-record[^"]*/g) || [];
    assert.deepEqual(lanesWarn, [], 'doctor finds nothing wrong with the lanes');
    r = yad(P, 'tidy', 'up', '--dry-run');
    assert.match(r.out, /EP-l: would fold 4 trust \+ 2 build shard\(s\)/, 'tidy sees a shipped story to fold');
    // Done twice changes nothing.
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 0, r.out);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build step: the lane is walked in order; a halt needs a reason; the review step closes with done', () => {
  const { W, P, dir } = workspace();
  try {
    let r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'in_progress');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EP-l-S01 has no lane in api yet/);
    assert.match(r.out, /yad build start EP-l-S01 --repo api/);
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EP-l-S01 \/ api is at spec, not implement/);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'blocked');
    assert.match(r.out, /a halt needs a reason/);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'blocked', '--reason', 'the contract is unclear');
    assert.equal(r.code, 0, r.out);
    const spec = read(path.join(dir, '.sdlc/build-state/EP-l-S01.json')).repos.api.steps[0];
    assert.deepEqual([spec.status, spec.record.reason], ['blocked', 'the contract is unclear']);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'engineer-review', 'done');
    assert.match(r.out, /engineer-review is closed by `yad build done EP-l-S01`/);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--run', 'deadbeef');
    assert.match(r.out, /no trust run deadbeef for EP-l-S01 \/ api \/ spec/);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done');
    assert.equal(r.code, 0, r.out);
    const after = read(path.join(dir, '.sdlc/build-state/EP-l-S01.json')).repos.api;
    assert.equal(after.currentStep, 'tasks');
    assert.equal('record' in after.steps[0], false, 'closing a halted step drops the halt record');
    r = yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'nope');
    assert.match(r.out, /EP-l-S01 does not declare nope/);
    r = yad(P, 'build', 'start', 'EP-l-S9', '--repo', 'api');
    assert.match(r.out, /no story EP-l-S9/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build trust: signals are checked per step, and --uid finalizes the verdict', () => {
  const { W, P, dir } = workspace();
  try {
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    let r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'great');
    assert.match(r.out, /'great' is not a verdict/);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'rejected', '--signal', 'checks=pass');
    assert.match(r.out, /'checks' is not a implement signal/);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'engineer-review', '--verdict', 'rejected');
    assert.match(r.out, /'engineer-review' has no trust entry/);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'approved-unchanged', '--signal', 'human_edited_diff=false', '--ran-by', 'machine', '--json');
    assert.equal(r.code, 0, r.out);
    const { uid } = json(r);
    const shard = path.join(dir, `.sdlc/trust-log/EP-l-S01-api-implement-${uid}.json`);
    const entry = read(shard);
    assert.deepEqual([entry.verdict, entry.ranBy, entry.signals.human_edited_diff, entry.advance, entry.automation], ['approved-unchanged', 'machine', false, 'human', 'human_approve']);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--uid', uid, '--verdict', 'approved-with-edits');
    assert.equal(r.code, 0, r.out);
    assert.equal(read(shard).verdict, 'approved-with-edits');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship: reads the merged PR, refuses an unmerged one or another task\'s branch', async () => {
  const { buildShip } = await import('./build.mjs');
  const { W, P, dir } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const view = (over = {}) => ({
      state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, headRefName: 'feat/EP-l-S01-T01-orders',
      url: 'https://github.com/o/api/pull/7', body: '## Summary\nx\n\nRisk level: medium\n<!-- yad:trailer -->\n',
      statusCheckRollup: [{ name: 'spec-link', conclusion: 'SUCCESS' }, { name: 'build-test-lint', conclusion: 'SUCCESS' }, { name: 'flaky', conclusion: 'FAILURE' }], ...over,
    });
    let answer = view();
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'pr' ? { ok: true, stdout: JSON.stringify(answer), stderr: '' } : { ok: false, stdout: '', stderr: 'x' });
    const prReader = () => ({ ok: true, reviews: [{ login: 'bob', state: 'APPROVED', body: '' }], headOid: null });
    const r = await buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-19', runner, prReader });
    assert.equal(r.changed, true);
    const ship = read(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json'));
    assert.deepEqual(
      [ship.branch, ship.pr, ship.mergeCommit, ship.gates, ship.risk, ship.companion.trailer, ship.shippedAt, ship.engineer_review],
      ['feat/EP-l-S01-T01-orders', 'https://github.com/o/api/pull/7', 'c'.repeat(40), ['build-test-lint', 'spec-link'], 'medium', true, '2026-10-18', [{ approver: 'bob', engagement: 'none' }]],
    );
    answer = view({ state: 'OPEN', headRefName: 'feat/EP-l-S01-T02-x' });
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', pr: '8', today: '2026-10-19', runner, prReader }), /PR #8 in api is not merged/);
    answer = view({ headRefName: 'feat/EP-l-S01-T03-x' });
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', pr: '9', today: '2026-10-19', runner, prReader }), /is EP-l-S01-T03, not EP-l-S01-T02/);
    answer = view();
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-19', runner, prReader }), /already has a ship in api/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('parseTaskIds and planDone: task lines in their usual forms; a retro ship covers its repo; an unreadable repo refuses', async () => {
  const { parseTaskIds, planDone } = await import('./build.mjs');
  assert.deepEqual(parseTaskIds('# Tasks\n- [ ] T01 a\n- [x] **T02** b\n### T03 — c\n4. T04 d\nT05: e\nsee T09 in text\n- T01 again\n'), ['T01', 'T02', 'T03', 'T04', 'T05']);
  const ships = [{ story: 'S', repo: 'api', task: 'T01' }, { story: 'S', repo: 'web', task: 'retro', retroactive: true }];
  assert.deepEqual(planDone({ story: 'S', declared: ['api', 'web'], owed: { api: ['T01'], web: null }, ships }), { missing: [], unreadable: [], shipped: true });
  assert.deepEqual(planDone({ story: 'S', declared: ['api', 'ops'], owed: { api: ['T01', 'T02'], ops: null }, ships }).missing, ['api/T02']);
  assert.deepEqual(planDone({ story: 'S', declared: ['api', 'ops'], owed: { api: ['T01'], ops: null }, ships }).unreadable, ['ops']);
  assert.equal(planDone({ story: 'S', declared: ['api', 'ops'], skipped: ['ops'], owed: { api: ['T01'] }, ships }).shipped, true);
});

test('yad build done: a repo the story owes with no lane is refused, so yad next and the status never disagree', () => {
  const { W, P, dir } = workspace({ tasks: '- T01 one\n' });
  try {
    // Shipped by hand in api, with no lane: done would set shipped while yad next still reads it in Build.
    let r = yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'd'.repeat(40));
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EP-l-S01 has no lane in api, so `yad next` would still read it in Build/);
    assert.match(r.out, /yad checkpoint --retro-ship/);
    assert.notEqual((fs.readFileSync(path.join(dir, 'stories/EP-l-S01.md'), 'utf8').match(/^status:\s*(\S+)/m) || [])[1], 'shipped');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

// Drive api's lane through its four author steps (no trust runs: the closing record names none).
function walk(P) {
  for (const step of ['spec', 'tasks', 'implement', 'checks']) yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', step, 'done');
}
const story = (dir) => path.join(dir, 'stories/EP-l-S01.md');
const setStory = (dir, fm, name = 'EP-l-S01.md') => {
  fs.rmSync(story(dir), { force: true });
  fs.writeFileSync(path.join(dir, 'stories', name), `---\n${fm}\n---\n# S01\n`);
};

test('yad build done: the status line moves from any Shape value, and a value it cannot place is refused before anything is written (#346 review 1)', () => {
  const { W, P, dir } = workspace({ tasks: '- T01 one\n' });
  try {
    // A story nobody ran sync-status on still says draft; a file named other than its id is found by id.
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: "draft" # authored\nrepos: [api, web]', 'EP-l-S01-checkout.md');
    yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    let r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'e'.repeat(40));
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 0, r.out);
    assert.match(fs.readFileSync(path.join(dir, 'stories/EP-l-S01-checkout.md'), 'utf8'), /^status: shipped$/m);
    assert.match(r.out, /EP-l is now sealed/);

    // A value no Build write can move on: refused, the lanes untouched.
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    const lanesBefore = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(dir, 'stories/EP-l-S01-checkout.md'));
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: ready-for-build\nrepos: [api, web]');
    const bs = JSON.parse(lanesBefore);
    bs.repos.api.steps.find((s) => s.id === 'engineer-review').status = 'todo';
    fs.writeFileSync(file, JSON.stringify(bs));
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /has status: ready-for-build, which a Build write cannot move on/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).repos.api.steps.find((s) => s.id === 'engineer-review').status, 'todo');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build done: no repo owed, a stray lane, a blocked review step, a failed fetch — each refused (#346 review 1)', () => {
  const { W, P, dir, api } = workspace({ tasks: '- T01 one\n' });
  try {
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: approved\nrepos: []');
    let r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /owes no lane in any repo/);
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: approved\nrepos: [api]');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'f'.repeat(40));
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    const bs = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...bs, repos: { ...bs.repos, Api: { currentStep: 'spec', steps: [{ id: 'spec', status: 'todo' }] } } }));
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /has a lane the story does not declare: Api/);
    fs.writeFileSync(file, JSON.stringify(bs));
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'engineer-review', 'blocked', '--reason', 'waiting on a fix');
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /engineer-review is blocked in api/);
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'engineer-review', 'in_progress');
    git(api, 'remote', 'set-url', 'origin', path.join(W, 'gone.git'));
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /could not fetch main in api to read the tasks it owes/);
    r = yad(P, 'build', 'done', 'EP-l-S01', '--no-fetch');
    assert.equal(r.code, 0, r.out);
    const review = JSON.parse(fs.readFileSync(file, 'utf8')).repos.api.steps.find((s) => s.id === 'engineer-review');
    assert.equal(review.status, 'done');
    assert.equal('record' in review, false, 'no halt record left on a closed step');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship: a repo not checked out is never read through the Product; --pr is a number; the stories review must have passed; the branch match ignores case and prefixes (#346 review 1)', async () => {
  const { buildShip } = await import('./build.mjs');
  const { W, P, dir } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../nowhere', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    let r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--pr', '7');
    assert.match(r.out, /api is not checked out here, so its PR cannot be read/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--pr', 'https://x/pull/7', '--merge-commit', 'a'.repeat(40));
    assert.match(r.out, /--pr must be the PR\/MR number/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'not-a-sha');
    assert.match(r.out, /--merge-commit must be a commit SHA/);
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const answer = { state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, headRefName: 'amn/feat/ep-l-s01-t01-orders', url: 'u', body: '', statusCheckRollup: [] };
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'pr' ? { ok: true, stdout: JSON.stringify(answer), stderr: '' } : { ok: false, stdout: '', stderr: 'x' });
    const res = await buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-19', runner, prReader: () => ({ ok: true, reviews: [] }) });
    assert.equal(res.changed, true, 'a lower-case branch under a folder still names the task');
    const st = JSON.parse(fs.readFileSync(path.join(dir, '.sdlc/state.json'), 'utf8'));
    st.steps.find((x) => x.id === 'stories-review').status = 'in_review';
    fs.writeFileSync(path.join(dir, '.sdlc/state.json'), JSON.stringify(st));
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T02', '--repo', 'api', '--merge-commit', 'a'.repeat(40));
    assert.match(r.out, /the stories review has not passed/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});
