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
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ok, info, hand, warn, run, readJSON, readJSONStrict, writeJSON, isPlainObject, exists } from './lib.mjs';
import { epicRoot, epicRel, epicStories, loadLedger, stepStatus, laneStarted, isPassed, readFrontmatter, nextAction, loadAutomation, effectiveAdvance } from './epic-state.mjs';
import { DEFAULT_LIFECYCLE, laneOrder, laneAuthorSteps } from './lifecycle.mjs';
import { epicFiles, PROJECT_FILES } from './manifest.mjs';
import { err } from './errors.mjs';
import { readShips, readTrustRuns, writeShip, writeTrustRun, updateTrustRun } from './ledger.mjs';
import { setBuildStatus, readStoryStatus } from './artifact-status.mjs';
import { readPr, mapApprovers, detectPlatform, cliFor, platformReady } from './platform.mjs';
import { repoPathFromGitUrl } from './protection.mjs';
import { readCommit, tasksOfCommit, prOfCommit } from './ship-drift.mjs';
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
// The steps walked once per task (the user's decision, 2026-10-20): `implement` and every author step after
// it. A story's tasks each go through them in turn, so a later task reopens them.
export const PER_TASK = new Set(LANE.slice(LANE.indexOf('implement')).filter((id) => AUTHOR.has(id)));

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
export function planStep(buildState, { story, repo, step, to, reason = null, by = null, date = null, via = 'human', run = null, task = null, automation = null }) {
  if (task != null && !TASK_RE.test(String(task))) throw err(CODE, `--task must be a task id such as T02 (got '${task}')`, '--task T02');
  if (!STEP_MOVES.includes(to)) throw err(CODE, `'${to}' is not a step state this sets`, `one of: ${STEP_MOVES.join(', ')}`);
  const bs = lanes(buildState, story);
  const lane = liveLane(bs, story, repo);
  const target = lane.steps.find((s) => s?.id === step);
  if (!target) throw err(CODE, `${story} / ${repo} has no step '${step}'`, `its steps: ${lane.steps.map((s) => s?.id).join(', ')}`);
  if (step === REVIEW_STEP && to === 'done') {
    throw err(CODE, `${REVIEW_STEP} is closed by \`yad build done ${story}\``, 'it checks that every task has a ship record first');
  }
  const active = activeStep(lane);
  if (isPassed(target)) {
    // `done --task T02` on a step T01 closed is not "already done": T02 has not been through it.
    if (to === 'done' && task && target.closed?.task !== task) {
      if (!PER_TASK.has(step)) throw err(CODE, `--task does not apply to ${step}`, `${step} is walked once per story, not per task`);
      throw err(CODE, `${step} was closed ${target.closed?.task ? `for ${target.closed.task}` : 'for no task'}, not ${task}`, `reopen it for ${task} first: yad build step ${story} --repo ${repo} implement in_progress --task ${task}`);
    }
    if (to === 'done') return { buildState: bs, already: true };
    // The next task reopens the per-task steps — once the lane has walked them all for the task before
    // (it is at the review step) and the review is not closed. Each close stays in `runs`, by task.
    // The next task starts at implement: reopening checks alone would leave the task no implement run.
    const first = [...PER_TASK][0];
    const reopen = step === first && task && active?.id === REVIEW_STEP && stepStatus(active) !== 'blocked';
    if (!reopen) {
      const hint = !PER_TASK.has(step) ? 'a closed step is not reopened'
        : active?.id === REVIEW_STEP && stepStatus(active) === 'blocked' ? `clear the halt on ${REVIEW_STEP} first`
          : `the next task reopens ${first} once the lane is at ${REVIEW_STEP}: yad build step ${story} --repo ${repo} ${first} ${to} --task <T>`;
      throw err(CODE, `${step} is already done in ${story} / ${repo}`, hint);
    }
    const at = LANE.indexOf(step);
    const keep = (s) => {
      const n = { ...s };
      if (n.closed) {
        const prior = Array.isArray(n.runs) ? n.runs : [];
        n.runs = [...(n.closed.run ? prior.filter((r) => r?.run !== n.closed.run) : prior), n.closed];
      }
      delete n.closed;
      delete n.record;
      return n;
    };
    const steps = lane.steps.map((s) => {
      if (s?.id === step) {
        const n = { ...keep(s), status: to, task };
        if (to === 'blocked') {
          if (reason == null || reason === true || !String(reason).trim()) throw err(CODE, 'a halt needs a reason', `yad build step ${story} --repo ${repo} ${step} blocked --task ${task} --reason "<what a person must resolve>"`);
          n.record = { reason: String(reason).trim(), by, date };
        }
        return n;
      }
      // The per-task steps after it are owed again for this task.
      if (PER_TASK.has(s?.id) && LANE.indexOf(s.id) > at && isPassed(s)) return { ...keep(s), status: 'todo', task };
      return s;
    });
    return { buildState: { ...bs, repos: { ...bs.repos, [repo]: { ...lane, currentStep: step, steps } } }, already: false, reopened: task };
  }
  if (active && active.id !== step) {
    throw err(CODE, `${story} / ${repo} is at ${active.id}, not ${step}`, `move ${active.id} first — the lane is walked in order`);
  }
  if (!['auto', 'human'].includes(via)) throw err(CODE, `--via must be auto or human (got '${via}')`, '--via human, unless the orchestrator advanced it on its own');
  // The dial IN FORCE — the lane's own, held at human while the kill switch is on — not the lane's word alone.
  if (via === 'auto' && to === 'done' && effectiveAdvance(target, automation).advance !== 'auto') {
    const why = effectiveAdvance(target, automation).why;
    throw err(CODE, `${step} is not advancing on its own in ${story} / ${repo}${why === 'kill' ? ' (the kill switch is on)' : ''}, so it is not closed --via auto`,
      why === 'kill' ? '`yad unkill` turns the kill switch off' : `\`yad dial ${storyEpic(story)} ${story} --repo ${repo} ${step} --to auto\` sets the dial first`);
  }
  // A step reopened for a task closes for that task: `--task` defaults to it, and another is refused.
  if (task && target.task && task !== target.task) throw err(CODE, `${step} is open for ${target.task}, not ${task}`, `--task ${target.task}`);
  const forTask = task || target.task || null;
  const next = { ...target, status: to };
  delete next.record;
  if (to === 'blocked') {
    if (reason == null || reason === true || !String(reason).trim()) throw err(CODE, 'a halt needs a reason', `yad build step ${story} --repo ${repo} ${step} blocked --reason "<what a person must resolve>"`);
    next.record = { reason: String(reason).trim(), by, date };
  }
  if (to === 'done') {
    next.closed = { by, date, via, ...(run ? { run } : {}), ...(forTask ? { task: forTask } : {}) };
    delete next.task;
  }
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
export function trustEntry({ story, repo, step, verdict, signals = {}, ranBy = 'human', note = null, date = null, lane = null, uid, task = null, automation = null }) {
  if (task != null && !TASK_RE.test(String(task))) throw err(CODE, `--task must be a task id such as T02 (got '${task}')`, '--task T02');
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
  // The dial in force at run time: the lane's own, held at human while the kill switch is on.
  const advance = st ? effectiveAdvance(st, automation).advance : 'human';
  return {
    story, repo, step, uid,
    automation: advance === 'auto' ? 'machine_advance' : 'human_approve', advance,
    verdict, signals: out, ranBy, date,
    ...(task ? { task } : {}),
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

// The review step closed by `build done`: done, with its closing record, and no halt record left on it.
const closeReview = (s, { by, date }) => {
  const n = { ...s, status: 'done', closed: { by, date, via: 'human' } };
  delete n.record;
  return n;
};

// ---- the commands ----------------------------------------------------------------------------------

// The story's file, found the way `epicStories` finds the story: by its frontmatter `id`, else its name.
// One file, named for the story: `yad tidy` and the seal name a story by its file, so a file named other
// than its id would be shipped here and never folded there.
function storyFileOf(epicDir, story) {
  const dir = path.join(epicDir, 'stories');
  const claim = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
    .filter((f) => (readFrontmatter(path.join(dir, f)).id || f.replace(/\.md$/, '')) === story);
  if (!claim.length) throw err(CODE, `no story file for ${story}`, 'check the story id');
  if (claim.length > 1) throw err(CODE, `${claim.length} story files claim ${story}: ${claim.join(', ')}`, 'keep one');
  if (claim[0] !== `${story}.md`) throw err(CODE, `${story} is in stories/${claim[0]}, not stories/${story}.md`, `rename it to ${story}.md: yad tidy and the epic seal read a story by its file name`);
  return path.join(dir, claim[0]);
}

// The status a Build write moves the story from must be one it can place; refused before anything is
// written, so the lanes and the status line never part.
function storyStatusOk(ctx, story) {
  const st = readStoryStatus(ctx.storyFile);
  if (!['draft', 'in-review', 'approved', 'in-build', 'shipped'].includes(st)) {
    throw err(CODE, `${path.relative(ctx.epicDir, ctx.storyFile)} has status: ${st ?? '(none)'}, which a Build write cannot move on`, `set it to approved (\`yad sync-status ${storyEpic(story)}\` does), then run this again`);
  }
  return st;
}

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
    epic, epicDir, entry, file, ledger,
    storiesPassed: ['done', 'satisfied'].includes(stepStatus(review)),
    buildState: readJSONStrict(file, null),
    storyFile: storyFileOf(epicDir, story),
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

export async function buildStep(root, { story, repo, step, to, reason, via = 'human', run: runUid = null, task = null, today } = {}) {
  repoArg(repo, `yad build step ${story || '<story>'} --repo <name> <step> ${STEP_MOVES.join('|')}`);
  if (!step || !to) throw err(CODE, 'a step and the state to move it to are required', `yad build step ${story} --repo ${repo} <step> ${STEP_MOVES.join('|')}`);
  const ctx = storyContext(root, story);
  // A run named must be a run of this step in this lane, for the task the close is for, and not one an
  // earlier close already names: the closing record points at the evidence.
  if (runUid && runUid !== true) {
    const lane = lanes(ctx.buildState, story).repos[repo];
    const st = Array.isArray(lane?.steps) ? lane.steps.find((x) => x?.id === step) : null;
    const forTask = (task && task !== true ? task : null) || st?.task || null;
    const used = [st?.closed?.run, ...(Array.isArray(st?.runs) ? st.runs.map((x) => x?.run) : [])].filter(Boolean);
    // The same close sent again (an orchestrator resuming) is "already done", not a second close.
    const same = st && isPassed(st) && st.closed?.run === runUid && (!forTask || st.closed?.task === forTask);
    if (!same && used.includes(runUid)) throw err(CODE, `trust run ${runUid} already closed ${step} in ${story} / ${repo}`, 'each close names its own run: record this one with `yad build trust`');
    const known = readTrustRuns(ctx.epicDir).some((r) => r.uid === runUid && r.story === story && r.repo === repo && r.step === step
      && !(r.task && forTask && r.task !== forTask));
    if (!known) throw err(CODE, `no trust run ${runUid} for ${story} / ${repo} / ${step}`, `\`yad build trust ${story} --repo ${repo} ${step} --verdict …\` prints the uid of the run it records`);
  }
  // An automatic close names the run that earned it: without one, nothing shows the run was not rejected.
  if (to === 'done' && via === 'auto' && (!runUid || runUid === true)) {
    throw err(CODE, '--via auto needs --run <uid>, the trust run that advanced the step', `yad build trust ${story} --repo ${repo} ${step} --verdict … prints it`);
  }
  if (runUid && runUid !== true && to === 'done' && via === 'auto') {
    const r = readTrustRuns(ctx.epicDir).find((x) => x.uid === runUid && x.story === story && x.repo === repo && x.step === step);
    if (r?.verdict === 'rejected') throw err(CODE, `trust run ${runUid} is rejected, so ${step} does not advance on its own`, `halt instead: yad build step ${story} --repo ${repo} ${step} blocked --reason "<why>"`);
  }
  const { buildState, already, reopened } = planStep(ctx.buildState, {
    story, repo, step, to, reason, by: recordActor(root), date: today, via, run: runUid === true ? null : runUid, task: task === true ? null : task,
    automation: loadAutomation(root),
  });
  if (already) {
    ok(`${step} is already done in ${story} / ${repo} — nothing changed`);
    return { story, repo, step, status: 'done', changed: false };
  }
  writeJSON(ctx.file, buildState);
  const lane = buildState.repos[repo];
  ok(`${story} / ${repo}: ${step} is ${to}${reopened ? ` again, for ${reopened}` : ''}${to === 'blocked' ? ` — ${String(reason).trim()}` : ''}`);
  if (to === 'done') info(`next: ${lane.currentStep}`);
  hand('commit with `yad checkpoint --push`');
  return { story, repo, step, status: to, currentStep: lane.currentStep, changed: true };
}

export async function buildTrust(root, { story, repo, step, verdict, signals = {}, ranBy = 'human', note = null, uid = null, task = null, today } = {}) {
  repoArg(repo, `yad build trust ${story || '<story>'} --repo <name> <step> --verdict <${VERDICTS.join('|')}>`);
  if (!step) throw err(CODE, 'a step is required', `yad build trust ${story} --repo ${repo} <step> --verdict <v>`);
  if (!verdict || verdict === true) throw err(CODE, '--verdict is required', `one of: ${VERDICTS.join(', ')}`);
  const ctx = storyContext(root, story);
  // Finalizing a run that was already recorded: the human gate confirms or overrides the provisional verdict.
  if (uid && uid !== true) {
    if (Object.keys(signals).length) throw err(CODE, '--signal is not changed when finalizing a run', 'the signals are what the run saw; --uid sets only the verdict (and --note)');
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
  const entry = trustEntry({ story, repo, step, verdict, signals, ranBy, note, date: today, lane, uid: randomBytes(4).toString('hex'), task: task === true ? null : task, automation: loadAutomation(root) });
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
  // The folder must be the registered repo: a stale path to another clone would read that repo's PR #n.
  // Compared by the repo's path on its host (`team/api`), so a port, an SSH host alias, a token in the URL
  // or a trailing slash do not matter. Never printed as a URL: a remote can hold a token.
  if (checkout && meta?.git_url && remote) {
    const have = repoPathFromGitUrl(remote);
    const want = repoPathFromGitUrl(meta.git_url);
    if (!have !== !want) warn(`${repo}: could not compare the clone with its registered git_url — check ${meta.path} is ${want || 'the registered repo'}`);
    if (have && want && have.toLowerCase() !== want.toLowerCase()) throw err(CODE, `${meta.path} is a clone of ${have}, not ${want}`, `fix the path of ${repo} in .sdlc/repos.json, or clone it with \`yad repo clone ${repo}\``);
  }
  const named = typeof meta?.default_branch === 'string' && meta.default_branch ? meta.default_branch : null;
  if (named && (named.startsWith('-') || !run('git', ['check-ref-format', '--branch', named]).ok)) {
    throw err(CODE, `.sdlc/repos.json names a default_branch for ${repo} git cannot use: ${named}`, 'fix default_branch in .sdlc/repos.json');
  }
  return { meta, checkout, platform: meta?.platform || detectPlatform(remote) || product.platform || null, defaultBranch: named };
}

// A PR/MR's state in one vocabulary: open, merged or closed (closed without a merge). GitLab's `locked` is
// an MR mid-merge, so still open.
const ghState = (v) => ({ OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' })[v] || null;
const glState = (v) => ({ opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' })[v] || null;

// The merged PR/MR's facts the ship record holds. `runner` is injectable for tests.
export function readMergedPr(platform, n, { cwd, runner = run } = {}) {
  if (platform === 'gitlab') {
    const r = runner('glab', ['api', `projects/:id/merge_requests/${n}`], { cwd });
    if (!r.ok) return { ok: false, reason: r.stderr || 'glab api merge_requests failed' };
    let mr; try { mr = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'unreadable glab answer' }; }
    // The gates that passed: the job names of the MR's head pipeline that succeeded.
    // One page of up to 100 jobs; jobs of a child or downstream pipeline are not listed here.
    let checks = [];
    let checksRead = false;
    const pid = mr.head_pipeline?.id;
    if (pid) {
      const j = runner('glab', ['api', `projects/:id/pipelines/${pid}/jobs?per_page=100`], { cwd });
      if (j.ok) { try { checks = [...new Set((JSON.parse(j.stdout) || []).filter((x) => x?.status === 'success').map((x) => x.name).filter(Boolean))].sort(); checksRead = true; } catch { /* unreadable */ } }
    }
    return {
      // A fast-forward merge has no merge commit: the MR's head is what landed.
      ok: true, state: glState(mr.state), merged: mr.state === 'merged', mergeCommit: mr.merge_commit_sha || mr.squash_commit_sha || (mr.state === 'merged' ? mr.sha : null) || null, checksRead,
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
    ok: true, state: ghState(pr.state), merged: pr.state === 'MERGED', mergeCommit: pr.mergeCommit?.oid || null, mergedAt: pr.mergedAt || null, checksRead: true,
    branch: pr.headRefName || null, url: pr.url || null, body: pr.body || '', checks,
  };
}

// The task ids a branch names, lower-case: `feat/EP-auth-S01-T02-2fa-setup` → ['ep-auth-s01-t02'], under any
// folders, in any case. Each id is the shortest one from a folder or `_` boundary that ends at a word
// boundary, so a slug after the task (`-2fa-setup`, `-then-S02-T03`) is never read as part of it, and
// `T012` is not `T01`.
export function tasksInBranch(branch) {
  return [...String(branch || '').matchAll(/(?:^|[/_])(ep-[a-z0-9-]+?-s\d+-t\d+)(?=$|[-_/])/gi)].map((m) => m[1].toLowerCase());
}

// Which task a PR's branch carries, for `story`-`task`: 'this' (it names this task), 'other' (it names
// another) or 'none'. The expected id first: an epic slug may itself read like a task (`EP-aws-s3-t2-backup`).
export function branchTask(branch, story, task) {
  const esc = `${story}-${task}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[/_])${esc}(?=$|[-_/])`, 'i').test(branch || '')) return 'this';
  return tasksInBranch(branch).length ? 'other' : 'none';
}

// A commit in the repo's own checkout: it exists and is on the default branch (origin's, fetched first
// unless --no-fetch; the local one when there is no origin). `strict` (a ship read with the platform's help)
// also asks that it names the task, by the rules `yad reconcile check` reads every commit with — a `Task:`
// trailer, a task branch a merge brought in, or the full id in the subject. By hand, where the platform
// cannot be read, the person vouches for it: it may not name a DIFFERENT task, and naming none is a warning.
function checkCommit(where, { story, task, repo, mergeCommit, strict = true, fetch = true, noTask = 'recorded as you say it ships' }) {
  const cwd = where.checkout;
  const hasOrigin = run('git', ['remote', 'get-url', 'origin'], { cwd }).ok;
  const head = run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd }).stdout;
  const branch = where.defaultBranch || (head.startsWith('origin/') ? head.slice(7) : 'main');
  let ref = `refs/heads/${branch}`;
  if (hasOrigin) {
    if (fetch && !run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd }).ok) {
      throw err(CODE, `could not fetch ${branch} in ${repo} to check the commit`, 'check the network and your login, or pass --no-fetch to check against the last fetched copy');
    }
    ref = `refs/remotes/origin/${branch}`;
  }
  if (!run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd }).ok) {
    throw err(CODE, `${repo} has no ${hasOrigin ? `origin/${branch}` : `branch ${branch}`} to check the commit against`, `set default_branch for ${repo} in .sdlc/repos.json`);
  }
  const sha = run('git', ['rev-parse', '--verify', '--quiet', `${mergeCommit}^{commit}`], { cwd }).stdout;
  if (!sha) throw err(CODE, `${mergeCommit} is not a commit in ${repo}`, 'fetch it, or check the SHA');
  if (!run('git', ['merge-base', '--is-ancestor', sha, ref], { cwd }).ok) {
    throw err(CODE, `${mergeCommit} is not on ${repo}'s ${branch}`, 'a ship is recorded once the work is merged into the default branch');
  }
  const rec = readCommit(cwd, sha);
  if (!rec) throw err(CODE, `${mergeCommit} could not be read in ${repo}`, 'check the SHA');
  const named = tasksOfCommit(rec).map((x) => x.task);
  const want = `${story}-${task}`;
  if (!named.includes(want)) {
    if (strict || named.length) {
      throw err(CODE, named.length ? `${mergeCommit} names ${named.join(', ')}, not ${want}` : `${mergeCommit} does not name ${want}`,
        'the commit must name the task it ships: its Task: trailer, the task branch a merge commit brought in, or the full id in its subject');
    }
    if (noTask) warn(`${mergeCommit} names no task — ${noTask} ${want}`);
  }
  const body = run('git', ['log', '-1', '--format=%b', sha], { cwd }).stdout;
  return { sha, rec, body, date: run('git', ['log', '-1', '--format=%cs', sha], { cwd }).stdout };
}

