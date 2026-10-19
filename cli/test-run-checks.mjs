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
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const YAD = path.join(ROOT, 'bin/yad.mjs');
// No CI variable, git identity or base from the shell that runs the suite.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^GIT_(AUTHOR|COMMITTER)_/.test(k) && !/^(CI|GITLAB_CI|GITHUB_ACTIONS|SDLC_BASE|SDLC_HUB_CONFIG|SDLC_PRODUCT_CONFIG)$/.test(k) && !/^(CI_|GITHUB_)/.test(k)));
// Nor the person's own git settings (a signing key, an allowed-signers list).
ENV.GIT_CONFIG_GLOBAL = '/dev/null';
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
    assert.match(r.out, /the Product's main \([0-9a-f]{12}\) is written to \.yad\/product, as CI checks it out, and removed after these gates/);
    assert.match(r.out, /PASS \[spec-link\]: \w+ EP-demo-S01-T01 -> specs\/EP-demo-S01\/link\.md/);
    assert.match(r.out, /PASS \[epic-open\]: \w+ EP-demo-S01-T01 -> EP-demo \(epic is open/);
    assert.match(r.out, /PASS \[lineage-check\]: \w+ EP-demo-S01-T01 -> EP-demo \(genesis feature epic\)/);
    assert.match(r.out, /PASS \[pr-title\]/);
    assert.match(r.out, /the title is the branch's one commit subject/);
    assert.match(r.out, /skipped: pr-template — no description: pass --body <file/);
    assert.match(r.out, /skipped: install-deps — skipped with --no-build/);
    assert.match(r.out, /FAIL \[verified-commits\]: \w+ is not signed/);
    assert.match(r.out, /the platform's Verified badge .* is judged in CI after the push/);
    assert.match(r.out, /1 gate failed: verified-commits/);
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
    assert.equal(git(product, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(product, 'diff', '--cached', '--name-only'), '', 'its index is untouched');
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
    assert.match(r.out, /checks\/spec-link\.sh is not the gate this yadflow ships — CI runs the committed copy; if it is an older one, `yad update` replaces it/);
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
    assert.match(r.out, /passed, \d+ skipped \(a skipped gate is not a pass\) — push when ready/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: install-deps and build/test/lint run by default', () => {
  const { W, backend } = workspace();
  try {
    commitAll(backend, 'chore: scripts\n\nTask: EP-demo-S01-T01', {
      // The build job never has the Product checked out in CI, so the copy must not be there yet.
      'package.json': JSON.stringify({ name: 'b', version: '0.0.0', scripts: { lint: 'node -e "process.exit(require(\'fs\').existsSync(\'.yad/product\') ? 1 : 0)"', build: 'node -e ""', test: 'node -e "process.exit(1)"' } }),
      'package-lock.json': JSON.stringify({ name: 'b', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'b', version: '0.0.0' } } }),
    });
    const r = yad(backend, ['run', 'checks', '--title', 'feat: add thing']);
    assert.match(r.out, /✓ install-deps/);
    assert.doesNotMatch(r.out, /npm run lint' failed/, 'lint did not see a Product copy');
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

test('yad run checks: a path CI refuses fails here too, and nothing outside the repo is written', () => {
  const { W, backend } = workspace();
  try {
    // .yad is a symlink to a folder outside the repo.
    fs.mkdirSync(path.join(W, 'shared'));
    fs.symlinkSync(path.join(W, 'shared'), path.join(backend, '.yad'));
    let r = yad(backend, ['run', 'checks', '--no-build']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL \[product-checkout\]: '\.yad' is a symlink — the Product is not written through it/);
    assert.deepEqual(fs.readdirSync(path.join(W, 'shared')), [], 'nothing written through the link');
    fs.rmSync(path.join(backend, '.yad'));
    // A default_branch that git would read as an option.
    git(backend, 'checkout', '-q', 'main');
    commitAll(backend, 'chore: odd record', { '.sdlc/product-link.json': JSON.stringify({ git_url: 'x', path: '.yad/product', default_branch: `--upload-pack=touch ${path.join(W, 'PWNED')};git-upload-pack` }) });
    git(backend, 'push', '-q', 'origin', 'main');
    git(backend, 'checkout', '-q', 'feature');
    r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /FAIL \[product-checkout\]: \.sdlc\/product-link\.json on origin\/main names a default_branch git cannot use as a branch name/);
    assert.ok(!fs.existsSync(path.join(W, 'PWNED')), 'the value never reaches git as an option');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a folder already there is read as it is and kept; a copy an earlier run left is replaced', () => {
  const { W, backend } = workspace();
  try {
    write(backend, { '.yad/notes.txt': 'mine\n' });
    let r = yad(backend, ['run', 'checks', '--no-build']);
    assert.ok(fs.existsSync(path.join(backend, '.yad/notes.txt')), 'a .yad/ of the user\'s own is kept');
    assert.ok(!fs.existsSync(path.join(backend, '.yad/product')), 'only the copy is removed');
    write(backend, { '.yad/product/epics/x.md': 'hand-made\n' });
    r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /\.yad\/product is already there, so it is read as it is — it may not be the Product's default branch/);
    assert.ok(fs.existsSync(path.join(backend, '.yad/product/epics/x.md')), 'a folder the run did not write is left in place');
    fs.rmSync(path.join(backend, '.yad/product'), { recursive: true });
    write(backend, { '.yad/product/.yad-run-checks': 'left\n', '.yad/product/stale.md': 'old\n' });
    r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /is written to \.yad\/product/);
    assert.ok(!fs.existsSync(path.join(backend, '.yad/product')), 'the leftover copy is replaced, then removed');
    assert.ok(fs.existsSync(path.join(backend, '.yad/notes.txt')));
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: an SSH signature git has no allowed-signers list for is "cannot check here", not "not signed"', { skip: spawnSync('ssh-keygen', ['-?']).error && 'needs ssh-keygen' }, () => {
  const { W, backend } = workspace();
  try {
    const key = path.join(W, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'pipe' });
    for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key]]) git(backend, 'config', k, v);
    git(backend, 'commit', '-q', '--amend', '--no-edit', '-S');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /note \[verified-commits\]: \w+ is signed, but this machine cannot check the key/);
    assert.doesNotMatch(r.out, /is not signed/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: Ctrl-C stops the run even when the gate catches it, and the copy is gone', { skip: process.platform === 'win32' && 'process groups' }, async () => {
  const { W, backend } = workspace();
  try {
    commitAll(backend, 'chore: scripts\n\nTask: EP-demo-S01-T01', {
      'package.json': JSON.stringify({ name: 'b', version: '0.0.0', scripts: { lint: 'node -e "process.on(\'SIGINT\',()=>process.exit(130));process.on(\'SIGTERM\',()=>process.exit(143));setTimeout(()=>{},30000)"', build: 'node -e ""', test: 'node -e ""' } }),
      'package-lock.json': JSON.stringify({ name: 'b', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'b', version: '0.0.0' } } }),
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const child = (await import('node:child_process')).spawn(process.execPath, [YAD, 'run', 'checks', '--title', 'feat: x'], { cwd: backend, env: { ...ENV, PWD: backend, YAD_NO_REPORT: '1' }, detached: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const started = Date.now();
      while (!/build\/test\/lint\]? lint…|\[build\/test\/lint\] lint/.test(out) && Date.now() - started < 20000) await sleep(100);
      await sleep(500);
      // Ctrl-C reaches the whole group; a plain kill reaches yad alone.
      if (sig === 'SIGINT') process.kill(-child.pid, sig); else process.kill(child.pid, sig);
      const code = await new Promise((r) => child.on('close', r));
      assert.equal(code, 130, `${sig}: ${out}`);
      assert.match(out, /stopped \(SIG(INT|TERM)\) — nothing after that gate ran/, out);
      assert.doesNotMatch(out, /\ncontract-check\n/, `${sig}: no later gate ran`);
      assert.ok(Date.now() - started < 25000, `${sig}: it stopped promptly`);
    }
    assert.ok(!fs.existsSync(path.join(backend, '.yad')));
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: member-check is left to CI when a member file changes; a missing --body file is refused', () => {
  const { W, product } = workspace();
  try {
    fs.mkdirSync(path.join(product, 'checks'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'skills/yad-checks/templates/checks/member-check.mjs'), path.join(product, 'checks/member-check.mjs'));
    commitAll(product, 'chore: wire the gate', {});
    git(product, 'push', '-q', 'origin', 'main');
    git(product, 'checkout', '-q', '-b', 'join');
    commitAll(product, 'chore: join', { '.sdlc/members/github-alice.json': '{"accounts":[]}\n' });
    let r = yad(product, ['run', 'checks']);
    assert.match(r.out, /skipped: member-check — a member file changes, and the gate needs the PR's author, which only CI has/);
    r = yad(product, ['run', 'checks', '--body', 'nope.md']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--body file not found: nope\.md/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: the base follows the registry like yad open-pr, and GitLab warns at the 2700-character cut', () => {
  const { W, product, backend } = workspace();
  try {
    git(backend, 'checkout', '-q', '-b', 'develop', 'main');
    git(backend, 'push', '-q', 'origin', 'develop');
    git(backend, 'checkout', '-q', 'feature');
    write(product, { '.sdlc/repos.json': JSON.stringify({ repos: [{ name: 'backend', path: '../backend', default_branch: 'develop', platform: 'gitlab' }] }) });
    const body = path.join(W, 'body.md');
    fs.writeFileSync(body, `## Summary\n${'x'.repeat(2800)}\n`);
    const r = yad(backend, ['run', 'checks', '--no-build', '--body', body]);
    assert.match(r.out, /base origin\/develop/);
    assert.match(r.out, /the description is \d+ characters; GitLab hands CI only the first 2700/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a gate that exits 143 on its own is a FAIL, and the gates after it still run', () => {
  const { W, backend } = workspace();
  try {
    fs.writeFileSync(path.join(backend, 'checks/risk-map-check.sh'), '#!/usr/bin/env bash\necho "FAIL [risk-map]: a helper got SIGTERM"\nexit 143\n');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ risk-map/);
    assert.match(r.out, /PASS \[epic-open\]/, 'the gates after it ran');
    assert.doesNotMatch(r.out, /stopped/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: the Product copy is gone before any other gate, whichever Product gates are installed', () => {
  const { W, backend } = workspace();
  try {
    fs.rmSync(path.join(backend, 'checks/reconcile-debt-check.sh'));
    fs.writeFileSync(path.join(backend, 'checks/backfill-check.sh'), '#!/usr/bin/env bash\nif [ -e .yad/product ]; then echo "FAIL [backfill]: COPY PRESENT"; exit 1; fi\necho "PASS [backfill]: no copy"\n');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /PASS \[epic-open\]/);
    assert.match(r.out, /PASS \[backfill\]: no copy/, r.out);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a record with no default_branch reads the Product clone\'s own default branch', () => {
  const { W, product, backend } = workspace({ storyStatus: 'shipped' });
  try {
    // The Product's trunk is master; main is gone.
    git(product, 'branch', '-m', 'main', 'master');
    git(product, 'push', '-q', 'origin', 'master');
    git(path.join(W, 'remotes/product.git'), 'symbolic-ref', 'HEAD', 'refs/heads/master');
    git(product, 'push', '-q', 'origin', '--delete', 'main');
    git(product, 'remote', 'set-head', 'origin', '-a');
    git(backend, 'checkout', '-q', 'main');
    commitAll(backend, 'chore: record with no branch', { '.sdlc/product-link.json': JSON.stringify({ git_url: path.join(W, 'remotes/product.git'), path: '.yad/product', default_branch: null }) });
    git(backend, 'push', '-q', 'origin', 'main');
    git(backend, 'checkout', '-q', 'feature');
    git(backend, 'rebase', '-q', 'main');
    const r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /the record names no default_branch, so the Product clone's origin\/HEAD says it: master/);
    assert.match(r.out, /FAIL \[epic-open\]: \w+ EP-demo-S01-T01 targets SEALED epic EP-demo/, 'master was read');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a stop during a Product gate removes the copy; a gate that ignores the signal is killed', { skip: process.platform === 'win32' && 'process groups' }, async () => {
  const { W, backend } = workspace();
  try {
    fs.writeFileSync(path.join(backend, 'checks/lineage-check.sh'), '#!/usr/bin/env bash\necho "lineage started"\ntrap "" INT TERM HUP\nsleep 30\n');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [YAD, 'run', 'checks', '--no-build'], { cwd: backend, env: { ...ENV, PWD: backend, YAD_NO_REPORT: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = Date.now();
    while (!/lineage started/.test(out) && Date.now() - started < 20000) await sleep(100);
    assert.ok(fs.existsSync(path.join(backend, '.yad/product')), 'the copy is there while the gate runs');
    child.kill('SIGINT');
    const t = Date.now();
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 130, out);
    assert.ok(Date.now() - t < 12000, 'killed after the grace period, not after the gate\'s 30 seconds');
    assert.ok(!fs.existsSync(path.join(backend, '.yad')), 'the copy is gone');
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});

test('yad run checks: a copy another live run is using is not touched; a product-checkout FAIL skips the four gates; uncommitted work is named', () => {
  const { W, backend } = workspace();
  try {
    write(backend, { '.yad/product/.yad-run-checks': `${process.pid} ${os.hostname()}\n`, '.yad/product/x.md': 'busy\n' });
    let r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /another yad run checks is using \.yad\/product right now/);
    assert.ok(fs.existsSync(path.join(backend, '.yad/product/x.md')));
    fs.rmSync(path.join(backend, '.yad'), { recursive: true });
    write(backend, { 'src/new.js': 'not added\n' });
    fs.mkdirSync(path.join(W, 'shared'));
    fs.symlinkSync(path.join(W, 'shared'), path.join(backend, '.yad'));
    r = yad(backend, ['run', 'checks', '--no-build']);
    assert.match(r.out, /uncommitted changes are built and tested here but are not in the push/);
    assert.match(r.out, /skipped: contract-check — product-checkout failed, so it was not run \(as in CI\)/);
    assert.match(r.out, /✗ product-checkout — the Product could not be put where CI puts it/);
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});
