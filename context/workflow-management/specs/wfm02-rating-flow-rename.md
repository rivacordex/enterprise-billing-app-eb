# wfm02 — Rating Flow-ID Harmonization (rename)

**Status:** Planning. **Authority:** `context/workflow-management/wfm-architecture.md` (this spec is the executable form of that doc's §4.3 naming rule, narrowed to flow **ids**). **Scope:** flow **identity only** — the `id:` field and the matching `.yaml` filename of the four `rating`-namespace flows, plus every reference that keys on those names. No `namespace`, role, grant, claim contract, two-writer boundary, task logic, or money math is touched; no `[CRITICAL]` rating/billing invariant changes.

**Repo split.** This spec's **doc edits** (Implementation §8) land in the planning repo (`_plan_enterprise-billing-app`). Its **code changes** (§1–§7) are executed against the codebase repo (`enterprise-billing-app`) by a code-repo session — this planning repo never emits code (CLAUDE.md).

---

## Goal

Harmonize the four Rating-engine flow ids so each is self-identifying as a Rating-module flow in the shared workflow-engine UI. Rename each flow's `id:` and its matching `.yaml` filename per the D-A table, fix every reference that keys on the old id/filename (in-flow comments, tests, runtime docstrings, READMEs, infra docs), delete the orphaned old-id flows from every running engine (the deploy is upsert-only, D-D), and reconcile the living docs. Flow bodies, triggers, tasks, and all rating invariants are otherwise byte-unchanged.

---

## Design

### D-A · The rename mapping

| Current `id:` / filename | New `id:` / filename | Rename shape |
| --- | --- | --- |
| `completeness-check` | `rating-completeness-check` | prefix |
| `stranded-batch-reconcile` | `rating-batch-reconcile` | prefix + drop `stranded` |
| `log-sweep` | `rating-logger` | reword |
| `ran-usage-rating` | `rating-engine-ran-usage` | front-load `rating`, drop trailing `rating` |

The user's literal target strings are authoritative (not a mechanical "prepend `rating-`" — three of the four also reword). **Namespace stays `rating`** for all four. **Filename follows the id** — this repo's convention is `filename == id` (every current file matches its `id:`), so each file is renamed to `<new-id>.yaml`.

### D-B · Scope = flow identity only

The rename reaches the flow `id:`, its filename, and every reference that **keys on** that id/filename. It does **not** touch:

- **Namespace** — already `rating` (already module-clear); changing it is a topology change (wfm §5), not a rename.
- **Runtime Python modules** — `runtime.log_sweep`, `runtime.stranded_reconcile`, `runtime.completeness_check`, `runtime.prp/rp/rl` stay as-is. They are invoked as `python3 -m runtime.<mod>` *inside* a task; renaming them is a separate, larger blast radius (imports, `__init__.py`, package tests) with no flow-id-clarity gain.
- **Internal task ids** — `sweep`, `reconcile`, `completeness-check`, `prp`/`rp`/`rl`, `on-error`, `always` are flow-local; unchanged.
- **KV config keys** — already `rating_*`-prefixed. `rating_stranded_batch_threshold_seconds` retains the word `stranded` after its flow becomes `rating-batch-reconcile`; that residue is accepted (the key is already module-clear, and renaming a live KV key is a data-migration risk, not a clarity win). Recorded in **Out of scope**.

### D-C · No conflict with the wfm naming rule (§4.3 / Inv #2)

wfm-architecture §4.3 / Inv #2 governs **directories** ("each immediate child of `flows/` is a solution function") and states logical-engine names (`rating`, `billrun`) live "in the flow's `namespace:` and the registry." It does **not** govern flow **ids**. This rename keeps the directory `flows/rating-engine/` and the namespace `rating` exactly as the rule requires; it adds a module-clarity prefix to the *id* only. Rationale: the base **collapsed** topology co-tenants `rating` + `billrun` on one `workflow-engine` instance (wfm §5), so an operator sees a flat flow list spanning both namespaces — a `rating-`/`rating-engine-` id prefix makes ownership obvious at a glance. Tradeoff: the prefix is mildly redundant with the `rating` namespace; accepted for operator clarity (the stated goal).

### D-D · Old-id flows must be explicitly deleted from every engine [operational]

`kestra flow namespace update` is run with **`--no-delete`** (`infra/azure-pipelines.yml:492`, a deliberate safety guard against a partial checkout wiping a live flow). Renaming an `id:` therefore creates a **new** flow and leaves the **old-id flow — and its triggers — live on the engine**:

- old `ran-usage-rating` keeps its `landing/` file trigger → a second execution races every arriving file (the `UNIQUE (file_key, batch_run_num)` claim, Inv #7, prevents double-*load*, but a redundant execution still spawns and errors/no-ops);
- old `log-sweep`, `stranded-batch-reconcile`, `completeness-check` keep their `Schedule` triggers → duplicate sweeps / reconcile passes / completeness checks every tick.

So the rename **must** include a one-time delete of the four old ids from **every engine they were deployed to** (dev compose engine and any CI/deployed engine). **Do not** remove `--no-delete` to achieve this — that would re-expose the guarded hazard. Use an explicit per-id delete (§7).

### D-E · Revision-counter reset is safe now (pre-first-live-execution)

A Kestra id rename starts `flow.revision` fresh at 1 for the new id. Only `rating-engine-ran-usage` (the ex-`ran-usage-rating`) stamps a revision on money rows — `rating_flow_revision` on every `udr_rated` row via `{{ flow.revision }}` (Inv #12) — and the column stores only the integer, not the id, so a reset could in principle make "revision N of the old flow" and "revision N of the new flow" indistinguishable. It does not here: per `ratemgmt-progress-tracker.md` the **first live Kestra execution is still pending** ("once rm04's stack is up with flows deployed"), so **no `udr_rated` row is yet stamped under the old id** — the reset creates no historical ambiguity. Renaming **before go-live is deliberate and the safe window**; renaming after rows exist would require recording the cutover id/date alongside the revision. The other three flows write no money rows, so their revision reset is inconsequential.

---

## Implementation

### §1 · Rename flow id + file (the four flows)
Under `workflow-management/flows/rating-engine/`, `git mv` each file and change its one `id:` line; every other byte of each flow body is unchanged.

| Rename file | Edit line |
| --- | --- |
| `completeness-check.yaml` → `rating-completeness-check.yaml` | `completeness-check.yaml:12` `id: completeness-check` → `id: rating-completeness-check` |
| `stranded-batch-reconcile.yaml` → `rating-batch-reconcile.yaml` | `stranded-batch-reconcile.yaml:13` `id: stranded-batch-reconcile` → `id: rating-batch-reconcile` |
| `log-sweep.yaml` → `rating-logger.yaml` | `log-sweep.yaml:11` `id: log-sweep` → `id: rating-logger` |
| `ran-usage-rating.yaml` → `rating-engine-ran-usage.yaml` | `ran-usage-rating.yaml:21` `id: ran-usage-rating` → `id: rating-engine-ran-usage` |

### §2 · Fix stale in-flow comment cross-references
The flows cite each other's **filenames** in comments; these break on rename (meaning-changing, not cosmetic — a broken path reference):
- `rating-completeness-check.yaml:16` — `log-sweep.yaml / stranded-batch-reconcile.yaml` → `rating-logger.yaml / rating-batch-reconcile.yaml`.
- `rating-batch-reconcile.yaml:17` (`log-sweep.yaml`), `:27` (`log-sweep.yaml`), `:35` (`ran-usage-rating.yaml`) → `rating-logger.yaml` ×2, `rating-engine-ran-usage.yaml`.
- `rating-logger.yaml:2` (`a crashed ran-usage-rating`) → `rating-engine-ran-usage`.
- `rating-engine-ran-usage.yaml:12` (`deploy_rating_flows` — see §6 note), `:207` (`later loaded by log-sweep.yaml`) → `rating-logger.yaml`.

### §3 · Update test references (code-repo `tests/rating/`)
Tests read flow files by filename and (rm13) drive a flow by id — these are hard requirements; the suite fails otherwise:
- **Filename joins** → new filenames: `rm06-flow-template-logging-sweep.integration.test.ts:92` (`ran-usage-rating.yaml`), `:95` (`log-sweep.yaml`); `rm07-…:121`, `rm08-…:174`, `rm09-…:153`, `rm13-…:64` (all `ran-usage-rating.yaml`); `rm11-…:126` (`stranded-batch-reconcile.yaml`); `rm12-…:102` (`completeness-check.yaml`). Update comment mentions in the same files (`rm06:36,167,275,528`) too.
- **Flow-id constants / assertions:** `rm13-no-fan-out.integration.test.ts:51` `const FLOW_ID = "ran-usage-rating"` → `"rating-engine-ran-usage"`; `:164` assertion message `rating.ran-usage-rating` → `rating.rating-engine-ran-usage`.

### §4 · Update runtime docstring / README references
Docstrings name the owning flow file (a real path reference, so meaning-changing):
- `runtime/completeness_check.py:4` (`flows/completeness-check.yaml`) → `rating-completeness-check.yaml`.
- `runtime/stranded_reconcile.py:4,58` (`flows/stranded-batch-reconcile.yaml`) → `rating-batch-reconcile.yaml`.
- `runtime/log_sweep.py:19` (`ran-usage-rating.yaml`), `:20` (`log-sweep.yaml`) → `rating-engine-ran-usage.yaml`, `rating-logger.yaml`. (Log **strings** at `:263,266,270,290` say `log-sweep:` — leave; they are the component's log prefix, not a flow-id reference, and D-B keeps the module name.)
- `runtime/prp.py:3`, `runtime/rp.py:3`, `runtime/rl.py:3` (`flows/ran-usage-rating.yaml`) → `rating-engine-ran-usage.yaml`.
- `runtime/__init__.py:51` (`flows/stranded-batch-reconcile.yaml`), `:61` (`flows/completeness-check.yaml`) → new names.
- `worker/workflow-engine/runtime/README.md:18` (and the row at `:19`) — `../../flows/stranded-batch-reconcile.yaml` → `rating-batch-reconcile.yaml`; the log-sweep row → `rating-logger.yaml`.

### §5 · Update the function README table
`workflow-management/flows/rating-engine/README.md:9–12` — the four filename rows → the new filenames (purposes unchanged).

### §6 · Infra / CI / env / docs references
- **CI deploy needs no change.** `deploy_fn rating-engine rating` (`azure-pipelines.yml:523`) deploys the **whole directory** by namespace, so the new filenames/ids are picked up automatically. The stray comment mention `log-sweep` at `azure-pipelines.yml:491` → `rating-logger` (illustrative example only).
- `.gitignore:69` comment (`ran-usage-rating.yaml consumes real usage files`) → `rating-engine-ran-usage.yaml`.
- **Webhook-path references are legacy/doc-only.** `dev/.env.example:79,84`, `infra/docs/engine-access.md:105,112`, and `infra/bicep/modules/workflow-engine-container-app.bicep:229,401` describe an rm06 **Webhook** trigger whose URL path embeds the flow id (`…/webhook/rating/ran-usage-rating/<key>`). rm07 replaced that trigger with the `landing/` **file trigger** (`ran-usage-rating.yaml:100`, `action: NONE`), so no live webhook keys on the id today — but if any external caller or KV secret still assumes that path, it must move to `…/rating-engine-ran-usage/…`. Update the doc/comment strings to the new id and flag the path change to whoever owns the (now-legacy) webhook secret.

### §7 · Delete the orphaned old-id flows from every engine (D-D)
One-time, per environment, **after** the new flows deploy (upsert), because `--no-delete` will not remove them:
- **Dev (compose):** delete the four old ids from the local `workflow-engine`, e.g. `kestra flow delete rating <old-id>` (or `DELETE /api/v1/flows/rating/<old-id>`) for `ran-usage-rating`, `log-sweep`, `stranded-batch-reconcile`, `completeness-check`. Confirm the flag/verb name at the D0 spike (same UNCONFIRMED caveat class as the other Kestra CLI flags, `azure-pipelines.yml:493`).
- **Deployed engine(s):** run the same four deletes once against each engine the flows had been deployed to.
- **Keep `--no-delete`** on the pipeline deploy (do not delete-by-reconcile). Verify **zero** executions of any old id fire after the cutover (no duplicate schedule/file-trigger runs).

### §8 · Doc reconciliations (planning repo — applied with this spec)
Update the **living/reference** docs that list the flows by current name; leave the **historical `rmNN` build-spec bodies** (rm06/rm07/rm08/rm09/rm11/rm12, including their embedded `id:` YAML) intact as point-in-time delivery records — **wfm02 is the authority for the rename** (mirrors wfm01's treatment of historical progress-tracker entries). Minimal diffs, no reformatting.

| Doc | Edit |
| --- | --- |
| `wfm-architecture.md` §3 (line 43 Flows row) + §4.1 tree (lines 67–70) | Flow names → the D-A new ids/filenames; namespace/table/diagram structure otherwise unchanged. |
| `ratemgmt-code-standards.md` §8 (lines 161–164) | The four filenames → new filenames. |
| `ratemgmt-progress-tracker.md` (lines 21, 22, 27, 38) | `completeness-check.yaml`→`rating-completeness-check.yaml`; `stranded-batch-reconcile.yaml`→`rating-batch-reconcile.yaml`; `log-sweep`→`rating-logger`; `ran-usage-rating`(manual, line 38)→`rating-engine-ran-usage`. Runtime `*.py` names left as-is (D-B). |
| `rm00-build-plan.md` (lines 138, 148) | Unit boundary tags `stranded-batch-reconcile`/`completeness-check` → new ids. |
| `billmgmt-completed-tracker.md` (line 391) | `rating.stranded-batch-reconcile` → `rating.rating-batch-reconcile`. |
| `_updatemodule-product-pricing-components-plan.md` (line 270), `prodmgmt-ai-workflow-rules.md` (line 128), `prodmgmt-code-standards.md` (line 68), `_updatemodule-ratecard-lookup-plan-v2.md` (line 9), `pm51-rating-runtime-rekey.md` (line 74) | `ran-usage-rating.yaml` path/name → `rating-engine-ran-usage.yaml` where the reference is to the live flow (not a historical build note). |

*(These references exist in both repos' `context/` trees; apply in the planning repo per the Repo-split note, and again in the code-repo `context/` copy as part of the §1–§7 code change so the two stay in sync.)*

---

## Dependencies (packages to install)

- None. No new npm/Python/infra dependency; the rename reuses the already-pinned Kestra image as its deploy/delete CLI (§7).

---

## Verification checklist

- [ ] `workflow-management/flows/rating-engine/` holds exactly the four **new** filenames; each file's `id:` matches its filename; every other byte of each flow body is identical to pre-rename (`git diff --stat` shows only the renamed lines).
- [ ] `grep -rn "ran-usage-rating\|log-sweep\|stranded-batch-reconcile\|completeness-check" enterprise-billing-app` returns **only** intended survivors: the `log-sweep:`/`LOG_SWEEP` log-string prefixes and the `stranded` KV key (D-B), and historical `rmNN` spec bodies (§8) — **no** live `id:`, filename, test, docstring, or README reference to an old name.
- [ ] `rm13` deploys+triggers `rating-engine-ran-usage` and its no-fan-out assertion passes; `rm06/rm07/rm08/rm09/rm11/rm12` read the new filenames and stay green.
- [ ] Pipeline `deploy_fn rating-engine rating` deploys all four new-id flows to `rating`; `azure-pipelines.yml` still carries `--no-delete` (unchanged).
- [ ] **(D-D)** After cutover, the engine lists the four **new** ids under `rating` and **none** of the four old ids; no duplicate schedule/file-trigger execution of any old id is observed.
- [ ] **(D-E)** No `udr_rated` row predates the rename (first-live-execution still pending) — confirmed before cutover, so no revision-counter ambiguity.
- [ ] Living docs (§8) show the new names; historical `rmNN` build-spec bodies unchanged; no `[CRITICAL]` invariant, grant, claim-contract, two-writer, or money-math edit in the diff.

---

## Out of scope (this spec)

- Renaming runtime Python modules (`runtime.log_sweep`, `runtime.stranded_reconcile`, `runtime.completeness_check`), internal task ids, or the `rating` namespace (D-B).
- Renaming the KV key `rating_stranded_batch_threshold_seconds` (retains `stranded`; already `rating_`-prefixed, live-key migration risk — D-B).
- Any change to flow logic, triggers, task order, roles, grants, the claim contract, or money math — this is an identity rename only.
- Rewriting historical `rmNN` build-spec bodies (§8) — they remain point-in-time delivery records.
