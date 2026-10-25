# Spec Kit handoff — command list, output map, and degradation rules

Step A (`yad-spec`) runs the **heavy Spec Kit ceremony once per story per repo** and writes the
result into the story's code repo. This reference pins the exact commands, the files they produce, and
how to hand-author the same files faithfully when Spec Kit is not used — so Step B
(`yad-implement`, not built yet) can read them unchanged.

## The ceremony (run once, in order)

Driven as harness slash-commands (RESEARCH-NOTES §2, Deviation 3), from **inside** the code repo:

| # | Command | Purpose | Writes |
|---|---------|---------|--------|
| 1 | `/speckit.specify`   | Turn the story into a spec | `specs/<feature-id>/spec.md` (+ `research.md`, `data-model.md`, `contracts/`) |
| 2 | `/speckit.clarify`   | Resolve ambiguities; tighten the spec | updates `spec.md` |
| 3 | `/speckit.plan`      | Technical approach for this repo | `specs/<feature-id>/plan.md` |
| 4 | `/speckit.analyze`   | Cross-check spec ↔ plan consistency | updates `spec.md`/`plan.md` |
| 5 | `/speckit.checklist` | Quality checklist for the spec | checklist section under `specs/<feature-id>/` (in the degraded path, folded into `spec.md`) |
| 6 | `/speckit.tasks`     | Atomic task list | `specs/<feature-id>/tasks.md` |

