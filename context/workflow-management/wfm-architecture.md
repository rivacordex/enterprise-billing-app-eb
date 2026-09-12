# Workflow Management Platform — Architecture

This document **extends `context/architecture.md`** (the platform-wide architecture every module inherits) and is the **single source of truth for the workflow-management layer** — the Kestra deployment that the Rating and Billing modules both run on. It reconciles two decisions that were made independently and read as contradictory: rating's *"dedicated rating instance, sharing rejected"* (`rm04` D1) and the bill run's *"named engine registry, configurable topology, default shared"* (`_updatemodule-billing-billrun-phase2-plan.md` D24/D25). Both are now **valid deployment mappings of one platform**, not competing choices.

**Status:** Planning. It governs everything the two modules say about the engine layer; where a module doc disagrees on **topology, repository layout, or the logical-engine model**, this document wins and the module doc is reconciled (§9).

**Scope boundary.** This doc owns **the engine layer** — what the platform is, its three functions, the repository/directory layout, the logical→physical topology model, the registry, the roles/credentials, and the go-forward roadmap. It does **not** restate each function's internal design: rating's PRP→RP→RL lives in `context/rating-management/`, and the bill run's pipeline lives in `context/billing-management/` and `_updatemodule-billing-billrun-phase2-plan.md`. This doc references those; it does not supersede their functional content.

---

## 1. The one-line positioning

**Kestra is the solution's single logical workflow-management platform.** Every scheduled, fanned-out, or long-running compute the Enterprise Billing solution performs runs here — the application itself runs **no** schedulers, cron jobs, or background workers (`architecture.md` §6, unchanged). From a solution point of view the platform delivers exactly **three functions**:

| # | Function | What it does | Owning module | Produces |
| --- | --- | --- | --- | --- |
| **1** | **Rating engine** | File-batch pipeline (PRP → RP → RL) that turns raw usage files into priced charge records. | Rating Management | `rating.udr_rated` (+ `udr_batch`, `process_log`) |
| **2** | **Bill run — processor** | The bill-run processing pipeline (validate → collect/claim → aggregate → tax → verify) that turns rated usage into draft bill data. | Billing Management | `billing.customer_bill` (+ tax), the `udr_rated` claim |
| **3** | **Bill run — distributor** | Transport of the run's rendered artifacts (invoices, reports) to downstream targets. | Billing Management | delivery outcomes (no money logic) |

These three are the stable vocabulary. Instance counts, namespaces, and repository names are implementation detail underneath them.

**Functions are not engines.** "Three functions" is a *solution* decomposition. The physical decomposition — how many Kestra instances, how many logical engines in the registry — is a **topology decision** (§5), deliberately decoupled. The **base deployment runs all three functions on one Kestra instance**; the meaningful configurable split is **by module** (`rating` | `billrun`, 2 instances). Going from one to two is a deploy change, never a redesign.

---

## 2. Why this layer is promoted to first-class

Before this document, each module reasoned about "its" Kestra locally, and the two reasonings collided:

- **Rating** (`rm04` D1) fixed a **dedicated** rating instance and *rejected* sharing — because sharing would run bill-run flows on the rating worker image and let anyone past rm05's proxy edit bill-run flows.
- **Billing** (D24/D25) introduced a **named engine registry** with logical engines `rating` and `billrun`, made topology a deploy-time configuration, and set the **default to one shared instance** for the evaluation phase.

Read side by side, one says "never share" and the other says "share by default." Neither is wrong; they describe **different deployment mappings of the same platform under different constraints** (rating's isolation concern vs the bill run's evaluation-phase pragmatism). The fix is not to pick one — it is to name the platform they are both mapping onto, state that topology is the variable, and let each environment choose. §5 does that; §9 records the specific edits that retire the apparent contradiction.

---

## 3. The three functions in detail (the contract table)

