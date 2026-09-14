# bm22 — Environmental Gate

**Unit:** bm22 (Phase 3 · Phase J). **Boundary:** infrastructure / DB ops (`db/migrations` apply, `db/bootstrap`, `workflow-management/dev`, `workflow-management/worker/workflow-engine`, CI). **No application code, no schema authored here** (`billmgmt-ai-workflow-rules.md` §1.4 / §4.1). **Specs from:** `billmgmt-update-overview.md` (phase-3 external prerequisites), `bm00-build-plan.md` Unit 22 + the Status block's phase-3 prerequisite list, `billmgmt-progress-tracker.md` **Outstanding (environmental only)**, `billmgmt-known-issues.md` §4.

> **Framing.** Phase 2 shipped feature-complete but **DB-gated** — every migration, partman registration, role/grant boundary, render, blob round-trip and live-Kestra proof was written and statically verified, never executed against real infrastructure (`billmgmt-progress-tracker.md` "Outstanding"). This unit is the **environmental gate**: it runs the whole phase-2-shaped pipeline against real Postgres, real Kestra, a real blob store and a **real SFTP endpoint** for the first time, and closes the two phase-3 external prerequisites that don't yet exist — the SFTP endpoint and the worker-image plugins. It authors **no** phase-3 schema or logic: everything it touches already exists in the repo. It lands first so a migration that fails, or a missing worker plugin, is found **before** `customer_bill_line` (bm23) is stacked on top — a broken migration would shift phase-3's numbering, and a missing plugin is an image rebuild, not a config change (ACA runs no Docker daemon).