// Which PRs/MRs merged a commit, asked of the platform — the only reliable answer (the user's decision,
// 2026-10-20): a squash subject ending "(#N)" may cite an issue, and a GitLab merge names its MR only in
// the body. Returns { ok, prs: [numbers] } or { ok: false, reason }.
export function prsForCommit(platform, sha, { cwd, runner = run } = {}) {
  if (platform === 'gitlab') {
    const r = runner('glab', ['api', `projects/:id/repository/commits/${sha}/merge_requests`], { cwd });
    if (!r.ok) return { ok: false, reason: r.stderr || 'glab api failed' };
    try { return { ok: true, prs: (JSON.parse(r.stdout) || []).filter((m) => m?.state === 'merged').map((m) => Number(m.iid)).filter(Boolean) }; } catch { return { ok: false, reason: 'unreadable glab answer' }; }
  }
  const r = runner('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`], { cwd });
  if (!r.ok) return { ok: false, reason: r.stderr || 'gh api failed' };
  try { return { ok: true, prs: (JSON.parse(r.stdout) || []).filter((p) => p?.merged_at).map((p) => Number(p.number)).filter(Boolean) }; } catch { return { ok: false, reason: 'unreadable gh answer' }; }
}

// The ship of a task merged with no PR/MR, where the platform can be read: the commit names the task, and
// the platform says no PR merged it. A PR that did is named (so the ship keeps its approvers); a platform
// that cannot answer is a refusal, never a guess.
function shipWithoutPr(where, { story, task, repo, mergeCommit, today, runner, fetch }) {
  const c = checkCommit(where, { story, task, repo, mergeCommit, strict: true, fetch });
  const asked = prsForCommit(where.platform, c.sha, { cwd: where.checkout, runner });
  if (!asked.ok) throw err(CODE, `could not ask ${where.platform} whether a PR/MR merged ${mergeCommit}: ${asked.reason}`, `log in with \`${cliFor(where.platform)} auth login\`, or pass --pr <n> if one did`);
  if (asked.prs.length) throw err(CODE, `${mergeCommit} was merged by PR/MR #${asked.prs[0]}`, `record it from that PR/MR, with its approvers: yad build ship ${story} --task ${task} --repo ${repo} --pr ${asked.prs[0]}`);
  return {
    story, task, repo, branch: null, pr: 'none', mergeCommit: c.sha, gates: [],
    ai_review: null, engineer_review: [], companion: { trailer: false, cards: false, chat: false },
    risk: null, shippedAt: c.date || today,
  };
}

const riskFromBody = (body) => (String(body).match(/^\s*Risk level:\s*(low|medium|high)\b/im) || [])[1]?.toLowerCase() || null;

// What a ship of `story`/`task` in `repo` needs before anything is asked or written — shared by `build ship`
// and `build merged`, so `merged` never answers "merged" for a ship `ship` would then refuse.
function shipContext(root, { story, task, repo, pr, verb }) {
  repoArg(repo, `yad build ${verb} ${story || '<story>'} --task <T01> --repo <name>`);
  if (!TASK_RE.test(String(task || ''))) throw err(CODE, `--task must be a task id such as T01 (got '${task ?? ''}')`, `yad build ${verb} ${story} --task T01 --repo ${repo}`);
  if (pr && pr !== true && !/^[1-9]\d*$/.test(String(pr))) throw err(CODE, `--pr must be the PR/MR number (got '${pr}')`, 'the number, not a URL or a branch');
  const ctx = storyContext(root, story);
  if (!ctx.storiesPassed) throw err(CODE, `the stories review has not passed, so ${story} is not approved for Build yet`, 'pass the stories review first (yad gate)');
  if (!ctx.entry.repos.includes(repo)) throw err(CODE, `${story} does not declare ${repo}`, `its repos: ${ctx.entry.repos.join(', ') || 'none'}`);
  storyStatusOk(ctx, story);
  const lane = lanes(ctx.buildState, story).repos[repo];
  if (isPlainObject(lane) && lane.status === 'skipped' && !laneStarted(lane)) {
    throw err(CODE, `${story} / ${repo} is skipped`, `\`yad unskip ${ctx.epic} ${story} --repo ${repo}\` before recording a ship there`);
  }
  return { ctx, where: registeredRepo(root, repo) };
}

export async function buildShip(root, { story, task, repo, pr, mergeCommit = null, approvers = [], today, fetch = true, runner = run, prReader = readPr } = {}) {
  if (mergeCommit && mergeCommit !== true && !/^[0-9a-f]{7,64}$/i.test(String(mergeCommit))) throw err(CODE, `--merge-commit must be a commit SHA (got '${mergeCommit}')`, 'the merge commit, 7 to 64 hex characters');
  const { ctx, where } = shipContext(root, { story, task, repo, pr, verb: 'ship' });
  let ship;
  // Read from the platform only in the repo's own checkout: from anywhere else `gh pr view <n>` reads that
  // folder's repo — the Product's own PR #n.
  const readable = where.platform && where.checkout && (runner !== run || platformReady(where.platform));
  const byHand = (mergeCommit && mergeCommit !== true) || approvers.length;
  // A task merged with no PR/MR (the user's decision, 2026-10-20): the commit is the evidence, so it must be
  // on the default branch and name the task. Nobody approved a PR, so there are no approvers.
  if (readable && (!pr || pr === true) && mergeCommit && mergeCommit !== true && !approvers.length) {
    ship = shipWithoutPr(where, { story, task, repo, mergeCommit, today, runner, fetch });
  } else if (readable && byHand) throw err(CODE, `the ship is read from PR #${pr || '?'} on ${where.platform}`, '--merge-commit and --approver are for a repo whose platform cannot be read; drop them');
  const usable = readable;
  if (where.platform && !where.checkout && !byHand) {
    throw err(CODE, `${repo} is not checked out here, so its PR cannot be read`, `\`yad repo clone ${repo}\` fetches it; or record it by hand with --merge-commit <sha> and --approver <login>`);
  }
  if (!ship && usable && (!pr || pr === true)) throw err(CODE, '--pr <n> is required', `the merged PR/MR the ship is read from: yad build ship ${story} --task ${task} --repo ${repo} --pr <n>`);
  if (ship) { /* recorded from the commit above */ } else if (usable) {
    const got = readMergedPr(where.platform, pr, { cwd: where.checkout, runner });
    if (!got.ok) throw err(CODE, `could not read PR #${pr} in ${repo}: ${got.reason}`, `log in with \`${cliFor(where.platform)} auth login\`, then run this again`);
    if (!got.merged) throw err(CODE, `PR #${pr} in ${repo} is not merged`, 'a ship is recorded once the PR/MR merges');
    if (!got.mergeCommit) throw err(CODE, `PR #${pr} in ${repo} is merged, but the platform names no merge commit`, 'record it from the commit instead: yad build ship … --merge-commit <sha> with no --pr');
    // The PR's branch names the task it carries (`feat/EP-x-S01-T01-…`): the ship is never put on another.
    const carries = branchTask(got.branch, story, task);
    if (carries === 'other') throw err(CODE, `PR #${pr} is from ${got.branch}, which names another task than ${story}-${task}`, 'check --task and --pr');
    if (carries === 'none') warn(`PR #${pr} is from ${got.branch || '(no branch)'}, which names no task — check it is the PR for ${story}-${task}`);
    const pull = prReader(where.platform, pr, { cwd: where.checkout, runner });
    const seen = new Set();
    const engineerReview = [];
    for (const a of pull.ok ? mapApprovers(pull.reviews, { headOid: pull.headOid }) : []) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      engineerReview.push({ approver: a.name, engagement: a.engagement === 'verified' ? 'verified' : 'none' });
    }
    if (got.checksRead === false) warn(`could not read the checks of PR #${pr} — gates is left empty`);
    if (!pull.ok) warn(`could not read the approvals of PR #${pr} (${pull.reason}) — engineer_review is left empty; \`yad review reconcile\` fills it later`);
    // What merged must be on the default branch, and may not name another task — the same check as by hand.
    const c = checkCommit(where, { story, task, repo, mergeCommit: got.mergeCommit, strict: false, fetch });
    ship = {
      story, task, repo, branch: got.branch, pr: got.url || `#${pr}`, mergeCommit: c.sha, gates: got.checks,
      ai_review: null, engineer_review: engineerReview,
      companion: { trailer: /<!--\s*yad:trailer\s*-->/.test(got.body), cards: false, chat: false },
      risk: riskFromBody(got.body), shippedAt: (got.mergedAt || '').slice(0, 10) || today,
    };
  } else {
    // No platform to ask: the person says what merged.
    if (!mergeCommit || mergeCommit === true) {
      throw err(CODE, where.platform ? `${cliFor(where.platform)} is not available to read the PR` : `${repo} has no platform to read the PR from`, '--merge-commit <sha> (and --approver <login> for each approver) records it by hand');
    }
    // In the repo's checkout the commit is checked as evidence too; only with no checkout is it taken as given.
    const c = where.checkout ? checkCommit(where, { story, task, repo, mergeCommit, strict: false, fetch }) : null;
    // A commit whose own merge subject names a PR is that PR's: a different --pr is refused.
    const said = c ? prOfCommit(c.rec.subject, c.body) : null;
    if (said?.certain && pr && pr !== true && Number(pr) !== said.pr) throw err(CODE, `${mergeCommit} merged PR/MR #${said.pr}, not #${pr}`, `--pr ${said.pr}`);
    ship = {
      story, task, repo, branch: null, pr: pr && pr !== true ? `#${pr}` : 'local', mergeCommit: c ? c.sha : mergeCommit, gates: [],
      ai_review: null, engineer_review: approvers.map((a) => ({ approver: a, engagement: 'none' })),
      companion: { trailer: false, cards: false, chat: false }, risk: null, shippedAt: (c && c.date) || today,
    };
  }
  const res = writeShip(ctx.epicDir, ship);
  if (!res.written) {
    if (res.reason === 'exists') throw err(CODE, `${story} / ${task} already has a ship in ${repo}`, 'one ship per task and repo');
    throw err(CODE, `${repo} shares a ship file name with ${res.repo || 'another repo'}`, 'repo names that differ only in punctuation cannot both ship this task');
  }
  // The story is in Build now (the skill's rule); `build done` sets it shipped once every task is.
  const moved = setBuildStatus(ctx.storyFile, 'in-build');
  ok(`ship recorded: ${story} / ${task} in ${repo}${ship.mergeCommit ? ` (${String(ship.mergeCommit).slice(0, 12)})` : ''}`);
  if (moved.changed) info(`${story} is now in-build`);
  hand(`when every task has shipped: yad build done ${story}; commit with \`yad checkpoint --push\``);
  return { story, task, repo, changed: true, ship, file: rel(root, res.file) };
}