| Concern | **1 · Rating engine** | **2 · Bill run — processor** | **3 · Bill run — distributor** |
| --- | --- | --- | --- |
| Trigger | Usage file arrives in `landing/` (file trigger) | App triggers execution #1 when the run enters `PROCESSING` | App triggers execution #2 when the run reaches `INVOICED` |
| Flows | `ran-usage-rating`, `log-sweep`, `completeness-check`, `stranded-batch-reconcile` | `bill_run_processing` | `bill_run_distribution` |
| Writes (DB role) | `rating.*` as **`rating_runtime`** | `customer_bill` (+tax) and the six `udr_rated` claim columns as **`billrun_runtime`** | none (transport only) |
| Reads | `product`/`ordering`/`inventory`/`billing` (SELECT, 7 enumerated tables) | seeded/real `udr_rated` | stored artifact references |
| Business logic in the flow? | **Yes** — rating logic lives in the flow definition (`rating_flow_revision` stamped per row) | **Yes** (B-fat) — bill-data compute lives in the flow (`processing_flow_revision` on `bill_run`) | **No** — transport only, but still versioned (`distribution_flow_revision`) |
| App HTTP surface it calls | none (rating exposes and calls no HTTP) | app M2M stage endpoints (`/api/billrun/{runId}/stage/{stage}/complete`) | app M2M status endpoints |
| Operator persona | BSS Ops (engine UI) | RevOps (app control plane) + BSS Ops (engine recovery) | RevOps (app) + BSS Ops (engine) |
| Terminal boundary | archive-after-commit; batch reconciles | terminates at `PROCESSED` — never waits on approval | signals per-target → `COMPLETED` / `DISTRIBUTION_FAILED` |

**The control-plane / compute-plane split holds for functions 2 and 3:** the **app is the control plane** (trigger, approve, reject, rerun, posting) and Kestra is **where the pipeline runs**. Approval and posting are irreducibly app-side. Function 1 has no app control plane — Billing Ops operates it directly through the engine UI.

---

## 4. Repository & directory layout — `flows/` is the upper directory

**The change:** flow definitions are organized under a **top-level `flows/` directory whose immediate children are the three functions**, not under each module. "Workflow management" is the container; the functions are services within it.

### 4.1 Target layout — the `workflow-management/` spin-off subdirectory

The workflow-management surface is a **spin-off subdirectory of the app repo** (a monorepo today, structured so it can later become its own repo): one parent `workflow-management/` holding `flows/`, `worker/`, `kestra/`, and `dev/`. The Azure **bicep stays at the app-root `infra/`** (the solution deploys as one app), renamed to the `workflow-engine` identity.

```
workflow-management/                # ← the spin-off subdirectory: the workflow-management surface
  flows/                            # function-first flow definitions
    rating-engine/                  # function 1
      ran-usage-rating.yaml         # PRP → RP → RL template
      log-sweep.yaml
      completeness-check.yaml
      stranded-batch-reconcile.yaml
      README.md
    bill-run-processor/             # function 2
      bill_run_processing.template.yml
      README.md
    bill-run-distributor/           # function 3
      bill_run_distribution.template.yml
      README.md
  worker/
    workflow-engine/                # THE ONE shared custom image — Python toolchain + Postgres client, baked
      Dockerfile                    # FROM kestra pinned-by-digest; process runner (no Docker-in-Docker on ACA)
  kestra/kestra.yml                 # platform config (datasource, storage, default-namespace)
  dev/                              # docker-compose stack, sample fixtures, .env.example
```

**One shared engine image, not per-function workers.** ACA has no Docker daemon, so Kestra runs as a **process runner** on a custom image built `FROM` a **digest-pinned** Kestra base. The base (collapsed) topology co-tenants all functions on **one** `workflow-engine` instance, so **one** `worker/workflow-engine/` image — the Python billing-data toolchain (rm04 D3) plus a Postgres client — serves rating and bill run alike; bill run carries no worker of its own. Split-by-module *may* later derive per-module images from this same base, but the default never needs two. The physical engine (container/ACR image/bicep module) is named **`workflow-engine`**, not `rating-engine` (§5, §6).

The organizing principle: **`flows/<function>/`**, one directory per solution function, each self-contained (its own `README.md` naming the deploy step and owner). Cross-function shared assets (the `workflow-engine` image, `kestra/`, dev stack) sit *beside* `flows/` inside `workflow-management/`; the Azure bicep sits at the app-root `infra/`, never inside a function directory. The executable form of this restructure is `context/workflow-management/specs/wfm01-engine-restructure.md`.

### 4.2 One monorepo surface — templates and real flows co-located by function

Because the workflow-management surface is a **spin-off subdirectory of the app repo** (not a separate repo yet), there is no second flow tree to mirror. All flows live under `workflow-management/flows/<function>/`, differing only by maturity:

