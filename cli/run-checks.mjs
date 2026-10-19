// `yad run checks` (issue #347): run every pull request gate on this machine before pushing, so a failure
// shows here and not after a CI round trip. The same words for a GitHub pull request and a GitLab merge
// request.
//
// What makes "passes here" mean "passes in CI":
//   - the repo's OWN installed `checks/` scripts run, not the templates this package ships — CI runs the
//     installed copies. One that differs from the shipped template is named, so a stale gate is not
//     mistaken for the current rules.
//   - the base is the remote branch the change will merge into (`origin/<default>`, fetched first), as CI
//     passes it.
//   - the Product-reading gates read the Product's DEFAULT BRANCH, as CI's product-checkout.sh clones it
//     (the user's decision, 2026-10-19): it is written out from the local Product clone's
//     `origin/<default_branch>` to where `.sdlc/product-link.json` ON THE BASE says, and removed after.
//     Unmerged Product edits are not seen, as CI does not see them. Written with a private index, so the
//     Product clone's own index, branch and files are never touched.
//   - every gate runs, even after one fails (CI jobs run side by side), then one summary.
//
// What cannot be the same here, and says so:
//   - verified-commits asks the platform for its Verified badge, which an unpushed commit does not have.
//     Locally each commit's signature is checked with git instead (`%G?`); the badge is judged in CI.
//   - member-check needs the PR's author, which only the platform event carries. It runs when no member
//     file changes, and otherwise is left to CI with a note.
//   - pr-title and pr-template need text the PR does not have yet: --title and --body <file>, with the
//     subject of a one-commit branch as the title (it becomes the squash title).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { c, log, info, warn, fail, hand, ok, run, exists, readJSON, refuse, inJSON, asset, fileSha } from './lib.mjs';
import { detectPlatform } from './platform.mjs';
import { registryEntryFor } from './find-product.mjs';
import { repoPathFromGitUrl } from './protection.mjs';

// GitLab hands CI only this many characters of a merge request description (#164, #343).
const GITLAB_DESCRIPTION_CUT = 2700;

const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts });

// The shipped template a gate was installed from, or null.
function shippedTemplate(script) {
  const skills = asset('skills');
  for (const sk of fs.readdirSync(skills)) {
    const p = path.join(skills, sk, 'templates', 'checks', script);
    if (exists(p)) return p;
  }
  return null;
}

// The remote branch a change merges into: the remote's default branch, else the settings' default_branch,
// else main.
function defaultBranch(repoRoot, settings) {
  const head = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.startsWith('origin/')) return head.stdout.slice('origin/'.length);
  if (typeof settings?.default_branch === 'string' && settings.default_branch) return settings.default_branch;
  return 'main';
}

// A folder inside the repo the Product may be written to: relative, no `..`, no `.git` part — the rules
// product-checkout.sh applies to the same value.
function safeRecordPath(p) {
  if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || p.includes('\\')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.toLowerCase() === '.git')) return null;
  return parts.join('/');
}

// Write the Product's default branch where the record says. Returns { placed, dest, created, notes }.
// `created` is the top folder this run made, removed afterwards.
function placeProduct(repoRoot, base, productRoot, { fetch }) {
  const notes = [];
  const shown = git(repoRoot, ['show', `${base}:.sdlc/product-link.json`]);
  if (!shown.ok) {
    notes.push(`no .sdlc/product-link.json on ${base}, so nothing is checked out for the Product — as in CI, the Product-reading gates read what product-repo reaches, or skip their Product check`);
    return { placed: false, notes };
  }
  let record;
  try { record = JSON.parse(shown.stdout); } catch { record = null; }
  const rel = safeRecordPath(record?.path);
  if (!rel) {
    notes.push(`.sdlc/product-link.json on ${base} names no usable path — product-checkout fails the same way in CI`);
    return { placed: false, notes };
  }
  const dest = path.join(repoRoot, rel);
  if (exists(dest)) {
    notes.push(`${rel} is already there, so it is read as it is (CI's product-checkout leaves an existing folder too)`);
    return { placed: false, dest: rel, notes };
  }
  if (!productRoot) {
    notes.push(`no Product clone found from here, so ${rel} is not written — the Product-reading gates skip their Product check, as CI does without YAD_PRODUCT_TOKEN`);
    return { placed: false, dest: rel, notes };
  }
  const branch = typeof record?.default_branch === 'string' && record.default_branch ? record.default_branch : 'main';
  const want = repoPathFromGitUrl(record?.git_url || '');
  const have = repoPathFromGitUrl(git(productRoot, ['remote', 'get-url', 'origin']).stdout);
  if (want && have && want.toLowerCase() !== have.toLowerCase()) {
    notes.push(`the Product clone's origin is ${have}, but the record names ${want} — it is read anyway`);
  }
  if (fetch) {
    const f = git(productRoot, ['fetch', '--quiet', 'origin', branch]);
    if (!f.ok) notes.push(`could not fetch ${branch} in the Product clone — its last fetched copy is read`);
  }
  const sha = git(productRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]);
  if (!sha.ok || !sha.stdout) {
    notes.push(`the Product clone has no origin/${branch}, so ${rel} is not written — the Product-reading gates skip their Product check`);
    return { placed: false, dest: rel, notes };
  }
  // The top folder this run creates (`.yad` for `.yad/product`), so the clean-up removes only what it made.
  const parts = rel.split('/');
  let created = null;
  for (let i = 1; i <= parts.length; i++) {
    const p = path.join(repoRoot, ...parts.slice(0, i));
    if (!exists(p)) { created = p; break; }
  }
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yad-run-checks-')), 'index');
  try {
    fs.mkdirSync(dest, { recursive: true });
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const read = spawnSync('git', ['read-tree', sha.stdout], { cwd: productRoot, env, encoding: 'utf8' });
    const out = read.status === 0
      ? spawnSync('git', ['checkout-index', '-a', '-f'], { cwd: productRoot, env: { ...env, GIT_WORK_TREE: dest }, encoding: 'utf8' })
      : read;
    if (out.status !== 0) {
      if (created) fs.rmSync(created, { recursive: true, force: true });
      notes.push(`could not write the Product's ${branch} to ${rel} — the Product-reading gates skip their Product check`);
      return { placed: false, dest: rel, notes };
    }
  } finally {
    fs.rmSync(path.dirname(idx), { recursive: true, force: true });
  }
  notes.push(`the Product's ${branch} (${sha.stdout.slice(0, 12)}) is written to ${rel} for this run, as CI checks it out, and removed after`);
  return { placed: true, dest: rel, created, notes };
}

