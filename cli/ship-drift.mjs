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
// registry or a ledger that could not be read, or read only in part, is said and counted as unknown.
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

const STORY_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+\b(?!-T\d)/g;
const TASK_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+-T\d+\b/g;
const SHORT_TAG = /^[a-z]+\(\s*(s\d+)\s*\)!?:/i;
const SHA = /^[0-9a-f]{7,64}$/;
const storyOf = (task) => task.replace(/-T\d+$/, '');

// git, raw: `run()` trims its output, and these records are split on NUL and unit separators. Signatures
// are never checked (`log.showSignature` in a repo's config runs a program of its choosing), and a partial
// clone never fetches a missing object (review 2): "nothing is fetched" stays true.
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'log.showSignature=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  return { ok: r.status === 0, status: r.status, out: r.stdout || '' };
};

// The default branch of one clone: origin's copy when the clone has one, else the local branch.
function defaultRef(dir, branch) {
  for (const ref of branch ? [`origin/${branch}`, branch] : []) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).ok) return ref;
  }
  return null;
}

// The branch a merge commit's subject names: GitLab's "Merge branch 'X' into 'main'", a local merge of a
// remote-tracking branch, GitHub's "Merge pull request #N from owner/X".
function mergedBranch(subject) {
  const m = subject.match(/^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'/) || subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/);
  return m ? m[1] : null;
}

// One repo's merged work, read from its clone. `{ read: true, ref, sha, dir, shared, tasks: Map(task ->
// evidence), possible, skipped }` or `{ read: false, why }` — a repo that cannot be read says so, and is
// never "nothing merged".
export function readRepoMerges(root, repo) {
  const judged = judgeRepo(root, repo);
  if (judged.state === 'missing') return { read: false, why: 'not cloned here (`yad repo clone`)' };
  // `path: "."` — the Product's own checkout IS the code repo (a supported monorepo layout, review 2).
  if (judged.state !== 'present' && judged.state !== 'product') return { read: false, why: judged.reason };
  if (judged.linked) return { read: false, why: 'it is reached through a link inside a repo, so git would read somewhere else' };
  const dir = judged.state === 'product' ? path.resolve(root) : judged.target;
  const ref = defaultRef(dir, typeof repo.default_branch === 'string' ? repo.default_branch : '');
  if (!ref) return { read: false, why: repo.default_branch ? `no branch ${forTerminal(repo.default_branch)} in the clone` : 'no default_branch in repos.json' };
  // A repo folder inside a shared checkout (the monorepo layout) reads only its own folder's history: the
  // whole history would credit every other folder's tasks to it too (review 1). The folder is named as it
  // is on disk (its true letter case) and matched literally — `Apps/API` or a folder named `apps/*` must not
  // match nothing, or more (review 2) — and merge commits are kept (`--full-history`).
  let only = null;
  if (judged.inside) {
    try { only = path.relative(fs.realpathSync.native(judged.inside), fs.realpathSync.native(dir)).split(path.sep).join('/'); } catch { return { read: false, why: 'its folder could not be resolved' }; }
  }
  // One record per commit: SHA, commit date, subject, Task trailer values — split by 0x1f, records by NUL.
  const log = git(dir, ['log', '--no-show-signature', ...(only ? ['--full-history'] : []), '-z',
    `--format=%H%x1f%cs%x1f%s%x1f%(trailers:key=${TASK_TRAILER},valueonly,separator=%x1e)`,
    '--end-of-options', ref, '--', ...(only ? [`:(top,literal)${only}`] : [])]);
  if (!log.ok) return { read: false, why: `git could not read ${forTerminal(ref)}` };
  const tasks = new Map();
  const possible = [];
  let skipped = 0;
  const add = (task, ev) => { if (!tasks.has(task)) tasks.set(task, ev); };
  for (const rec of log.out.split('\0')) {
    if (!rec.trim()) continue;
    const fields = rec.replace(/^\n/, '').split('\x1f');
    // A 0x1f inside a subject or trailer makes more fields: such a commit cannot be read safely, and is
    // counted (review 2), never dropped without a word.
    if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/.test(fields[0])) { skipped++; continue; }
    const [sha, date, subject, trailers] = fields;
    let hadTask = false;
    for (const v of trailers.split('\x1e').map((s) => s.trim())) {
      if (TASK_ID_RE.test(v)) { add(v, { sha, date, via: 'trailer' }); hadTask = true; }
    }
    const branchTask = /^Merge /.test(subject) ? taskFromBranch(mergedBranch(subject) || '') : null;
    if (branchTask && TASK_ID_RE.test(branchTask)) { add(branchTask, { sha, date, via: 'merge commit' }); hadTask = true; }
    if (!/^Revert\b/i.test(subject)) {
      for (const t of subject.match(TASK_IN_TEXT) || []) { add(t, { sha, date, via: 'task ID in the subject' }); hadTask = true; }
    }
    if (hadTask) continue;
    for (const id of subject.match(STORY_IN_TEXT) || []) possible.push({ sha, story: id, via: 'story ID in the subject' });
    const tag = subject.match(SHORT_TAG);
    // `s06` and `s6` name the same story number; stories are keyed by the number itself.
    if (tag) possible.push({ sha, tag: `s${Number(tag[1].slice(1))}`, via: `short tag ${tag[1].toLowerCase()}` });
  }
  const sha = git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]).out.trim();
  return { read: true, ref, sha, dir, shared: !!only || judged.state === 'product', tasks, possible, skipped };
}

