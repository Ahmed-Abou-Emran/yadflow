// `yad run checks` (issue #347): every pull request gate, run here before the push, as CI runs it.
// Each test builds a workspace — a Product and a code repo, each with a bare origin — and runs the real CLI
// from inside the code repo.
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
// No CI variable, git identity or base from the shell that runs the suite.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^GIT_(AUTHOR|COMMITTER)_/.test(k) && !/^(CI|GITLAB_CI|GITHUB_ACTIONS|SDLC_BASE|SDLC_HUB_CONFIG|SDLC_PRODUCT_CONFIG)$/.test(k) && !/^(CI_|GITHUB_)/.test(k)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: ENV }).toString().trim();
const fm = (fields) => ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
function commitAll(dir, msg, files = {}) {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'alice');
  git(dir, 'config', 'user.email', 'alice@corp.io');
  git(dir, 'config', 'commit.gpgsign', 'false');
}
function addOrigin(dir, bare) {
  git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', path.basename(bare));
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
}
// Every installed gate, as `yad check --fix` puts them in a code repo.
function installChecks(repo) {
  fs.mkdirSync(path.join(repo, 'checks'), { recursive: true });
  for (const sk of ['yad-checks', 'yad-pr-template']) {
    const from = path.join(ROOT, 'skills', sk, 'templates', 'checks');
    for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(repo, 'checks', f));
  }
}

// W/product (registers ../backend), W/backend on a `feature` branch with one task commit, both with origins.
function workspace({ storyStatus = 'in-progress' } = {}) {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yad-run-checks-')));
  fs.mkdirSync(path.join(W, 'remotes'));
  fs.writeFileSync(path.join(W, '.yad-workspace.json'), JSON.stringify({ version: 1, product: 'product' }));
  const product = path.join(W, 'product');
  initRepo(product);
  commitAll(product, 'chore: seed the Product', {
    '.sdlc/product.json': JSON.stringify({ platform: 'github', default_branch: 'main' }),
    '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'backend', path: '../backend' }] }),
    'epics/EP-demo/epic.md': `${fm({ epic: 'EP-demo', type: 'feature' })}\n# EP-demo\n`,
    'epics/EP-demo/stories/EP-demo-S01.md': `${fm({ story: 'EP-demo-S01', status: storyStatus })}\n# S01\n`,
  });
  addOrigin(product, path.join(W, 'remotes/product.git'));

  const backend = path.join(W, 'backend');
  initRepo(backend);
  installChecks(backend);
  commitAll(backend, 'chore: wire the gates', {
    '.gitignore': '.yad/\n',
    '.sdlc/product-link.json': JSON.stringify({ git_url: path.join(W, 'remotes/product.git'), path: '.yad/product', default_branch: 'main' }),
    'specs/EP-demo-S01/link.md': fm({ story: 'EP-demo-S01', epic: 'EP-demo', 'product-repo': '../../.yad/product' }),
  });
  addOrigin(backend, path.join(W, 'remotes/backend.git'));
  git(backend, 'checkout', '-q', '-b', 'feature');
  commitAll(backend, 'feat: add thing\n\nTask: EP-demo-S01-T01', { 'src/thing.js': 'x\n' });
  return { W, product, backend };
}

