---
name: yad-spec
description: 'Build Step A of the gated SDLC. For one ready-for-build story and one of its repos, run the heavy Spec Kit ceremony ONCE (specify → clarify → plan → analyze → checklist → tasks) inside that code repo, writing specs/<story-id>/ in Spec Kit''s own layout. Drives /speckit.* as harness slash-commands when installed; authors the same files by hand and records speckit: not-installed when absent. References the locked contract — never re-invents the surface. Writes link.md back to the story. Never auto-advances. Use when the user says "spec story <id> in <repo>" or after a story is ready-for-build.'
---

# SDLC — Author Spec (Build Step A)

**Goal:** Turn ONE `ready-for-build` story into a per-repo Spec Kit spec/plan/tasks inside that
story's code repo. The heavy spec ceremony runs **once per story per repo**; the light
tasks → implement loop is **Step B** (`yad-implement`). This step **never re-locks the contract** —
the cross-repo surface is owned upstream by the architecture gate (build plan §A, Cross-cutting
"Heavy spec once per story, light loop per task"). It does not advance the Shape state machine;
when driven by the orchestrator (`yad-run`, Phase 4) it records a `spec`/`tasks` trust signal
(Step 8) — but it never auto-advances a contract change or a Shape step.

Spec Kit is driven as **harness slash-commands** (`/speckit.*`), not a subprocess CLI (Phase 0
Deviation 3). When Spec Kit is not used (**When a tool is missing** below), the same files are
hand-authored in Spec Kit's exact layout and the spec is marked `speckit: not-installed` — the workflow
does not block on the tool. This
is the same graceful-degradation pattern `yad-ui` uses for Impeccable.

## When a tool is missing

<!-- Written from yadflow's cli/toolbox.mjs (E87). Change the words there: a test holds this section to it. -->

No tool below is required. When one is missing, this skill still finishes, using the fallback written
beside it.

For Spec Kit, decide from yad's answer, not from a guess:
run `yad toolbox list --json` and read, in its `tools` list, the entry with the tool's `id`. Run it
where the tool will run: for work inside a code repo, add `--dir <that repo>`, so the tools installed
there are found.

- **The team's choices.** They come from the Product. If the answer's `product` is null, yad found no
  Product, so a tool the team chose not to use still shows `used: true`. Tell the person that.
- **When yad cannot see the tool.** yad does not read every way a tool can be set up (an older install
  may be missed). If the entry says `missing` but the check in the steps below finds the tool, use
  it — but never when the entry says `used: false`.
- **When yad cannot answer** (yad is not installed here, or the command fails), use the check in the
  steps below.

Tell the person which tools you used and which fallbacks, and why.

- **Spec Kit** (`spec-kit`). Use it when its entry has `used: true` and `status.state` is `installed` or `available`. Otherwise — not found, its plugin turned off in Claude Code, or the team chose not to use it (`yad toolbox remove spec-kit`) — use the fallback.
  - Fallback — yad-spec writes the same spec files by hand, in Spec Kit's layout.
  - Record `speckit: not-installed`. It means the tool was not used, whatever the reason.

<!-- end: When a tool is missing -->

## Conventions

- `{project-root}` resolves from the project working directory — the **product** repo (epic
  "thinking" + per-epic `.sdlc/` state live here).
- **Code repos are separate git repos**, one `.git` each, under `{project-root}/demo-repos/<repo>/`
  (`config.yaml` `build.code_repos_root`). All Spec Kit outputs land **inside the code repo**, never
  in the product repo.
- `{feature-id}` is the **story ID** (e.g. `EP-checkout-S01`) — **pinned**, never Spec Kit's
  numbered auto-slug (which is unstable and severs the permanent story link). The spec folder is
  `specs/<story-id>/`.
- Spec Kit output layout (RESEARCH-NOTES §2): `specs/<feature-id>/spec.md` (+ `research.md`,
  `data-model.md`, `contracts/`), `plan.md`, `tasks.md`; constitution at `.specify/memory/constitution.md`.
- Speak in the `communication_language` set in `{project-root}/.sdlc/config.yaml`; write documents in `document_output_language`.

## Inputs

- `epic`  — the `EP-<slug>` to operate on (ask if not provided).
- `story` — the ONE story to spec, `EP-<slug>-S0N` (ask if not provided).
- `repo`  — one entry from that story's `repos` (the ONE repo to spec; ask if the story lists more
  than one).

## Ask the human-only questions first, in one batch

