# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- **IN PROGRESS — wfm01 Workflow-Engine Restructure**
  (`context/workflow-management/specs/wfm01-engine-restructure.md`). Restructure the
  workflow-engine code into the wfm platform shape: spin-off `workflow-management/`
  subdirectory with function-first `flows/`, one shared process-runner
  `workflow-engine` image, physical rename `rating-engine` → `workflow-engine`,
  topology as a single deploy parameter (default `collapsed`), and stand-up that
  deploys both functions' flows into the running engine. Executing **code changes
  §1–§7b** in this app repo; **§8 doc reconciliations are the planning repo's** and
  are out of scope for this session. No `[CRITICAL]` invariant/grant/claim/two-writer/
  money-math touched.

  Done (§ = wfm01 spec section):
  - [x] §1 Directory move → `workflow-management/` (D-A move map, `git mv`); removed emptied
        `rating-engine/`, `flows/billrun/`; `.gitignore` pycache glob; new function READMEs.
        Rating flow + worker-runtime bodies verified byte-identical (git-hash match).
  - [x] §2 Shared `worker/workflow-engine/` image — added `postgresql-client` (USER root), platform header.
  - [x] §3 `kestra/kestra.yml` header cross-refs + default-namespace note (semantics unchanged).
  - [x] §4 Infra bicep rename `rating-engine-*` → `workflow-engine-*` (kept `RATING_ENGINE_VERSION`,
        `rating_engine_version`, `rating-landing`). `az bicep build` clean.
  - [x] §4b Topology deploy param (`collapsed` default | `split-by-module` | `enterprise`) + per-env
        bicepparams; ACR/KV grant params → arrays for the split; easy-auth gated to collapsed;
        NO `services/`/`app/` change.
  - [x] §5 CI stages `containerize_workflow_engine` / `deploy_workflow_flows`; ZAP stage file renamed; YAML parses.
  - [x] §6 Dev compose service `rating-engine` → `workflow-engine`, paths under `workflow-management/`; compose config parses.
  - [x] §7 App-repo comment/doc touch-ups only (no `services/billing/*` or `app/api/billrun/*` logic change).
  - [x] §7b Idempotent stand-up flow bootstrap: dev `flow-deploy` one-shot (engine healthcheck +
        deploy all 3 functions to their namespaces) + CI `deploy_workflow_flows` generalized; billrun flows as `# STUB` shells.
  - [x] Verification: typecheck clean; `az bicep build` clean; pipeline/compose parse; tree matches D-A;
        no `[CRITICAL]` invariant/grant/claim/two-writer/money edit.

  Judgment calls / reconciliations (surfaced for review):
  - §3 vs §4 storage env var: renamed the whole `RATING_ENGINE_AZURE_` prefix →
    `WORKFLOW_ENGINE_AZURE_` consistently across bicep + kestra.yml + dev `.env.example` + dev compose
    (a half-rename would break `${...}` interpolation). Two stale bicep-filename refs INSIDE
    kestra.yml's storage note were left verbatim per §3.
  - Rating INTEGRATION tests (rm06–rm13) hard-code `join(process.cwd(),"rating-engine",...)`; the §1
    move breaks them, so path literals were updated to `workflow-management/...` (under-scoped by the
    spec, necessary for the move). Not run here (need the disposable test DB).
  - `acr.bicep`/`key-vault.bicep` engine-grant param generalized `string` → `array` so split-by-module
    grants both engine identities. easy-auth scoped to collapsed (split ingress = later, rm05).
  - §8 doc reconciliations are the PLANNING repo's (per the spec header) — NOT done in this code repo.

  Post-review fixes (xhigh code-review, all applied + verified):
  - [x] flow-deploy called bare `kestra` under a bash entrypoint (not on PATH) → now `/app/kestra`.
        Verified: `up flow-deploy` exits 0.
  - [x] deploy loops targeted bill-run function ROOTs (no deployable flow there; the *.template.yml is a
        non-deployable contract doc, CLI doesn't recurse) → now target `<fn>/local-dev`. VERIFIED end-to-end:
        `rating` ns = 4 flows, `billrun` ns = bill_run_processing + bill_run_distribution (API-confirmed).
  - [x] CI `deploy_fn`/rating_fanout_gate invoked `"$IMG" kestra flow …` (leading `kestra` = "Unmatched
        argument" under the default `/app/kestra "$@"` entrypoint) → dropped the `kestra` prefix. Also
        DROPPED the standalone `flow validate` step — deprecated + server-connecting in v1.3.35; `flow
        namespace update --server` validates server-side on ingest.
  - [x] split-by-module: both container-app instances hardcoded ACA env-storage name `rating-landing` →
        added `landingEnvStorageName` param (billrun split = `billrun-landing`); collision gone. `az bicep build` clean.
  - [x] split billrun instance now sets default namespace `billrun` (`defaultNamespace` param); documented
        the remaining shared-`kestra`-DB/JDBC-queue limitation as deferred to phase 2 (true isolation needs a
        second kestra DB or Enterprise edition).
  - [x] Corrected the misleading easy-auth+split "fails fast" comment (it safely skips; split ingress is internal)
        and the `enterprise` topology comment (currently deploys the collapsed single-instance shape; edition/tokens deferred).
  - Deferred (low): shared path-literal helper for the 9 rating integration tests (cleanup only).

  Pre-existing (NOT wfm01): the app unit suite is 2985/2999 green; 14 failures in 4 order/subscription
  action test files (`create-order`, `resume/suspend/terminate-subscription`). Their test files,
  subjects, and shared deps are all unmodified vs HEAD and outside wfm01's blast radius — they fail at
  HEAD, independent of this change. Flagged for separate investigation.

## Previous Goal (done)

- Implement `_change-id-padding-standardization-plan.md`: widen the 9 non-compliant
  domain-table ID DEFAULT expressions (6/7 → 8 digits), loosen the exact-length
  validation regexes to `\d+`, update the affected integration tests, and pin the
  width in `code-standards.md` #18.

## Completed

- Change: Standardize Human-Readable ID Sequences to 8-Digit Padding
  (`_change-id-padding-standardization-plan.md`) — code complete.
  - [x] 4.1 Migration — the 8-digit `SET DEFAULT` widening shipped folded into the
        base CREATE migrations (`0006`/`0009`/`0012`), not a standalone `0023`
        (see *Migration-chain consolidation* below); the drizzle-kit baseline was
        later re-generated as `meta/0021_snapshot.json`.
  - [x] 4.2 Drizzle schema — 9 lpad `6/7 → 8` edits across product.ts, customer.ts,
        billing/accounts.ts, billing/catalogs.ts, billing/ledger-binding.ts.
  - [x] 4.3 Validation — 23 regexes → `^PREFIX\d+$` across 15 files (FIN, BAN, BCY,
        ORG, PRDOFR). CTMD/PTRL/DLN left at `\d{8}` per plan default.
  - [x] 4.4 Tests — 5 integration tests → `^PREFIX\d{8}$` for fresh inserts.
  - [x] Plan gap fixed: 3 unit tests in `tests/validation/` asserted the removed
        exact-width rejection (parse-accounts-context, organization.schema,
        offering-list.schema) — realigned to the `\d+` shape contract. (§4.4 only
        listed integration tests; these were under-scoped by the plan.)
  - [x] 4.6 Docs — `context/code-standards.md` #18 pins width to 8 and documents
        the `^PREFIX\d+$` validation rule.
  - [x] typecheck clean, lint clean, full unit suite green (2097 tests).

- Migration-chain consolidation (folded 0022 + 0023 into originals):
  - [x] `0006_product.sql` — PRDOFR/PRDOFP/PRDSMD lpad `6 → 8`.
  - [x] `0009_customer.sql` — ORG lpad `7 → 8`.
  - [x] `0012_billing_module_tables.sql` — BAN/FIN/BCY/GLM/LBD lpad `6 → 8`;
        `reference_date` column created directly as `entry_date`.
  - [x] Deleted `0022_document_rename_reference_date_to_entry_date.sql` and
        `0023_widen_id_sequence_padding.sql`; removed journal idx 22 & 23
        (tail truncation — no renumbering; journal now ends at 0021).
  - [x] `db/schema/billing/documents.ts` comment updated (no longer cites the
        deleted 0022 migration).
  - [x] Structural verification: 22 .sql = 22 journal entries, every tag has a
        file, zero leftover 6/7-digit lpad, zero `reference_date` in migrations,
        schema TS (source of truth) already matches (entry_date + 8-digit).
  - Safe because ALL databases are rebuilt from 0000 (user-confirmed) — editing
    already-applied migrations is otherwise a divergence hazard.

## Verification (DB rebuilt from 0000)

- Full rebuild run (steps 1–6): drop schemas → `db:migrate` as superuser →
  `db:bootstrap-roles` → `db:setup-partman` → seeds. §7 checklist confirmed by
  read-only query against the live DB:
  - 22 migrations applied, ledger `0000` → `0021` (no stale `0022`/`0023`).
  - `billing.document` has `entry_date`, no `reference_date`.
  - All 9 widened tables' ID defaults are `lpad(..., 8, '0')`; new inserts are 8-digit.
  - partman: `core.audit_log` config present; premake future partitions only
    partially created (known/accepted — a prior partman run left stale state;
    audit writes land in the default partition).
- NOT run against the live dev DB: `vitest --config vitest.integration.config.ts`
  — it drops+rebuilds all schemas (destructive) and would wipe the just-seeded
  DB. Run it on CI / a disposable DB for the end-to-end proof.
- Seed data: the rebuild produced a uniform 8-digit baseline, so option (a)'s
  mixed-width case does not arise; no legacy narrow rows remain.

## Open Questions

- Seed data: going with §5 option (a) — leave existing narrow-width rows as-is
  (recommended default). Reseed (option b) only if a clean baseline is later wanted.

## Architecture Decisions

- Human-readable domain-table IDs standardize on 8-digit zero-padded suffix
  (`PREFIX + lpad(nextval(seq), 8, '0')`). DEFAULT-expression change only; column
  stays `text`, sequence stays `BIGINT`. Existing rows keep their stored width.
- ID validation regexes use `^PREFIX\d+$` (shape, not fixed width) for the widened
  IDs so legacy-narrow, newly-widened, and future widths all stay valid; the
  always-8-digit IDs (party_role, contact_medium, document_line, document) keep
  `^PREFIX\d{8}$`.

## Session Notes

- Snapshot convention deviation from the plan is intentional; see In Progress note.
- No 6/7-digit width assumptions exist outside `validation/` and `tests/` (swept
  app/, components/, lib/, services/, db/).