```
workflow-management/flows/
  rating-engine/                    # function 1 — REAL flows (rating v1; computation stubbed, not skeletons)
  bill-run-processor/bill_run_processing.template.yml   # function 2 — # STUB: template skeleton this phase
  bill-run-distributor/bill_run_distribution.template.yml  # function 3 — # STUB: template skeleton this phase
```

Bill run's `# STUB:`-marked templates (the recorded billing-specific handling — `bm16`) carry key sections + commented activities and **no business logic**; they are deployed as flow shells (§8 stand-up) so the `billrun` namespace and flow definitions exist ahead of billing phase 2. Rating's flows are the real deployable definitions. When the subdirectory is later spun off into its own repo, this whole tree moves together — the templates go with it, so the earlier "real flows live in a separate repo" framing becomes "real flows live in the spun-off `workflow-management` repo, which is this same tree."

### 4.3 What this supersedes

| Prior statement | Location | Now |
| --- | --- | --- |
| `flows/` holds rating flows **flat** at the top (`ran-usage-rating.yaml`, …) | `ratemgmt-code-standards.md` §8 | flat files move under **`flows/rating-engine/`** |
| App-repo skeletons live under **`flows/billrun/`**, `flows/rating/` a "reserved sibling" | `bm16` Design | **`flows/bill-run-processor/`** + **`flows/bill-run-distributor/`**; **`flows/rating-engine/`** the reserved sibling |
| "the billrun app repo carries template skeletons under `flows/billrun/`" | `billmgmt-architecture.md` §2 / `billmgmt-code-standards.md` §7 | function-first paths above |

**Naming rule (new, platform-level):** flow directories are named for the **solution function** (`rating-engine`, `bill-run-processor`, `bill-run-distributor`), not for the logical engine or the module abbreviation. The logical-engine name (`rating`, `billrun`) stays in the flow's `namespace:` and the registry, not in the directory tree — because a function may move between engines under a topology change (§5) but its identity does not.

**Migration note (rating v1 assumed complete).** Because rating v1 is treated as delivered, moving its four flows into `flows/rating-engine/` is a **rename/move of planned artifacts**, not a code rewrite — the flow bodies, the worker image, and every rating invariant are unchanged. Only the path and the two doc references in §4.3 change.

---

## 5. Topology — one logical platform, a deploy-time physical mapping

**The model (resolves rm04 D1 vs D25).** There is one logical platform. The **engine registry** maps *logical engines* to *physical Kestra instances*. A deployment declares its topology explicitly; changing it later is a config/deploy change with **no app-code change** — the app always addresses an engine **by name**.

**The base deployment is one Kestra instance running all three functions** — this is the simple, recommended default and stays valid for every environment until a reason to isolate appears. That single physical instance is named **`workflow-engine`** (not `rating-engine` — the container *is* the shared platform, §6), and a single **`topology` deploy parameter** (`collapsed` default | `split-by-module` | `enterprise`) selects the mapping. The **only meaningful split is by module** — `rating` | `billrun` — and it is **fully configurable**: flipping the parameter takes a deployment from one instance to two without app-code change (the app addresses the engine by name). There is no split-by-function step; the distributor rides with the processor under `billrun`.