// Each commit's signature, as git reads it here. `%G?`: G good, U good with unknown trust, X/Y expired,
// R revoked, E cannot be checked (no key here), B bad, N none.
function localSignatures(repoRoot, base) {
  const r = git(repoRoot, ['log', '--format=%H %G? %P', `${base}..HEAD`]);
  if (!r.ok) return { status: 'fail', lines: [`FAIL [verified-commits]: git could not list the commits in ${base}..HEAD`] };
  const lines = [];
  let bad = 0;
  for (const row of r.stdout.split('\n').filter(Boolean)) {
    const [sha, mark, ...parents] = row.split(' ');
    const short = sha.slice(0, 7);
    if (mark === 'N' && parents.length > 1) { lines.push(`note [verified-commits]: ${short} is an unsigned merge commit — CI waives it only when it adds nothing of its own`); continue; }
    if (mark === 'N') { bad++; lines.push(`FAIL [verified-commits]: ${short} is not signed — sign commits (git config commit.gpgsign true, with a GPG or SSH key added to your account), then re-sign: git rebase --exec 'git commit --amend --no-edit -S' ${base}`); continue; }
    if (mark === 'B' || mark === 'R') { bad++; lines.push(`FAIL [verified-commits]: ${short} has a ${mark === 'B' ? 'bad' : 'revoked'} signature — re-sign it with a key your account holds`); continue; }
    if (mark === 'E') { lines.push(`note [verified-commits]: ${short} is signed, but this machine cannot check the key — the platform checks it in CI`); continue; }
    lines.push(`PASS [verified-commits]: ${short} is signed`);
  }
  if (!lines.length) lines.push(`PASS [verified-commits]: no commits in ${base}..HEAD`);
  lines.push(`note [verified-commits]: checked with git here; the platform's Verified badge (your key on your account) is judged in CI after the push`);
  return { status: bad ? 'fail' : 'pass', lines };
}

