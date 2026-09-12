# wfm01 — Workflow-Engine Restructure

**Status:** Planning. **Authority:** `context/workflow-management/wfm-architecture.md` (this spec is the executable form of that doc's §4–§6 + §9). **Scope:** the engine layer only — directory layout, the shared engine image, the physical engine identity, topology config, and stand-up flow deployment. No `[CRITICAL]` rating/billing invariant, grant, claim contract, two-writer boundary, or money math is touched.

**Repo split.** This spec's **doc edits** (Implementation §8) land in the planning repo (`_plan_enterprise-billing-app`). Its **code changes** (§1–§7b) are executed against the codebase repo (`enterprise-billing-app`) by a code-repo session — this planning repo never emits code (CLAUDE.md).

---

## Goal

Restructure the workflow-engine code into the wfm platform shape — a spin-off `workflow-management/` subdirectory with function-first `flows/`, one shared process-runner Kestra image, and the physical engine renamed `rating-engine` → `workflow-engine` — make topology a single deploy parameter (default one shared instance, splittable by config with no app-code change), have stand-up register both functions' flows into the running engine, and reconcile every doc that still describes the old shape.

---

## Design

### D-A · Target tree (spin-off boundary = `workflow-management/`; bicep stays at root `infra/`)

```
workflow-management/                     # spin-off subdirectory repo (the WFM component)
  flows/
    rating-engine/                       # function 1 — real flows (rating v1, computation stubbed)
      ran-usage-rating.yaml
      log-sweep.yaml
      completeness-check.yaml
      stranded-batch-reconcile.yaml
      README.md
    bill-run-processor/                  # function 2 — template skeleton this phase
      bill_run_processing.template.yml
      local-dev/bill_run_processing.yml
      README.md
    bill-run-distributor/                # function 3 — template skeleton this phase
      bill_run_distribution.template.yml
      local-dev/bill_run_distribution.yml
      README.md
    README.md                            # "WFM surface; function-first; spin-off boundary"
  worker/
    workflow-engine/                     # THE ONE shared custom image (D-B)
      Dockerfile
      requirements.in
      requirements.txt
      runtime/                           # prp / rp / rl / log_sweep / completeness_check / db / storage / …
  kestra/
    kestra.yml                           # platform config (datasource, storage, default-namespace)
  dev/
    docker-compose.dev.yml
    .env.example
    set-kestra-role-password.mjs
    landing/  archive/  error/  logs/    # each .gitkeep + README
  README.md
```

**Move map** (a rename/move of planned artifacts — bodies unchanged, wfm §4 migration note):

| From (current) | To (target) |
| --- | --- |
| `rating-engine/flows/*` | `workflow-management/flows/rating-engine/` |
| `rating-engine/worker/*` | `workflow-management/worker/workflow-engine/` |
| `rating-engine/kestra/*` | `workflow-management/kestra/` |
| `rating-engine/dev/*` | `workflow-management/dev/` |
| `flows/billrun/bill_run_processing.template.yml` + `flows/billrun/local-dev/bill_run_processing.yml` | `workflow-management/flows/bill-run-processor/` |
| `flows/billrun/local-dev/bill_run_distribution.yml` | `workflow-management/flows/bill-run-distributor/` |
| `flows/billrun/README.md`, `flows/billrun/local-dev/README.md` | split into each function's `README.md` |

The old top-level `rating-engine/` and `flows/billrun/` directories are removed once emptied.

### D-B · One shared process-runner image (`workflow-engine`)

`FROM kestra/kestra:<ver>@sha256:…` — the base is **pinned by digest** (reproducibility gate; its digest is the value stamped into `udr_rated.rating_engine_version`, Inv #12). On top:
- Python libs installed into the image's `/app/.venv` via `uv pip install --require-hashes` (the fully-pinned `requirements.txt` is the hard gate).
- `runtime/` baked at `/app/runtime`, `PYTHONPATH=/app` so any Python task can `import runtime`.
- **Postgres client** (`postgresql-client` / libpq + `psql`) installed as a system dep, so any function's task can act on the DB directly.
- Runs `server standalone` as a **process runner** — no Docker daemon, no Docker socket, ever. This is forced by ACA: Azure Container Apps has no Docker daemon, so Kestra's Docker task runner is unavailable; every task runs in-process on this image.

**Default = collapsed, one instance, one image serving both functions.** The base topology co-tenants rating + bill-run on a single `workflow-engine` instance, so that instance runs **one shared image** for both — hence a single `worker/workflow-engine/`, not per-function workers. Bill-run carries **no worker of its own**; it rides the shared image. Split-by-module stays a pure config change and *may* later derive specialized per-module images from this same base, but the collapsed default never needs two. (Supersedes wfm §4.1's two-`worker/` drawing.)

### D-C · Physical rename `rating-engine` → `workflow-engine`

The Container App named `rating-engine` *is* the shared platform engine (it runs all co-tenant functions), so its physical identity generalizes to `workflow-engine` across container/bicep/ACR/KV/CI/compose. **Function-scoped identity is unchanged** and must NOT be renamed: namespace `rating`/`billrun`, roles `rating_runtime`/`kestra_engine`, DB column `udr_rated.rating_engine_version`, and rating's `landing/` input stay rating-scoped. Only the physical engine's name generalizes.

### D-D · Naming rule (platform-level, elevated)

Flow directories are named for the **solution function** (`rating-engine`, `bill-run-processor`, `bill-run-distributor`), never for the module abbreviation or the logical-engine name. Logical-engine names (`rating`, `billrun`) live only in each flow's `namespace:` and in the app's engine registry — because a function can move between engines under a topology change but its identity does not. A flow filed by module/logical-engine name is a review defect.

### D-E · Topology is one deploy parameter (objective d)

A single `topology` param — `collapsed` (**default**) | `split-by-module` | `enterprise` — drives infra; the app always addresses the engine **by name** and never learns the count:

- **`collapsed`** (default, all non-prod): provision **one** `workflow-engine` Container App hosting **both namespaces** `rating` + `billrun`. The app's `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_NAMESPACE` resolve to that instance / `billrun`; rating flows deploy to `rating` on the same instance. Carries the recorded OSS money-logic-isolation accepted risk (wfm §6).
- **`split-by-module`**: provision **two** apps (`workflow-engine-rating`, `workflow-engine-billrun`); app config repoints `billrun` to the second — **no app-code change** (`engine-registry.ts` is already by-name). Every namespace keeps its own role/credential/URL even when collapsed, so a split is *repointing only* — no new secrets (wfm §5 guardrails a–e).
- **`enterprise`**: one Enterprise-edition instance with scoped tokens; removes the OSS shared-instance risk without splitting.

Flipping the param (and the matching env template) is the whole change.

### D-F · Stand-up deploys flows into the engine (objective e)

Standing up the platform does not end at "container healthy" — it ends when **both functions' flows are registered inside the running engine**: rating's real flows under namespace `rating`, bill-run's template/skeleton flows under `billrun`, with the namespaces asserted and secret refs wired. One **idempotent** bootstrap path is shared by local dev (compose) and CI, deploying every `workflow-management/flows/<function>/` flow to its namespace against the (collapsed-by-default) instance. Bill-run flows deploy as their `# STUB` templates — flow shells in the engine, no business logic — enough that the namespace and flow definitions exist ahead of billing phase 2.

---

## Implementation

### §1 · Directory move
Execute the D-A move map. Rating flow/worker/kestra bodies are byte-unchanged; bill-run skeletons keep their `# STUB:` markers. Remove the emptied `rating-engine/` and `flows/billrun/` directories. Update `.gitignore`'s pycache glob (`rating-engine/worker/**/__pycache__/` → `workflow-management/worker/workflow-engine/**/__pycache__/`).

### §2 · Shared image (`worker/workflow-engine/Dockerfile`)
Carry over the pinned base, `uv pip install --require-hashes -r requirements.txt`, `COPY runtime/ /app/runtime/`, and `PYTHONPATH=/app`. **Add** the Postgres client install (`postgresql-client`) as `USER root` before dropping back to `USER kestra`. Update the header comment from the rm04 "dedicated rating engine" framing to the platform framing (shared `workflow-engine` image serving both functions, process runner, ACA/no-DinD). Re-hash `requirements.txt` only if a package is added.

### §3 · `kestra/kestra.yml`
Semantics unchanged. Refresh the header cross-references to `workflow-management/…` paths and the renamed bicep module (`workflow-engine-container-app.bicep`). `default-namespace` stays `rating` (flows are namespace-qualified; the default only affects an unqualified deploy — note this in the comment). Keep the process-runner `tmp-dir` and the Azure storage field notes verbatim.

### §4 · Infra rename (root `infra/`, files stay put, identifiers change)
- `infra/bicep/modules/rating-engine-container-app.bicep` → `workflow-engine-container-app.bicep`; `rating-engine-storage.bicep` → `workflow-engine-storage.bicep`.
- `infra/bicep/main.bicep`: module refs, params `ratingEngine*` → `workflowEngine*`, ACR image `rating-engine:bootstrap` → `workflow-engine:bootstrap`.
- Container name literal `rating-engine` → `workflow-engine`; ACR repo `rating-engine` → `workflow-engine`; KV secret `rating-engine-client-secret` → `workflow-engine-client-secret`.
- Storage env var `RATING_ENGINE_AZURE_ACCOUNT_NAME` → `WORKFLOW_ENGINE_AZURE_ACCOUNT_NAME`. **Keep the non-`KESTRA_STORAGE_AZURE_*` prefix** — renaming it into the `KESTRA_STORAGE_AZURE_` namespace re-triggers the Micronaut nested-map collision documented at `rating-engine-container-app.bicep:230-239` and `kestra.yml:57-68` (Micronaut lowercases + splits on `_`, creating a bogus nested `account` map that Jackson rejects).
- `RATING_ENGINE_VERSION` env var → **keep** (it stamps rating's `rating_engine_version` column; its value is the workflow-engine image digest). The Azure Files share may stay `rating-landing` (it is rating's usage-file input).
- CI bicep-validate paths (`azure-pipelines.yml`) point at the renamed module files.

### §4b · Topology config — default shared, splittable (objective d, D-E)
- Add a `topology` param (`@allowed(['collapsed','split-by-module','enterprise'])`, default `collapsed`) to `main.bicep` and set it per env in `infra/bicep/parameters/*.bicepparam` (`dev`/`staging` = `collapsed`; `prod` may select `split-by-module`).
- `collapsed`: one `workflow-engine-container-app` module instance carrying both namespaces. `split-by-module`: the module instantiated twice with `-rating` / `-billrun` suffixes, each with its own managed identity + storage module.
- Resolve the app's `billRunEngineConfig` inputs (`BILLRUN_ENGINE_URL`, `BILLRUN_ENGINE_NAMESPACE`) from the chosen topology's instance via the env templates (`infra/env/.env.*.template`, `.env.example`). Assert each namespace/role/credential is standalone so a split needs no new secrets (guardrails a–e).
- **No `services/` or `app/` code change** — the registry is already by-name.

### §5 · CI (`infra/azure-pipelines.yml`, `infra/zap-scan-rating-engine-stage.yml`)
- Stage `containerize_rating_engine` → `containerize_workflow_engine`; build context `rating-engine/worker` → `workflow-management/worker/workflow-engine`; image tag `…/rating-engine:…` → `…/workflow-engine:…`; `requirements.txt` hash-validate path updated.
- Stage `deploy_rating_flows` generalizes to **deploy all functions' flows** (see §7b) and is renamed `deploy_workflow_flows`; flow-mount `rating-engine/flows` → `workflow-management/flows/…`.
- `rating_fanout_gate`: compose `-f rating-engine/dev/docker-compose.dev.yml` → `-f workflow-management/dev/docker-compose.dev.yml`; `.env` copy/source + `RATING_LANDING_HOST_DIR` paths under `workflow-management/dev/`; flow validate/deploy mounts under `workflow-management/flows/rating-engine`.
- Rename `infra/zap-scan-rating-engine-stage.yml` → `zap-scan-workflow-engine-stage.yml` and update its references.

### §6 · Dev stack (`workflow-management/dev/docker-compose.dev.yml`)
Rename service `rating-engine` → `workflow-engine`; build context → `./workflow-management/worker/workflow-engine`; all `./rating-engine/{kestra,dev}/…` volume paths → `./workflow-management/…`; `set-kestra-role-password.mjs` invocation path updated; top-level invocation string in the header comment updated. Keep the `RATING_ENGINE_VERSION: dev-local` sentinel, the `KESTRA_CONFIGURATION` Azurite connection-string override, and the **"never mount `/var/run/docker.sock`"** guard.

### §7 · App-repo reference touch-ups (comments/docs only — no logic)
`lib/config.ts:94`, `.env.example:78/94`, `scripts/billrun-live-kestra-smoke.ts`, `README.md` (compose invocations + curl `@flows/billrun/local-dev/…` → `@workflow-management/flows/bill-run-*/local-dev/…`), `infra/docs/engine-access.md`, `infra/bicep/modules/*` doc comments referencing `rating-engine/worker/runtime/…` and `rating-engine/dev/.env.example`. **No** change to `services/billing/*` or `app/api/billrun/*` behaviour.

### §7b · Stand-up flow bootstrap (objective e, D-F)
One idempotent flow-deploy path shared by dev + CI, run after the engine is healthy, using the **already-pinned Kestra image as its CLI** (`docker run … kestra flow namespace update <ns> <dir>` — the same mechanism the pipeline already uses to validate/deploy rating flows):
- **Dev:** add a one-shot `flow-deploy` service to the compose stack (sibling to `kestra-setup`, `depends_on` a healthy `workflow-engine`) that deploys every `workflow-management/flows/<function>/*.y{a,}ml` to its namespace. `up` then ends with rating flows under `rating` and bill-run template flows under `billrun` visible in the UI.
- **CI:** `deploy_workflow_flows` deploys all three functions' flows to their namespaces on the collapsed instance.
- Namespaces `rating` + `billrun` are created/asserted before flow deploy; re-runs re-assert without duplication.
- Bill-run flows deploy as `# STUB` templates (shells only).

### §8 · Doc reconciliations (planning repo — applied with this spec)
Apply the wfm §9 table plus these clarification-driven additions; minimal diffs, no reformatting:

| Doc | Edit |
| --- | --- |
| `wfm-architecture.md` §4.1/§4.2/§5/§6 | "separate workflow-management repo" → **spin-off subdirectory `workflow-management/`**; two-`worker/` drawing → **one shared `worker/workflow-engine/`** (Python + Postgres client); state the **ACA/no-DinD process-runner** rationale; physical engine named **`workflow-engine`**; flip §9 status boxes as each doc lands. |
| `ratemgmt-architecture.md` §1, §7 dev.5 | Kestra = shared platform; rating = function 1; "dedicated instance" = split-by-module topology. |
| `rm04-kestra-deployment-and-local-dev.md` D1 + layout | Reframe D1 as split-by-module topology; rename infra refs `rating-engine`→`workflow-engine`; add ACA/DinD custom-image rationale; new paths. |
| `ratemgmt-code-standards.md` §8 | Flow files under `workflow-management/flows/rating-engine/`. |
| `bm16-processing-flow-engine-registry.md` Design | Skeleton paths → `flows/bill-run-processor/` + `flows/bill-run-distributor/`; `flows/rating-engine/` reserved sibling; cross-ref wfm §5. |
| `billmgmt-architecture.md` §2, `billmgmt-code-standards.md` §7 | Same path realignment; reference wfm §4. |
| `_updatemodule-billing-billrun-phase2-plan.md` D24/D25/§8 | Point registry/topology authority at wfm §5; keep D25 a–e as guardrails. |
| `_newmodule-billrun-rating-workflow-plan.md` banner | Add: one platform, three functions; "separate rating instance" = split-by-module topology. |
| `ratemgmt-progress-tracker.md`, `billmgmt-progress-tracker.md` | Update moved-path references (meaning-changing, not cosmetic). |

---

## Dependencies (packages to install)

- **Shared image:** `postgresql-client` (libpq + `psql`) via the base image's package manager; existing pinned Python libs in `requirements.txt` unchanged (re-hashed only if touched).
- **Flow bootstrap:** none new — reuses the already-pinned Kestra image as its CLI.
- **App side:** no new npm/runtime dependencies (control plane untouched).

---

## Verification checklist

- [ ] `workflow-management/` tree matches D-A; no `rating-engine/` or `flows/billrun/` dirs remain; rating flow bodies byte-identical to pre-move.
- [ ] `docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up` starts a healthy `workflow-engine`; UI reachable; `psql --version` and `python -c "import runtime"` succeed inside it.
- [ ] `grep -r "rating-engine" infra/ docker-compose*.yml` returns only intended function-scoped hits (namespace/role/column), no physical-container references.
- [ ] `az bicep build` on both renamed modules + `main.bicep` succeeds; image ref resolves to `…/workflow-engine:…`.
- [ ] Pipeline stages renamed (`containerize_workflow_engine`, `deploy_workflow_flows`); `azure-pipelines.yml` lint passes; ZAP stage file renamed and referenced.
- [ ] Rating fan-out gate still green (flows deploy from `workflow-management/flows/rating-engine`, engine runs the shared image).
- [ ] **(d)** `topology=collapsed` (default) provisions **one** `workflow-engine` instance carrying both namespaces; `bicep build`/what-if with `topology=split-by-module` provisions **two** — only param + env differences, no `services/`/`app/` diff.
- [ ] **(e)** After `up`, the Kestra UI (and `GET /api/v1/flows`) lists rating flows under `rating` **and** bill-run template flows under `billrun`; re-running the bootstrap is idempotent (no duplicates).
- [ ] App unit/integration suites unchanged and green (proves the control plane was untouched).
- [ ] No `[CRITICAL]` invariant, grant, claim-contract, two-writer boundary, or money-math edit in the diff.

---

## Out of scope (this spec)

- Real bill-run compute (correlation/calculation/tax) — billing phase 2 (bm14–bm21).
- Real rating computation (PRP mapping, RP price resolution) — rating phase 2.
- Moving to Kestra Enterprise / scoped per-flow tokens — the `enterprise` topology target, later.
- Any change to the app control plane (`services/billing/*`, `app/api/billrun/*`), grants, or DB schema — all already conformant.
