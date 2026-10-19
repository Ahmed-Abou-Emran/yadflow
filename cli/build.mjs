// `yad build start|step|trust|ship|done` (issue #346) — one command per Build record, so the records are
// written in the shape every reader expects instead of by hand. The user's decisions (2026-10-19):
//   - one family, `yad build …`, named after the Build phase the records belong to;
//   - `build ship` reads the merge commit, checks and approvers from the MERGED PR/MR on the platform (as
//     `yad review reconcile` does), and refuses one that is not merged; flags fill in with no platform;
//   - `build done` makes the three "shipped" signals agree — the story's `status:` line, the ship records
//     and every lane step `done` — so `yad next`, the epic seal and `yad tidy up` all read the same answer.
//
// The records and their readers are unchanged: the commands write exactly what the skills wrote by hand
// (skills/yad-epic/references/state-schema.md, skills/yad-engineer-review/references/ship-and-record.md).
// They write; `yad checkpoint --push` commits, as before.
//
// The rules are the PURE planners below (`planStart`, `planStep`, `trustEntry`, `planDone`); the commands
// read the files, call them, and write.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ok, info, hand, warn, run, readJSON, readJSONStrict, writeJSON, isPlainObject, exists } from './lib.mjs';
import { epicRoot, epicRel, epicStories, loadLedger, stepStatus, laneStarted, isPassed } from './epic-state.mjs';
import { DEFAULT_LIFECYCLE, laneOrder, laneAuthorSteps } from './lifecycle.mjs';
import { epicFiles, PROJECT_FILES } from './manifest.mjs';
import { err } from './errors.mjs';
import { readShips, readTrustRuns, writeShip, writeTrustRun, updateTrustRun } from './ledger.mjs';
import { setBuildStatus } from './artifact-status.mjs';
import { readPr, mapApprovers, detectPlatform, cliFor, platformReady } from './platform.mjs';
import { taskFromBranch } from './commit.mjs';
import { recordActor } from './skip.mjs';
import { sealedEpic } from './thread.mjs';

const CODE = 'YAD-STATE-009';
const STORY_RE = /^EP-[a-z0-9-]+-S\d+$/;
const TASK_RE = /^T\d+$/;
export const VERDICTS = ['approved-unchanged', 'approved-with-edits', 'rejected'];
// The signals each step's trust entry may carry (state-schema.md, "Per-step signals fields").
export const STEP_SIGNALS = {
  spec: ['human_edited_spec'],
  tasks: ['task_rescoped'],
  implement: ['human_edited_diff', 'scope_overrun', 'contract_touch'],
  checks: ['checks'],
};
// The states `build step` moves a step to. `done` closes it; `blocked` halts the lane with a record.
export const STEP_MOVES = ['in_progress', 'in_review', 'done', 'blocked'];

const LANE = laneOrder(DEFAULT_LIFECYCLE);
const AUTHOR = new Set(laneAuthorSteps(DEFAULT_LIFECYCLE));
const REVIEW_STEP = LANE.find((id) => !AUTHOR.has(id)) || 'engineer-review';

export const storyEpic = (story) => String(story).replace(/-S\d+$/, '');

// A lane as `yad-run` seeds it: every step `todo`, every dial `human`, the review step locked.
export function newLane() {
  return {
    currentStep: LANE[0],
    steps: LANE.map((id) => ({ id, automation: 'human_approve', advance: 'human', locked: !AUTHOR.has(id), status: 'todo' })),
  };
}

// A build-state file this can read as a lane map, or a refusal — never overwritten when it cannot be read.
function lanes(bs, story) {
  if (bs == null) return { story, repos: {} };
  if (!isPlainObject(bs)) throw err(CODE, `build-state/${story}.json is not a JSON object`, 'fix the file by hand — nothing here overwrites content it cannot read');
  if ('repos' in bs && !isPlainObject(bs.repos)) throw err(CODE, `build-state/${story}.json has a \`repos\` that is not an object`, 'fix the file by hand — nothing here overwrites content it cannot read');
  return { ...bs, story: bs.story || story, repos: { ...(bs.repos || {}) } };
}