const yad = (cwd, args) => {
  const r = spawnSync(process.execPath, [YAD, ...args], { cwd, env: { ...ENV, PWD: cwd, YAD_NO_REPORT: '1', YAD_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

test('yad run checks: every gate runs with the Product\'s default branch where CI puts it, and it is removed after', () => {
  const { W, backend } = workspace();
  try {
    const r = yad(backend, ['run', 'checks', '--no-build']);
    // The only failure is the unsigned test commits: signatures are checked with git here.
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the Product's main \([0-9a-f]{12}\) is written to \.yad\/product for this run, as CI checks it out, and removed after/);
    assert.match(r.out, /PASS \[spec-link\]: \w+ EP-demo-S01-T01 -> specs\/EP-demo-S01\/link\.md/);
    assert.match(r.out, /PASS \[epic-open\]: \w+ EP-demo-S01-T01 -> EP-demo \(epic is open/);
    assert.match(r.out, /PASS \[lineage-check\]: \w+ EP-demo-S01-T01 -> EP-demo \(genesis feature epic\)/);
    assert.match(r.out, /PASS \[pr-title\]/);
    assert.match(r.out, /the title is the branch's one commit subject/);
    assert.match(r.out, /skipped: pr-template — no description: pass --body <file/);
    assert.match(r.out, /skipped: install-deps — skipped with --no-build/);
    assert.match(r.out, /FAIL \[verified-commits\]: \w+ is not signed/);
    assert.match(r.out, /the platform's Verified badge .* is judged in CI after the push/);
    assert.match(r.out, /✗ verified-commits/);
    assert.ok(!fs.existsSync(path.join(backend, '.yad')), 'the Product copy is removed after the run');
    assert.equal(git(backend, 'status', '--porcelain'), '', 'nothing is left in the work tree');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: the Product is read from its default branch, not from local unmerged edits — as in CI', () => {
  const { W, product, backend } = workspace({ storyStatus: 'shipped' });
  try {
    // Locally the story is reopened, but not merged: CI would still read it as shipped.
    write(product, { 'epics/EP-demo/stories/EP-demo-S01.md': `${fm({ story: 'EP-demo-S01', status: 'in-progress' })}\n# S01\n` });
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL \[epic-open\]: \w+ EP-demo-S01-T01 targets SEALED epic EP-demo/);
    assert.match(git(product, 'status', '--porcelain'), /EP-demo-S01\.md/, 'the Product clone is left exactly as it was');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a contract file the base changed after the branch split is not this branch\'s change (#363 shape)', () => {
  const { W, backend } = workspace();
  try {
    git(backend, 'checkout', '-q', 'main');
    commitAll(backend, 'feat: a slice lands on main\n\nTask: EP-demo-S01-T02\nContract-Change: yes', { 'specs/EP-demo-S01/contracts/api.md': 'GET /x\n' });
    git(backend, 'push', '-q', 'origin', 'main');
    git(backend, 'checkout', '-q', 'feature');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /PASS \[contract-check\]: diff does not touch the contract surface/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: --title and --body are checked, and the run fails on any FAIL', () => {
  const { W, backend } = workspace();
  try {
    const body = path.join(W, 'body.md');
    fs.writeFileSync(body, '## Summary\nx\n');
    const r = yad(backend, ['run', 'checks', '--no-build', '--title', 'Add a thing.', '--body', body, '--json']);
    assert.equal(r.code, 1, r.out);
    const json = JSON.parse(r.stdout);
    const byName = Object.fromEntries(json.gates.map((g) => [g.name, g]));
    assert.equal(byName['pr-title'].status, 'fail');
    assert.ok(byName['pr-title'].fails.some((l) => /is not '<type>\(<scope>\)\?!\?: <description>'/.test(l)), JSON.stringify(byName['pr-title']));
    assert.equal(byName['pr-template'].status, 'fail');
    assert.ok(byName['pr-template'].fails.some((l) => /missing section '## Impact & Risk'/.test(l)), JSON.stringify(byName['pr-template']));
    assert.equal(byName['spec-link'].status, 'pass');
    assert.equal(json.kind, 'code');
    assert.equal(json.base, 'origin/main');
    assert.equal(json.product.placed, true);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a gate that differs from the shipped one is named; no checks/ folder is refused', () => {
  const { W, backend } = workspace();
  try {
    fs.appendFileSync(path.join(backend, 'checks/spec-link.sh'), '\n# a local edit\n');
    let r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /checks\/spec-link\.sh differs from the gate this yadflow ships — CI runs the committed copy; `yad update` brings it to this version/);
    fs.rmSync(path.join(backend, 'checks'), { recursive: true, force: true });
    r = yad(backend, ['run', 'checks']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no checks\/ folder in .* — the gates are not installed here/);
    r = yad(backend, ['run', 'nope']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unknown run action: nope \(checks\)/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: commits signed with a key git can check pass verified-commits here', { skip: spawnSync('ssh-keygen', ['-?']).error && 'needs ssh-keygen' }, () => {
  const { W, backend } = workspace();
  try {
    const key = path.join(W, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'pipe' });
    fs.writeFileSync(path.join(W, 'allowed'), `alice@corp.io ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
    for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key], ['gpg.ssh.allowedSignersFile', path.join(W, 'allowed')]]) git(backend, 'config', k, v);
    git(backend, 'commit', '-q', '--amend', '--no-edit', '-S');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /PASS \[verified-commits\]: \w+ is signed/);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /passed, \d+ skipped — push when ready/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: install-deps and build/test/lint run by default', () => {
  const { W, backend } = workspace();
  try {
    commitAll(backend, 'chore: scripts\n\nTask: EP-demo-S01-T01', {
      'package.json': JSON.stringify({ name: 'b', version: '0.0.0', scripts: { lint: 'node -e ""', build: 'node -e ""', test: 'node -e "process.exit(1)"' } }),
      'package-lock.json': JSON.stringify({ name: 'b', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'b', version: '0.0.0' } } }),
    });
    const r = yad(backend, ['run', 'checks', '--title', 'feat: add thing']);
    assert.match(r.out, /✓ install-deps/);
    assert.match(r.out, /FAIL \[build\/test\/lint\]: '.*npm run test' failed/);
    assert.equal(r.code, 1, r.out);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: from the Product, the Product gates run with the branch and changed paths CI passes', () => {
  const { W, product } = workspace();
  try {
    fs.mkdirSync(path.join(product, 'checks'), { recursive: true });
    for (const sk of ['yad-checks', 'yad-pr-template']) {
      const from = path.join(ROOT, 'skills', sk, 'templates', 'checks');
      for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(product, 'checks', f));
    }
    commitAll(product, 'chore: wire the gates', {});
    git(product, 'push', '-q', 'origin', 'main');
    git(product, 'checkout', '-q', '-b', 'tooling');
    commitAll(product, 'ci: tune a workflow', { 'notes.md': 'x\n' });
    const r = yad(product, ['run', 'checks']);
    assert.match(r.out, /Product product · branch tooling · base origin\/main/);
    assert.match(r.out, /PASS \[commit-message\]/);
    assert.match(r.out, /PASS \[pr-title\]/);
    assert.match(r.out, /✓ ledger-guard/);
    assert.match(r.out, /✓ member-check/);
    assert.doesNotMatch(r.out, /spec-link|contract-check|written to/);
    // A Shape artifact on a tooling branch fails, because the changed paths are passed as CI passes them.
    commitAll(product, 'docs: edit the epic', { 'epics/EP-demo/epic.md': `${fm({ epic: 'EP-demo', type: 'feature' })}\n# EP-demo, edited\n` });
    const r2 = yad(product, ['run', 'checks', '--title', 'docs: edit the epic']);
    assert.match(r2.out, /FAIL \[pr-title\]: head 'tooling' changes Shape artifacts/);
    assert.equal(r2.code, 1, r2.out);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a Product review branch takes no commit subject as its title', () => {
  const { W, product } = workspace();
  try {
    fs.mkdirSync(path.join(product, 'checks'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'skills/yad-pr-template/templates/checks'))) fs.copyFileSync(path.join(ROOT, 'skills/yad-pr-template/templates/checks', f), path.join(product, 'checks', f));
    commitAll(product, 'chore: wire the gates', {});
    git(product, 'push', '-q', 'origin', 'main');
    git(product, 'checkout', '-q', '-b', 'review/EP-demo/epic');
    commitAll(product, 'docs: draft the epic', { 'epics/EP-demo/epic.md': `${fm({ epic: 'EP-demo', type: 'feature' })}\n# EP-demo, drafted\n` });
    let r = yad(product, ['run', 'checks']);
    assert.match(r.out, /skipped: pr-title — a review branch: pass --title "review: <artifact> \(EP-<slug>\)"/);
    r = yad(product, ['run', 'checks', '--title', 'review: epic (EP-demo)']);
    assert.match(r.out, /PASS \[pr-title\]/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: --base picks the base, and --no-fetch reads the last fetched one', () => {
  const { W, backend } = workspace();
  try {
    // A commit on the remote main this clone has not fetched.
    const other = path.join(W, 'other');
    git(W, 'clone', '-q', '-b', 'main', path.join(W, 'remotes/backend.git'), other);
    git(other, 'config', 'user.name', 'bob');
    git(other, 'config', 'user.email', 'bob@corp.io');
    commitAll(other, 'chore: on main meanwhile', { 'b.txt': 'b\n' });
    git(other, 'push', '-q', 'origin', 'main');
    const before = git(backend, 'rev-parse', 'origin/main');
    yad(backend, ['run', 'checks', '--no-build', '--no-fetch']);
    assert.equal(git(backend, 'rev-parse', 'origin/main'), before, '--no-fetch fetches nothing');
    yad(backend, ['run', 'checks', '--no-build']);
    assert.notEqual(git(backend, 'rev-parse', 'origin/main'), before, 'the base is fetched first');
    const r = yad(backend, ['run', 'checks', '--no-build', '--base', 'main']);
    assert.match(r.out, /base main\b/);
    const bad = yad(backend, ['run', 'checks', '--base', 'nope']);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /base 'nope' is not a commit here/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});
