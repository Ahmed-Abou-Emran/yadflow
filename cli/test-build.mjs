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
  // A merged commit per task, each naming its task with a Task: trailer, on origin/main.
  const sha = {};
  for (const t of ['T01', 'T02']) {
    write(api, { [`src/${t}.js`]: `${t}\n` });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', `feat: ${t}\n\nTask: EP-l-S01-${t}`);
    sha[t] = git(api, 'rev-parse', 'HEAD');
  }
  git(api, 'push', '-q', 'origin', 'main');
  return { W, P, dir, api, sha };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const status = (dir) => (fs.readFileSync(path.join(dir, 'stories/EP-l-S01.md'), 'utf8').match(/^status:\s*(\S+)/m) || [])[1];

test('yad build: start → step → trust → ship → done, and every reader agrees the story shipped (#346)', () => {
  const { W, P, dir, sha } = workspace();
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

    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01, '--approver', 'bob');
    assert.equal(r.code, 0, r.out);
    assert.equal(status(dir), 'in-build', 'a first ship puts an approved story in Build');
    // Not every task shipped: refused, naming what is missing.
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no ship yet for: api\/T02/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T02', '--repo', 'api', '--merge-commit', sha.T02);
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
    assert.deepEqual([ship.story, ship.task, ship.repo, ship.mergeCommit, ship.engineer_review[0].approver], ['EP-l-S01', 'T01', 'api', sha.T01, 'bob']);
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
  const { W, P, dir, sha } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const view = (over = {}) => ({
      state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: sha.T01 }, headRefName: 'feat/EP-l-S01-T01-orders',
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
      ['feat/EP-l-S01-T01-orders', 'https://github.com/o/api/pull/7', sha.T01, ['build-test-lint', 'spec-link'], 'medium', true, '2026-10-18', [{ approver: 'bob', engagement: 'none' }]],
    );
    answer = view({ state: 'OPEN', headRefName: 'feat/EP-l-S01-T02-x' });
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', pr: '8', today: '2026-10-19', runner, prReader }), /PR #8 in api is not merged/);
    answer = view({ headRefName: 'feat/EP-l-S01-T03-x' });
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', pr: '9', today: '2026-10-19', runner, prReader }), /feat\/EP-l-S01-T03-x, which names another task than EP-l-S01-T02/);
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
  const { W, P, dir, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    // Shipped by hand in api, with no lane: done would set shipped while yad next still reads it in Build.
    let r = yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
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
  const { W, P, dir, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    // A file named other than its id is refused: yad tidy and the seal read a story by its file name.
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: draft\nrepos: [api, web]', 'EP-l-S01-checkout.md');
    let r = yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    assert.match(r.out, /EP-l-S01 is in stories\/EP-l-S01-checkout\.md, not stories\/EP-l-S01\.md/);
    fs.rmSync(path.join(dir, 'stories/EP-l-S01-checkout.md'));
    // A story nobody ran sync-status on still says draft, here quoted with a comment.
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: "draft" # authored\nrepos: [api, web]');
    yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 0, r.out);
    assert.match(fs.readFileSync(story(dir), 'utf8'), /^status: shipped$/m);
    assert.match(r.out, /EP-l is now sealed/);

    // A value no Build write can move on: refused, the lanes untouched.
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    const lanesBefore = fs.readFileSync(file, 'utf8');
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
  const { W, P, dir, api, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: approved\nrepos: []');
    let r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /owes no lane in any repo/);
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: approved\nrepos: [api]');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
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
  const { W, P, dir, sha } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../nowhere', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    let r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--pr', '7');
    assert.match(r.out, /api is not checked out here, so its PR cannot be read/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--pr', 'https://x/pull/7', '--merge-commit', 'a'.repeat(40));
    assert.match(r.out, /--pr must be the PR\/MR number/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', 'not-a-sha');
    assert.match(r.out, /--merge-commit must be a commit SHA/);
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const answer = { state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: sha.T01 }, headRefName: 'amn/feat/ep-l-s01-t01-orders', url: 'u', body: '', statusCheckRollup: [] };
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

test('yad build done: a shipped status written another way is rewritten; two status lines or two files are refused; the epic must be in Build (#346 review 2)', () => {
  const { W, P, dir, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: approved\nstatus: approved\nrepos: [api, web]');
    let r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /which a Build write cannot move on/);
    fs.writeFileSync(path.join(dir, 'stories/EP-l-S01-copy.md'), '---\nid: EP-l-S01\nstatus: approved\n---\n');
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /2 story files claim EP-l-S01/);
    fs.rmSync(path.join(dir, 'stories/EP-l-S01-copy.md'));
    setStory(dir, 'id: EP-l-S01\nepic: EP-l\nstatus: "shipped" # by hand\nrepos: [api, web]');
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.equal(r.code, 0, r.out);
    assert.match(fs.readFileSync(story(dir), 'utf8'), /^status: shipped$/m, 'rewritten as the seal and tidy read it');
    assert.match(r.out, /EP-l is now sealed/);
    // A reopened stories review takes the epic out of Build.
    const st = JSON.parse(fs.readFileSync(path.join(dir, '.sdlc/state.json'), 'utf8'));
    st.steps.find((x) => x.id === 'stories-review').status = 'in_review';
    st.currentStep = 'stories-review';
    fs.writeFileSync(path.join(dir, '.sdlc/state.json'), JSON.stringify(st));
    r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /EP-l is not in Build/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('tasksInBranch: the task a branch names, under folders and in any case, never a slug after it (#346 review 3)', async () => {
  const { tasksInBranch } = await import('./build.mjs');
  assert.deepEqual(tasksInBranch('feat/EP-auth-S01-T02-2fa-setup'), ['ep-auth-s01-t02']);
  assert.deepEqual(tasksInBranch('amn/feat/ep-l-s01-t01-orders'), ['ep-l-s01-t01']);
  assert.deepEqual(tasksInBranch('feat/EP-x-S01-T01-then-S02-T03'), ['ep-x-s01-t01']);
  assert.deepEqual(tasksInBranch('feat/EP-l-S01-T012-x'), ['ep-l-s01-t012']);
  assert.deepEqual(tasksInBranch('EP-l-S01-T01'), ['ep-l-s01-t01']);
  assert.deepEqual(tasksInBranch('fix-typo'), []);
});

test('yad build done: a lane with no steps is half-seeded, not shipped; a clone is matched to its registered URL by path, never printed (#346 review 3)', () => {
  const { W, P, dir, api, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    const bs = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...bs, repos: { ...bs.repos, api: { currentStep: 'spec', steps: [] } } }));
    let r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /EP-l-S01 has no lane in api/);
    // The registered URL with a port and a token, the clone over another remote form: one repo.
    git(api, 'remote', 'set-url', 'origin', path.join(W, 'api.git'));
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', git_url: 'ssh://git@host:2222/team/api.git' }, { name: 'web', path: '../web' }] }) });
    git(api, 'remote', 'set-url', 'origin', 'https://oauth2:SECRET@host/team/api/');
    r = yad(P, 'build', 'done', 'EP-l-S01', '--no-fetch');
    assert.doesNotMatch(r.out, /is a clone of/);
    git(api, 'remote', 'set-url', 'origin', 'https://oauth2:SECRET@host/team/other.git');
    r = yad(P, 'build', 'done', 'EP-l-S01', '--no-fetch');
    assert.match(r.out, /\.\.\/api is a clone of team\/other, not team\/api/);
    assert.doesNotMatch(r.out, /SECRET/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship: an epic slug that reads like a task still matches its own branch (#346 review 4)', async () => {
  const { tasksInBranch } = await import('./build.mjs');
  assert.deepEqual(tasksInBranch('feat/EP-aws-s3-t2-backup-S01-T01-x'), ['ep-aws-s3-t2'], 'the general scan alone would refuse it');
  // The exact id is matched first, so a branch whose slug after the task reads like another task passes too.
  const { W, P, sha } = workspace();
  try {
    const { buildShip } = await import('./build.mjs');
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const answer = { state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: sha.T01 }, headRefName: 'feat/EP-l-S01-T01-s3-t2-x', url: 'u', body: '', statusCheckRollup: [] };
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'pr' ? { ok: true, stdout: JSON.stringify(answer), stderr: '' } : { ok: false, stdout: '', stderr: 'x' });
    const r = await buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-20', runner, prReader: () => ({ ok: true, reviews: [] }) });
    assert.equal(r.changed, true);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build done: a status write that fails puts the lanes back; another build-state file claiming the story is refused (#346 review 4)', { skip: (process.getuid && process.getuid() === 0) && 'root writes read-only files' }, () => {
  const { W, P, dir, sha } = workspace({ tasks: '- T01 one\n' });
  try {
    yad(P, 'skip', 'EP-l', 'EP-l-S01', '--repo', 'web', '--reason', 'no UI change');
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    walk(P);
    yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01);
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    fs.writeFileSync(path.join(dir, '.sdlc/build-state/copy.json'), JSON.stringify({ story: 'EP-l-S01', repos: {} }));
    let r = yad(P, 'build', 'done', 'EP-l-S01');
    assert.match(r.out, /build-state\/copy\.json also says story: EP-l-S01/);
    fs.rmSync(path.join(dir, '.sdlc/build-state/copy.json'));
    const before = fs.readFileSync(file, 'utf8');
    fs.chmodSync(story(dir), 0o444);
    try {
      r = yad(P, 'build', 'done', 'EP-l-S01');
      assert.notEqual(r.code, 0, r.out);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the lanes are exactly as they were');
    } finally { fs.chmodSync(story(dir), 0o644); }
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build step --task: the next task reopens implement and checks once the lane is at the review step; each close is kept (#346)', () => {
  const { W, P, dir } = workspace();
  try {
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    for (const step of ['spec', 'tasks']) yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', step, 'done');
    let r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'approved-unchanged', '--task', 'T01', '--json');
    const t1 = json(r).uid;
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--run', t1, '--task', 'T01');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'in_progress', '--task', 'T02');
    assert.match(r.out, /once the lane is at engineer-review/, 'not before checks is done for T01');
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done', '--task', 'T01');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'in_progress');
    assert.match(r.out, /implement is already done/, 'no --task, no reopen');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'blocked', '--task', 'T02', '--reason', 'scope overrun: b.js');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /implement is blocked again, for T02/);
    const file = path.join(dir, '.sdlc/build-state/EP-l-S01.json');
    let lane = read(file).repos.api;
    const impl = lane.steps.find((s) => s.id === 'implement');
    assert.deepEqual([lane.currentStep, impl.status, impl.record.reason, impl.runs[0].task, impl.runs[0].run], ['implement', 'blocked', 'scope overrun: b.js', 'T01', t1]);
    assert.equal(lane.steps.find((s) => s.id === 'checks').status, 'todo', 'checks is owed again for T02');
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'approved-with-edits', '--task', 'T02', '--json');
    const t2 = json(r).uid;
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--run', t2, '--task', 'T02');
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done', '--task', 'T02');
    lane = read(file).repos.api;
    assert.equal(lane.currentStep, 'engineer-review');
    assert.deepEqual(lane.steps.find((s) => s.id === 'implement').closed, { by: 'alice', date: lane.steps.find((s) => s.id === 'implement').closed.date, via: 'human', run: t2, task: 'T02' });
    assert.equal(read(path.join(dir, `.sdlc/trust-log/EP-l-S01-api-implement-${t2}.json`)).task, 'T02');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship: a task merged with no PR is recorded from its commit on the default branch (#346)', async () => {
  const { buildShip } = await import('./build.mjs');
  const { W, P, dir, api } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    write(api, { 'src/x.js': 'x\n' });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'feat: x\n\nTask: EP-l-S01-T01');
    const sha = git(api, 'rev-parse', 'HEAD');
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'api' ? { ok: true, stdout: '[]', stderr: '' } : { ok: false, stdout: '', stderr: 'no PR is read' });
    // Not pushed yet: not on the default branch.
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', mergeCommit: sha, today: '2026-10-20', runner }), /is not on api's main/);
    git(api, 'push', '-q', 'origin', 'main');
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', mergeCommit: sha, today: '2026-10-20', runner }), /names EP-l-S01-T01, not EP-l-S01-T02/);
    const r = await buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', mergeCommit: sha.slice(0, 12), today: '2026-10-20', runner });
    assert.equal(r.changed, true);
    const ship = read(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json'));
    assert.deepEqual([ship.pr, ship.mergeCommit, ship.engineer_review], ['none', sha, []]);
    // Hand-given approvers are still refused where the platform can be read.
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', mergeCommit: sha, approvers: ['bob'], today: '2026-10-20', runner }), /the ship is read from PR/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship with no PR, where the platform can be read: the commit names the task, and the platform says no PR merged it (#346 review 7)', async () => {
  const { buildShip } = await import('./build.mjs');
  const { W, P, dir, api } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    const commit = (msg) => {
      write(api, { [`src/${Math.random().toString(36).slice(2)}.js`]: 'x\n' });
      git(api, 'add', '-A');
      git(api, 'commit', '-q', '-m', msg);
      git(api, 'push', '-q', 'origin', 'main');
      return git(api, 'rev-parse', 'HEAD');
    };
    let pulls = '[]';
    let fails = false;
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'api' && /\/pulls$/.test(args[1])
      ? (fails ? { ok: false, stdout: '', stderr: 'HTTP 401' } : { ok: true, stdout: pulls, stderr: '' })
      : { ok: false, stdout: '', stderr: 'x' });
    const ship = (task, sha) => buildShip(P, { story: 'EP-l-S01', task, repo: 'api', mergeCommit: sha, today: '2026-10-20', runner });
    await assert.rejects(() => ship('T1', commit('feat: ten\n\nTask: EP-l-S01-T10')), /names EP-l-S01-T10, not EP-l-S01-T1/);
    await assert.rejects(() => ship('T03', commit('Revert "feat: three EP-l-S01-T03"')), /does not name EP-l-S01-T03/);
    await assert.rejects(() => ship('T03', commit('docs: notes\n\nfollow-up to EP-l-S01-T03')), /does not name EP-l-S01-T03/);
    // The platform says a PR merged it: refused, naming that PR so its approvers are kept.
    const squashed = commit('feat: EP-l-S01-T03 orders (#5)');
    pulls = JSON.stringify([{ number: 5, merged_at: '2026-10-19T10:00:00Z' }]);
    await assert.rejects(() => ship('T03', squashed), /merged by PR\/MR #5/);
    // The platform cannot answer: refused, never a guess.
    fails = true;
    await assert.rejects(() => ship('T03', squashed), /could not ask github whether a PR\/MR merged/);
    // "(#346)" cites an issue and the platform knows no PR: recorded with no PR.
    fails = false;
    pulls = '[]';
    const r = await ship('T04', commit('feat: EP-l-S01-T04 orders (#346)'));
    assert.equal(r.changed, true);
    assert.equal(read(path.join(dir, '.sdlc/build-log/EP-l-S01-T04-api.json')).pr, 'none');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build ship by hand, where the platform cannot be read: the person vouches, but not for another task or another PR (#346 review 7)', () => {
  const { W, P, api } = workspace();
  try {
    const commit = (msg) => {
      write(api, { [`src/${Math.random().toString(36).slice(2)}.js`]: 'x\n' });
      git(api, 'add', '-A');
      git(api, 'commit', '-q', '-m', msg);
      git(api, 'push', '-q', 'origin', 'main');
      return git(api, 'rev-parse', 'HEAD');
    };
    let r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T03', '--repo', 'api', '--merge-commit', commit('feat: ten\n\nTask: EP-l-S01-T10'));
    assert.match(r.out, /names EP-l-S01-T10, not EP-l-S01-T03/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T03', '--repo', 'api', '--pr', '7', '--merge-commit', commit('Merge pull request #9 from org/feat/x'), '--approver', 'bob');
    assert.match(r.out, /merged PR\/MR #9, not #7/);
    r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T03', '--repo', 'api', '--pr', '5', '--merge-commit', commit('feat: list orders (#5)'), '--approver', 'bob');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /names no task — recorded as you say it ships EP-l-S01-T03/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build step: done --task for another task is refused; only implement reopens; closes without --run keep their history (#346 review 5)', () => {
  const { W, P, dir } = workspace();
  try {
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    for (const step of ['spec', 'tasks']) yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', step, 'done');
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--task', 'T01');
    let r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--task', 'T02');
    assert.match(r.out, /implement was closed for T01, not T02/);
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'in_progress', '--task', 'T02');
    assert.match(r.out, /the next task reopens implement once the lane is at engineer-review/);
    // Walked by hand, with no --run: every task's close is kept.
    for (const t of ['T02', 'T03']) {
      yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'in_progress', '--task', t);
      r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done');
      assert.equal(r.code, 0, r.out);
      yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done');
    }
    const impl = read(path.join(dir, '.sdlc/build-state/EP-l-S01.json')).repos.api.steps.find((s) => s.id === 'implement');
    assert.deepEqual([impl.closed.task, ...impl.runs.map((x) => x.task)], ['T03', 'T01', 'T02'], 'the task defaults to the one the step was reopened for');
    // A close with no task is not "already done" for T04, and a run already used for a close is not reused.
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'approved-unchanged', '--json');
    const used = json(r).uid;
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'in_progress', '--task', 'T04');
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--run', used);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--task', 'T09');
    assert.match(r.out, /implement was closed for T04, not T09/);
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done');
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'in_progress', '--task', 'T05');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--run', used);
    assert.match(r.out, new RegExp(`trust run ${used} already closed implement`));
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('prOfCommit: certain for a GitHub or GitLab merge, only a maybe for a squash (#346 review 6)', async () => {
  const { prOfCommit } = await import('./ship-drift.mjs');
  assert.deepEqual(prOfCommit('Merge pull request #42 from org/feat/x'), { pr: 42, certain: true });
  assert.deepEqual(prOfCommit("Merge branch 'feat/x' into 'main'", 'See merge request team/api!12'), { pr: 12, certain: true });
  assert.deepEqual(prOfCommit('feat: orders (#17)'), { pr: 17, certain: false });
  assert.deepEqual(prOfCommit('feat: orders #17 later'), { pr: null, certain: false });
});

test('yad build step: the same close sent again is "already done", and no second trust run is asked for (#346 review 7)', () => {
  const { W, P, dir } = workspace();
  try {
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    const r0 = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'spec', '--verdict', 'approved-unchanged', '--json');
    const uid = json(r0).uid;
    let r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--run', uid);
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--run', uid);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /spec is already done in EP-l-S01 \/ api — nothing changed/);
    assert.equal(fs.readdirSync(path.join(dir, '.sdlc/trust-log')).length, 1);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--task', 'T01');
    assert.match(r.out, /--task does not apply to spec/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build: the PR path checks what merged; a by-hand ship keeps the commit date; --via auto obeys the kill switch and a rejected run (#346 final review)', async () => {
  const { buildShip } = await import('./build.mjs');
  const { W, P, api, sha } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    // Merged into another branch: not on main.
    git(api, 'checkout', '-q', '-b', 'release/1.x');
    write(api, { 'src/rel.js': 'x\n' });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'feat: release fix\n\nTask: EP-l-S01-T01');
    const off = git(api, 'rev-parse', 'HEAD');
    git(api, 'push', '-q', 'origin', 'release/1.x');
    git(api, 'checkout', '-q', 'main');
    let mergeOid = off;
    let branch = 'feat/EP-l-S01-T01-x';
    const runner = (cmd, args) => (cmd === 'gh' && args[0] === 'pr'
      ? { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: mergeOid }, headRefName: branch, url: 'u', body: '', statusCheckRollup: [] }), stderr: '' }
      : { ok: false, stdout: '', stderr: 'x' });
    const prReader = () => ({ ok: true, reviews: [] });
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-20', runner, prReader }), /is not on api's main/);
    // A branch naming no task, a merge commit naming another: refused.
    mergeOid = sha.T02;
    branch = 'hotfix-login';
    await assert.rejects(() => buildShip(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '8', today: '2026-10-20', runner, prReader }), /names EP-l-S01-T02, not EP-l-S01-T01/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build: a by-hand ship records the commit date; --via auto needs the dial in force and a run not rejected (#346 final review)', () => {
  const { W, P, dir, api, sha } = workspace();
  try {
    const when = git(api, 'log', '-1', '--format=%cs', sha.T01);
    let r = yad(P, 'build', 'ship', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--merge-commit', sha.T01, '--approver', 'bob');
    assert.equal(r.code, 0, r.out);
    assert.equal(read(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json')).shippedAt, when);
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    r = yad(P, 'dial', 'EP-l', 'EP-l-S01', '--repo', 'api', 'spec', '--to', 'auto');
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'spec', '--verdict', 'rejected', '--json');
    const bad = json(r).uid;
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--via', 'auto');
    assert.match(r.out, /--via auto needs --run <uid>/);
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--via', 'auto', '--run', bad);
    assert.match(r.out, /is rejected, so spec does not advance on its own/);
    r = yad(P, 'kill', '--reason', 'a bad week');
    assert.equal(r.code, 0, r.out);
    r = yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'spec', '--verdict', 'approved-unchanged', '--json');
    const good = json(r).uid;
    assert.equal(read(path.join(dir, `.sdlc/trust-log/EP-l-S01-api-spec-${good}.json`)).advance, 'human', 'the dial in force under the kill switch');
    r = yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'spec', 'done', '--via', 'auto', '--run', good);
    assert.match(r.out, /the kill switch is on/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build merged: asks the platform about the task\'s PR, found by its branch; --ship records it once (#355)', async () => {
  const { buildMerged } = await import('./build.mjs');
  const { W, P, dir, sha } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    let list = [];
    const views = {};
    const asked = [];
    const runner = (cmd, args) => {
      asked.push(args.slice(0, 2).join(' '));
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: JSON.stringify(list), stderr: '' };
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && views[args[2]]) return { ok: true, stdout: JSON.stringify(views[args[2]]), stderr: '' };
      return { ok: false, stdout: '', stderr: 'x' };
    };
    const prReader = () => ({ ok: true, reviews: [{ login: 'bob', state: 'APPROVED', body: '' }], headOid: null });
    const ask = (over = {}) => buildMerged(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', today: '2026-10-20', runner, prReader, ...over });
    const view = (state, branch = 'feat/EP-l-S01-T01-orders', oid = sha.T01) => ({
      state, mergedAt: state === 'MERGED' ? '2026-10-19T10:00:00Z' : null, mergeCommit: state === 'MERGED' ? { oid } : null,
      headRefName: branch, url: 'https://github.com/o/api/pull/7', body: '', statusCheckRollup: [],
    });
    // No PR carries the task yet. Another task's PR and a branch with the id inside a longer one do not count.
    list = [{ number: 3, state: 'OPEN', headRefName: 'feat/EP-l-S01-T02-x', url: 'u3' }, { number: 4, state: 'OPEN', headRefName: 'feat/EP-l-S01-T012-x', url: 'u4' }];
    assert.equal((await ask()).state, 'none');
    // An open PR: not merged yet, and nothing written.
    list.push({ number: 7, state: 'OPEN', headRefName: 'feat/EP-l-S01-T01-orders', url: 'u7' });
    views['7'] = view('OPEN');
    let r = await ask({ ship: true });
    assert.deepEqual([r.state, r.pr, r.changed], ['open', 7, false]);
    assert.equal(fs.existsSync(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json')), false);
    // Two live PRs for the task: refused, naming both. A closed one alongside a live one does not count.
    list.push({ number: 8, state: 'OPEN', headRefName: 'fix/ep-l-s01-t01', url: 'u8' });
    await assert.rejects(() => ask(), /more than one PR\/MR carries EP-l-S01-T01: #7 \(open\), #8 \(open\)/);
    list[list.length - 1].state = 'CLOSED';
    // Merged: the merge commit is named; without --ship nothing is written.
    views['7'] = view('MERGED');
    r = await ask();
    assert.deepEqual([r.state, r.pr, r.mergeCommit, r.changed], ['merged', 7, sha.T01, false]);
    assert.equal(fs.existsSync(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json')), false);
    // --ship records it through `build ship`, with the PR's approvers.
    r = await ask({ ship: true });
    assert.deepEqual([r.state, r.changed, r.ship.engineer_review], ['merged', true, [{ approver: 'bob', engagement: 'none' }]]);
    assert.equal(read(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json')).mergeCommit, sha.T01);
    assert.equal(status(dir), 'in-build');
    // Asked again: already shipped, the same answer with or without --ship, and the platform is not asked.
    asked.length = 0;
    r = await ask({ ship: true });
    assert.deepEqual([r.state, r.changed, r.mergeCommit], ['shipped', false, sha.T01]);
    assert.deepEqual(asked, []);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build merged: closed, a cut-short list, a --pr for another task, and no platform to ask (#355)', async () => {
  const { buildMerged, findTaskPrs } = await import('./build.mjs');
  const { W, P } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'gitlab' }, { name: 'web', path: '../web' }] }) });
    let mrs = [];
    const mr = {};
    const runner = (cmd, args) => {
      if (cmd !== 'glab') return { ok: false, stdout: '', stderr: 'x' };
      if (args[1].startsWith('projects/:id/merge_requests?')) return { ok: true, stdout: JSON.stringify(mrs), stderr: '' };
      const n = (args[1].match(/merge_requests\/(\d+)$/) || [])[1];
      return n && mr[n] ? { ok: true, stdout: JSON.stringify(mr[n]), stderr: '' } : { ok: false, stdout: '', stderr: 'x' };
    };
    const ask = (over = {}) => buildMerged(P, { story: 'EP-l-S01', task: 'T02', repo: 'api', today: '2026-10-20', runner, ...over });
    // Only a closed MR: closed, naming it.
    mrs = [{ iid: 5, state: 'closed', source_branch: 'feat/EP-l-S01-T02-y', web_url: 'w5' }];
    assert.deepEqual([(await ask()).state, (await ask()).pr], ['closed', 5]);
    // A locked MR is mid-merge: still open.
    mr['6'] = { iid: 6, state: 'locked', source_branch: 'feat/EP-l-S01-T02-y', web_url: 'w6' };
    assert.equal((await ask({ pr: '6' })).state, 'open');
    // A full page with no match: none, and the answer says the list was cut short.
    mrs = Array.from({ length: 100 }, (_, i) => ({ iid: i + 10, state: 'merged', source_branch: `feat/x-${i}` }));
    const r = await ask();
    assert.deepEqual([r.state, r.partial], ['none', true]);
    assert.equal(findTaskPrs('gitlab', { story: 'EP-l-S01', task: 'T02' }, { runner }).partial, true);
    // --pr naming another task's MR: refused. A bad number: refused.
    mr['9'] = { iid: 9, state: 'merged', source_branch: 'feat/EP-l-S01-T01-x', merge_commit_sha: 'abc1234' };
    await assert.rejects(() => ask({ pr: '9' }), /feat\/EP-l-S01-T01-x, which names another task than EP-l-S01-T02/);
    await assert.rejects(() => ask({ pr: 'x9' }), /--pr must be the PR\/MR number/);
    // The listing fails: refused, never "none".
    await assert.rejects(() => ask({ runner: () => ({ ok: false, stdout: '', stderr: 'denied' }) }), /could not list the PRs\/MRs of api: denied/);
    // No platform recorded: refused with the by-hand way.
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api' }, { name: 'web', path: '../web' }] }) });
    fs.rmSync(path.join(W, 'api/.git/refs/remotes'), { recursive: true, force: true });
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: path.join(W, 'api') });
    await assert.rejects(() => ask(), /api has no platform to ask, so yad cannot see whether EP-l-S01-T02 merged/);
    // A story the repo is not declared for: the same refusal `build ship` gives.
    await assert.rejects(() => buildMerged(P, { story: 'EP-l-S01', task: 'T02', repo: 'ops', runner }), /does not declare ops/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build merged through the CLI: help names it, and --json carries the state (#355)', () => {
  const { W, P } = workspace();
  try {
    const h = yad(P, '--help');
    assert.match(h.out, /yad build merged <story> --task <T> --repo <r>/);
    const r = yad(P, 'build', 'merged', 'EP-l-S01', '--task', 'T01', '--repo', 'api', '--json');
    // api has an origin on disk but no platform: refused with the by-hand hint, as JSON.
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /cannot see whether EP-l-S01-T01 merged/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build merged: a PR merged off the default branch, or naming another task, is refused, never "merged" (#355 review 1)', async () => {
  const { buildMerged } = await import('./build.mjs');
  const { W, P, api, sha } = workspace();
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }) });
    git(api, 'checkout', '-q', '-b', 'release/1.x');
    write(api, { 'src/rel.js': 'x\n' });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'feat: release fix\n\nTask: EP-l-S01-T01');
    const off = git(api, 'rev-parse', 'HEAD');
    git(api, 'push', '-q', 'origin', 'release/1.x');
    git(api, 'checkout', '-q', 'main');
    let oid = off;
    const runner = (cmd, args) => (cmd === 'gh' && args[1] === 'view'
      ? { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-19T10:00:00Z', mergeCommit: oid ? { oid } : null, headRefName: 'feat/EP-l-S01-T01-x', url: 'u', body: '', statusCheckRollup: [] }), stderr: '' }
      : { ok: false, stdout: '', stderr: 'x' });
    const ask = () => buildMerged(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-20', runner });
    await assert.rejects(ask, /is not on api's main/);
    oid = sha.T02;
    await assert.rejects(ask, /names EP-l-S01-T02, not EP-l-S01-T01/);
    oid = null;
    await assert.rejects(ask, /merged, but the platform names no merge commit/);
    oid = sha.T01;
    assert.deepEqual([(await ask()).state, (await ask()).mergeCommit], ['merged', sha.T01]);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad build merged: a ship build ship would not write (a file another repo\'s name shares) is refused, not "merged" (#355 review 3)', async () => {
  const { buildMerged } = await import('./build.mjs');
  const { W, P, dir, sha } = workspace();
  try {
    write(P, {
      '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github' }, { name: 'web', path: '../web' }] }),
      // A shard under api's file name that the ledger cannot read: build ship would refuse to write over it.
      'epics/EP-l/.sdlc/build-log/EP-l-S01-T01-api.json': '{ not json',
    });
    const runner = (cmd, args) => (cmd === 'gh' && args[1] === 'view'
      ? { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-19T10:00:00Z', mergeCommit: { oid: sha.T01 }, headRefName: 'feat/EP-l-S01-T01-x', url: 'u', body: '', statusCheckRollup: [] }), stderr: '' }
      : { ok: false, stdout: '', stderr: 'x' });
    await assert.rejects(() => buildMerged(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', pr: '7', today: '2026-10-20', runner }), /api shares a ship file name/);
    assert.equal(fs.readFileSync(path.join(dir, '.sdlc/build-log/EP-l-S01-T01-api.json'), 'utf8'), '{ not json');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('planAutoOpen: only this task\'s checks close, with a run that passed and was not rejected, opens a PR without asking (#356)', async () => {
  const { planAutoOpen } = await import('./build.mjs');
  const at = { story: 'EP-l-S01', repo: 'api' };
  const run = (uid, over = {}) => ({ uid, story: 'EP-l-S01', repo: 'api', step: 'checks', verdict: 'approved-unchanged', signals: { checks: 'pass' }, ...over });
  const lane = (checks, extra = {}) => ({ currentStep: 'engineer-review', steps: [{ id: 'implement', status: 'done' }, { id: 'checks', status: 'done', ...checks }], ...extra });
  const ask = (l, runs, task = 'T01') => planAutoOpen(l, runs, { ...at, task });
  // No close for the task, or a close for another task.
  assert.match(ask(lane({}), []).message, /checks has not closed for T01/);
  assert.match(ask(lane({ closed: { run: 'a', task: 'T02', date: '2026-10-20' } }), [run('a', { task: 'T02' })]).message, /has not closed for T01/);
  // A close naming a run that is not recorded, a rejected run, a run without checks=pass.
  assert.match(ask(lane({ closed: { run: 'a', task: 'T01' } }), []).message, /trust run a, which is not recorded/);
  assert.match(ask(lane({ closed: { run: 'a', task: 'T01' } }), [run('a', { verdict: 'rejected' })]).message, /is rejected/);
  assert.match(ask(lane({ closed: { run: 'a', task: 'T01' } }), [run('a', { signals: { checks: 'fail' } })]).message, /did not record checks=pass/);
  assert.match(ask(lane({ closed: { run: 'a', task: 'T01' } }), [run('a', { signals: {} })]).message, /did not record checks=pass/);
  // A pass: the close in `closed`, or an earlier one kept in `runs` after the next task reopened the step.
  assert.equal(ask(lane({ closed: { run: 'a', task: 'T01' } }), [run('a')]).ok, true);
  assert.equal(ask(lane({ status: 'todo', task: 'T02', runs: [{ run: 'a', task: 'T01', date: '2026-10-19' }] }), [run('a')]).ok, true);
  // A close naming no task counts when its run names none, or this one — never another.
  assert.equal(ask(lane({ closed: { run: 'a' } }), [run('a')]).ok, true);
  assert.equal(ask(lane({ closed: { run: 'a' } }), [run('a', { task: 'T01' })]).ok, true);
  assert.equal(ask(lane({ closed: { run: 'a' } }), [run('a', { task: 'T02' })]).ok, false);
  // The newest close wins: a later rejected re-run is not hidden by an earlier pass.
  const twice = lane({ closed: { run: 'b', task: 'T01', date: '2026-10-20' }, runs: [{ run: 'a', task: 'T01', date: '2026-10-19' }] });
  assert.match(ask(twice, [run('a'), run('b', { verdict: 'rejected' })]).message, /\(b\) is rejected/);
  // Already opened by the dial: not a second time.
  assert.match(ask(lane({ closed: { run: 'a', task: 'T01' } }, { opened: [{ task: 'T01', pr: 12 }] }), [run('a')]).message, /already opened by the dial: #12/);
  assert.match(ask(null, []).message, /has no lane/);
});

test('yad dial open-pr: a project-wide action dial every automation.json writer keeps; doctor names a bad value (#356)', async () => {
  const { automationChecks } = await import('./doctor.mjs');
  const { W, P } = workspace();
  try {
    const file = path.join(P, '.sdlc/automation.json');
    let r = yad(P, 'dial', 'open-pr', '--json');
    assert.deepEqual([json(r).scope, json(r).advance, json(r).why], ['action', 'human', 'project']);
    r = yad(P, 'dial', 'open-pr', '--to', 'auto');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(read(file).actions, { 'open-pr': 'auto' });
    // A Shape dial and the kill switch rewrite the file: the action dial survives each.
    yad(P, 'dial', 'architecture', '--to', 'auto');
    yad(P, 'kill', '--reason', 'bad deploy');
    r = yad(P, 'dial', 'open-pr', '--json');
    assert.deepEqual([json(r).set, json(r).advance, json(r).why], ['auto', 'human', 'kill']);
    yad(P, 'unkill');
    assert.deepEqual([read(file).actions, read(file).steps], [{ 'open-pr': 'auto' }, { architecture: 'auto' }]);
    assert.equal(json(yad(P, 'dial', 'open-pr', '--json')).advance, 'auto');
    // Set for the project, never per lane.
    r = yad(P, 'dial', 'EP-l', 'EP-l-S01', '--repo', 'api', 'open-pr', '--to', 'auto');
    assert.notEqual(r.code, 0);
    assert.match(r.out, /open-pr is set for the whole project, not per lane/);
    // Back to human: the key is removed.
    yad(P, 'dial', 'open-pr', '--to', 'human');
    assert.equal(read(file).actions, undefined);
    // Doctor: an unknown value or action is named.
    fs.writeFileSync(file, JSON.stringify({ steps: {}, actions: { 'open-pr': 'yes', merge: 'auto' } }));
    const checks = [];
    automationChecks(checks, P);
    const unknown = checks.find((x) => x.id === 'automation:unknown');
    assert.match(unknown.message, /actions\.open-pr: "yes" is not human or auto/);
    assert.match(unknown.message, /actions\.merge: not an action this release knows/);
    assert.equal(json(yad(P, 'dial', 'open-pr', '--json')).advance, 'human', '"yes" is not auto');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad open-pr --via auto: opened on the standing approval only after this task\'s checks passed; refusals push nothing; recorded on the lane (#356)', async () => {
  const { runOpenPr } = await import('./openpr.mjs');
  const { buildMerged } = await import('./build.mjs');
  const { W, P, dir, api, sha } = workspace();
  const prev = process.exitCode;
  try {
    write(P, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'api', path: '../api', platform: 'github', default_branch: 'main' }, { name: 'web', path: '../web' }] }) });
    git(P, 'add', '-A');
    git(P, 'commit', '-q', '-m', 'chore: register api on github');
    const branch = 'feat/EP-l-S01-T01-orders';
    git(api, 'checkout', '-q', '-b', branch);
    write(api, { 'src/orders.js': 'x\n' });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'feat: orders\n\nTask: EP-l-S01-T01');
    const pushed = () => git(api, 'ls-remote', '--heads', 'origin', branch) !== '';
    let created = 0;
    const creator = () => { created += 1; return { ok: true, url: 'https://github.com/o/api/pull/12' }; };
    const runner = () => ({ ok: false, stdout: '', stderr: 'no platform here' });
    const open = (over = {}) => runOpenPr(api, { product: P, via: 'auto', creator, runner, today: '2026-10-20', ...over });
    // The dial is human: refused, nothing pushed.
    await assert.rejects(open, /the open-pr dial is human/);
    yad(P, 'dial', 'open-pr', '--to', 'auto');
    // No lane yet, then checks not closed for T01: refused, nothing pushed.
    await assert.rejects(open, /has no lane/);
    yad(P, 'build', 'start', 'EP-l-S01', '--repo', 'api');
    for (const step of ['spec', 'tasks']) yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', step, 'done');
    const impl = json(yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'implement', '--verdict', 'approved-unchanged', '--task', 'T01', '--json')).uid;
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'implement', 'done', '--run', impl, '--task', 'T01');
    await assert.rejects(open, /checks has not closed for T01/);
    const checks = json(yad(P, 'build', 'trust', 'EP-l-S01', '--repo', 'api', 'checks', '--verdict', 'approved-unchanged', '--signal', 'checks=pass', '--task', 'T01', '--json')).uid;
    yad(P, 'build', 'step', 'EP-l-S01', '--repo', 'api', 'checks', 'done', '--run', checks, '--task', 'T01');
    // The kill switch holds it.
    yad(P, 'kill', '--reason', 'freeze');
    await assert.rejects(open, /kill switch .* holds it at human/);
    yad(P, 'unkill');
    // A bad --via; a branch naming no task.
    await assert.rejects(() => open({ via: 'yes' }), /--via must be auto or human/);
    await assert.rejects(() => open({ task: 'nope' }), /names no task/);
    assert.equal(pushed(), false, 'no refusal pushed the branch');
    assert.equal(created, 0);
    // Opened: pushed, created once, and recorded on the lane with the run that earned it.
    const res = await open();
    assert.deepEqual([res.via, pushed(), created], ['auto', true, 1]);
    const lane = read(path.join(dir, '.sdlc/build-state/EP-l-S01.json')).repos.api;
    assert.deepEqual(lane.opened, [{ task: 'T01', pr: 12, url: 'https://github.com/o/api/pull/12', via: 'auto', run: checks, by: 'alice', date: '2026-10-20' }]);
    // Not a second time.
    await assert.rejects(open, /already opened by the dial: #12/);
    // `yad build merged` reads the recorded number: no search is needed (the listing would fail here).
    const view = (cmd, args) => (cmd === 'gh' && args[1] === 'view' && args[2] === '12'
      ? { ok: true, stdout: JSON.stringify({ state: 'OPEN', headRefName: branch, url: 'u12', body: '', statusCheckRollup: [] }), stderr: '' }
      : { ok: false, stdout: '', stderr: 'x' });
    const m = await buildMerged(P, { story: 'EP-l-S01', task: 'T01', repo: 'api', today: '2026-10-20', runner: view });
    assert.deepEqual([m.state, m.pr], ['open', 12]);
    // A human open is today's open: no dial asked, nothing recorded.
    git(api, 'checkout', '-q', '-b', 'feat/EP-l-S01-T02-list');
    const h = await runOpenPr(api, { product: P, creator, runner });
    assert.equal(h.via, 'human');
    assert.equal(read(path.join(dir, '.sdlc/build-state/EP-l-S01.json')).repos.api.opened.length, 1);
    void sha;
  } finally { process.exitCode = prev; fs.rmSync(W, { recursive: true, force: true }); }
});
