// Issue #365 — merged work the Product's build ledger does not record. When task MRs merge in the code
// repos, nothing writes the build-log ship or the story's `status: shipped` on its own (the
// yad-engineer-review skill does, by hand), and `yad reconcile check` could not see the gap. This reads
// what merged and compares it with the ledger. READ-ONLY: it reports, with the command that fixes each
// line where one exists; it never writes a ship (that is #346).
//
// What counts as merged, per repo the Product registers (.sdlc/repos.json):
//   - on the repo's default branch, in its clone here (as the clone last saw it — nothing is fetched): a
//     `Task: EP-<slug>-S<n>-T<n>` trailer, a merge commit naming a task branch, or a full task ID in a
//     commit subject (a squash commit titled with its task) — the full ID only (the user's decision);
//   - a PR/MR merged INTO the default branch whose source branch names a task (`feat/EP-x-S01-T01-…`),
//     when the platform answers: a GitLab squash keeps only the MR title, so the branch is where a
//     squashed task still shows (the user's decision, 2026-10-18).
// A full STORY ID in a subject, or a short scope tag such as `feat(s06):`, is only a POSSIBLE match: listed
// to check by hand, never counted (2026-10-17). A story ID only in a commit body is not evidence.
//
// git runs only in a repo `judgeRepo` finds present — the guard `yad doctor` and `yad repo clone` use: a
// committed folder shaped like a bare repo would have git read its config, and a path outside the
// workspace is not this Product's to read (review 1). Facts only: a SHA, a PR/MR number and an ID — never
// a subject, a body or a branch name. Never an all-clear over what was not read (review 2): a repo, a
// registry, a ledger or a story that could not be read or compared is said and counted as unknown.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJSONStrict, exists, forTerminal, asArg } from './lib.mjs';
import { PROJECT_FILES, TASK_ID_RE, TASK_TRAILER } from './manifest.mjs';
import { taskFromBranch } from './commit.mjs';
import { epicIds, epicRoot, readFrontmatter, declaredRepos } from './epic-state.mjs';
import { readShips } from './ledger.mjs';
import { listMergedBranches } from './pr-list.mjs';
import { judgeRepo } from './workspace.mjs';
import { hostFromGitUrl, plainHost } from './platform.mjs';
import { repoPathFromGitUrl } from './protection.mjs';

const STORY_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+\b(?!-T\d)/g;
const TASK_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+-T\d+\b/g;
const SHORT_TAG = /^[a-z]+\(\s*(s\d+)\s*\)!?:/i;
const SHA = /^[0-9a-f]{7,64}$/;
// A branch NAME, never revision syntax: `main~1`, `main@{1}`, `HEAD` or a leading `-` would read another
// commit than the branch's tip, and hide what merged (review 3).
const BRANCH = /^(?!-)(?!HEAD$)(?!.*(?:\.\.|@\{|\/\/|\.lock$|\/$|\.$))[A-Za-z0-9._/-]+$/;
const storyOf = (task) => task.replace(/-T\d+$/, '');
const shaOf = (v) => (typeof v === 'string' && SHA.test(v.toLowerCase()) ? v.toLowerCase() : null);

// git, raw: `run()` trims its output, and these records are split on NUL and unit separators. Signatures
// are never checked (`log.showSignature` in a repo's config runs a program of its choosing), and a partial
// clone never fetches a missing object on git 2.44+ (review 2): "nothing is fetched".
const git = (cwd, args) => {
  // TZ=UTC: commit dates read as the UTC day, as ship dates and the platform's are (review 4).
  const r = spawnSync('git', ['-c', 'log.showSignature=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', TZ: 'UTC' } });
  return { ok: r.status === 0, status: r.status, out: r.stdout || '' };
};