// PURE: add a repo's lane to a story's build-state. The same refusals as a lane skip (E39): the stories
// review passed, and the story declares the repo. A lane already there is left as it is.
export function planStart(buildState, { story, repo, declared = [], storiesPassed = false }) {
  if (!storiesPassed) throw err(CODE, `the stories review has not passed, so ${story} is not approved for Build yet`, 'pass the stories review first (yad gate)');
  if (!declared.includes(repo)) {
    throw err(CODE, `${story} does not declare ${repo}, so it has no lane there`, declared.length ? `its repos: ${declared.join(', ')} (names are case-sensitive)` : 'the story declares no repos at all');
  }
  const bs = lanes(buildState, story);
  const lane = bs.repos[repo];
  if (isPlainObject(lane) && lane.status === 'skipped' && !laneStarted(lane)) {
    throw err(CODE, `${story} / ${repo} is skipped`, `\`yad unskip ${storyEpic(story)} ${story} --repo ${repo}\` if the lane is owed after all`);
  }
  if (lane != null) return { buildState: bs, already: true };
  return { buildState: { ...bs, repos: { ...bs.repos, [repo]: newLane() } }, already: false };
}

// A lane to change, or a refusal naming what to run first.
function liveLane(bs, story, repo) {
  const lane = bs.repos[repo];
  if (lane == null) throw err(CODE, `${story} has no lane in ${repo} yet`, `\`yad build start ${story} --repo ${repo}\` makes it`);
  if (!isPlainObject(lane) || !Array.isArray(lane.steps)) {
    if (isPlainObject(lane) && lane.status === 'skipped') throw err(CODE, `${story} / ${repo} is skipped`, `\`yad unskip ${storyEpic(story)} ${story} --repo ${repo}\` if the lane is owed after all`);
    throw err(CODE, `${story} / ${repo} has no steps in build-state/${story}.json`, 'fix the file by hand — nothing here overwrites content it cannot read');
  }
  return lane;
}

// The lane's step now: `currentStep` when it is not done, else the first step not done.
const activeStep = (lane) => {
  const cur = lane.steps.find((s) => s?.id === lane.currentStep);
  return cur && !isPassed(cur) ? cur : lane.steps.find((s) => !isPassed(s)) || null;
};

// PURE: move one step of a lane. Only the lane's active step moves, so a lane is never walked out of order.
// `done` writes the closing record (E18) and moves `currentStep` on; `blocked` needs a reason, written as
// the step's record. The review step is closed by `build done`, which checks every task shipped first.
export function planStep(buildState, { story, repo, step, to, reason = null, by = null, date = null, via = 'human', run = null }) {
  if (!STEP_MOVES.includes(to)) throw err(CODE, `'${to}' is not a step state this sets`, `one of: ${STEP_MOVES.join(', ')}`);
  const bs = lanes(buildState, story);
  const lane = liveLane(bs, story, repo);
  const target = lane.steps.find((s) => s?.id === step);
  if (!target) throw err(CODE, `${story} / ${repo} has no step '${step}'`, `its steps: ${lane.steps.map((s) => s?.id).join(', ')}`);
  if (step === REVIEW_STEP && to === 'done') {
    throw err(CODE, `${REVIEW_STEP} is closed by \`yad build done ${story}\``, 'it checks that every task has a ship record first');
  }
  if (isPassed(target)) {
    if (to === 'done') return { buildState: bs, already: true };
    throw err(CODE, `${step} is already done in ${story} / ${repo}`, 'a closed step is not reopened here');
  }
  const active = activeStep(lane);
  if (active && active.id !== step) {
    throw err(CODE, `${story} / ${repo} is at ${active.id}, not ${step}`, `move ${active.id} first — the lane is walked in order`);
  }
  if (!['auto', 'human'].includes(via)) throw err(CODE, `--via must be auto or human (got '${via}')`, '--via human, unless the orchestrator advanced it on its own');
  const next = { ...target, status: to };
  delete next.record;
  if (to === 'blocked') {
    if (reason == null || reason === true || !String(reason).trim()) throw err(CODE, 'a halt needs a reason', `yad build step ${story} --repo ${repo} ${step} blocked --reason "<what a person must resolve>"`);
    next.record = { reason: String(reason).trim(), by, date };
  }
  if (to === 'done') next.closed = { by, date, via, ...(run ? { run } : {}) };
  const steps = lane.steps.map((s) => (s?.id === step ? next : s));
  let currentStep;
  if (to === 'done') {
    const i = LANE.indexOf(step);
    const after = steps.find((s, k) => !isPassed(s) && (LANE.indexOf(s?.id) > i || (LANE.indexOf(s?.id) === -1 && k > steps.indexOf(next))));
    currentStep = after ? after.id : step;
  } else currentStep = step;
  return { buildState: { ...bs, repos: { ...bs.repos, [repo]: { ...lane, currentStep, steps } } }, already: false };
}