// The PRs/MRs whose source branch carries `story`-`task`, newest first, from one page of the repo's PRs/MRs
// (any state). `{ ok, prs: [{ number, state, branch, url }], partial }` — `partial` when the page was full,
// so an older PR may not be in it — or `{ ok: false, reason }`. Run in the repo's own checkout: from anywhere
// else gh and glab read that folder's repo.
const PR_PAGE = 100;
export function findTaskPrs(platform, { story, task }, { cwd, runner = run } = {}) {
  let rows;
  if (platform === 'gitlab') {
    const r = runner('glab', ['api', `projects/:id/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=${PR_PAGE}`], { cwd });
    if (!r.ok) return { ok: false, reason: r.stderr || 'glab api merge_requests failed' };
    try { rows = (JSON.parse(r.stdout) || []).map((m) => ({ number: Number(m?.iid), state: glState(m?.state), branch: m?.source_branch || null, url: m?.web_url || null })); } catch { return { ok: false, reason: 'unreadable glab answer' }; }
  } else {
    const r = runner('gh', ['pr', 'list', '--state', 'all', '--limit', String(PR_PAGE), '--json', 'number,state,headRefName,url'], { cwd });
    if (!r.ok) return { ok: false, reason: r.stderr || 'gh pr list failed' };
    try { rows = (JSON.parse(r.stdout) || []).map((p) => ({ number: Number(p?.number), state: ghState(p?.state), branch: p?.headRefName || null, url: p?.url || null })); } catch { return { ok: false, reason: 'unreadable gh answer' }; }
  }
  if (!Array.isArray(rows)) return { ok: false, reason: 'unreadable answer' };
  return { ok: true, prs: rows.filter((x) => x.number > 0 && x.state && branchTask(x.branch, story, task) === 'this'), partial: rows.length >= PR_PAGE };
}

