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
// a subject, a body or a branch name.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJSON, exists, forTerminal, asArg } from './lib.mjs';
import { PROJECT_FILES, TASK_ID_RE, TASK_TRAILER } from './manifest.mjs';
import { taskFromBranch } from './commit.mjs';
import { epicIds, epicRoot, readFrontmatter, declaredRepos } from './epic-state.mjs';
import { readShips } from './ledger.mjs';
import { listMergedBranches } from './pr-list.mjs';
import { judgeRepo } from './workspace.mjs';

const STORY_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+\b(?!-T\d)/g;
const TASK_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+-T\d+\b/g;
const SHORT_TAG = /^[a-z]+\(\s*(s\d+)\s*\)!?:/i;
const storyOf = (task) => task.replace(/-T\d+$/, '');

// git, raw: `run()` trims its output, and these records are split on NUL and unit separators. Signatures
// are never checked: `log.showSignature` in a repo's config runs a program of its choosing.
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'log.showSignature=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout || '' };
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

// One repo's merged work, read from its clone. `{ read: true, ref, sha, dir, tasks: Map(task -> evidence),
// possible }` or `{ read: false, why }` — a repo that cannot be read says so, and is never "nothing merged".
export function readRepoMerges(root, repo) {
  const judged = judgeRepo(root, repo);
  if (judged.state === 'missing') return { read: false, why: 'not cloned here (`yad repo clone`)' };
  if (judged.state !== 'present') return { read: false, why: judged.state === 'product' ? 'it is the Product itself' : judged.reason };
  if (judged.linked) return { read: false, why: 'it is reached through a link inside a repo, so git would read somewhere else' };
  const dir = judged.target;
  const ref = defaultRef(dir, typeof repo.default_branch === 'string' ? repo.default_branch : '');
  if (!ref) return { read: false, why: repo.default_branch ? `no branch ${forTerminal(repo.default_branch)} in the clone` : 'no default_branch in repos.json' };
  // A repo folder inside a shared checkout (the monorepo layout) reads only its own folder's history: the
  // whole history would credit every other folder's tasks to it too (review 1).
  const only = judged.inside ? path.relative(judged.inside, dir) : null;
  // One record per commit: SHA, commit date, subject, Task trailer values — split by 0x1f, records by NUL.
  const log = git(dir, ['log', '--no-show-signature', '-z', `--format=%H%x1f%cs%x1f%s%x1f%(trailers:key=${TASK_TRAILER},valueonly,separator=%x1e)`,
    '--end-of-options', ref, '--', ...(only ? [`:(top)${only.split(path.sep).join('/')}`] : [])]);
  if (!log.ok) return { read: false, why: `git could not read ${forTerminal(ref)}` };
  const tasks = new Map();
  const possible = [];
  const add = (task, ev) => { if (!tasks.has(task)) tasks.set(task, ev); };
  for (const rec of log.out.split('\0')) {
    const fields = rec.replace(/^\n/, '').split('\x1f');
    if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue; // a separator in a subject is not a field
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
  return { read: true, ref, sha, dir, tasks, possible };
}

// The task branches merged INTO the default branch that the platform knows of, when it answers. Adds to
// `tasks`, never replaces a commit already found. Returns a note when it did not answer, or in part.
function addPlatformMerges(repo, merges, { runner, env, authCache }) {
  const t = { platform: repo.platform || null, gitUrl: repo.git_url || '' };
  const r = listMergedBranches(t, { base: repo.default_branch, ...(runner ? { runner } : {}), env, authCache });
  if (!r.ok) return `platform not read — ${r.why}`;
  for (const m of r.merged) {
    const task = m.branch ? taskFromBranch(m.branch) : null;
    if (task && TASK_ID_RE.test(task)) merges.tasks.has(task) || merges.tasks.set(task, { sha: m.commit, pr: m.number, via: 'merged branch' });
  }
  return r.partial ? 'the platform listed only its most recently updated merged PRs/MRs — older ones may be missing' : null;
}

// Does a retroactive ship stand for this merged task? It covers what merged up to it: a task commit its
// merge commit holds, else one dated on or before it. A retro ship with neither records nothing to tell
// by, and stands for the whole story here, as before. A task merged after it is reported (review 1).
function retroCovers(retro, ev, dir) {
  if (retro.mergeCommit && ev.sha && dir) {
    return git(dir, ['merge-base', '--is-ancestor', '--end-of-options', ev.sha, retro.mergeCommit]).ok;
  }
  if (retro.shippedAt && ev.date) return ev.date <= String(retro.shippedAt).slice(0, 10);
  return !retro.mergeCommit && !retro.shippedAt;
}

// The whole comparison. `epics` (a Set) limits it to those epics, and then only the repos their stories
// name are read. Returns { repos, unreadEpics, findings }:
//   repos:  [{ repo, read, why? | ref, sha, note? }]
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

  const registry = readJSON(path.join(root, PROJECT_FILES.reposRegistry), null);
  const wanted = epics ? new Set(stories.flatMap((s) => s.repos)) : null;
  const repos = (Array.isArray(registry?.repos) ? registry.repos : []).filter((r) => r && typeof r.name === 'string' && (!wanted || wanted.has(r.name)));
  const read = new Map();
  const reposOut = [];
  for (const repo of repos) {
    const m = readRepoMerges(root, repo);
    const note = m.read && platform ? addPlatformMerges(repo, m, { runner, env, authCache }) : null;
    read.set(repo.name, m);
    reposOut.push({ repo: repo.name, read: m.read, ...(m.read ? { ref: m.ref, sha: m.sha } : { why: m.why }), ...(note ? { note } : {}) });
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
          fix = `if ${s.story} predates ledger tracking: yad checkpoint --retro-ship ${s.epic}/${s.story} --repo ${repoName} --task ${t}${ev.sha ? ` --merge-commit ${ev.sha.slice(0, 12)}` : ''} (the story's status must be in-build or shipped first); otherwise ${engineer}`;
          suggested = true;
        }
        findings.push({ kind: 'merged-no-ship', epic: s.epic, story: s.story, task: t, repo: repoName, sha: ev.sha || null, pr: ev.pr ?? null, via: ev.via, fix });
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
  return { repos: reposOut, unreadEpics, findings };
}