// PURE: a trust entry, checked. `signals` is { name: value } from `--signal name=value`.
export function trustEntry({ story, repo, step, verdict, signals = {}, ranBy = 'human', note = null, date = null, lane = null, uid }) {
  if (!AUTHOR.has(step)) throw err(CODE, `'${step}' has no trust entry`, `trust is recorded for: ${[...AUTHOR].join(', ')}`);
  if (!VERDICTS.includes(verdict)) throw err(CODE, `'${verdict}' is not a verdict`, `one of: ${VERDICTS.join(', ')}`);
  if (!['machine', 'human'].includes(ranBy)) throw err(CODE, `--ran-by must be machine or human (got '${ranBy}')`, 'machine when the orchestrator advanced it, else human');
  const allowed = STEP_SIGNALS[step] || [];
  const out = {};
  for (const [k, raw] of Object.entries(signals)) {
    if (!allowed.includes(k)) throw err(CODE, `'${k}' is not a ${step} signal`, `${step} signals: ${allowed.join(', ')}`);
    const v = String(raw);
    if (k === 'checks') {
      if (!['pass', 'fail', 'n/a'].includes(v)) throw err(CODE, `checks=${v}: expected pass, fail or n/a`, '--signal checks=pass');
      out[k] = v;
    } else {
      if (!['true', 'false'].includes(v)) throw err(CODE, `${k}=${v}: expected true or false`, `--signal ${k}=true`);
      out[k] = v === 'true';
    }
  }
  const st = lane?.steps?.find((s) => s?.id === step);
  const advance = st?.advance === 'auto' || st?.automation === 'machine_advance' ? 'auto' : 'human';
  return {
    story, repo, step, uid,
    automation: advance === 'auto' ? 'machine_advance' : 'human_approve', advance,
    verdict, signals: out, ranBy, date,
    ...(note ? { note: String(note) } : {}),
  };
}

// The tasks a story owes in one repo: the ids in `specs/<story>/tasks.md` on the repo's default branch
// (merged, not the working tree — the rule the gates read by). Each task line starts with its id (`T01`).
export function parseTaskIds(text) {
  const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|\d+[.)]\s+)?\**(T\d+)\b/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// PURE: what `build done` finds. `owed` is { repo: [taskIds] | null } (null: tasks.md could not be read);
// `ships` the story's ships. A retroactive ship covers its whole repo.
export function planDone({ story, declared, skipped = [], owed, ships }) {
  const missing = [];
  const unreadable = [];
  for (const repo of declared) {
    if (skipped.includes(repo)) continue;
    const shipped = ships.filter((s) => s.story === story && s.repo === repo);
    if (shipped.some((s) => s.retroactive)) continue;
    const tasks = owed[repo];
    if (tasks == null) { unreadable.push(repo); continue; }
    if (!tasks.length) { unreadable.push(repo); continue; }
    for (const t of tasks) if (!shipped.some((s) => s.task === t)) missing.push(`${repo}/${t}`);
  }
  return { missing, unreadable, shipped: !missing.length && !unreadable.length };
}

// ---- the commands ----------------------------------------------------------------------------------

function storyContext(root, story) {
  if (!STORY_RE.test(String(story || ''))) throw err(CODE, `'${story}' is not a story id`, 'expected EP-<slug>-S<n>, such as EP-checkout-S01');
  const epic = storyEpic(story);
  const epicDir = epicRoot(root, epic);
  const ledger = loadLedger(epicDir);
  if (!ledger.state) throw err(CODE, `no epic state at ${epicRel(epic)}`, 'seed the epic first with yad-epic');
  const entry = epicStories(epicDir).find((s) => s.id === story);
  if (!entry) throw err(CODE, `no story ${story} under ${epicRel(epic)}/stories/`, 'check the story id');
  const review = ledger.state.steps.find((s) => s?.id === 'stories-review');
  const file = path.join(epicFiles(epicDir).buildStateDir, `${story}.json`);
  return {
    epic, epicDir, entry, file,
    storiesPassed: ['done', 'satisfied'].includes(stepStatus(review)),
    buildState: readJSONStrict(file, null),
    storyFile: path.join(epicDir, 'stories', `${story}.md`),
  };
}