// The task branches merged INTO the default branch that the platform knows of, when it answers. Adds to
// `tasks`, never replaces a commit already found. Returns `{ note, partial }`: turned off on purpose, or no
// platform to ask, is a note; a platform that should have answered and did not (or in part) is partial.
function addPlatformMerges(repo, merges, { runner, env, authCache }) {
  const t = { platform: repo.platform || null, gitUrl: repo.git_url || '' };
  const r = listMergedBranches(t, { base: repo.default_branch, ...(runner ? { runner } : {}), env, authCache });
  if (!r.ok) {
    const deliberate = ['off', 'no-platform', 'no-url'].includes(r.kind);
    return { note: `platform not read — ${r.why}`, partial: !deliberate };
  }
  for (const m of r.merged) {
    const task = m.branch ? taskFromBranch(m.branch) : null;
    if (task && TASK_ID_RE.test(task) && !merges.tasks.has(task)) merges.tasks.set(task, { sha: m.commit, pr: m.number, via: 'merged branch' });
  }
  return r.partial ? { note: 'the platform listed only its most recently updated merged PRs/MRs — older ones may be missing', partial: true } : { note: null, partial: false };
}

// Does a retroactive ship stand for this merged task? It covers what merged up to it: a task commit its
// merge commit holds, else one dated on or before it. Only a hex SHA that resolves to a commit here is
// asked about — `main` or `:/text` would cover everything (review 2); one this clone lacks falls back to the
// date. A retro ship with neither a usable commit nor a date records nothing to tell by, and stands for the
// whole story here, as before. A task merged after it is reported (review 1).
function retroCovers(retro, ev, dir) {
  const mc = typeof retro.mergeCommit === 'string' && SHA.test(retro.mergeCommit) && dir
    && git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${retro.mergeCommit}^{commit}`]).ok ? retro.mergeCommit : null;
  if (mc && ev.sha && SHA.test(ev.sha)) {
    const r = git(dir, ['merge-base', '--is-ancestor', '--end-of-options', ev.sha, mc]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    // anything else (an object this clone lacks): fall back to the date
  }
  const shipped = typeof retro.shippedAt === 'string' ? retro.shippedAt.slice(0, 10) : null;
  if (shipped && ev.date) return ev.date <= shipped;
  return !mc && !shipped;
}

// The whole comparison. `epics` (a Set) limits it to those epics, and then only the repos their stories
// name are read. Returns { repos, unreadEpics, registry, findings }:
//   repos:     [{ repo, read, why? | ref, sha, note?, partial? }]
//   registry:  null when it was read; else why it was not (the file does not parse, or an entry is not one)
//   finding.kind 'merged-no-ship' { epic, story, task, repo, sha, pr, via, fix }   — counted
//                'looks-shipped'  { epic, story, status, repos }                      — a hint
//                'possible'       { repo, sha, token, via, stories }                  — check by hand
export function shipDrift(root, { platform = true, epics = null, runner, env = process.env, authCache = new Map() } = {}) {
  const stories = [];
  const unreadEpics = [];
  for (const epic of epicIds(root)) {
    if (epics && !epics.has(epic)) continue;
    const dir = path.join(epicRoot(root, epic), 'stories');
    if (!exists(dir)) continue;
    let ships;
    try { ships = readShips(epicRoot(root, epic)); } catch { unreadEpics.push(epic); continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const fm = readFrontmatter(path.join(dir, f));
      const fileId = f.replace(/\.md$/, '');
      const story = typeof fm.id === 'string' && fm.id ? fm.id : fileId;
      if (!new RegExp(`^${epic}-S\\d+$`).test(story)) continue;
      stories.push({ epic, story, sameFile: story === fileId, status: typeof fm.status === 'string' ? fm.status : '', repos: declaredRepos(fm), ships: ships.filter((s) => s.story === story) });
    }
  }

  // The registry: a file that does not parse is not "no repos" (review 2). Entries that are not repos are
  // counted too.
  let registry = null;
  let entries = [];
  try {
    const reg = readJSONStrict(path.join(root, PROJECT_FILES.reposRegistry), { repos: [] });
    entries = Array.isArray(reg?.repos) ? reg.repos : null;
    if (!entries) { registry = 'its `repos` is not a list'; entries = []; }
  } catch { registry = 'it does not parse'; }
  const usable = entries.filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name);
  if (!registry && usable.length !== entries.length) registry = `${entries.length - usable.length} entry(ies) are not a repo with a name`;

  const wanted = new Set(stories.flatMap((s) => s.repos));
  const repos = usable.filter((r) => !epics || wanted.has(r.name));
  // The same platform repo under two names (monorepo folders share their checkout's `origin`): its merged
  // branches cannot be told apart by folder, so it is not asked for any of them (review 2).
  const urlCount = new Map();
  for (const r of repos) if (r.git_url) urlCount.set(r.git_url, (urlCount.get(r.git_url) || 0) + 1);
  const read = new Map();
  const reposOut = [];
  for (const repo of repos) {
    const m = readRepoMerges(root, repo);
    let pl = { note: null, partial: false };
    if (m.read && platform) {
      pl = m.shared || (repo.git_url && urlCount.get(repo.git_url) > 1)
        ? { note: 'platform not asked — the repo shares its checkout, so its merged branches cannot be told apart by folder', partial: false }
        : addPlatformMerges(repo, m, { runner, env, authCache });
    }
    const partial = pl.partial || (m.read && m.skipped > 0);
    const notes = [pl.note, m.read && m.skipped ? `${m.skipped} commit(s) could not be read` : null].filter(Boolean);
    read.set(repo.name, m);
    reposOut.push({ repo: repo.name, read: m.read, ...(m.read ? { ref: m.ref, sha: m.sha } : { why: m.why }), ...(notes.length ? { note: notes.join('; ') } : {}), ...(partial ? { partial: true } : {}) });
  }
  // A repo a story names that the registry does not hold is not read either — said, not assumed empty.
  for (const name of [...wanted].sort()) {
    if (!read.has(name) && !usable.some((r) => r.name === name)) reposOut.push({ repo: name, read: false, why: 'a story names it, but it is not in repos.json' });
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
        if (recorded.some((x) => x.task === t)) continue;
        if (retros.some((x) => retroCovers(x, ev, m.dir))) continue;
        // `yad checkpoint --retro-ship` records ONE ship per (story, repo), marked as a pre-tracking backfill,
        // and needs the story `in-build` or `shipped` first. So it is offered once, only while (story, repo)
        // has no ship at all and the story's file carries its ID, and only for a story that predates
        // tracking; every other line says to record the ship as yad-engineer-review does (review 1).
        const engineer = 'record the ship as yad-engineer-review does (a command for it is #346)';
        let fix = engineer;
        if (!recorded.length && !suggested && s.sameFile && asArg(repoName) === repoName) {
          fix = `if ${s.story} predates ledger tracking: yad checkpoint --retro-ship ${s.epic}/${s.story} --repo ${repoName} --task ${t}${ev.sha && SHA.test(ev.sha) ? ` --merge-commit ${ev.sha.slice(0, 12)}` : ''} (the story's status must be in-build or shipped first); otherwise ${engineer}`;
          suggested = true;
        }
        findings.push({ kind: 'merged-no-ship', epic: s.epic, story: s.story, task: t, repo: repoName, sha: ev.sha && SHA.test(ev.sha) ? ev.sha : null, pr: Number.isInteger(ev.pr) ? ev.pr : null, via: ev.via, fix });
      }
    }
    if (everyRepoHasWork && s.status !== 'shipped') findings.push({ kind: 'looks-shipped', epic: s.epic, story: s.story, status: s.status || null, repos: s.repos });
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
  }
  return { repos: reposOut, unreadEpics, registry, findings };
}