| Topology | Physical instances | When | Trade-off |
| --- | --- | --- | --- |
| **Collapsed (base — default)** | **1** (all three functions co-tenant) | the simple base deployment; every environment until isolation is wanted (incl. the evaluation phase — billing D25) | Kestra **OSS** has no per-namespace access control → one login can edit *any* function's money logic. Recorded **accepted risk**, removed by splitting or by Enterprise. |
| **Split-by-module** | 2 (`rating` \| `billrun`) | when rating and bill-run flows must not be editable from one login (rating's isolation stance, `rm04` D1); the eventual production shape | rating flows and bill-run flows are isolated; separate worker images; two instances to operate. |
| **Enterprise (single, scoped)** | 1 (Enterprise edition) | phase-2 target | scoped, revocable per-flow tokens and a user model remove the OSS shared-instance risk without splitting. |

**Logical engines: two (`rating`, `billrun`).** The processor and distributor are two flows on the `billrun` engine — the distributor holds no money logic, so it needs no blast radius of its own. The split axis is the module boundary, so `billrun` never subdivides further; the two logical engines *are* the two split targets.

**Guardrails that keep topology a pure config change (from D25 a–e, elevated to platform-level):**

1. Every registry entry is a **complete standalone connection descriptor** — base URL, namespace, Basic-Auth credential ref, inbound callback-token ref. Never "reuse another engine's connection."
2. Each logical engine uses **its own credentials and DB role** even on a collapsed instance, so a split needs **no new secrets** — only repointing.
3. Each function's flows **deploy to a standalone instance** with no dependency on another function's flows or namespace being co-present.
4. The deployment **declares its topology** (`collapsed` / `split-by-module` / `enterprise`); the default is `collapsed` (one instance), and a collapsed OSS mapping carries the recorded money-logic-isolation accepted risk.
5. Each execution is stored with its **resolved engine identity** (registry key + instance reference), so a later topology change never orphans reconcile/cancel of a historical execution.

---

## 6. Roles, credentials & the boundary

Each function runs as its **own least-privilege Postgres role**; the boundary between functions is a **grant, not a convention**. This is unchanged from the module docs and restated here only to show the whole picture in one place.

| Credential / role | Function | Blast radius | Source of truth |
| --- | --- | --- | --- |
| `rating_runtime` | 1 | `SELECT`/`INSERT` on `rating.*`, `UPDATE(status)` on `udr_rated`, SELECT on 7 enumerated tables, **no `DELETE`**, no `billing` write | `ratemgmt-*`, `rm03` |
| `billrun_runtime` | 2 | column-scoped write on `customer_bill`(+tax) and the six `udr_rated` claim columns; **no** run-state / `document` / pgledger | `bm14`, phase-2 plan D15 |
| `kestra_engine` | platform | `CONNECT`+`CREATE` on the `kestra` DB only; **no `CONNECT` on billing** | `rm03a` |
| Kestra Basic Auth | platform | instance-admin on the engine (OSS) | `rm04` D5, phase-2 D27 |
| `BILLRUN_APP_TOKEN` | 2 & 3 | scoped to the bill-run M2M endpoints; **billing's — rating has none** | phase-2 D27 |

**Deploy run-order is load-bearing:** `platform → rating → billrun` (D15). `billrun_runtime` must never be created during the window where `PUBLIC` still holds `CONNECT` on the billing database (the `rm03a` ordering hazard). `billrun-db-roles.sql` self-asserts the precondition and fails closed (phase-2 eng-review #12).

**Business logic lives in flow definitions for functions 1 and 2**, so the **flow revision is part of the audit trail** — `rating_flow_revision` on every `udr_rated` row, `processing_flow_revision` / `distribution_flow_revision` on `bill_run`. Neither the engine's execution history nor the app's tables alone reconstruct a historical charge; the flow revision is required. The distributor holds no money logic but is still versioned so a delivery is reconstructable.

**Accepted risk, solution-wide (OSS collapsed/shared topology).** Anyone past the Entra Easy Auth reverse proxy holds full Kestra-OSS instance rights, which on a collapsed instance means the ability to edit **any co-located function's** money logic, with no per-user audit inside the engine. Mitigated by network restriction + proxy access-logs; removed by splitting or by moving to Enterprise. This is the same risk the rating and billing docs each record; it is stated once here as the platform position.

---

## 7. Platform invariants (workflow-management layer)

In addition to `architecture.md` §7 and each module's invariants:

1. **One logical platform; topology is configuration, not code.** The app addresses every engine **by name** through the registry; no base URL, namespace, or instance count is hard-coded in app logic.
2. **`flows/` is the upper directory; each immediate child is a solution function** (`rating-engine`, `bill-run-processor`, `bill-run-distributor`). A flow filed by module abbreviation or logical-engine name instead of function is a review defect.
3. **Every registry entry is a complete standalone connection descriptor** (§5 guardrail 1). No entry depends on another engine being co-present.
4. **Each function writes only through its own granted role.** A flow that writes outside its function's grant is refused by Postgres, not by review.
5. **Business logic in a flow ⇒ its revision is stamped on the output rows** (functions 1 and 2). A historical charge/bill must be reconstructable from the stamped revision.
6. **Never edit a flow in the Kestra UI.** OSS has no per-user action history; a UI edit is an untracked change to how money is calculated. Flows are version-controlled and deployed from the repository (`ratemgmt-code-standards.md` §3.1, elevated to platform-level).
7. **Never fan out per record** (rating Inv #10, elevated). Tasks are per file / per chunk / per account. The OSS JDBC queue makes every task transition a polled DB row.

---

## 8. Go-forward roadmap — by function

The roadmap is organized by function, so "which phase am I in" is answered per function rather than per module.

| Function | Delivered (assumed) | Next phase | Then |
| --- | --- | --- | --- |
| **1 · Rating engine** | v1 — schema, roles, deployment, flow skeletons with the computation **stubbed** (rm01–rm13) | **Rating phase 2** — the real PRP mapping rules, RP price resolution & calculation, RL guards over live rating logic (currently out of scope in rating v1) | additional rate types beyond `FLAT`; allowance/bundle/minimum-commitment handling |
| **2 · Bill run — processor** | phase 1 — app-surface, stubbed | **Billing phase 2** (bm14–bm21) — wire the processor to Kestra with **placeholder** stage tasks; two-writer boundary; `PROCESSED` for real | real billing compute (correlation, calculation, tax rules) replacing the placeholders |
| **3 · Bill run — distributor** | phase 1 — `DISTRIBUTING` a no-op | **Billing phase 2** (bm20) — Kestra distribution flow, one loopback target, `DISTRIBUTION_FAILED` loop | real targets (portal, AR feed, statutory, email); per-run `bill_run_output` |

**Sequencing across functions:** the bill run's phase 2 runs against a **`_SAMPLE_*` seed** of `udr_rated`, so functions 2 and 3 do not block on function 1's phase 2. When rating phase 2 lands, the processor's source of records changes from the seed to the live pipeline with **no change to the two-writer boundary or the claim contract** — the seam that this platform framing is designed to preserve.

---

## 9. Reconciliations this document forces

Each module doc keeps its functional content; only its **topology / layout / logical-engine framing** is pointed at this document. The executable form is `context/workflow-management/specs/wfm01-engine-restructure.md`; the reconciliation edits below were applied alongside it (☑ = applied in the planning repo; the code move itself is `wfm01` §1–§7b, handed to a code-repo session):

| Doc | Edit | Status |
| --- | --- | --- |
| `ratemgmt-architecture.md` §1, §2, §7 dev.5 | Note Kestra is the shared **workflow-management platform** (this doc); rating is **function 1**; "dedicated instance" is the **split-by-module topology**, one valid mapping, not a standalone decision; `*(rating repo)*` paths → the `workflow-management/` subdirectory. | ☑ |
| `rm04` D1 | Reframe "dedicated engine" as the **split-by-module topology** of the platform registry; cross-reference §5; container renamed `rating-engine` → `workflow-engine`. Keep the isolation rationale. | ☑ |
| `ratemgmt-code-standards.md` §8 | Flow files move under **`workflow-management/flows/rating-engine/`**; worker under `workflow-management/worker/workflow-engine/`; reference §4. | ☑ |
| `_updatemodule-billing-billrun-phase2-plan.md` D24/D25, §8 | Point the registry/topology model at this doc as the authority; keep D25 (a–e) as the guardrails (now §5). | ☑ |
| `bm16` Design | Skeletons at **`workflow-management/flows/bill-run-processor/`** + **`.../bill-run-distributor/`**; `.../rating-engine/` the co-located function-1 sibling; topology authority = §5. | ☑ |
| `billmgmt-architecture.md` §2, `billmgmt-code-standards.md` §7 | Same path realignment; reference §4. | ☑ |
| `_newmodule-billrun-rating-workflow-plan.md` | Add to its superseded banner that the engine is one **workflow-management platform** with three functions; the "separate rating instance" line is the split-by-module topology. | ☑ |
| `ratemgmt-progress-tracker.md`, `billmgmt-progress-tracker.md` | Forward-pointer to `wfm01` at the header; historical path entries left intact (accurate until the code move executes). | ☑ |

**Additions folded in by `wfm01` (clarifications):** (a) the workflow surface is a **spin-off subdirectory `workflow-management/`**, not a separate repo (§4.1–§4.2); (b) **one shared process-runner image `workflow-engine`** with Python + a Postgres client, serving both functions (ACA has no Docker daemon — §4.1); (c) the physical engine is renamed **`rating-engine` → `workflow-engine`** (§5, §6); (d) topology is a single **`topology` deploy parameter**, default `collapsed`/one instance (§5); (e) stand-up **deploys both functions' flows into the running engine** (`wfm01` §7b).

**No functional invariant changes.** Nothing here touches a `[CRITICAL]` rating or billing invariant, the grant model, the claim contract, the two-writer boundary, or the money math. This is a **positioning + layout** reframe; every enforceable guarantee stays exactly where its module put it.