export async function runChecks(dir, opts = {}) {
  log(c.bold('\nyad run checks'));
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return refuse(`not a git repo: ${dir}`, 'run it inside the repo whose change you want checked');
  const repoRoot = top.stdout;
  const checksDir = path.join(repoRoot, 'checks');
  if (!exists(checksDir)) return refuse(`no checks/ folder in ${repoRoot} — the gates are not installed here`, 'run `yad check --fix` from the Product to install them');

  const settings = readJSON(path.join(repoRoot, '.sdlc/product.json'), null) || readJSON(path.join(repoRoot, '.sdlc/hub.json'), null);
  const isProduct = !!settings;
  const branchName = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;

  // The base: as given, else the remote's default branch, fetched first.
  let base = opts.base;
  if (!base) {
    const b = defaultBranch(repoRoot, settings);
    if (opts.fetch !== false) {
      const f = git(repoRoot, ['fetch', '--quiet', 'origin', b]);
      if (!f.ok) warn(`could not fetch ${b} from origin — the last fetched origin/${b} is the base`);
    }
    base = `origin/${b}`;
  }
  if (!git(repoRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    return refuse(`base '${base}' is not a commit here`, 'fetch it (git fetch origin), or pass --base <ref>');
  }
  info(`${isProduct ? 'Product' : 'code repo'} ${path.basename(repoRoot)} · branch ${branchName} · base ${base}`);

  // The registry's platform first: a self-hosted GitLab's host need not say "gitlab".
  const platform = (isProduct ? settings.platform : null) || registryEntryFor(opts.product || null, repoRoot)?.meta?.platform
    || detectPlatform(git(repoRoot, ['remote', 'get-url', 'origin']).stdout) || null;

  // The PR text.
  let title = opts.title || null;
  let titleNote = null;
  // A Product review branch's title is `review: <artifact> (EP-<slug>)`, which `yad gate open` writes — a
  // commit subject is never it.
  const reviewHead = isProduct && /^review\/EP-/.test(branchName);
  if (!title && !reviewHead) {
    const subjects = git(repoRoot, ['log', '--no-merges', '--format=%s', `${base}..HEAD`]).stdout.split('\n').filter(Boolean);
    if (subjects.length === 1) { title = subjects[0]; titleNote = 'the title is the branch\'s one commit subject (pass --title to check another)'; }
  }
  let bodyFile = null;
  if (opts.body) {
    bodyFile = path.resolve(process.cwd(), opts.body);
    if (!exists(bodyFile)) return refuse(`--body file not found: ${opts.body}`, 'save the PR/MR description to a file and pass its path');
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yad-run-checks-'));
  let placed = null;
  const cleanUp = () => {
    if (placed?.created) fs.rmSync(placed.created, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = () => { cleanUp(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const results = [];
  let stopped = false;
  try {
    if (!isProduct) {
      placed = placeProduct(repoRoot, base, opts.product || null, { fetch: opts.fetch !== false });
      for (const n of placed.notes) info(n);
    }

    // The changed paths, for the Product's pr-title/pr-template split, built as yad-product-checks.yml does.
    const changedFile = path.join(scratch, 'changed');
    if (isProduct) {
      const d = git(repoRoot, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', `${base}...HEAD`]);
      fs.writeFileSync(changedFile, d.ok ? `${d.stdout}\n` : '');
    }

    const profile = isProduct ? 'product' : 'code';
    const head = isProduct ? ['--head', branchName, '--changed', changedFile] : [];
    const gates = isProduct
      ? [
        { name: 'commit-message', script: 'commit-message.sh', args: ['--profile', profile, base] },
        { name: 'pr-title', script: 'pr-title.sh', args: ['--profile', profile, ...head, title], needs: title ? null : reviewHead ? 'a review branch: pass --title "review: <artifact> (EP-<slug>)" — `yad gate open` writes that title' : 'no title: pass --title "<the PR/MR title>" (a branch of one commit uses its subject)' },
        { name: 'pr-template', script: 'pr-template.sh', args: ['--profile', profile, ...head, bodyFile], needs: bodyFile ? null : 'no description: pass --body <file holding the PR/MR description>' },
        { name: 'ledger-guard', script: 'ledger-guard.sh', args: [base] },
        { name: 'member-check', script: 'member-check.mjs', node: true, args: [base] },
        { name: 'verified-commits', local: true },
      ]
      : [
        { name: 'spec-link', script: 'spec-link.sh', args: [base] },
        { name: 'contract-check', script: 'contract-check.sh', args: [base] },
        { name: 'risk-map', script: 'risk-map-check.sh', args: [base] },
        { name: 'install-deps', script: 'install-deps.sh', args: [], build: true },
        { name: 'build/test/lint', script: 'build-test-lint.sh', args: [], build: true, after: 'install-deps' },
        { name: 'lineage-check', script: 'lineage-check.sh', args: [base] },
        { name: 'epic-open', script: 'epic-open.sh', args: [base] },
        { name: 'reconcile-debt', script: 'reconcile-debt-check.sh', args: [base] },
        { name: 'commit-message', script: 'commit-message.sh', args: ['--profile', profile, base] },
        { name: 'pr-title', script: 'pr-title.sh', args: ['--profile', profile, title], needs: title ? null : 'no title: pass --title "<the PR/MR title>" (a branch of one commit uses its subject)' },
        { name: 'pr-template', script: 'pr-template.sh', args: ['--profile', profile, bodyFile], needs: bodyFile ? null : 'no description: pass --body <file holding the PR/MR description>' },
        { name: 'verified-commits', local: true },
        { name: 'backfill', script: 'backfill-check.sh', args: [base], optional: true },
      ];

    // A CI variable from the shell this runs in would make a gate act as if it were in CI.
    // GITHUB_TOKEN stays: gh reads it to sign in.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'CI' || k === 'GITLAB_CI' || k.startsWith('CI_') || (k.startsWith('GITHUB_') && k !== 'GITHUB_TOKEN')) delete env[k];
    delete env.SDLC_BASE;

    for (const g of gates) {
      log(`\n${c.bold(g.name)}`);
      const r = { name: g.name, status: 'pass', reason: null, output: '' };
      results.push(r);
      if (g.local) {
        const s = localSignatures(repoRoot, base);
        r.status = s.status; r.output = s.lines.join('\n');
        log(r.output.replace(/^/gm, '  '));
        continue;
      }
      const scriptPath = path.join(checksDir, g.script);
      if (!exists(scriptPath)) {
        r.status = 'skip';
        r.reason = g.optional ? 'not installed here (placed by hand when a team backfills)' : `checks/${g.script} is not installed here — \`yad check --fix\` installs the gates this repo is wired for`;
        if (g.optional) results.pop(); else info(r.reason);
        continue;
      }
      if (g.build && opts.build === false) { r.status = 'skip'; r.reason = 'skipped with --no-build'; info(r.reason); continue; }
      if (g.name === 'install-deps') info('installs from the lockfile as CI does (npm ci or pnpm install --frozen-lockfile), which replaces node_modules — --no-build skips it');
      if (g.after && results.find((x) => x.name === g.after)?.status === 'fail') { r.status = 'skip'; r.reason = `${g.after} failed, so it was not run`; info(r.reason); continue; }
      if (g.needs) { r.status = 'skip'; r.reason = g.needs; info(r.reason); continue; }
      if (g.name === 'member-check') {
        const m = git(repoRoot, ['diff', '--no-renames', '--name-only', `${base}...HEAD`, '--', '.sdlc/members']);
        if (m.ok && m.stdout) { r.status = 'skip'; r.reason = 'a member file changes, and the gate needs the PR\'s author, which only CI has — it is judged in CI'; info(r.reason); continue; }
      }
      const shipped = shippedTemplate(g.script);
      if (shipped && fileSha(shipped) !== fileSha(scriptPath)) {
        r.differs = true;
        warn(`checks/${g.script} differs from the gate this yadflow ships — CI runs the committed copy; \`yad update\` brings it to this version`);
      }
      const p = spawnSync(g.node ? process.execPath : 'bash', [scriptPath, ...g.args], { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // Ctrl-C reaches the gate first (one process group): stop here, and let `finally` clean up.
      if (p.signal === 'SIGINT' || p.signal === 'SIGTERM') { r.status = 'skip'; r.reason = 'stopped'; stopped = true; break; }
      r.output = `${p.stdout || ''}${p.stderr || ''}`.replace(/\s+$/, '');
      r.exit = p.status;
      r.status = p.status === 0 ? 'pass' : 'fail';
      if (r.output) log(r.output.replace(/^/gm, '  '));
      if (g.name === 'pr-title' && titleNote) info(titleNote);
      if (g.name === 'pr-template' && platform === 'gitlab') {
        const len = [...fs.readFileSync(bodyFile, 'utf8')].length;
        if (len >= GITLAB_DESCRIPTION_CUT) warn(`the description is ${len} characters; GitLab hands CI only the first ${GITLAB_DESCRIPTION_CUT} — the gate then reads the rest from GitLab's API with a token, so keep the required sections near the top`);
      }
    }
  } finally {
    cleanUp();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (stopped) { warn('stopped — the Product copy is removed; nothing was pushed'); process.exitCode = 130; return { stopped: true }; }
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  const passed = results.filter((r) => r.status === 'pass');
  log(`\n${c.bold('Summary')}`);
  for (const r of results) {
    const line = `${r.name}${r.reason ? ` — ${r.reason}` : ''}`;
    if (r.status === 'pass') ok(line);
    else if (r.status === 'skip') info(`skipped: ${line}`);
    else fail(line);
  }
  if (failed.length) {
    hand('fix what each FAIL line above says, then run `yad run checks` again — docs/GATES.md lists every message and what to change');
    process.exitCode = 1;
  } else {
    ok(`${passed.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''} — push when ready`);
  }
  if (inJSON()) {
    return {
      repo: path.basename(repoRoot), kind: isProduct ? 'product' : 'code', base, platform,
      product: placed ? { placed: placed.placed, path: placed.dest || null, notes: placed.notes } : null,
      gates: results.map(({ name, status, reason, exit, differs, output }) => ({
        name, status, ...(reason ? { reason } : {}), ...(exit !== undefined ? { exit } : {}), ...(differs ? { differs: true } : {}),
        // The FAIL lines, so an agent reading --json sees what to change without the whole log.
        fails: (output || '').split('\n').filter((l) => /^FAIL /.test(l)),
      })),
      passed: passed.length, failed: failed.length, skipped: skipped.length,
    };
  }
  return { failed: failed.length };
}