const rel = (root, p) => path.relative(root, p);
const repoArg = (repo, usage) => { if (!repo || repo === true) throw err(CODE, '--repo <name> is required', usage); return repo; };

export async function buildStart(root, { story, repo, today } = {}) {
  repoArg(repo, `yad build start ${story || '<story>'} --repo <name>`);
  const ctx = storyContext(root, story);
  const { buildState, already } = planStart(ctx.buildState, { story, repo, declared: ctx.entry.repos, storiesPassed: ctx.storiesPassed });
  if (already) {
    ok(`${story} / ${repo} already has a lane — nothing changed`);
    return { story, repo, changed: false, file: rel(root, ctx.file) };
  }
  writeJSON(ctx.file, buildState);
  ok(`${story} / ${repo} lane started at ${buildState.repos[repo].currentStep}${today ? ` on ${today}` : ''}`);
  hand(`yad next ${ctx.epic} shows it; commit with \`yad checkpoint --push\``);
  return { story, repo, changed: true, lane: buildState.repos[repo], file: rel(root, ctx.file) };
}

export async function buildStep(root, { story, repo, step, to, reason, via = 'human', run: runUid = null, today } = {}) {
  repoArg(repo, `yad build step ${story || '<story>'} --repo <name> <step> ${STEP_MOVES.join('|')}`);
  if (!step || !to) throw err(CODE, 'a step and the state to move it to are required', `yad build step ${story} --repo ${repo} <step> ${STEP_MOVES.join('|')}`);
  const ctx = storyContext(root, story);
  // A run named must be a run of this step in this lane: the closing record points at the evidence.
  if (runUid && runUid !== true) {
    const known = readTrustRuns(ctx.epicDir).some((r) => r.uid === runUid && r.story === story && r.repo === repo && r.step === step);
    if (!known) throw err(CODE, `no trust run ${runUid} for ${story} / ${repo} / ${step}`, `\`yad build trust ${story} --repo ${repo} ${step} --verdict …\` prints the uid of the run it records`);
  }
  const { buildState, already } = planStep(ctx.buildState, {
    story, repo, step, to, reason, by: recordActor(root), date: today, via, run: runUid === true ? null : runUid,
  });
  if (already) {
    ok(`${step} is already done in ${story} / ${repo} — nothing changed`);
    return { story, repo, step, status: 'done', changed: false };
  }
  writeJSON(ctx.file, buildState);
  const lane = buildState.repos[repo];
  ok(`${story} / ${repo}: ${step} is ${to}${to === 'blocked' ? ` — ${String(reason).trim()}` : ''}`);
  if (to === 'done') info(`next: ${lane.currentStep}`);
  hand('commit with `yad checkpoint --push`');
  return { story, repo, step, status: to, currentStep: lane.currentStep, changed: true };
}

export async function buildTrust(root, { story, repo, step, verdict, signals = {}, ranBy = 'human', note = null, uid = null, today } = {}) {
  repoArg(repo, `yad build trust ${story || '<story>'} --repo <name> <step> --verdict <${VERDICTS.join('|')}>`);
  if (!step) throw err(CODE, 'a step is required', `yad build trust ${story} --repo ${repo} <step> --verdict <v>`);
  if (!verdict || verdict === true) throw err(CODE, '--verdict is required', `one of: ${VERDICTS.join(', ')}`);
  const ctx = storyContext(root, story);
  // Finalizing a run that was already recorded: the human gate confirms or overrides the provisional verdict.
  if (uid && uid !== true) {
    if (!VERDICTS.includes(verdict)) throw err(CODE, `'${verdict}' is not a verdict`, `one of: ${VERDICTS.join(', ')}`);
    const res = updateTrustRun(ctx.epicDir, (r) => r.uid === uid && r.story === story && r.repo === repo && r.step === step, (r) => {
      r.verdict = verdict;
      if (note) r.note = String(note);
    });
    if (!res.found) throw err(CODE, `no trust run ${uid} for ${story} / ${repo} / ${step}`, 'the uid is the one `yad build trust` printed when it recorded the run');
    ok(`trust run ${uid} (${story} / ${repo} / ${step}) is now ${verdict}`);
    hand('commit with `yad checkpoint --push`');
    return { story, repo, step, uid, verdict, changed: true, finalized: true };
  }
  const bs = lanes(ctx.buildState, story);
  const lane = liveLane(bs, story, repo);
  const entry = trustEntry({ story, repo, step, verdict, signals, ranBy, note, date: today, lane, uid: randomBytes(4).toString('hex') });
  const res = writeTrustRun(ctx.epicDir, entry);
  if (!res.written) throw err(CODE, `a trust run named ${path.basename(res.file)} is already there`, 'run it again: a new uid is drawn each time');
  ok(`trust run ${entry.uid} recorded: ${story} / ${repo} / ${step} — ${verdict}`);
  info(`close the step with it: yad build step ${story} --repo ${repo} ${step} done --run ${entry.uid}`);
  hand('commit with `yad checkpoint --push`');
  return { story, repo, step, uid: entry.uid, verdict, changed: true, file: rel(root, res.file) };
}

