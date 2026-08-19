# Billing Management (Bill Run) Module — Architecture

This document **extends `context/architecture.md`** (the platform-wide architecture every module inherits — stack, folder boundaries, DB design, auth platform, and platform invariants) and records **only what the Bill Run module adds or does differently**. User flows and the functional design live in `billmgmt-project-overview.md` and `_newmodule-billing-billrun-plan.md`; the workflow/rating seam is in `_newmodule-billrun-rating-workflow-plan.md`.

**Status:** Planning. Inherits every platform invariant in `architecture.md` §7 unchanged; the rules below are additional and module-specific.

**One-line summary of the deltas:** the module introduces (1) an **external workflow engine** (Kestra OSS) that orchestrates the pipeline and drives the app through the platform's first **machine-to-machine ingest path**, (2) **partitioned high-volume record tables** maintained by `pg_partman`/`pg_cron`, (3) a **claim-based charge boundary** — the app reads and claims already-rated records in the `rating` schema and posts through the existing Accounts document engine, keeping **no billing-side copy of charges**.

---

## 1. Stack — module additions

Everything in `architecture.md` §1 still holds (Next.js + Route Handlers/Server Actions over `services/`, Drizzle on Azure Flexible Server PG ≥ 16, Better-Auth, Container Apps, no cache/CDN). The Bill Run module adds:

| Layer | Technology | Role |
| --- | --- | --- |
| **Workflow orchestration** | **Kestra (OSS edition)** — external, private-network only | Orchestrates the bill-run pipeline: fan-out per account, per-stage completion signals, heartbeat, health/cancel. **Not an app process** — it drives the app via M2M ingest. Schema and code stay vendor-neutral ("the workflow engine", `workflow_execution_id`, `workflow_definition_id`); Kestra is named only in this doc and the plan's §7, where the Basic-Auth / secret-injection specifics are genuinely Kestra's. |
| **Table partitioning** | **`pg_partman` + `pg_cron`** on Azure Flexible Server | Monthly range-partitioning of the four record tables on `period_partition`; daily maintenance (premake + detach-and-archive at the 7-year boundary), driven by a `partition_management` config table. A **DB-level scheduler, not an app job.** |
| **Ledger posting** | **pgledger + the Accounts document engine** (`postDocument`, `INV` documents) | **Reused, not owned.** Bill Run posts one `INV` per billed account inside its own transaction; the INV reason code carries an unlimited `autoPostLimit` so it auto-posts without a per-document approval. See `acctmgmt`/accounts plan. |
| **Charge source** | **`rating` schema** (`rating.udr_rated`, `rating.udr_exception`) — external, **stub in v1** | Source of already-rated Usage Detail Records. Bill Run **reads** (`SELECT`) and **claims** (a single `UPDATE` on the claim-marker column) only; the rating engine owns the rest. |
| **M2M ingest** | Next.js Route Handlers under `app/api/billrun/*`, **service-token bearer auth** | The platform's **first machine-to-machine path** — the workflow engine signals stage/run completion. No session semantics (see §4). |

---

## 2. System boundaries — folder ownership (module slice)

Same inward-pointing dependency rule and the same folders as `architecture.md` §2; the module's pages live under `app/(app)/billing/`. The module-specific ownership:

| Path | Owns | Must NOT contain |
| --- | --- | --- |
| `app/(app)/billing/bill-runs/**` | The "Billing" section pages: run list (Current & Upcoming / Historical), run detail tabs (Workflow, Customers & Bills, Uncharged, Errors, Audit), the posting-progress view. Thin orchestrators; each page declares its `billrun_*` permission + level. | DB queries; raw SQL; permission decisions beyond the guard. |
| `app/api/billrun/**` | **M2M ingest** Route Handlers: `POST /{runId}/stage/{stage}/complete` and `POST /{runId}/status`. Service-token bearer auth, **never `getSession`**; Zod-validate → delegate to the service. | Session semantics; business rules; direct DB access. |
| `actions/**` (billing slice) | Server Actions for **trigger, rerun, cancel, approve, post** — each wrapping validate → mutate → audit in one transaction. Materialization is **not** an action — it is the write on the Bill Runs list page's RSC render (code-standards §3.2), the single materialization entry point. | DB queries; business logic beyond orchestration. |
| `services/**` (billing slice) | Run lifecycle, scoping/validation/claim, aggregation/taxation/verification, and posting orchestration; the four-eyes and double-trigger checks. Framework-agnostic. | `next/*`; request/response objects; UI. |
| `db/**` (billing slice) | Drizzle schema + repositories for the `billing` tables (§3), the `period_partition` partition registration, and the **one claim-marker `UPDATE`** on `rating.udr_rated`. The only place SQL lives. | Business rules; permission checks. |
| `validation/**` (billing slice) | Zod schemas for the two ingest payloads and every action input. | Business logic; DB access. |