<!-- The same section is in yad-spec and yad-implement: a test holds the two copies equal (#357). -->

Some decisions belong to the human alone. If one turns up late, the long work stops and waits for it.
So before the long work starts, list every such decision together with every open question, and ask
them all in **one** message.

**Human-only decisions** — never decide these yourself, and never pick a default just to keep going:
- **Security trade-offs.** Who may call or see what, what data is stored, logged or shown, how
  people sign in, and any check made weaker on purpose.
- **Secrets and tokens.** Which secret or token the work needs, who creates it, where it is kept,
  and what it may access.
- **Contract changes.** The work needs the shared cross-repo surface (the locked `contract.md`) to
  change. Nobody decides this here: it goes back to the architecture gate, or, on a short lane, to a
  new epic on `classic`. Raise it in the batch so the person learns it now, not halfway through.
- **Changes that cannot be undone.** Deleting data, or a data migration with no way back.

**How to ask:**
1. Number each item. For each one, say what must be decided, why only a human can decide it, and the
   options, with your recommendation where a safe one exists.
2. Wait for the answers, then record them where the step below says, so no later step asks again.
   `yad-implement` first reads the answers `yad-spec` recorded in `spec.md`, and asks only what is
   still open.
3. If nothing is open, say "no human-only decisions or open questions" and go on.
4. If a new one still turns up later, stop, collect any others that are open at that point, and ask
   them together. In the report, say the first batch missed it.
5. **Run by the orchestrator (`yad-run`):** open questions are the loop's `ambiguous` halt. Run
   `yad build step <story> --repo <repo> <step> blocked --reason "waiting on human decisions: <the
   questions, short>"` (add `--task <task>` on the implement leg). Write **no** trust entry, because
   nothing was produced to judge. Then stop. Once a person answers, the step runs again with the
   answers in hand.

<!-- end: Ask the human-only questions first -->

## On Activation

### Step 1 — Resolve the story and check readiness
Read `{project-root}/epics/<epic>/.sdlc/state.json`. Proceed only when
`currentStep == "ready-for-build"` (the gating Shape — through the **stories** gate — is `done`).
The **`test-cases` track may still be `in_progress`**: it is parallel and non-blocking, so Build runs alongside it — its status does not affect readiness here. Read the story file
`epics/<epic>/stories/<story>.md`; confirm `repo` is in its `repos`. If the epic is not ready, STOP
and point the user at `yad-status`. **Do not mutate Shape state** — `ready-for-build` semantics
stay intact.

### Step 2 — Resolve the target code repo
Map `repo` → `{project-root}/demo-repos/<repo>/`. Confirm it exists and is its own git repo
(`demo-repos/<repo>/.git` present). If missing, STOP and point the user at `demo-repos/README.md`
(how to regenerate the throwaway repo). Operate **inside this repo** with absolute paths.

### Step 3 — Read the contract (reference, do NOT re-invent)
Read `epics/<epic>/contract.md` and `epics/<epic>/.sdlc/contract-lock.json`. The spec's contract
inputs (the API shapes, data-model entities, and events the story touches) are **quoted from the
locked surface**, not re-authored. Each `contracts/` file is Markdown holding the quoted lines, copied
whole and word for word as ONE consecutive run, in one `<!-- CONTRACT-QUOTE:BEGIN -->` …
`<!-- CONTRACT-QUOTE:END -->` block, and nothing else but blank lines and, as the first line, the title
`# Contract slice — <story ID>` (one file per run; notes go in `spec.md` or `plan.md`), so the contract-check gate
can prove it is a quote and needs no `Contract-Change` trailer (see `references/spec-handoff.md`). The spec MUST stay within that surface. If the story needs surface
the contract does not define, STOP and route back to the **architecture gate** — never extend the
contract here. (On a route that HAS one; the short lanes do not — see below.)

- **Short-lane-safe:** read `epics/<epic>/.sdlc/state.json`'s `profile` first (an epic seeded before
  file shape 6 has no such key — fall back to what its `steps[]` contains). On the `chore` and
  `spike` routes there is no architecture step, so `contract.md` and `contract-lock.json` **never
  exist** — that is the route's design, not a missing file to chase. Write the spec from the story and
  `epic.md` alone, record `contract-lock: none` in Step 6's frontmatter, and say in the spec that this
  epic defines no contract surface.
- A short lane has no architecture gate to route back to. So the rule above becomes stricter, not
  looser: if the story turns out to need the shared cross-repo surface to CHANGE, **STOP and escalate
  to a human** — the work belongs to a new epic on `classic`. Do not write the change into a spec on a
  short lane. Do not create `specs/<story>/contracts/` at all on one — a short-lane story has no
  surface to quote, and a slice folder under a lockless epic is what the CI gate refuses. (If one
  already exists, a commit that only DELETES it is allowed through, which is the way back out.)

### Step 4 — Detect Spec Kit
Read Spec Kit's entry in `yad toolbox list --json --dir demo-repos/<repo>`, as **When a tool is
missing** says. If yad cannot answer, check for `/speckit.*` slash-commands and/or
`demo-repos/<repo>/.specify/`. Record the result for Step 6's
frontmatter (`speckit: installed | not-installed`).