> **Reconciliation (codebase, 2026-09-11 — supersedes the "never executed" framing above).** The local dev stack has since been provisioned and verified (`billmgmt-progress-tracker.md`): **all 39 migrations applied** (incl. `0033`, `0035`–`0038`), the **six `billing.*` partman parents registered** (the seventh, `customer_bill_line`, arrives with bm23), **every seed run**, **Azurite serving**, and the **`billrun` namespace live with all six flows deployed** (`bill_run_processing`/`bill_run_distribution` + rating's four). So §§1–2 and §5–6's *apply / register / bring-up* steps are **already done locally** — this gate now **verifies** them rather than performing them from scratch, and drives what genuinely remains: the **SFTP endpoint + `fs.sftp` plugin** (still net-new — distribution is still the loopback placeholder), a **real posted run end to end** (`SCHEDULED → COMPLETED`), the **DB-gated suites against a *disposable* database** (never this provisioned stack — they `DROP SCHEMA … CASCADE` and would wipe its seed data), and **bm18's Chromium-in-container render**. The deployed (Azure) environment is still gated from scratch.

## Goal

Execute every environmental prerequisite that must precede any phase-3 schema change: apply the already-written migrations `0033`, `0035`–`0038` against a real Postgres; run `db:setup-partman-billing`; execute the DB-gated integration suites against a disposable/CI database; build and smoke-test the Chromium render image; bring up the blob store (Azurite local / Azure Blob deployed) and round-trip a checksum-matching PDF; **add and verify** the `azure.storage.blob.Download`, `fs.sftp.Upload` and `core.http.Request` plugins in the custom worker image; **stand up an SFTP endpoint**; and run `npm run billrun:live-kestra-smoke` against a real engine — so a phase-2-shaped run traverses `SCHEDULED → COMPLETED` end to end against real infrastructure.

## Design

**Structural decisions**

- **Infra-first, nothing authored.** This unit applies, runs and verifies existing artifacts; it writes no migration, schema, service, flow or UI. Its "diff" is limited to two genuinely-missing infra pieces (§6 the SFTP Kestra plugin, §7 the SFTP dev service) plus the env-template/docs entries they need. Everything else is a **command run against real infrastructure**, recorded as a gate outcome.
- **Image gaps are rebuilds, not config (D0).** ACA has no Docker daemon, so a plugin absent from the worker image cannot be added at deploy time. Plugin presence is therefore gated **here**, at image-build time — a rebuild of `workflow-management/worker/workflow-engine/Dockerfile`, not a runtime setting.
- **SFTP is net-new, not a verification.** Today the repo carries **no** `fs.sftp` plugin and **no** SFTP container (confirmed: no SFTP task type appears in any flow, no SFTP service in either compose file). bm34 consumes `fs.sftp.Upload` for real; bm22 must therefore *create* the endpoint and *add* the plugin now, not merely assert they exist.
- **Loopback vs. real, selected by environment.** Local dev uses Azurite (`BILLRUN_BLOB_CONNECTION_STRING`) + a local SFTP container; deployed uses Azure Blob (Managed Identity) + the real SFTP target — no code fork, the same selection idiom bm19 established for blob.
- **DB-gated suites run on a disposable database, never the shared dev DB.** The integration configs `describe.skipIf(!DATABASE_URL)` and each suite owns the full schema lifecycle (DROP/migrate/teardown, `fileParallelism: false`); running them against the shared local dev Postgres would wipe seed data and break login. Point `DATABASE_URL` at a throwaway/CI database (the module's established convention, recorded in the tracker).
- **The leap-year defect is a surfaced gate outcome (known-issues §4a).** With the business clock near a month-end, the bill-run date derivation produces `2026-02-29` — an invalid date Postgres rejects (`22008`). Applying the migrations and running `materialize-runs`/`billing-schema`/`trigger-run` **surfaces** it. Its fix is the `scheduled_run_date`/`period_end` month-end clamp (bm02/bm03 date math, scheduled by bm21 T7) plus the `trigger-run` per-case isolation (§4b) — **not** phase-3 app code. bm22 fails closed until both are green; if the delivered derivation still lacks the clamp, that bm02/bm03 correction is a prerequisite of passing this gate.

## Implementation

### 1. Apply the outstanding migrations `0033`, `0035`–`0038` (`npm run db:migrate`)

Against a real Postgres, apply the migrations generated/reviewed but never executed in phase 2 (`billmgmt-progress-tracker.md` "Outstanding"). Each already exists in `db/migrations/`:

- `0033_customer_bill_finalization_guard.sql` — the `BEFORE UPDATE OR DELETE` trigger on `billing.customer_bill` enforcing the `ref_inv_document_id` finalization latch (bm13).
- `0035_bill_run_two_executions.sql` — the `workflow_* → processing_*` rename + `distribution_*` / `*_engine_ref` columns on `bill_run` (bm16).
- `0036_bill_run_invoices.sql` — the partitioned `bill_run_invoices` table + its unconditional immutability trigger (bm19).
- `0037_document_customer_bill_latch.sql` — the structural one-INV-per-bill latch on `document` (bm19 T5, closing known-issues §2).
- `0038_bill_run_distribution.sql` — the partitioned `bill_run_distribution` table + `bill_run.distribution_attempt` (bm20).

(`0034_rating.sql` is the rating module's, applied by its own gate — listed only so the `0033 → 0035` numbering gap is understood, not re-numbered.) A clean apply on a fresh database is the gate; the leap-year surfacing (Design) is expected and handled per known-issues §4a.

### 2. Partition registration (`npm run db:setup-partman-billing`)

Run `db/bootstrap/billing-partman-setup.{sql,ts}` under `BOOTSTRAP_DATABASE_URL` (superuser/owner — `app_migrate` lacks the privilege). Confirm all **six** billing parents registered through `0038` (`bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`, `bill_run_invoices`, `bill_run_distribution`) via `partman.create_parent` (monthly, 7-year detach-and-archive) and that a row dated a future month lands in its **own** partition, not the default. (`customer_bill_line` becomes the seventh parent in bm23 — not here.) Verified by `tests/db/billing-partman-setup.integration.test.ts`.

### 3. DB-gated integration suites (`vitest.integration.config.ts`)

Against the disposable database, run the suites that have never executed:

- `tests/db/billing-e2e-happy-path.integration.test.ts` — the ship-gate journey (materialize → trigger → stage signals → PROCESSED → reject → rerun → approve → post → COMPLETED, incl. the finalization-trigger proof and the bm21 D10 render-pending safety net).
- `tests/db/billrun-db-roles.integration.test.ts` — the two-writer grant boundary (bm14), per column/table/function/database.
- `tests/db/materialize-runs.integration.test.ts` and `tests/db/trigger-run.integration.test.ts` — materialization idempotency and the trigger transaction (surfaces known-issues §4a/§4b).
- Plus the remaining billing DB-gated suites (`billing-partman-setup`, `billing-schema`, `migration`, the schema tests) run green.

### 4. Chromium render image build + smoke

`docker build` the app image (`Dockerfile`, base `node:22-bookworm-slim`, all stages; installs Chromium via `npx playwright install --with-deps chromium`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) and confirm `renderDraftInvoice`/`renderFinalInvoice` produce a real PDF **from that built image** — the proof bm18/bm19 could only review statically (tracker "Outstanding"). The dev-stack render path (`docker-compose.dev.yml` still on `node:22-alpine`) remains bm18's documented, non-blocking gap; note it, don't silently rely on it.

### 5. Blob store round-trip (Azurite local / Azure deployed)

Bring up Azurite (`workflow-management/dev/docker-compose.dev.yml` service `azurite`, `mcr.microsoft.com/azure-storage/azurite`, port 10000) and connect via `BILLRUN_BLOB_CONNECTION_STRING`. Round-trip an invoice PDF through `blobStore.putInvoice`/`getInvoice` and confirm the downloaded bytes' md5 matches the stored `checksum` (bm19's artifact checksum). Deployed environments use `BILLRUN_BLOB_ACCOUNT_URL` + Managed Identity instead — same code path.

### 6. Worker image plugin verification + SFTP plugin add

Against `workflow-management/worker/workflow-engine/Dockerfile` (base `kestra/kestra:v1.3.35@sha256:…`): verify `azure.storage.blob.Download` and `core.http.Request` resolve (both present via the plugin-bundled base image), and **add the Kestra `fs`/SFTP plugin** so `fs.sftp.Upload` resolves — currently absent. Rebuild the worker image and confirm all three task types load in a trivial flow (`kestra plugins list` / a smoke flow that references each). This is a real image change, the one thing in bm22 that must ship as a rebuilt artifact (Design: D0).

### 7. SFTP endpoint (net-new)

Add an SFTP server service to `workflow-management/dev/docker-compose.dev.yml` (a standard SFTP container image, key-auth, a mounted `{remote_base}` matching bm34's `{remote_base}/invoices/{YYYY-MM}/…` layout) and the corresponding `SFTP_*` entries to the env templates (`.env.example`, `workflow-management/dev/.env.example`, `infra/env/*.template`): host, port, user, remote base, and the SSH key / known-hosts material bm34 reads from a Kestra Secret with **host-key verification on**. Local uses the container; deployed points at the real target. No app or flow logic here — the endpoint and its config only.

### 8. Live-Kestra smoke (`npm run billrun:live-kestra-smoke`)

Run `scripts/billrun-live-kestra-smoke.ts` against a real `billrun` engine hosting the deployed placeholder `bill_run_processing` flow, honouring its fail-closed safety gates (`BILLRUN_ENGINE_URL/_AUTH/_NAMESPACE` set, `BILLRUN_PLACEHOLDER_MODE=true`, every scoped account under `_SAMPLE_-BILLRUN-0001`, every candidate charge `_SAMPLE_`-marked). This closes the phase-2 exit criterion bm21 formalized (T3): the smoke script exists but has never run against a real engine because none was deployed. Resolving the three `_TBD_` lines (the separate workflow-management repo, its owner, and its deploy step, per `flows/billrun/README.md`) is a prerequisite of this step.

### 9. Docs / sync

Clear `billmgmt-progress-tracker.md`'s "Outstanding (environmental only)" section as each item is proven; record bm22 as delivered with the concrete run outcomes. Tick the `bm00-build-plan.md` Status block's phase-3 external prerequisites (SFTP endpoint + worker-image plugins) as met. Record any resolution surfaced during the run in the owning doc (known-issues §4a/§4b closure noted where fixed).

## Dependencies

- **No new npm packages.** New **infrastructure**: one SFTP server service in the dev compose (§7); one Kestra `fs`/SFTP plugin in the worker image (§6).
- **Prerequisites:** phase 1 + 2 delivered code; a disposable/CI Postgres (`DATABASE_URL`); `BOOTSTRAP_DATABASE_URL` (superuser); `BILLRUN_BLOB_CONNECTION_STRING` (or `BILLRUN_BLOB_ACCOUNT_URL` deployed); a real `billrun` Kestra engine + deployed placeholder flow with `BILLRUN_ENGINE_URL/_AUTH/_NAMESPACE`; a container runtime to build/run the app + worker images; the new `SFTP_*` vars.
- **External (must exist by end of unit):** the rating engine producing real `RAN_USAGE` into `rating.udr_rated` (rm07–rm13, delivered) and `inventory.product_inventory.billing_account_id` populated (delivered) — not consumed until bm26/bm27 but part of the same environment.

## Verification checklist

- [ ] `0033`, `0035`–`0038` apply cleanly on a fresh real Postgres; the `db/migrations` backlog in the tracker's "Outstanding" is cleared.
- [ ] `db:setup-partman-billing` registers all six billing parents through `0038`; a future-month row lands in its own partition, not the default (`billing-partman-setup.integration.test.ts` green).
- [ ] The DB-gated suites (§3) pass against a disposable database — never the shared dev DB.
- [ ] The `2026-02-29` clamp (known-issues §4a) holds — a seeded run crossing a non-leap February produces a valid date — and the `trigger-run` per-case isolation (§4b) passes; if the delivered derivation still lacks the clamp, the bm02/bm03 fix (bm21 T7) is applied as a prerequisite.
- [ ] The app image builds from `node:22-bookworm-slim` and renders a real PDF from the built image (draft + final).
- [ ] Azurite round-trips an invoice PDF whose downloaded md5 matches the stored artifact checksum.
- [ ] The rebuilt worker image resolves `azure.storage.blob.Download`, `fs.sftp.Upload` **and** `core.http.Request` (the SFTP plugin added this unit).
- [ ] The SFTP endpoint is reachable with key-auth + host-key verification; `SFTP_*` env entries exist across the templates.
- [ ] `npm run billrun:live-kestra-smoke` runs green against a real `billrun` engine (trigger → claim → PROCESSED); the three `flows/billrun/README.md` `_TBD_` lines are resolved.
- [ ] A phase-2-shaped run traverses `SCHEDULED → COMPLETED` against real Postgres, real Kestra, a real blob store and a real SFTP endpoint, using the existing placeholder flows.
- [ ] `billmgmt-progress-tracker.md` "Outstanding (environmental only)" cleared; `bm00-build-plan.md` phase-3 prerequisites ticked; no phase-3 schema or app code introduced by this unit.