// The default branch of one clone: origin's copy when the clone has one, else the local branch — named as
// a full ref, so no tag or other name of the same spelling is read instead. `{ ref (shown), full }`.
function defaultRef(dir, branch) {
  if (!BRANCH.test(branch)) return null;
  for (const [ref, full] of [[`origin/${branch}`, `refs/remotes/origin/${branch}`], [branch, `refs/heads/${branch}`]]) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${full}^{commit}`]).ok) return { ref, full };
  }
  return null;
}

// The branches a merge commit's subject says it brought in — never the "into …" part: GitLab's "Merge
// branch 'X' into 'main'", a local merge of a remote-tracking branch, an octopus "Merge branches 'a' and
// 'b'", GitHub's "Merge pull request #N from owner/X".
function mergedBranches(subject) {
  const gh = subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/);
  if (gh) return [gh[1]];
  const head = subject.match(/^Merge (?:remote-tracking )?branch(?:es)? ((?:'[^']+'(?:,\s*|\s+and\s+)?)+)/);
  return head ? [...head[1].matchAll(/'(?:origin\/)?([^']+)'/g)].map((m) => m[1]) : [];
}

// The commits of one `git log`, as { sha, date, parents, subject, trailers } — or null when git could not
// read them. `skipped` counts a record that cannot be read safely (a 0x1f in a subject or trailer makes
// more fields).
function logRecords(dir, args, counter) {
  const log = git(dir, ['log', '--no-show-signature', '-z', '--date=format-local:%Y-%m-%d', `--format=%H%x1f%cd%x1f%P%x1f%s%x1f%(trailers:key=${TASK_TRAILER},valueonly,separator=%x1e)`, ...args]);
  if (!log.ok) return null;
  const out = [];
  for (const rec of log.out.split('\0')) {
    if (!rec.trim()) continue;
    const fields = rec.replace(/^\n/, '').split('\x1f');
    if (fields.length !== 5 || !/^[0-9a-f]{40,64}$/.test(fields[0])) { counter.skipped++; continue; }
    out.push({ sha: fields[0], date: fields[1], parents: fields[2].split(' ').filter(Boolean), subject: fields[3], trailers: fields[4] });
  }
  return out;
}

// One repo's merged work, read from its clone. `{ read: true, ref, sha, dir, shared, tasks: Map(task ->
// evidence), possible, skipped }` or `{ read: false, why }` — a repo that cannot be read says so, and is
// never "nothing merged".
export function readRepoMerges(root, repo) {
  const judged = judgeRepo(root, repo);
  if (judged.state === 'missing') return { read: false, why: 'not cloned here (`yad repo clone`)' };
  // `path: "."` — the Product's own checkout IS the code repo (a supported monorepo layout, review 2). Only
  // when the Product folder holds its own `.git`: otherwise git would walk up into whatever repo encloses
  // it (review 3).
  if (judged.state === 'product' && !exists(path.join(root, '.git'))) return { read: false, why: 'the Product folder is not a git checkout of its own' };
  if (judged.state !== 'present' && judged.state !== 'product') return { read: false, why: judged.reason };
  if (judged.linked) return { read: false, why: 'it is reached through a link inside a repo, so git would read somewhere else' };
  const dir = judged.state === 'product' ? path.resolve(root) : judged.target;
  const branch = typeof repo.default_branch === 'string' ? repo.default_branch : '';
  if (branch && !BRANCH.test(branch)) return { read: false, why: 'its default_branch in repos.json is not a branch name' };
  const found = defaultRef(dir, branch);
  const ref = found?.ref;
  if (!found) return { read: false, why: branch ? `no branch ${forTerminal(branch)} in the clone` : 'no default_branch in repos.json' };
  // A shallow clone holds only its newest commits: what merged before its edge is not there, and reading it
  // would be an all-clear over history it does not have (review 5). Said, not read.
  const shallow = git(dir, ['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok || shallow.out.trim() !== 'false') return { read: false, why: shallow.ok ? 'a shallow clone — run `git fetch --unshallow` in it, then run again' : 'git could not tell whether it is a shallow clone' };
  // A repo folder inside a shared checkout (the monorepo layout) reads only its own folder's NON-MERGE
  // commits: their `Task:` trailers and task IDs in their subjects (what `yad commit` writes). The whole
  // history would credit every other folder's tasks to it (review 1); a merge commit cannot be told to
  // belong to one folder without edge cases that kept turning up — shallow edges, criss-cross merges, a
  // stacked branch carrying another task's work — so a merge's title is not read for a folder (the user's
  // decision, 2026-10-19, review 5), and the output says so. The folder is named as it is on disk (its true
  // letter case) and matched literally (review 2).
  let only = null;
  if (judged.inside) {
    try { only = path.relative(fs.realpathSync.native(judged.inside), fs.realpathSync.native(dir)).split(path.sep).join('/'); } catch { return { read: false, why: 'its folder could not be resolved' }; }
  }
  const counter = { skipped: 0 };
  const spec = only ? ['--', `:(top,literal)${only}`] : ['--'];
  const records = logRecords(dir, [...(only ? ['--no-merges'] : []), '--end-of-options', found.full, ...spec], counter);
  if (!records) return { read: false, why: `git could not read ${forTerminal(ref)}` };
  const tasks = new Map();
  const possible = [];
  const add = (task, ev) => { if (!tasks.has(task)) tasks.set(task, ev); };
  // The Product's own checkpoint commits name a story in their subject; they are yad's records, not merged
  // work (review 3).
  const ownRecord = (subject) => judged.state === 'product' && /^chore\(product\):/.test(subject);
  for (const { sha, date, parents, subject, trailers } of records) {
    const isMerge = parents.length > 1;
    let hadTask = false;
    for (const v of trailers.split('\x1e').map((s) => s.trim())) {
      if (TASK_ID_RE.test(v)) { add(v, { sha, date, via: 'trailer' }); hadTask = true; }
    }
    const brought = isMerge ? mergedBranches(subject) : [];
    for (const b of brought) {
      const branchTask = taskFromBranch(b);
      if (branchTask && TASK_ID_RE.test(branchTask)) { add(branchTask, { sha, date, via: 'merge commit' }); hadTask = true; }
    }
    // A subject may carry a full task ID: a squash titled with its task, or a merge titled with its pull
    // request (review 5). A "Merge branch 'x' into 'y'" subject is read only for the branches it brought
    // in, never for an ID in its "into …" part (review 4).
    if (!brought.length && !/^Merge (?:remote-tracking )?branch(?:es)? '/.test(subject) && !/^Revert\b/i.test(subject) && !ownRecord(subject)) {
      for (const t of subject.match(TASK_IN_TEXT) || []) { add(t, { sha, date, via: 'task ID in the subject' }); hadTask = true; }
    }
    if (hadTask || ownRecord(subject)) continue;
    for (const id of subject.match(STORY_IN_TEXT) || []) possible.push({ sha, story: id, via: 'story ID in the subject' });
    const tag = subject.match(SHORT_TAG);
    // `s06` and `s6` name the same story number; stories are keyed by the number itself.
    if (tag) possible.push({ sha, tag: `s${Number(tag[1].slice(1))}`, via: `short tag ${tag[1].toLowerCase()}` });
  }
  const sha = git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', found.full]).out.trim();
  return { read: true, ref, sha, dir, shared: !!only, tasks, possible, skipped: counter.skipped, ...(only ? { mergesUnread: true } : {}) };
}

// The task branches merged INTO the default branch that the platform knows of, when it answers. Adds to
// `tasks`, never replaces a commit already found. Returns `{ note, partial }`: turned off on purpose, or no
// platform to ask, is a note; a platform that should have answered and did not is partial. A full page is
// a note only: local git sees every merge but a squash, and a busy repo would otherwise never read in full.
function addPlatformMerges(repo, merges, { runner, env, authCache }) {
  const t = { platform: repo.platform || null, gitUrl: repo.git_url || '' };
  const r = listMergedBranches(t, { base: repo.default_branch, ...(runner ? { runner } : {}), env, authCache });
  if (!r.ok) {
    const deliberate = ['off', 'no-platform', 'no-url'].includes(r.kind);
    const how = ['no-cli', 'no-login'].includes(r.kind) ? ' — install and log in to read squash-merged tasks, or set YAD_PLATFORM_READ=0 to read git only' : '';
    return { note: `platform not read — ${r.why}${how}`, partial: !deliberate };
  }
  for (const m of r.merged) {
    const task = m.branch ? taskFromBranch(m.branch) : null;
    if (task && TASK_ID_RE.test(task) && !merges.tasks.has(task)) merges.tasks.set(task, { sha: m.commit, pr: m.number, date: m.date, via: 'merged branch' });
  }
  return { note: r.partial ? 'the platform listed only its 100 most recently updated merged PRs/MRs — an older squash merge may be missing' : null, partial: false };
}

// Does a retroactive ship stand for this merged task? It covers what merged up to it: a task commit its
// merge commit holds, else one dated on or before it. Only a hex SHA that resolves to a commit here is
// asked about — `main` or `:/text` would cover everything (review 2); one this clone lacks falls back to the
// date. A retro ship with neither a commit nor a date recorded stands for the whole story here, as before;
// one whose recorded commit cannot be checked and has no date covers nothing it cannot prove (review 3).
function retroCovers(retro, ev, dir) {
  const recorded = shaOf(retro.mergeCommit);
  const mc = recorded && dir && git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${recorded}^{commit}`]).ok ? recorded : null;
  const evSha = shaOf(ev.sha);
  if (mc && evSha) {
    const r = git(dir, ['merge-base', '--is-ancestor', '--end-of-options', evSha, mc]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    // anything else (an object this clone lacks): fall back to the date
  }
  const shipped = typeof retro.shippedAt === 'string' ? retro.shippedAt.slice(0, 10) : null;
  if (shipped && ev.date) return ev.date <= shipped;
  return !retro.mergeCommit && !shipped;
}

// The platform repo a registry entry names, the same however its URL is spelled (review 3).
const platformKey = (url) => {
  const host = plainHost(hostFromGitUrl(url || ''));
  const repo = repoPathFromGitUrl(url || '');
  return host && repo ? `${host}/${repo}`.toLowerCase().replace(/\.git$/, '') : null;
};

// The whole comparison. `epics` (a Set) limits it to those epics, and then only the repos their stories
// name are read. Returns { repos, unreadEpics, uncompared, registry, findings }:
//   repos:      [{ repo, read, why? | ref, sha, note?, partial? }]
//   uncompared: stories that name no repo, when the registry holds more than one — they cannot be compared
//   registry:   null when it was read; else why it was not (the file does not parse, or an entry is not one)
//   finding.kind 'merged-no-ship' { epic, story, task, repo, sha, pr, via, fix }   — counted
//                'looks-shipped'  { epic, story, status, repos }                      — a hint
//                'possible'       { repo, sha, token, via, stories }                  — check by hand
//                'no-story'       { repo, sha, task, epic }                           — a task naming a story no file holds
export function shipDrift(root, { platform = true, epics = null, runner, env = process.env, authCache = new Map() } = {}) {
  // The registry first: a story that names no repo takes the one repo the Product registers, as
  // `yad checkpoint --retro-ship` does. A file that does not parse is not "no repos" (review 2).
  let registry = null;
  let entries = [];
  try {
    const reg = readJSONStrict(path.join(root, PROJECT_FILES.reposRegistry), { repos: [] });
    entries = Array.isArray(reg?.repos) ? reg.repos : null;
    if (!entries) { registry = 'its `repos` is not a list'; entries = []; }
  } catch { registry = 'it does not parse'; }
  const usable = entries.filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name);
  if (!registry && usable.length !== entries.length) registry = `${entries.length - usable.length} entry(ies) are not a repo with a name`;

  const stories = [];
  const unreadEpics = [];
  const uncompared = [];
  const knownEpics = new Set();
  const knownIds = new Set();
  for (const epic of epicIds(root)) {
    knownEpics.add(epic);
    if (epics && !epics.has(epic)) continue;
    const dir = path.join(epicRoot(root, epic), 'stories');
    if (!exists(dir)) continue;
    const idOk = (x) => new RegExp(`^${epic}-S\\d+$`).test(x);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort().map((f) => {
      const fm = readFrontmatter(path.join(dir, f));
      const fileId = f.replace(/\.md$/, '');
      // An `id:` that is not this epic's story ID (a typo) falls back to the file's name (review 4).
      const story = typeof fm.id === 'string' && idOk(fm.id) ? fm.id : fileId;
      return { fm, fileId, story };
    }).filter((x) => idOk(x.story));
    // Two files claiming one story ID (an `id:` copied by hand): each falls back to its own file name; a
    // clash that remains is not compared, and is said (review 5).
    const claims = new Map();
    for (const x of files) claims.set(x.story, (claims.get(x.story) || 0) + 1);
    for (const x of files) if (claims.get(x.story) > 1 && idOk(x.fileId)) x.story = x.fileId;
    const seenIds = new Map();
    for (const x of files) seenIds.set(x.story, (seenIds.get(x.story) || 0) + 1);
    // Its story IDs are known even when its ledger is not: a merged task of it is never "no such story".
    for (const x of files) knownIds.add(x.story);
    let ships;
    try { ships = readShips(epicRoot(root, epic)); } catch { unreadEpics.push(epic); continue; }
    for (const { fm, fileId, story } of files) {
      if (seenIds.get(story) > 1) { if (!uncompared.includes(story)) uncompared.push(story); continue; }
      let repos = declaredRepos(fm);
      let fallback = false;
      // A story that names no repo was never compared (review 3): with one registered repo it is that one;
      // with more it cannot be told, and is said.
      if (!repos.length) {
        if (usable.length === 1) { repos = [usable[0].name]; fallback = true; } else { uncompared.push(story); continue; }
      }
      stories.push({ epic, story, sameFile: story === fileId, fallback, status: typeof fm.status === 'string' ? fm.status : '', repos, ships: ships.filter((s) => s.story === story) });
    }
  }

  const wanted = new Set(stories.flatMap((s) => s.repos));
  const repos = usable.filter((r) => !epics || wanted.has(r.name));
  // The same platform repo under two names (monorepo folders share their checkout's `origin`), however its
  // URL is spelled: its merged branches cannot be told apart by name, so it is not asked for any of them.
  const keyCount = new Map();
  // From the whole registry, so a `--thread` run asks exactly what a full run does (review 4).
  for (const r of usable) { const k = platformKey(r.git_url); if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1); }
  const read = new Map();
  const reposOut = [];
  for (const repo of repos) {
    if (read.has(repo.name)) continue; // a name registered twice is read once
    const m = readRepoMerges(root, repo);
    let pl = { note: null, partial: false };
    if (m.read && platform) {
      const k = platformKey(repo.git_url);
      pl = m.shared || (k && keyCount.get(k) > 1)
        ? { note: 'platform not asked — another registered repo shares this one, so a squash-merged task that shows only in its branch name is not seen here', partial: false }
        : addPlatformMerges(repo, m, { runner, env, authCache });
    }
    const partial = pl.partial || (m.read && m.skipped > 0);
    const notes = [pl.note, m.read && m.skipped ? `${m.skipped} commit(s) could not be read` : null,
      m.mergesUnread ? 'merge-commit titles are not read for a folder in a shared checkout — a task seen only in one is not found' : null].filter(Boolean);
    read.set(repo.name, m);
    reposOut.push({ repo: repo.name, read: m.read, ...(m.read ? { ref: m.ref, sha: m.sha } : { why: m.why }), ...(notes.length ? { note: notes.join('; ') } : {}), ...(partial ? { partial: true } : {}) });
  }
  // A repo a story names that the registry does not hold is not read either — said, not assumed empty.
  for (const name of [...wanted].sort()) {
    if (!read.has(name)) reposOut.push({ repo: name, read: false, why: registry ? 'repos.json could not be read' : 'a story names it, but it is not in repos.json' });
  }

  const findings = [];
  for (const s of stories) {
    let everyRepoHasWork = s.repos.length > 0;
    for (const repoName of s.repos) {
      const m = read.get(repoName);
      const recorded = s.ships.filter((x) => x.repo === repoName);
      const retros = recorded.filter((x) => x.retroactive);
      const merged = m?.read ? [...m.tasks].filter(([task]) => storyOf(task) === s.story) : [];
      if (!recorded.length && !merged.length) everyRepoHasWork = false;
      let suggested = false;
      for (const [task, ev] of merged) {
        const t = task.slice(s.story.length + 1);
        // A hand-written ship may hold the full ID as its task (review 3).
        if (recorded.some((x) => x.task === t || x.task === task)) continue;
        if (retros.some((x) => retroCovers(x, ev, m.dir))) continue;
        // `yad checkpoint --retro-ship` records ONE ship per (story, repo), marked as a pre-tracking backfill,
        // and needs the story `in-build` or `shipped` first. So it is offered once, only while (story, repo)
        // has no ship at all and the story's file carries its ID, and only for a story that predates
        // tracking; every other line says to record the ship as yad-engineer-review does (review 1).
        const engineer = 'record the ship as yad-engineer-review does (a command for it is #346)';
        const evSha = shaOf(ev.sha);
        let fix = engineer;
        if (!recorded.length && !suggested && s.sameFile && asArg(repoName) === repoName) {
          fix = `if ${s.story} predates ledger tracking: yad checkpoint --retro-ship ${s.epic}/${s.story} --repo ${repoName} --task ${t}${evSha ? ` --merge-commit ${evSha.slice(0, 12)}` : ''} (the story's status must be in-build or shipped first); otherwise ${engineer}`;
          suggested = true;
        }
        findings.push({ kind: 'merged-no-ship', epic: s.epic, story: s.story, task: t, repo: repoName, sha: evSha, pr: Number.isInteger(ev.pr) ? ev.pr : null, via: ev.via, fix });
      }
    }
    if (everyRepoHasWork && s.status !== 'shipped') findings.push({ kind: 'looks-shipped', epic: s.epic, story: s.story, status: s.status || null, repos: s.repos, ...(s.fallback ? { fallback: true } : {}) });
  }

  // Possible matches, for stories not already shipped or recorded in that repo — a match for one that is
  // has nothing left to check, and the list would only grow with history (review 1). A short tag names a
  // story number, not an epic, so every such story in an epic that names the repo is a candidate.
  const open = (repoName) => stories.filter((s) => s.repos.includes(repoName) && s.status !== 'shipped' && !s.ships.some((x) => x.repo === repoName));
  for (const [repoName, m] of read) {
    if (!m.read) continue;
    const candidates = open(repoName);
    for (const p of m.possible) {
      const hit = candidates.filter((s) => (p.story ? s.story === p.story : `s${Number(s.story.match(/-S(\d+)$/)[1])}` === p.tag)).map((s) => s.story);
      if (hit.length) findings.push({ kind: 'possible', repo: repoName, sha: p.sha, token: p.story || p.tag, via: p.via, stories: hit });
    }
    // A merged task whose story no file holds — a typo in a trailer is exactly the drift this looks for
    // (review 3). Only for an epic that exists, and in scope.
    for (const [task, ev] of m.tasks) {
      const story = storyOf(task);
      const epic = story.replace(/-S\d+$/, '');
      if (knownIds.has(story) || !knownEpics.has(epic) || (epics && !epics.has(epic))) continue;
      findings.push({ kind: 'no-story', repo: repoName, sha: shaOf(ev.sha), task, epic });
    }
  }
  return { repos: reposOut, unreadEpics, uncompared, registry, findings };
}