**Cross-schema boundary.** `billing` (this module) ⇄ `rating` (external) ⇄ `billing.document`/pgledger (Accounts) are joined by **plain-text `(run, ban, attempt)` keys — no cross-schema foreign keys in either direction**, so the deployables' migrations stay decoupled.

---

## 3. Storage model — database vs file vs cache

Per `architecture.md` §3, **Postgres is the single system of record; no file storage or cache tier in v1.** Module specifics:

| Store | What | Notes |
| --- | --- | --- |
| **Postgres — `billing` schema** | `bill_run`, `bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`, `bill_template_version` | Run/account/bill state. IDs = prefix + zero-padded per-table sequence (`BRN`/`BRA`/`BRS`/`CBL`/…); money is `numeric(18,2)` text-mode. |
| **Postgres — partitioned** | `bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item` — range-partitioned on **`period_partition`** (default **monthly**), **84-partition (7-year)** detach-and-archive | Composite PK/unique keys include `period_partition`. `bill_run` (header, low volume) and `bill_template_version` (catalog) are **not** partitioned. |
| **Postgres — `rating` schema (external)** | `rating.udr_rated` / `rating.udr_exception` — **stub in v1** | Charge records. Bill Run holds `SELECT` on `rating.*` + `UPDATE` on **only** the claim-marker column. **There is no billing-side charge table** — charges are never copied into `billing`. |
| **File storage** | **None in v1** | Invoice PDF rendering + dispatch are deferred (stages 8–9). When built: binary → Azure Blob, DB stores a reference (`bill_template_version` already carries a reserved blob-ref/checksum). |
| **Cache** | **None** | Per platform. Run status and **pre-approval** totals are **derived live** (from `bill_run_account`) and **never cached**; any stored counter must equal the derived value (asserted by test). Distinct from these: the **immutable run total is the `bill_run.total_amount` stamp written once at `APPROVED`** (Inv. #12, code-standards §6.7) — from `APPROVED` onward the run total is read back from that stamp, not re-derived; the live derivation from `bill_run_account` is the source only while the run is unapproved. |
| **Config / flag** | **Stub-data mode** — an environment/config flag (not a per-run column) | Set until the rating engine is live; drives the "Stub data" badge. |

**Charge integrity without a copy.** `customer_bill` stamps `posted_attempt` + `charge_checksum` (a hash of the posted `rating.udr_rated` set) at posting. Review/reprint/audit read the lines back from `rating.udr_rated` by `(run, ban, posted_attempt)`; a later change to a posted line is caught by the checksum. Posted-row **immutability** and **retention** are enforced on the rating side.

---

## 4. Authentication, authorization & data ownership

**Two authentication paths.**

- **Human (UI + Server Actions):** unchanged from the platform — Better-Auth DB-backed session, live status + effective permissions resolved per request (`architecture.md` §5). No authz state in the session.
- **Machine (workflow engine → app):** `app/api/billrun/*` has **no session semantics**. Inbound is a dedicated **bearer service token** (constant-time compare, never logged, Zod-validated, HTTPS-only, rejected unless the run is `PROCESSING`). Outbound (app → engine) is a separate credential (Kestra-OSS instance-wide **Basic Auth** in Key Vault, private-network-only; phase-2 → scoped Enterprise token). The two credentials are independent, one per direction.

**Authorization — three module permissions** (added to `core.PERMISSIONS` by migration, per platform Inv #6; slotting into the platform permission+level model):

| Permission | Grants | Implies |
| --- | --- | --- |
| `billrun_view` | list, drill-down, CSV export | — |
| `billrun_operate` | trigger, rerun, cancel | `billrun_view` |
| `billrun_approve` | approve + post (the money gate) | `billrun_view` |

- A new **Billing Viewer** role carries `billrun_view` alone (Finance, Internal Audit). All three permissions and the M2M path are in the authz-sweep inventory.
- **Four-eyes (segregation of duties):** the user who triggered the **final** attempt can never approve/post the run — enforced in the **service layer**, not the UI. Because INV auto-posts (unlimited `autoPostLimit`), the run-level four-eyes is the **sole** second signature on the ledger.

**Data ownership (write boundary).** Each schema is written by exactly one owner: the app writes `billing.*`; the rating engine writes `rating.*`; Accounts writes `billing.document`/pgledger. **The one deliberate exception** is the claim marker — the app stamps `ref_bill_run_id` + `attempt` on `rating.udr_rated` rows it claims. Customer (MNO) records remain domain data, not tenants; RLS stays unused (platform Inv #16).

---

## 5. Background tasks & AI

Consistent with `architecture.md` §6: **no AI/ML**, and **the application itself runs no schedulers, cron jobs, or background workers.** What would elsewhere be "jobs" is either a per-request computation or an *external* mechanism:

| Mechanism | Where it runs | Why it's not an app job |
| --- | --- | --- |
| **Run materialization** | Per page load (lazy, `ON CONFLICT DO NOTHING`) | A run "exists on the 1st" because any view on/after the 1st creates it — no scheduler. |
| **`STALLED` detection** | Derived on read | Shown when `status='PROCESSING'` and `last_progress_at` exceeds the cycle threshold; nothing writes a stalled row. |
| **Pipeline orchestration** | **External workflow engine (Kestra)** | A separate deployable; it signals the app over M2M and persists nothing in `billing`. It cannot bypass app authorization because it is not in the app. |
| **Partition maintenance** | **`pg_cron` (DB-level)** via `pg_partman` | A database scheduler, not app code. Premake + detach-and-archive only; retention DDL deliberately bypasses the row-level delete guard (retention ≠ correction). |

No email/SMTP in v1 (distribution deferred).

---

## 6. Module invariants

Rules this module must never violate, **in addition to** the platform invariants in `architecture.md` §7. Platform **Invariant #18** (financially significant rows are immutable; corrections insert a successor) applies directly here. Each is testable; several are marked **[CRITICAL]** because a violation silently corrupts financial data.

1. **The bill run never rates.** It only collects already-rated `rating.udr_rated` records and bills them; no charge-computation logic exists in `billing`.
2. **One claim-marker write — no other cross-schema writes, no cross-schema FKs.** The only column the app writes in the `rating` schema is the claim marker (`ref_bill_run_id` + `attempt`); billing↔rating↔accounts join on plain-text `(run, ban, attempt)`.
3. **[CRITICAL] No billing-side charge copy.** Posted charge detail lives only in `rating.udr_rated`; `customer_bill` holds a `charge_checksum` + `posted_attempt`, never a copy of the lines. A change to a posted line is detectable from the checksum.
4. **[CRITICAL] `ref_inv_document_id` is the finalization boundary.** A `customer_bill` with it set is never UPDATEd, DELETEd, or stage-invalidated (DB-enforced); posting resumes by skipping such accounts. (extends platform Inv #18)
5. **[CRITICAL] Idempotency is a database constraint, never the orchestrator.** Replay-safety is the `UNIQUE (ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)` on `bill_run_account_stage`, inserted first inside the stage handler's transaction. The workflow engine provides no server-side dedup.
6. **[CRITICAL] Posting is per-account, in its own transaction, resumable, and never double-posts.** No single multi-INV transaction; an account already carrying `ref_inv_document_id` is skipped on retry; `postDocument` runs inside the caller's transaction, so a crash rolls INV + ledger + stamp back together.
7. **Invoice numbers are consumed only on successful posting.** A trial or `SKIPPED` account reserves none; a rollback may leave a rare gap — tolerated, not a compliance concern.
8. **Four-eyes on the money gate.** The final-attempt trigger actor can never approve/post the run; enforced in the service layer. INV auto-post means this run-level check is the sole second signature.
9. **M2M ingest has no session semantics.** `app/api/billrun/*` never calls `getSession`; it authenticates a bearer service token (constant-time compare, never logged, Zod-validated, HTTPS) and rejects any stage signal unless the run is `PROCESSING` (post-approval signals → 409).
10. **The app runs no schedulers or background jobs.** Runs materialize lazily on page load; `STALLED` is derived on read; the external workflow engine and `pg_cron` are the only schedulers, and neither runs in the app.
11. **`period_partition` is fixed per run, not insert-time.** Every row for a run — including a cross-month rerun — lands in that run's period partition, so the idempotency guard and per-run reads never scatter. Composite PK/unique keys include it.
12. **Run status is recomputed under a row lock, never an incremental counter.** `SELECT … FOR UPDATE` on `bill_run`; account-grain truth is `bill_run_account` / `bill_run_account_stage`, and any cached counter must equal the derived value.
13. **`gl_event_at` is fixed at trigger and defines the GL period.** It is the cycle's billing-run day (not the posting timestamp, not a service-period date); revenue posts to the run-month GL period, which the Accounts **period-close guard** keeps open until the run is `COMPLETED`/`CANCELLED`.
14. **[CRITICAL] Rating rows for an approved run are immutable and retained.** The rating subsystem may not purge or overwrite a run's charge rows once the run is `APPROVED`; posted rows are permanently immutable for the invoice's statutory life. A hard cross-team contract, covered by a test.
15. **Stub-data mode is unmissable and isolated.** While the stub flag is set, every run is visibly badged, and the stub/UAT environment is isolated from any ledger holding real Accounts data.
