// Issue #365 — merged work the Product's build ledger does not record. When task MRs merge in the code
// repos, nothing writes the build-log ship or the story's `status: shipped` on its own (the
// yad-engineer-review skill does, by hand), and `yad reconcile check` could not see the gap. This reads
// what merged and compares it with the ledger. READ-ONLY: it reports, with the command that fixes each
// line where one exists; it never writes a ship (that is #346).
//
// What counts as merged, per repo the Product registers (.sdlc/repos.json):
//   - a `Task: EP-<slug>-S<n>-T<n>` trailer on a commit of the repo's default branch, in its clone here
//     (the branch as this clone last saw it — nothing is fetched);
//   - a merged PR/MR whose source branch names a task (`feat/EP-x-S01-T01-…`), when the platform answers:
//     a squash merge on GitLab keeps only the MR title, so the branch is where a squashed task still shows.
// A full story ID in a commit subject, or a short scope tag such as `feat(s06):`, is only a POSSIBLE match
// (the user's decision, 2026-10-17): it is listed to check by hand, never counted as a merge. A story ID
// in a commit body is not evidence at all ("depends on EP-x-S02" is not a merge of S02).
//
// Facts only: a commit SHA, a PR/MR number and the ID it carries — never a subject, a body or a branch name.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJSON, exists, forTerminal } from './lib.mjs';
import { PROJECT_FILES, TASK_ID_RE, TASK_TRAILER } from './manifest.mjs';
import { taskFromBranch } from './commit.mjs';
import { epicIds, epicRoot, readFrontmatter } from './epic-state.mjs';
import { readShips } from './ledger.mjs';
import { listMergedBranches } from './pr-list.mjs';

const STORY_IN_TEXT = /\bEP-[a-z0-9-]+-S\d+\b(?!-T\d)/g;
const SHORT_TAG = /^[a-z]+\(\s*(s\d+)\s*\)!?:/i;
const storyOf = (task) => task.replace(/-T\d+$/, '');

// git, raw: `run()` trims its output, and these records are split on NUL and unit separators.
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
};

// The default branch of one clone: origin's copy when the clone has one, else the local branch.
function defaultRef(dir, branch) {
  for (const ref of branch ? [`origin/${branch}`, branch] : []) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) return ref;
  }
  return null;
}