### Step 5 — Run the heavy ceremony ONCE (or degrade)
**Ask first (#357).** Before the long part of the ceremony, ask the batch that **Ask the human-only
questions first** above describes. Its items come from the story, `epic.md`, the contract read in
Step 3, and the first draft of `spec.md`. Record the answers in `spec.md`, under `## Clarifications`,
as `- Q: <question> → A: <answer>` lines below a `### Session <YYYY-MM-DD>` heading. This is the format
`/speckit.clarify` writes, and both paths below leave the answers there.

**Used** — from inside `demo-repos/<repo>/`, drive, in order:
`/speckit.specify` → (ask the batch) → `/speckit.clarify` → `/speckit.plan` → `/speckit.analyze` →
`/speckit.checklist` → `/speckit.tasks`. **Pin the feature to `<story>`** (do not accept an
auto-slug). Seed `specify` from the story's acceptance criteria and the contract elements from Step 3.
Answer `/speckit.clarify`'s questions from the batch answers. A question it asks that the batch did not
cover is a late one: ask all such questions together, as rule 4 of the batch says.
`/speckit.constitution` and `/speckit.implement` are **out of scope for Step A** (implement is Step B).

**Not used (degrade)** — draft `spec.md` first, ask the batch, record the answers in it, and only then
write the rest. Hand-author the identical files in Spec Kit's layout under
`demo-repos/<repo>/specs/<story>/`: `spec.md`, `research.md`, `data-model.md`, `contracts/`,
`plan.md`, `tasks.md`. The content is what a real Spec Kit run would produce, traceable to the story's
acceptance criteria and the locked contract surface. `tasks.md` MUST be numbered atomic tasks (`T01…`),
each declaring the files it may touch, so Step B's "stay inside the declared files" rule has something
to read. See `references/spec-handoff.md` for the exact file map and per-file degradation rules.

### Step 6 — Write link.md back to the story
Write `demo-repos/<repo>/specs/<story>/link.md` (template in `references/spec-handoff.md`) with
frontmatter linking the spec back to the product repo: `story`, `epic`, `repo`, `feature-id`,
`product-repo` (path — when the code repo has `.sdlc/product-link.json`, write `../../<its path>`, the
place CI checks the Product out; the gates read that record first anyway), `contract-lock` (the hash **copied** from `contract-lock.json`, NOT recomputed
in the code repo — or the literal `none` on a short-lane epic, which has no lock; never a made-up or
empty hash, which the CI gate reads as a broken lock and fails), `speckit`
(`installed | not-installed`), `generated` (date). This `link.md` plus the
spec folder is the authoritative record that this story's spec exists.

### Step 7 — Stop (Shape state untouched)
Report: the spec folder path, the files written, whether Spec Kit was used, the task count from
`tasks.md`, and that the next action is **Step B — `yad-implement`**. Do **not** edit the epic's
`state.json`, `approvals.json`, or `contract-lock.json`. Step A is a generation step, not a Shape gate.

### Step 8 — Record the `spec` trust signal (Phase 4b)
When this step runs under the orchestrator (`yad-run`), the generated spec is a Build run that the
trust log measures (part of the run record `yad dial` shows beside the `spec` dial). The
verdict is **anchored to the human who accepts the spec**, never self-graded:
- the human approves the generated `specs/<story>/` untouched → `approved-unchanged`;
- the human edits the spec/plan/tasks before accepting → `approved-with-edits` (signal
  `human_edited_spec: true`);
- the spec is rejected or the ceremony re-run → `rejected`.
`yad-run` records a provisional entry when the spec is generated; this acceptance finalizes it (same
pattern as the engineer review finalizing `implement` at `yad-engineer-review`). Finalize it with
`yad build trust <story> --repo <repo> spec --uid <uid> --verdict <v>` — the `uid` is `closed.run` on the
`spec` step in `build-state/<story>.json`. Never write the shard by hand. Schema:
`../yad-epic/references/state-schema.md`. **Run standalone, no trust entry is written** — the
log measures orchestrated runs. The record is advice: the `spec` dial is
whatever the team sets with `yad dial`, and this step never changes it.

## Hard rules (build plan §A, Cross-cutting)

- **Heavy spec once per story, not per task.** specify/clarify/plan/analyze/checklist/tasks run once
  per story per repo. Do not re-run the ceremony for each task.
- **Per-repo spec, shared contract.** Spec/plan/tasks live in the code repo; the contract stays
  singular in the product repo. Never widen the contract surface from here.
- **Nothing auto-advances.** Step A generates files and stops; no state machine is advanced.
- **Human-only decisions are asked first, in one batch** (#357), before the long work — never decided
  by the agent.

## Reference
- Command list, output map, degradation rules, link.md template: `references/spec-handoff.md`.
- Contract surface format + hash recipe: `../yad-architecture/references/contract-format.md`.
- Spec Kit facts and the slash-command-vs-CLI deviation: `RESEARCH-NOTES.md` §2 + Phase 3 decisions + Deviation 3.
