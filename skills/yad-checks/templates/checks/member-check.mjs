#!/usr/bin/env node
// member-check gate (E131) — a member file (`.sdlc/members/<platform>-<login>.json`) says which accounts and
// which git emails are one person. The active-people count joins a commit to an approval through it, so a
// false file would fold one person into another and make the count SMALLER. This gate refuses that:
//
//   1. A PR may ADD or CHANGE only its author's own file: named `<platform>-<author>.json`, holding exactly
//      one account on the Product's platform and host — the author's, with the author's numeric account id
//      (so a login someone renamed away from, and another person registered, cannot take over the old file).
//      Never a bot's.
//   2. On GitHub, every email in a file the PR adds or changes must be the author email of a commit in the PR that GitHub itself
//      attributes to the PR's author (`commits/<sha>` → `author.login`). GitHub links a commit to an account
//      only through an email that account has verified, so this is the platform's proof, not the file's
//      claim. `yad member add` writes one commit per email for exactly this. On GitLab the API says no such
//      thing, so emails there feed the team list only and are never used by the gate count (the user's
//      decision, 2026-10-05) — this gate checks the owner rule alone.
//   3. A PR may DELETE anyone's file (removing a person can only make the count larger). `yad member remove
//      <login> --reason` puts the reason in the commit.
//   4. No account on the Product's platform, and no email, may be in two member files. (An OTHER account
//      two files claim is not refused: the CLI matches it to nobody until one file drops it, and refusing
//      it here would let whoever claimed it first block its real owner from joining.)
//   5. `.sdlc` and `.sdlc/members` are real folders and nothing under them is a link, and no path is a
//      case or Unicode twin of `.sdlc/members/` — a macOS or Windows checkout would read either as a member
//      file this gate never judged (E131 review 1–2; the E115 and E121 lessons).
//
// LIMIT: like every Product gate, this file and the workflow that runs it come from the PR's own checkout,
// so a PR can change the gate it is judged by; branch protection on the default branch is the backstop.
//
// A Node script, not bash: it reads JSON and hashes, and both CI images already have Node (E113's hooks are
// Node for the same reason). Usage: node checks/member-check.mjs <base-ref>
//   GitHub: PR_AUTHOR and PR_AUTHOR_ID (github.event.pull_request.user.login / .id) and GH_TOKEN (a read
//   token) in the environment.
//   GitLab: CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, and GITLAB_TOKEN or SDLC_API_TOKEN. With no
//   token it FAILS when a member file changed (fail closed — the user's decision, 2026-10-05).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DIR = '.sdlc/members/';
const LOGIN_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
let rc = 0;
const say = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => { say(`FAIL [member-check]: ${s}`); rc = 1; };
const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout || '' };
};
const hash = (email) => {
  const e = String(email || '').trim().toLowerCase();
  return e.indexOf('@', 1) < 0 ? null : `sha256:${createHash('sha256').update(e).digest('hex')}`;
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// The Product's settings under either name (product.json from 4.0, hub.json before). Drift between the two
// is refused by the other gates and the CLI; here the first one found is read.
const settingsFile = ['.sdlc/product.json', '.sdlc/hub.json'].find((f) => fs.existsSync(f)) || null;
const settings = settingsFile ? parse(fs.readFileSync(settingsFile, 'utf8')) : null;
const platform = settings?.platform === 'github' || settings?.platform === 'gitlab' ? settings.platform : null;
// The Product's host, from its clone URL (`git@host:…` or `https://host/…`), else the platform's own.
function hostOf(url) {
  const u = String(url || '').trim();
  const scp = u.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return scp[1].toLowerCase();
  try { return new URL(u).hostname.toLowerCase() || null; } catch { return null; }
}
// The same order the CLI reads it in: the settings' `git_url`, then the clone's origin (review 3).
const productHost = hostOf(settings?.git_url) || hostOf(git('remote', 'get-url', 'origin').out) || (platform === 'gitlab' ? 'gitlab.com' : 'github.com');
const onProduct = (a) => a?.platform === platform && String(a?.host || '').toLowerCase() === productHost;

const base = process.argv[2];
if (!base) { say('FAIL [member-check]: usage: node checks/member-check.mjs <base-ref> — the job must pass the base ref (the branch the PR targets), as yad-product-checks.yml (GitHub) and yad-product-checks.gitlab-ci.yml (GitLab) do'); process.exit(1); }
if (!git('rev-parse', '--verify', '-q', `${base}^{commit}`).ok) { say(`FAIL [member-check]: cannot resolve the base ref ${base} — check the code out with full history (GitHub: actions/checkout with fetch-depth: 0; GitLab: GIT_DEPTH: "0")`); process.exit(1); }

// Every path the PR touches, with its status. NUL-separated, no renames (a rename is a delete plus an add,
// and each is judged).
const diff = git('diff', '--no-renames', '--name-status', '-z', `${base}...HEAD`);
if (!diff.ok) { say('FAIL [member-check]: git could not list the changed files — check the code out with full history (GitHub: actions/checkout with fetch-depth: 0; GitLab: GIT_DEPTH: "0"), and give a base this branch shares history with, then run again'); process.exit(1); }
const parts = diff.out.split('\0').filter(Boolean);
const all = [];
for (let i = 0; i + 1 < parts.length; i += 2) all.push({ status: parts[i][0], path: parts[i + 1] });

// How to take member files out, the one rule every message uses (#381 review 4): a file this PR brings in
// (not on the base) is dropped from it; one the base holds — even one this PR edits — is deleted with git
// rm, which any PR may do (a deletion is never refused).
const onBase = (p) => git('cat-file', '-e', `${base}:${p}`).ok;
const removal = (paths) => {
  const here = paths.filter((p) => !onBase(p));
  const there = paths.filter(onBase);
  return [...(here.length ? [`drop ${here.join(' and ')} from this pull request`] : []),
    ...(there.length ? [`git rm ${there.join(' and ')} (any pull request may delete a member file)`] : [])].join('; ');
};

// A path as a case-insensitive, Unicode-folding file system sees it: `.sdlc/Members/x` and `.ſdlc/members/x`
// land in `.sdlc/members/` on macOS and Windows.
// A deletion is never judged here: removing a twin is how one is cleaned up (review 2).
const fold = (p) => p.normalize('NFKC').toLowerCase();
for (const { status, path } of all) {
  if (status === 'D') continue;
  const f = fold(path);
  if ((f === '.sdlc' || f.startsWith('.sdlc/')) && !(path === '.sdlc' || path.startsWith('.sdlc/'))) fail(`${JSON.stringify(path)} is another spelling of .sdlc/, which a macOS or Windows checkout reads as the Product's own folder, unjudged — move it into the real .sdlc/ folder (git mv), or delete it`);
  // `.sdlc/members` itself, a link where the folder goes, is the folder check's below, not a second spelling.
  else if ((f === '.sdlc/members' || f.startsWith(DIR)) && !path.startsWith(DIR) && path !== '.sdlc/members') fail(`${JSON.stringify(path)} is another spelling of ${DIR}, which a macOS or Windows checkout reads as a member file this gate does not judge — move it into the real ${DIR} folder (git mv), or delete it`);
}
// The folders themselves must be folders at HEAD, and nothing under them a link.
for (const p of ['.sdlc', '.sdlc/members']) {
  const t = git('ls-tree', 'HEAD', '--', p).out.trim();
  if (t && !t.startsWith('040000 ')) fail(`${p} is not a folder at HEAD (a link?), and member files are read only from a real ${DIR} — replace it with a real folder that holds the files themselves`);
}
// Two names of one file: keep one, take the other out (review 4). The base's copy is kept over one this PR
// brings in (whoever added the new one meant another file); then the name `yad member add` writes, in ASCII
// lower case. Only when both are on the base and neither is so named does the kept one need renaming.
const lowerName = (p) => { const n = p.slice(p.lastIndexOf('/') + 1); return n === n.toLowerCase() && /^[\x20-\x7e]*$/.test(n); };
function twin(a, b) {
  const pair = [a, b];
  const base0 = pair.filter(onBase);
  const pool = base0.length ? base0 : pair;
  const keep = pool.find(lowerName) || pool[0];
  const mv = base0.length === 2 && !lowerName(keep) ? `; then git mv ${keep} to its name in lower case` : '';
  fail(`${a} and ${b} are one file on macOS and Windows — keep ${keep}: ${removal(pair.filter((p) => p !== keep))}${mv}`);
}
const tree = git('ls-tree', '-r', '-z', 'HEAD', '--', DIR).out.split('\0').filter(Boolean);
const folded = new Map();
for (const line of tree) {
  const [meta, p] = line.split('\t');
  if (!meta.startsWith('100644 ') && !meta.startsWith('100755 ')) fail(`${p} is not a plain file (a link?), and a member file is never read through one — replace it with the file itself (yad member add writes it), or delete it`);
  const k = fold(p);
  if (folded.has(k)) twin(folded.get(k), p);
  folded.set(k, p);
}
if (rc) process.exit(rc);

const changed = all.filter((c) => c.path.startsWith(DIR));
if (!changed.length) { say('PASS [member-check]: no member file changed'); process.exit(0); }
// Where to set it: the file the gate read, or the one `yad setup` writes when there is none (review 1).
if (!platform) {
  const fix = !settingsFile ? 'there is no .sdlc/product.json: run yad setup in the Product, or write the file with "platform" ("github" or "gitlab")'
    : !settings || typeof settings !== 'object' || Array.isArray(settings) ? `${settingsFile} is not valid JSON or not an object: fix it, and set "platform" ("github" or "gitlab") in it`
      : `set "platform" ("github" or "gitlab") in ${settingsFile}`;
  say(`FAIL [member-check]: member files changed, but the Product names no platform, so nothing can be proven — ${fix}`);
  process.exit(1);
}

// Who opened the PR/MR, asked of the platform's own record.
// Returns { login, id }: the numeric id is what stays with a person when a login is renamed and reused.
async function prAuthor() {
  if (platform === 'github') return { login: process.env.PR_AUTHOR || null, id: Number(process.env.PR_AUTHOR_ID) || null };
  const url = process.env.CI_API_V4_URL;
  const project = process.env.CI_PROJECT_ID;
  const iid = process.env.CI_MERGE_REQUEST_IID;
  const token = process.env.GITLAB_TOKEN || process.env.SDLC_API_TOKEN;
  if (!url || !project || !iid) return null;
  if (!token) { fail('no API token (GITLAB_TOKEN or SDLC_API_TOKEN) to read who opened this MR — a member file cannot be checked without it; add a GITLAB_TOKEN masked CI/CD variable with the read_api scope, whose user can see the project'); return null; }
  try {
    const r = await fetch(`${url}/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(iid)}`, { headers: { 'PRIVATE-TOKEN': token } });
    // What to change, by what GitLab answered, as pr-template says it (#381). Only a refusal is the
    // token's fault; anything else is said as it is, with no advice to change the token.
    if (!r.ok) {
      const name = process.env.GITLAB_TOKEN ? 'GITLAB_TOKEN' : 'SDLC_API_TOKEN';
      const why = {
        401: `${name} was not accepted (expired, revoked, or not a valid token here) — renew or replace it`,
        403: `${name} was refused — give it the read_api scope`,
        404: `${name}'s user cannot see this project — use a token of a project member with Reporter access or more`,
      }[r.status] || 'GitLab did not answer with the MR — run the job again later';
      fail(`could not read the MR (HTTP ${r.status}): ${why}`);
      return null;
    }
    const mr = await r.json();
    return { login: mr?.author?.username || null, id: Number(mr?.author?.id) || null };
  } catch (e) { fail(`could not read the MR: ${e.message} — check that CI_API_V4_URL (${url}) is reachable from the runner and answers as GitLab's API, then run the job again`); return null; }
}

const who = await prAuthor();
if (rc) process.exit(rc);
const author = who?.login || null;
const authorId = who?.id || null;
// Two causes, each with its own fix (#381): the job did not say who opened it, or a bot did.
if (!author || !LOGIN_RE.test(author)) {
  const what = platform === 'github' ? 'PR' : 'MR';
  const fix = author ? `a member file is changed only by its own person: open the ${what} as that person`
    : platform === 'github' ? 'the job must pass PR_AUTHOR and PR_AUTHOR_ID from the pull_request event (github.event.pull_request.user.login and .id), as yad-product-checks.yml does'
      : who ? 'the merge request API named no author; run the job again'
        : 'run the job in a merge request pipeline, which sets CI_API_V4_URL, CI_PROJECT_ID and CI_MERGE_REQUEST_IID, as yad-product-checks.gitlab-ci.yml does';
  say(`FAIL [member-check]: cannot tell who opened this ${what}${author ? ` (${author} is a bot)` : ''} — ${fix}`);
  process.exit(1);
}

const fileAt = (ref, path) => { const r = git('show', `${ref}:${path}`); return r.ok ? parse(r.out) : null; };
const emailsOf = (rec) => new Set(Array.isArray(rec?.emails) ? rec.emails.filter((h) => typeof h === 'string' && HASH_RE.test(h)) : []);

// GitHub's own answer: which account a commit in this PR belongs to. Cached per commit.
const loginOf = new Map();
function githubLogin(sha) {
  if (loginOf.has(sha)) return loginOf.get(sha);
  const r = spawnSync('gh', ['api', `repos/{owner}/{repo}/commits/${sha}`, '--jq', '.author.login // ""'], { encoding: 'utf8' });
  const login = r.status === 0 ? (r.stdout || '').trim() : null;
  loginOf.set(sha, login);
  return login;
}

// The fix for a file that is not the author's own as `yad member add` writes it.
// It pushes its own branch (yad/member/<login>) and PR, so the file is dropped from any other PR.
const AGAIN = 'write the file again with yad member add, run by its own person; it opens its own pull request, so drop the file from any other one';

const prCommits = git('log', '--format=%H%x1f%ae', `${base}..HEAD`).out.split('\n').filter(Boolean).map((l) => { const [sha, email] = l.split('\x1f'); return { sha, hash: hash(email) }; });

for (const { status, path } of changed) {
  const name = path.slice(DIR.length);
  if (status === 'D') { say(`PASS [member-check]: ${path} removed (removing a member can only make the count larger)`); continue; }
  if (name.includes('/') || !name.endsWith('.json')) { fail(`${path}: only <platform>-<login>.json files belong in ${DIR} — move it to ${DIR}${platform}-<login>.json, or remove it`); continue; }
  if (name !== `${platform}-${author.toLowerCase()}.json`) { fail(`${path}: a PR may add or change only its author's own member file (${platform}-${author.toLowerCase()}.json) — drop this file from the PR, and change only ${platform}-${author.toLowerCase()}.json, which yad member add writes. To remove someone else's, use yad member remove <login> --reason "<why>"; git rm a file not named ${platform}-<login>.json`); continue; }
  const rec = fileAt('HEAD', path);
  if (!rec || !Array.isArray(rec.accounts)) { fail(`${path}: not a member file (no "accounts" list) — ${AGAIN}`); continue; }
  const here = rec.accounts.filter(onProduct);
  if (here.length !== 1) { fail(`${path}: must hold exactly one ${platform} account on ${productHost}, the author's own (it holds ${here.length}) — ${AGAIN}`); continue; }
  if (String(here[0].login || '').toLowerCase() !== author.toLowerCase()) { fail(`${path}: does not hold ${author}'s own ${platform} account on ${productHost} — ${AGAIN}`); continue; }
  // The numeric id: a login can be renamed away and registered again by someone else.
  if (!authorId) { fail(`${path}: cannot tell the numeric id of who opened this ${platform === 'github' ? 'PR (PR_AUTHOR_ID) — the job must pass PR_AUTHOR_ID from the pull_request event (github.event.pull_request.user.id), as yad-product-checks.yml does' : 'MR — the merge request API gave no author id; run the job again'}`); continue; }
  if (here[0].id !== authorId) { fail(`${path}: the account id in the file (${here[0].id ?? 'none'}) is not the author's (${authorId}) — ${AGAIN}`); continue; }
  const was = fileAt(base, path);
  const wasHere = Array.isArray(was?.accounts) ? was.accounts.filter(onProduct) : [];
  if (wasHere.length && wasHere[0].id !== authorId) { fail(`${path}: belonged to account id ${wasHere[0].id}, not ${author}'s (${authorId}), and a reused login does not take over a member file — remove the old file first with yad member remove ${author.toLowerCase()} --reason "<why>", in a pull request of its own`); continue; }
  if (platform !== 'github') { say(`PASS [member-check]: ${path} belongs to ${author} (on GitLab its emails feed the team list only)`); continue; }
  // EVERY email in a changed file is proven, not only the new ones (review 5): an email that reached the
  // branch while this gate was off or edited would otherwise ride along on any later change.
  const added = [...emailsOf(rec)];
  for (const h of added) {
    const proof = prCommits.filter((c) => c.hash === h).find((c) => String(githubLogin(c.sha) || '').toLowerCase() === author.toLowerCase());
    if (!proof) fail(`${path}: holds an email no commit in this PR proves (a commit authored by that email that GitHub attributes to ${author}) — verify the email on ${author}'s account, then run yad member add, which writes one such commit per email`);
  }
  if (!rc) say(`PASS [member-check]: ${path} belongs to ${author}${added.length ? `; ${added.length} email(s), each proven by a commit GitHub attributes to them` : ''}`);
}

// No account on the Product's platform and no email in two files, across every member file at HEAD.
const files = tree.map((l) => l.split('\t')[1]).filter((p) => p.endsWith('.json'));
const accounts = new Map();
const emails = new Map();
for (const p of files) {
  const rec = fileAt('HEAD', p);
  // Keyed on each file's OWN account only (review 2): an OTHER account two files claim is not refused here —
  // the CLI matches it to nobody — or whoever claimed someone's account first would block its owner.
  const login = p.slice(DIR.length).replace(new RegExp(`^${platform}-`), '').replace(/\.json$/, '');
  const k = `${platform}:${productHost}:${login.toLowerCase()}`;
  accounts.set(k, [...new Set([...(accounts.get(k) || []), p])]);
  for (const h of emailsOf(rec)) emails.set(h, [...(emails.get(h) || []), p]);
}
// The key comes from the file NAME, and two well-named files that share one are twins, refused above. So a
// clash here is a file named other than <platform>-<login>.json — which `yad member remove` cannot reach:
// it removes the well-named one (review 1).
const named = (p) => new RegExp(`^${platform}-[^/]+\\.json$`).test(p.slice(DIR.length));
const STALE = 'remove a stale file with yad member remove <login> --reason "<why>"';
// A misnamed file in a clash is taken out by `removal` (review 3, 4); `STALE` only when none is misnamed —
// two well-named files with one key are twins, refused above, so for accounts it is a guard, not a path today.
const misnamed = (list) => { const odd = list.filter((p) => !named(p)); return odd.length ? `${removal(odd)}. Only ${platform}-<login>.json files are member files` : null; };
for (const [k, list] of accounts) if (list.length > 1) fail(`the account ${k} is in ${list.join(' and ')}, and one account belongs to one member — ${misnamed(list) || STALE}`);
// On GitLab an email is never proven and never used by the count, so a shared one is not refused: refusing it
// would let whoever listed someone's known address first block that person (review 3). The CLI pairs it
// with nobody.
if (platform === 'github') for (const [, list] of emails) if (list.length > 1) fail(`one email is in ${list.join(' and ')}, and one email belongs to one member — ${misnamed(list) || `remove it from the file it does not belong in (that file's own person runs yad member add again, which keeps only the emails their account has verified), or ${STALE}`}`);

process.exit(rc);