// The registered repo's checkout, platform and default branch.
function registeredRepo(root, repo) {
  const reg = readJSON(path.join(root, PROJECT_FILES.reposRegistry), { repos: [] });
  const meta = (reg.repos || []).find((r) => r?.name === repo) || null;
  const product = readJSON(path.join(root, PROJECT_FILES.productConfig), null) || readJSON(path.join(root, '.sdlc/hub.json'), null) || {};
  const dir = meta?.path ? path.resolve(root, meta.path) : null;
  const checkout = dir && exists(path.join(dir, '.git')) ? dir : null;
  const remote = checkout ? run('git', ['remote', 'get-url', 'origin'], { cwd: checkout }).stdout : '';
  return { meta, checkout, platform: meta?.platform || detectPlatform(remote) || product.platform || null, defaultBranch: meta?.default_branch || null };
}

// The merged PR/MR's facts the ship record holds. `runner` is injectable for tests.
export function readMergedPr(platform, n, { cwd, runner = run } = {}) {
  if (platform === 'gitlab') {
    const r = runner('glab', ['api', `projects/:id/merge_requests/${n}`], { cwd });
    if (!r.ok) return { ok: false, reason: r.stderr || 'glab api merge_requests failed' };
    let mr; try { mr = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'unreadable glab answer' }; }
    const p = runner('glab', ['api', `projects/:id/merge_requests/${n}/pipelines`], { cwd });
    let checks = [];
    if (p.ok) { try { const rows = JSON.parse(p.stdout); if (Array.isArray(rows) && rows[0]?.status === 'success') checks = ['pipeline']; } catch { /* none */ } }
    return {
      ok: true, merged: mr.state === 'merged', mergeCommit: mr.merge_commit_sha || mr.squash_commit_sha || null,
      mergedAt: mr.merged_at || null, branch: mr.source_branch || null, url: mr.web_url || null, body: mr.description || '', checks,
    };
  }
  const r = runner('gh', ['pr', 'view', String(n), '--json', 'state,mergedAt,mergeCommit,headRefName,url,body,statusCheckRollup'], { cwd });
  if (!r.ok) return { ok: false, reason: r.stderr || 'gh pr view failed' };
  let pr; try { pr = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'unreadable gh answer' }; }
  // The gates that passed on the merged head: a check run's name, or a status context's.
  const checks = [...new Set((pr.statusCheckRollup || [])
    .filter((c) => (c.conclusion || c.state || '').toUpperCase() === 'SUCCESS')
    .map((c) => c.name || c.context).filter(Boolean))].sort();
  return {
    ok: true, merged: pr.state === 'MERGED', mergeCommit: pr.mergeCommit?.oid || null, mergedAt: pr.mergedAt || null,
    branch: pr.headRefName || null, url: pr.url || null, body: pr.body || '', checks,
  };
}

const riskFromBody = (body) => (String(body).match(/^\s*Risk level:\s*(low|medium|high)\b/im) || [])[1]?.toLowerCase() || null;