// `yad build merged <story> --task <T> --repo <r> [--pr <n>] [--ship]` (issue #355) — asks the platform
// whether the task's PR/MR has merged, so the agent need not wait for a person to say so. The user's
// decisions (2026-10-20): one check per run (the agent runs it again later; nothing waits); the PR is found
// by the task's branch unless --pr names it; --ship records the ship through `build ship` once merged.
// Every answer is a `state`: shipped (a ship is already recorded), merged, open, closed (closed without a
// merge) or none (no PR/MR carries the task yet). A refusal is only for what the agent must fix.
export async function buildMerged(root, { story, task, repo, pr = null, ship = false, today, fetch = true, runner = run, prReader = readPr } = {}) {
  const { ctx, where } = shipContext(root, { story, task, repo, pr, verb: 'merged' });
  const id = `${story}-${task}`;
  const shipCmd = (n) => `yad build ship ${story} --task ${task} --repo ${repo} --pr ${n}`;
  const out = (state, extra = {}) => ({ story, task, repo, state, pr: null, url: null, mergeCommit: null, changed: false, ...extra });
  // Already recorded: the same answer every time it is asked, with or without --ship.
  const had = readShips(ctx.epicDir).find((s) => s.story === story && s.task === task && s.repo === repo);
  if (had) {
    ok(`${id} already has a ship in ${repo}${had.mergeCommit ? ` (${String(had.mergeCommit).slice(0, 12)})` : ''}`);
    return out('shipped', { mergeCommit: had.mergeCommit || null });
  }
  if (!where.platform || !where.checkout || !(runner !== run || platformReady(where.platform))) {
    const why = !where.platform ? `${repo} has no platform to ask` : !where.checkout ? `${repo} is not checked out here` : `${cliFor(where.platform)} is not available`;
    throw err(CODE, `${why}, so yad cannot see whether ${id} merged`,
      !where.platform || where.checkout ? `once it has merged, record it by hand: yad build ship ${story} --task ${task} --repo ${repo} --merge-commit <sha>` : `\`yad repo clone ${repo}\` fetches it`);
  }
  let n = pr && pr !== true ? Number(pr) : null;
  if (!n) {
    const found = findTaskPrs(where.platform, { story, task }, { cwd: where.checkout, runner });
    if (!found.ok) throw err(CODE, `could not list the PRs/MRs of ${repo}: ${found.reason}`, `log in with \`${cliFor(where.platform)} auth login\`, or pass --pr <n>`);
    // A PR closed without a merge never competes with a later one for the same task.
    const live = found.prs.filter((x) => x.state !== 'closed');
    if (live.length > 1) throw err(CODE, `more than one PR/MR carries ${id}: ${live.map((x) => `#${x.number} (${x.state})`).join(', ')}`, `name the one that ships it: yad build merged ${story} --task ${task} --repo ${repo} --pr <n>`);
    if (!live.length && found.prs.length) {
      const last = found.prs[0];
      warn(`PR/MR #${last.number} for ${id} was closed without a merge`);
      hand('open a new PR/MR for the task, or ask the person who closed it');
      return out('closed', { pr: last.number, url: last.url });
    }
    if (!live.length) {
      info(`no PR/MR carries ${id} in ${repo} yet${found.partial ? ` among its newest ${PR_PAGE}` : ''}`);
      hand(found.partial ? `if it is older, name it: yad build merged ${story} --task ${task} --repo ${repo} --pr <n>` : 'open it with `yad open-pr`, then run this again');
      return out('none', { partial: found.partial });
    }
    n = live[0].number;
  }
  const got = readMergedPr(where.platform, n, { cwd: where.checkout, runner });
  if (!got.ok) throw err(CODE, `could not read PR/MR #${n} in ${repo}: ${got.reason}`, `log in with \`${cliFor(where.platform)} auth login\`, then run this again`);
  // A number given by hand must be this task's PR: its branch may not name another task.
  const carries = branchTask(got.branch, story, task);
  if (carries === 'other') throw err(CODE, `PR/MR #${n} is from ${got.branch}, which names another task than ${id}`, 'check --task and --pr');
  if (carries === 'none') warn(`PR/MR #${n} is from ${got.branch || '(no branch)'}, which names no task — check it is the PR for ${id}`);
  const state = got.state || (got.merged ? 'merged' : null);
  if (!state) throw err(CODE, `${where.platform} gave PR/MR #${n} a state yad does not know`, 'check it on the platform');
  const facts = { pr: n, url: got.url };
  if (state === 'open') {
    info(`PR/MR #${n} for ${id} is open — not merged yet`);
    hand(`run this again later; a person merges it`);
    return out('open', facts);
  }
  if (state === 'closed') {
    warn(`PR/MR #${n} for ${id} was closed without a merge`);
    hand('open a new PR/MR for the task, or ask the person who closed it');
    return out('closed', facts);
  }
  // Merged, but only an answer `build ship` would accept is `merged`: the same merge-commit checks run here
  // first (on the default branch, not naming another task), so a PR merged into a release branch or a
  // stacked parent is a refusal now, not a `merged` the ship then refuses.
  if (!got.mergeCommit) throw err(CODE, `PR/MR #${n} in ${repo} is merged, but the platform names no merge commit`, 'record it from the commit instead: yad build ship … --merge-commit <sha> with no --pr');
  // The warning for a commit naming no task is `build ship`'s to give, once, when it records; a read only asks.
  const c = checkCommit(where, { story, task, repo, mergeCommit: got.mergeCommit, strict: false, fetch, noTask: ship ? null : 'check it ships' });
  ok(`PR/MR #${n} for ${id} merged (${c.sha.slice(0, 12)})`);
  if (!ship) {
    hand(`record the ship: ${shipCmd(n)} (or run this again with --ship)`);
    return out('merged', { ...facts, mergeCommit: c.sha });
  }
  // The ship is written by `build ship` itself, never by a second path.
  const res = await buildShip(root, { story, task, repo, pr: String(n), today, fetch, runner, prReader });
  return out('merged', { ...facts, mergeCommit: res.ship.mergeCommit, changed: true, ship: res.ship, file: res.file });
}

export async function buildDone(root, { story, today, fetch = true } = {}) {
  const ctx = storyContext(root, story);
  // The epic is in Build — what featureStatus asks too: a reopened stories review takes it out again.
  if (nextAction(ctx.ledger).kind !== 'build') throw err(CODE, `${ctx.epic} is not in Build (its Shape chain is not finished)`, `\`yad next ${ctx.epic}\` says what is open`);
  storyStatusOk(ctx, story);
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
    // A stale copy could miss a task added since: a failed fetch refuses, unless --no-fetch asked for the copy.
    if (fetch && !run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: where.checkout }).ok) {
      throw err(CODE, `could not fetch ${branch} in ${repo} to read the tasks it owes`, `check the network and your login, and that ${branch} is ${repo}'s default branch (default_branch in .sdlc/repos.json); or pass --no-fetch to read the last fetched copy`);
    }
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
  if (!ctx.entry.repos.some((r) => !skipped.includes(r))) {
    throw err(CODE, `${story} owes no lane in any repo, so there is nothing to have shipped`, 'a story that needs no change in any repo is a question for its stories review');
  }
  // An empty `steps` is a half-seeded lane, which `yad next` reads as not started — never as shipped.
  const noLane = ctx.entry.repos.filter((r) => !skipped.includes(r) && !(isPlainObject(bs.repos[r]) && Array.isArray(bs.repos[r].steps) && bs.repos[r].steps.length));
  if (noLane.length) {
    throw err(CODE, `${story} has no lane in ${noLane.join(', ')}, so \`yad next\` would still read it in Build`,
      `\`yad build start ${story} --repo <r>\` and close its steps with \`yad build step\`; a story shipped before the Build ledger existed is recorded with \`yad checkpoint --retro-ship\` instead`);
  }
  const open = [];
  for (const repo of ctx.entry.repos.filter((r) => !skipped.includes(r))) {
    const lane = bs.repos[repo];
    for (const s of lane.steps) if (s?.id !== REVIEW_STEP && !isPassed(s)) open.push(`${repo}/${s?.id ?? '?'}`);
  }
  // Any other lane on disk (a repo the story does not declare, a name in another case) is read by `yad next`
  // too: one not finished would keep the story in Build there.
  const dupe = fs.existsSync(path.dirname(ctx.file)) ? fs.readdirSync(path.dirname(ctx.file)).filter((n) => n.endsWith('.json') && n !== `${story}.json`)
    .find((n) => readJSON(path.join(path.dirname(ctx.file), n), null)?.story === story) : null;
  if (dupe) throw err(CODE, `build-state/${dupe} also says story: ${story}`, 'yad next reads every file under build-state/: keep one per story');
  if (bs.story !== story) throw err(CODE, `build-state/${story}.json says story: ${bs.story}`, `set it to ${story}: yad next matches a lane to its story by that field`);
  const stray = Object.entries(bs.repos).filter(([r, l]) => !ctx.entry.repos.includes(r)
    && !(isPlainObject(l) && ((l.status === 'skipped' && !laneStarted(l)) || (Array.isArray(l.steps) && l.steps.length && l.steps.every(isPassed)))));
  if (stray.length) throw err(CODE, `build-state/${story}.json has a lane the story does not declare: ${stray.map(([r]) => r).join(', ')}`, '`yad doctor` reports it; remove it from the file, or add the repo to the story');
  const review = ctx.entry.repos.filter((r) => !skipped.includes(r)).filter((r) => bs.repos[r].steps.some((s) => s?.id === REVIEW_STEP && stepStatus(s) === 'blocked'));
  if (review.length) throw err(CODE, `${REVIEW_STEP} is blocked in ${review.join(', ')}`, `clear the halt first: \`yad build step ${story} --repo <r> ${REVIEW_STEP} in_progress\``);
  if (open.length) {
    throw err(CODE, `${story} has every task shipped, but these lane steps are still open: ${open.join(', ')}`, `close each with \`yad build step ${story} --repo <r> <step> done\`, then run this again`);
  }
  const by = recordActor(root);
  let changedLanes = 0;
  for (const repo of ctx.entry.repos.filter((r) => !skipped.includes(r))) {
    const lane = bs.repos[repo];
    const steps = lane.steps.map((s) => (s?.id === REVIEW_STEP && !isPassed(s) ? (changedLanes++, closeReview(s, { by, date: today })) : s));
    bs.repos[repo] = { ...lane, currentStep: REVIEW_STEP, steps };
  }
  // The lanes first, the status line last: if the run stops between the two, the story still reads in
  // Build to the seal and tidy — the safe side. A status line that cannot be set puts the lanes back.
  const storyText = fs.readFileSync(ctx.storyFile, 'utf8');
  const laneText = fs.existsSync(ctx.file) ? fs.readFileSync(ctx.file, 'utf8') : null;
  // The lanes first: a story file that could not be written (the usual cause) cannot be written back either.
  const restore = () => {
    if (laneText === null) fs.rmSync(ctx.file, { force: true }); else fs.writeFileSync(ctx.file, laneText);
    try { if (fs.readFileSync(ctx.storyFile, 'utf8') !== storyText) fs.writeFileSync(ctx.storyFile, storyText); } catch { /* left as it was */ }
  };
  if (changedLanes || !ctx.buildState?.story) writeJSON(ctx.file, bs);
  let moved;
  try {
    moved = setBuildStatus(ctx.storyFile, 'shipped');
  } catch (e) {
    restore();
    throw e;
  }
  if (moved.unknown || readFrontmatter(ctx.storyFile).status !== 'shipped') {
    restore();
    throw err(CODE, `could not set status: shipped in ${path.relative(ctx.epicDir, ctx.storyFile)}`, 'make it one plain `status:` line (with LF line endings), then run this again');
  }
  ok(`${story} is shipped${changedLanes ? ` — ${REVIEW_STEP} closed in ${changedLanes} lane${changedLanes > 1 ? 's' : ''}` : ''}`);
  if (sealedEpic(root, ctx.epic)) info(`${ctx.epic} is now sealed: every story shipped — new work there needs a change epic (yad-change)`);
  hand('commit with `yad checkpoint --push`');
  return { story, shipped: true, changed: changedLanes > 0 || !!moved.changed, lanesClosed: changedLanes };
}