// One repo's merged work, read from its clone. `{ read: true, ref, sha, tasks: Map(task -> sha), possible }`
// or `{ read: false, why }` — a repo that cannot be read says so, and is never "nothing merged".
export function readRepoMerges(root, repo) {
  const name = repo?.name;
  if (typeof repo?.path !== 'string' || !repo.path) return { read: false, why: 'no path in repos.json' };
  const dir = path.resolve(root, repo.path);
  if (!exists(dir)) return { read: false, why: 'not cloned here (`yad repo clone`)' };
  if (!git(dir, ['rev-parse', '--git-dir']).ok) return { read: false, why: 'not a git repo' };
  const ref = defaultRef(dir, repo.default_branch);
  if (!ref) return { read: false, why: repo.default_branch ? `no branch ${forTerminal(repo.default_branch)} in the clone` : 'no default_branch in repos.json' };
  // One record per commit: SHA, subject, Task trailer values — fields split by 0x1f, records by NUL.
  const log = git(dir, ['log', '-z', `--format=%H%x1f%s%x1f%(trailers:key=${TASK_TRAILER},valueonly,separator=%x1e)`, ref]);
  if (!log.ok) return { read: false, why: `git could not read ${forTerminal(ref)}` };
  const tasks = new Map();
  const possible = [];
  for (const rec of log.out.split('\0')) {
    if (!rec.trim()) continue;
    const [sha, subject = '', trailers = ''] = rec.replace(/^\n/, '').split('\x1f');
    let hadTask = false;
    for (const v of trailers.split('\x1e').map((s) => s.trim())) {
      if (!TASK_ID_RE.test(v)) continue;
      hadTask = true;
      if (!tasks.has(v)) tasks.set(v, { sha, via: 'trailer' });
    }
    // yad's branch names in a merge commit's subject ("Merge branch 'feat/EP-x-S01-T01-…'") name a task too.
    const branchTask = /^Merge (?:branch|pull request)/.test(subject) ? taskFromBranch((subject.match(/'([^']+)'|from \S+\/(\S+)/) || []).slice(1).find(Boolean) || '') : null;
    if (branchTask && TASK_ID_RE.test(branchTask)) {
      hadTask = true;
      if (!tasks.has(branchTask)) tasks.set(branchTask, { sha, via: 'merge commit' });
    }
    if (hadTask) continue;
    for (const id of subject.match(STORY_IN_TEXT) || []) possible.push({ sha, story: id, via: 'story ID in the subject' });
    const tag = subject.match(SHORT_TAG);
    // `s06` and `s6` name the same story number; stories are keyed by the number itself.
    if (tag) possible.push({ sha, tag: `s${Number(tag[1].slice(1))}`, via: `short tag ${tag[1].toLowerCase()}` });
  }
  const sha = git(dir, ['rev-parse', '--verify', '--quiet', ref]).out.trim();
  return { read: true, name, ref, sha, tasks, possible };
}

// The merged task branches the platform knows of, when it answers. Adds to `tasks` (by PR/MR), never
// replaces a commit already found. Returns a note when the platform did not answer, or answered in part.
function addPlatformMerges(repo, merges, { runner, env, authCache }) {
  const t = { platform: repo.platform || null, gitUrl: repo.git_url || '' };
  const r = listMergedBranches(t, { ...(runner ? { runner } : {}), env, authCache });
  if (!r.ok) return `platform not read — ${r.why}`;
  for (const m of r.merged) {
    const task = m.branch ? taskFromBranch(m.branch) : null;
    if (!task || !TASK_ID_RE.test(task)) continue;
    if (!merges.tasks.has(task)) merges.tasks.set(task, { sha: m.commit, pr: m.number, via: 'merged branch' });
  }
  return r.partial ? 'the platform listed only its most recent merged PRs/MRs — older ones may be missing' : null;
}

// The whole comparison. Returns { repos: [{ repo, read, why?, ref?, sha?, note? }], findings: [...] }.
//   finding.kind: 'merged-no-ship' { epic, story, task, repo, sha, pr, fix }
//                 'looks-shipped'   { epic, story, status, repos }
//                 'possible'        { repo, sha, token, stories }
export function shipDrift(root, { platform = true, runner, env = process.env, authCache = new Map() } = {}) {
  const registry = readJSON(path.join(root, PROJECT_FILES.reposRegistry), null);
  const repos = Array.isArray(registry?.repos) ? registry.repos.filter((r) => r && typeof r.name === 'string') : [];
  const read = new Map();
  const reposOut = [];
  for (const repo of repos) {
    const m = readRepoMerges(root, repo);
    let note = null;
    if (m.read && platform) note = addPlatformMerges(repo, m, { runner, env, authCache });
    read.set(repo.name, m);
    reposOut.push({ repo: repo.name, read: m.read, ...(m.read ? { ref: m.ref, sha: m.sha } : { why: m.why }), ...(note ? { note } : {}) });
  }

  const findings = [];
  const storiesByNumber = new Map(); // `s06` -> stories numbered 6, for the short-tag hint
  for (const epic of epicIds(root)) {
    const dir = path.join(epicRoot(root, epic), 'stories');
    if (!exists(dir)) continue;
    let ships;
    try { ships = readShips(epicRoot(root, epic)); } catch { continue; } // a broken ledger is doctor's to report
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const fm = readFrontmatter(path.join(dir, f));
      const story = typeof fm.id === 'string' && fm.id ? fm.id : f.replace(/\.md$/, '');
      if (!new RegExp(`^${epic}-S\\d+$`).test(story)) continue;
      const num = `s${Number(story.match(/-S(\d+)$/)[1])}`;
      if (!storiesByNumber.has(num)) storiesByNumber.set(num, []);
      const storyRepos = Array.isArray(fm.repos) ? fm.repos : fm.repos ? [fm.repos] : [];
      storiesByNumber.get(num).push({ story, repos: storyRepos });
      let everyRepoHasWork = storyRepos.length > 0;
      for (const repoName of storyRepos) {
        const m = read.get(repoName);
        const recorded = ships.filter((s) => s.story === story && s.repo === repoName);
        const merged = m?.read ? [...m.tasks].filter(([task]) => storyOf(task) === story) : [];
        if (!recorded.length && !merged.length) everyRepoHasWork = false;
        if (recorded.some((s) => s.retroactive)) continue; // a retro ship stands for the whole story here
        for (const [task, ev] of merged) {
          const t = task.slice(story.length + 1);
          if (recorded.some((s) => s.task === t)) continue;
          // The one command that records a ship today refuses once ANY ship exists for (story, repo).
          const fix = recorded.length
            ? 'record the ship as yad-engineer-review does (a command for it is #346)'
            : `yad checkpoint --retro-ship ${epic}/${story} --repo ${repoName} --task ${t}${ev.sha ? ` --merge-commit ${ev.sha.slice(0, 12)}` : ''}`;
          findings.push({ kind: 'merged-no-ship', epic, story, task: t, repo: repoName, sha: ev.sha || null, pr: ev.pr ?? null, via: ev.via, fix });
        }
      }
      const status = typeof fm.status === 'string' ? fm.status : '';
      if (everyRepoHasWork && status !== 'shipped') findings.push({ kind: 'looks-shipped', epic, story, status: status || null, repos: storyRepos });
    }
  }
  // Possible matches: a short tag names a story number, not an epic, so every story with that number in an
  // epic that names the repo is a candidate.
  for (const [repoName, m] of read) {
    if (!m.read) continue;
    for (const p of m.possible) {
      const stories = p.story ? [p.story] : (storiesByNumber.get(p.tag) || []).filter((s) => s.repos.includes(repoName)).map((s) => s.story);
      if (!stories.length) continue;
      findings.push({ kind: 'possible', repo: repoName, sha: p.sha, token: p.story || p.tag, via: p.via, stories });
    }
  }
  return { repos: reposOut, findings };
}