export async function buildShip(root, { story, task, repo, pr, mergeCommit = null, approvers = [], today, runner = run, prReader = readPr } = {}) {
  repoArg(repo, `yad build ship ${story || '<story>'} --task <T01> --repo <name> --pr <n>`);
  if (!TASK_RE.test(String(task || ''))) throw err(CODE, `--task must be a task id such as T01 (got '${task ?? ''}')`, `yad build ship ${story} --task T01 --repo ${repo} --pr <n>`);
  const ctx = storyContext(root, story);
  if (!ctx.entry.repos.includes(repo)) throw err(CODE, `${story} does not declare ${repo}`, `its repos: ${ctx.entry.repos.join(', ') || 'none'}`);
  const lane = lanes(ctx.buildState, story).repos[repo];
  if (isPlainObject(lane) && lane.status === 'skipped' && !laneStarted(lane)) {
    throw err(CODE, `${story} / ${repo} is skipped`, `\`yad unskip ${ctx.epic} ${story} --repo ${repo}\` before recording a ship there`);
  }
  const where = registeredRepo(root, repo);
  let ship;
  const usable = where.platform && (runner !== run || platformReady(where.platform));
  if (usable && (!pr || pr === true)) throw err(CODE, '--pr <n> is required', `the merged PR/MR the ship is read from: yad build ship ${story} --task ${task} --repo ${repo} --pr <n>`);
  if (usable) {
    const got = readMergedPr(where.platform, pr, { cwd: where.checkout || root, runner });
    if (!got.ok) throw err(CODE, `could not read PR #${pr} in ${repo}: ${got.reason}`, `log in with \`${cliFor(where.platform)} auth login\`, or pass --merge-commit <sha> and --approver <login>`);
    if (!got.merged) throw err(CODE, `PR #${pr} in ${repo} is not merged`, 'a ship is recorded once the PR/MR merges');
    // The PR's branch names the task it carries (`feat/EP-x-S01-T01-…`): the ship is never put on another.
    const named = taskFromBranch(got.branch || '');
    if (named && named !== `${story}-${task}`) throw err(CODE, `PR #${pr} is from ${got.branch}, which is ${named}, not ${story}-${task}`, 'check --task and --pr');
    const pull = prReader(where.platform, pr, { cwd: where.checkout || root, runner });
    const seen = new Set();
    const engineerReview = [];
    for (const a of pull.ok ? mapApprovers(pull.reviews, { headOid: pull.headOid }) : []) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      engineerReview.push({ approver: a.name, engagement: a.engagement === 'verified' ? 'verified' : 'none' });
    }
    if (!pull.ok) warn(`could not read the approvals of PR #${pr} (${pull.reason}) — engineer_review is left empty; \`yad review reconcile\` fills it later`);
    ship = {
      story, task, repo, branch: got.branch, pr: got.url || `#${pr}`, mergeCommit: got.mergeCommit, gates: got.checks,
      ai_review: null, engineer_review: engineerReview,
      companion: { trailer: /<!--\s*yad:trailer\s*-->/.test(got.body), cards: false, chat: false },
      risk: riskFromBody(got.body), shippedAt: (got.mergedAt || '').slice(0, 10) || today,
    };
  } else {
    // No platform to ask: the person says what merged.
    if (!mergeCommit || mergeCommit === true) {
      throw err(CODE, where.platform ? `${cliFor(where.platform)} is not available to read the PR` : `${repo} has no platform to read the PR from`, '--merge-commit <sha> (and --approver <login> for each approver) records it by hand');
    }
    ship = {
      story, task, repo, branch: null, pr: pr && pr !== true ? `#${pr}` : 'local', mergeCommit, gates: [],
      ai_review: null, engineer_review: approvers.map((a) => ({ approver: a, engagement: 'none' })),
      companion: { trailer: false, cards: false, chat: false }, risk: null, shippedAt: today,
    };
  }
  const res = writeShip(ctx.epicDir, ship);
  if (!res.written) {
    if (res.reason === 'exists') throw err(CODE, `${story} / ${task} already has a ship in ${repo}`, 'one ship per task and repo');
    throw err(CODE, `${repo} shares a ship file name with ${res.repo || 'another repo'}`, 'repo names that differ only in punctuation cannot both ship this task');
  }
  // The story is in Build now (the skill's rule); `build done` sets it shipped once every task is.
  const was = setBuildStatus(ctx.storyFile, 'in-build');
  ok(`ship recorded: ${story} / ${task} in ${repo}${ship.mergeCommit ? ` (${String(ship.mergeCommit).slice(0, 12)})` : ''}`);
  if (was) info(`${story} is now in-build`);
  hand(`when every task has shipped: yad build done ${story}; commit with \`yad checkpoint --push\``);
  return { story, task, repo, changed: true, ship, file: rel(root, res.file) };
}