**Ask first (#357).** Between `specify` and `clarify` — or, when the story qualifies for a light spec
(#348), on a hand draft before any Spec Kit command (SKILL.md Step 5) — the skill asks every human-only
decision and open question in one batch (SKILL.md, **Ask the human-only questions first**). The answers go into
`spec.md` under `## Clarifications`, as `- Q: <question> → A: <answer>` lines below a
`### Session <YYYY-MM-DD>` heading — the format `/speckit.clarify` writes. The degraded path writes
the same section, so `yad-implement` finds the answers in one place on both paths.

**Excluded from Step A:** `/speckit.constitution` (project-level, one-time bootstrap) and
`/speckit.implement` (that is Step B — the per-task build loop). Stop at `tasks`.

**Feature-id is pinned** to the story ID (`EP-<slug>-S0N`), never Spec Kit's numbered auto-slug. Two
things pin it (#348): `yad build step <story> --repo <repo> spec|tasks in_progress` writes
`{"feature_directory":"specs/<story>"}` to `.specify/feature.json`, which `/speckit.plan`, `/speckit.tasks`
and the rest read; and `/speckit.specify`, which does not read that file, is started with
`SPECIFY_FEATURE_DIRECTORY=specs/<story>`. If a
Spec Kit version forces its own folder name, keep the run but make `link.md` (below) the crosswalk
between the Spec-Kit slug and the permanent story ID.

## Output map (what must exist after Step A)

```
demo-repos/<repo>/specs/<story-id>/
  spec.md         # the feature spec — what to build & why, traced to acceptance criteria
  research.md     # decisions/unknowns resolved during clarify
  data-model.md   # entities/fields THIS repo implements (quoting the shared ones from the contract)
  contracts/      # the API/event surface this repo implements (quoted from the locked contract)
                  # OMITTED ENTIRELY on a short-lane epic, and for a story with nothing to quote — see below
  plan.md         # technical approach for this repo
  tasks.md        # numbered atomic tasks (T01…), each scoped to the files it may touch
  link.md         # back-pointer to the story in the product repo (Step A adds this; not a Spec Kit file)
```

## Light spec (#348)

A small story the human confirmed as light (SKILL.md Step 5 says when to offer it) has two files only:

```
demo-repos/<repo>/specs/<story-id>/
  spec.md         # the spec, then ## Plan, then ## Tasks with the marked tasks block
  link.md         # as below, with speckit: not-used and spec-mode: light
```

```markdown
# Spec — EP-<slug>-S0N

<the spec: context, the need, in scope, out of scope, acceptance criteria copied from the story>

## Clarifications
### Session <YYYY-MM-DD>
- Q: Light spec — one spec.md holding the spec, the plan and the tasks? → A: yes

## Plan
<the approach for this repo in a few lines: what changes, and how it is tested>

## Tasks
<!-- yad:tasks -->
## T01 — <one-line goal>
**Files:** <the files it may touch>
<!-- /yad:tasks -->
```

Each marker line appears once, alone on its line, begin before end. The tasks are read **only** from
between them (`yad build done`, `yad-implement`), so a `T01` mentioned in the spec or the plan is never
taken for a task. Spec Kit is not run for a light spec: its commands need `plan.md` and `tasks.md`.

## Degradation rules (when Spec Kit is not used)

Author each file by hand so it is **indistinguishable in shape** from a real Spec Kit run. The content
comes from the story's acceptance criteria and the **locked contract surface** — never invented.

- **`spec.md`** — restate the story as a spec: context, the user/system need, in-scope behavior,
  out-of-scope, and acceptance criteria copied verbatim from the story. Reference (do not redefine) the
  contract endpoints/entities the story touches.
- **`research.md`** — list the decisions and any unknowns; if the story is unambiguous, say so. Note
  where the contract already settles a question (e.g. status is server-owned).
- **`data-model.md`** — the entities/fields **this repo** implements. Shared entities (e.g. `Order`,
  `OrderStatus`) are **quoted from the contract** and marked as contract-owned; repo-private fields
  are marked as local.
- **`contracts/`** — the slice of the API/event surface this repo implements, **quoted from the locked
  `contract.md`** (e.g. `POST /orders` request/response). Put the quoted lines, **copied whole and word
  for word** from the `CONTRACT-SURFACE` block, between ONE pair of markers per file, under the fixed
  title:
  ```
  # Contract slice — EP-checkout-S01

  <!-- CONTRACT-QUOTE:BEGIN -->
  - `POST /orders` — place an order from the cart.
    - request: `{ items: { sku: string, qty: number }[], address: string, payment: string, note?: string }`
  <!-- CONTRACT-QUOTE:END -->
  ```
  The block is one **unbroken run** of consecutive surface lines, in their order; to quote two parts of
  the surface, write two files, one block each. The file holds nothing else but blank lines and, first,
  the title `# Contract slice — <story ID>` exactly as shown (or no title) — notes (for example, which
  endpoints this story builds) go in `spec.md` or `plan.md`. Write the slice as
  Markdown (`.md`). The contract-check gate then passes the slice with **no** `Contract-Change` trailer,
  because it can prove every quoted line is in the lock (issue #344). Never reword, reorder or skip a line
  inside a block: that is a surface change, and it needs the trailer.
  **Leave the folder out when there is nothing to quote** — a story on a locked epic that touches none of
  the surface has no `contracts/` folder (an empty one cannot be committed and quotes nothing).
  **Do NOT create this folder on a short-lane epic** (`profile: chore` or `spike`). Those routes have
  no architecture step, so there is no locked `contract.md` to quote and no lock for CI to check the
  quote against — the gate refuses a slice under a lockless epic. A short-lane story consumes the
  shared surface through the code it calls; it never restates it. If one already exists, a commit
  that only DELETES it is allowed through, which is the way back out.
- **`plan.md`** — the technical approach for this repo at story altitude (components, sequence,
  test approach). No new cross-repo surface.
- **`tasks.md`** — numbered atomic tasks. Each task: an ID (`T01`, `T02`, …), a one-line goal, and an
  explicit **Files** list naming the files it may touch (≤3 where possible). This is what Step B reads
  to enforce "the diff stays inside the files the task declared."

## link.md template

```markdown
---
story: EP-<slug>-S0N
epic: EP-<slug>
repo: <repo>
feature-id: EP-<slug>-S0N
product-repo: <path to the product repo — absolute, or relative to THIS file's dir (specs/<story>/)>
contract-lock: sha256:<hex copied from epics/EP-<slug>/.sdlc/contract-lock.json>   # or the literal
                 # `none` on a short-lane epic, which has no lock. Never an empty or invented hash:
                 # CI reads an unparseable value as a broken lock and fails.
speckit: installed | not-installed | not-used
spec-mode: full | light
generated: <YYYY-MM-DD>
---

# Spec link — EP-<slug>-S0N (<repo>)

This spec implements story **EP-<slug>-S0N** of epic **EP-<slug>** for the **<repo>** repo.

- Story: `<product-repo>/epics/EP-<slug>/stories/EP-<slug>-S0N.md`
- Contract (locked, singular): `<product-repo>/epics/EP-<slug>/contract.md`
- Contract surface hash at spec time: `sha256:<hex>` (copied from the lock, not recomputed here)

The contract surface above is **referenced, not re-defined**. Any change to the shared surface must go
back to the architecture gate in the product repo — it is never widened from this code repo.
```

`epic` must be the story ID's prefix (`EP-<slug>-S0N` → `EP-<slug>`); lineage-check, epic-open and
reconcile-debt-check FAIL on any other value (E118).

`product-repo` is the one field CI resolves on disk (contract-check, lineage-check, epic-open,
reconcile-debt all read it). Every gate resolves it the SAME way: an **absolute** path is used as-is; a
**relative** path is joined to this `link.md`'s own directory, `specs/<story>/` — `../../` climbs out of
the story dir and out of `specs/` to the code-repo root, so a Product checked out beside the code repo
is `../../../<product-dir>`. A relative value that only resolves from the **repo root** still works too
(what contract-check historically did), so older `link.md` files keep gating. Write it as an **unquoted
scalar** — `"..."` or `'...'` is taken literally, and a leading `~`/`$VAR` is never expanded. An
unreachable path degrades the Product-reading gates to a PASS-with-note rather than failing them, and
each one now says so in its output. **CI reads `product-repo` from `link.md` as it stands on the base
branch** once one is merged (E117): a PR that changes it is read by the old value, and the new one
counts after the merge. **A merged `.sdlc/product-link.json` in the code repo comes before all of it
(E120):** its `path` (from the repo root, where CI checks the Product out) is what the gates read, and
`link.md`'s `product-repo` is only a fallback for a repo without one — so write `../../<that path>` here
when the record exists. A Product folder that the code repo itself tracks (a monorepo) is read as it
stands on the base commit, so a re-lock must merge before the slice change that pins it.
**Reachable-but-lockless is a different case and does NOT degrade:** when the Product resolves and
`epics/<epic>/.sdlc/` is there with no `contract-lock.json` in it, a claimed `Contract-Change: yes`
FAILS, because nothing exists for the claim to be true of. That is the ordinary state of a short-lane
epic, of a stub, and of a classic epic that has not reached its architecture gate yet.

## Do not re-invent the contract

The spec **quotes** the locked surface; it never extends it. To confirm the surface the spec relies on
matches the lock, run from the **product** repo:

```bash
awk '/CONTRACT-SURFACE:BEGIN/{f=1;next} /CONTRACT-SURFACE:END/{f=0} f' \
  epics/EP-<slug>/contract.md | tr -d '\r' | shasum -a 256
# compare against epics/EP-<slug>/.sdlc/contract-lock.json
```

If the story needs surface that is not in the locked block, STOP and route back to the architecture
gate. Step A never re-locks or widens the contract.