export async function buildDone(root, { story, today, fetch = true } = {}) {
  const ctx = storyContext(root, story);
  const bs = lanes(ctx.buildState, story);
  const skipped = ctx.entry.repos.filter((r) => isPlainObject(bs.repos[r]) && bs.repos[r].status === 'skipped' && !laneStarted(bs.repos[r]));
  const ships = readShips(ctx.epicDir).filter((s) => s.story === story);
  // What each repo owes: its tasks.md on the repo's default branch, fetched first.
  const owed = {};
  const why = {};
  for (const repo of ctx.entry.repos) {
    if (skipped.includes(repo)) continue;
    const where = registeredRepo(root, repo);
    if (!where.checkout) { owed[repo] = null; why[repo] = 'not checked out here (`yad repo clone` fetches it)'; continue; }
    const head = run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: where.checkout }).stdout;
    const branch = where.defaultBranch || (head.startsWith('origin/') ? head.slice(7) : 'main');
    if (fetch) run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: where.checkout });
    const shown = run('git', ['show', `refs/remotes/origin/${branch}:specs/${story}/tasks.md`], { cwd: where.checkout });
    if (!shown.ok) { owed[repo] = null; why[repo] = `no specs/${story}/tasks.md on origin/${branch}`; continue; }
    owed[repo] = parseTaskIds(shown.stdout);
    if (!owed[repo].length) why[repo] = `specs/${story}/tasks.md on origin/${branch} names no task (T01, T02, …)`;
  }
  const plan = planDone({ story, declared: ctx.entry.repos, skipped, owed, ships });
  if (!plan.shipped) {
    for (const r of plan.unreadable) warn(`${r}: ${why[r]} — the tasks it owes cannot be read`);
    if (plan.missing.length) warn(`no ship yet for: ${plan.missing.join(', ')}`);
    throw err(CODE, `${story} is not shipped yet`, plan.missing.length ? `record each with \`yad build ship ${story} --task <T> --repo <r> --pr <n>\`` : 'make each repo\'s tasks.md readable on its default branch, then run this again');
  }
  // Every owed repo has a lane, and every lane's earlier steps are done: `yad next` reads a repo with no
  // lane as still owed, so a story marked shipped without one would read shipped in one place and in-build
  // in another. A pre-tracking story (shipped before the Build ledger) takes `yad checkpoint --retro-ship`.
  const noLane = ctx.entry.repos.filter((r) => !skipped.includes(r) && !(isPlainObject(bs.repos[r]) && Array.isArray(bs.repos[r].steps)));
  if (noLane.length) {
    throw err(CODE, `${story} has no lane in ${noLane.join(', ')}, so \`yad next\` would still read it in Build`,
      `\`yad build start ${story} --repo <r>\` and close its steps with \`yad build step\`; a story shipped before the Build ledger existed is recorded with \`yad checkpoint --retro-ship\` instead`);
  }
  const open = [];
  for (const repo of ctx.entry.repos.filter((r) => !skipped.includes(r))) {
    const lane = bs.repos[repo];
    for (const s of lane.steps) if (s?.id !== REVIEW_STEP && !isPassed(s)) open.push(`${repo}/${s.id}`);
  }
  if (open.length) {
    throw err(CODE, `${story} has every task shipped, but these lane steps are still open: ${open.join(', ')}`, `close each with \`yad build step ${story} --repo <r> <step> done\`, then run this again`);
  }
  const by = recordActor(root);
  let changedLanes = 0;
  for (const repo of ctx.entry.repos.filter((r) => !skipped.includes(r))) {
    const lane = bs.repos[repo];
    const steps = lane.steps.map((s) => (s?.id === REVIEW_STEP && !isPassed(s) ? (changedLanes++, { ...s, status: 'done', closed: { by, date: today, via: 'human' } }) : s));
    bs.repos[repo] = { ...lane, currentStep: REVIEW_STEP, steps };
  }
  if (changedLanes) writeJSON(ctx.file, bs);
  const before = setBuildStatus(ctx.storyFile, 'shipped');
  ok(`${story} is shipped${changedLanes ? ` — ${REVIEW_STEP} closed in ${changedLanes} lane${changedLanes > 1 ? 's' : ''}` : ''}`);
  if (sealedEpic(root, ctx.epic)) info(`${ctx.epic} is now sealed: every story shipped — new work there needs a change epic (yad-change)`);
  hand('commit with `yad checkpoint --push`');
  return { story, shipped: true, changed: changedLanes > 0 || before != null, lanesClosed: changedLanes };
}
