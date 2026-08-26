# Rating Management Module — Architecture

This document **extends `context/architecture.md`** (the platform-wide architecture every module inherits — stack, folder boundaries, DB design, auth platform, and platform invariants) and records **only what the Rating Management module adds or does differently**. Functional design and user flows live in `ratemgmt-project-overview.md`; the design decisions and their reasoning are in `_newmodule-rating-engine-plan.md`; the boundary to the bill run is in `_newmodule-billrun-rating-workflow-plan.md`.

**Status:** Planning. Inherits every platform invariant in `architecture.md` §7 except where §7 below records an explicit, signed-off deviation.

**One-line summary of the deltas:** this is the **first module that is not a Next.js application module** — it has no pages, Server Actions, components, or RBAC permissions. It introduces (1) **rating logic that lives outside the application repository**, in workflow definitions deployed to Kestra; (2) the platform's **first file storage** and **first second database**; (3) a **third Postgres role** whose grants are the rating/billing boundary; and (4) an **operator surface that is not the application** — Billing Ops works in the workflow engine's own UI behind an Entra proxy.

> **Four platform statements this module deviates from** — each is deliberate and recorded in §7: one logical database (§4), no file storage in v1 (§3), one least-privilege DB role (§4), and every mutation writing `core.AUDIT_LOG` (Inv #8).

---

## 1. Stack — module additions

Everything in `architecture.md` §1 still holds for the application (Next.js + Route Handlers/Server Actions over `services/`, Drizzle on Azure Flexible Server PG ≥ 16, Better-Auth, Container Apps, no cache/CDN). The rating module adds:

| Layer | Technology | Role |
| --- | --- | --- |
| **Rating compute + orchestration** | **Kestra (OSS edition)** — separate Container Apps deployment | Both the orchestrator **and the compute engine**. Rating logic is expressed in the workflow definitions themselves, not only in called code — which is why `rating_flow_revision` is stored on every rated row (§6, Inv #12). Vendor-neutral naming is **not** used in this module: unlike Bill Run, the engine here is load-bearing and named. |
| **Rating worker runtime** | **Custom Kestra worker image** (Docker, own registry tag) | Azure Container Apps provides **no Docker daemon**, so Kestra's Docker task runner is unavailable and tasks execute on the **process runner** — inside the worker container. The rating runtime and its dependencies are therefore baked into a custom image, and a Kestra version upgrade requires rebuilding and revalidating it. |
| **Engine state store** | **Second Postgres database**, same Flexible Server instance | Kestra's own queue, execution and flow-revision tables. A separate database (not a `kestra` schema on the billing database) so its **automatically-run schema migrations hold no `CONNECT` on the billing database** — see §7 item 1. |
| **Table partitioning** | **`pg_partman` + `pg_cron`** on Azure Flexible Server | Monthly range-partitioning of `rating.udr_rated` and `rating.process_log` on a `date` control column; premake + **detach-and-archive** — `udr_rated` at 7 years, `process_log` at **24 months** (rm01 D7). Registered on the **existing** daily maintenance job — no second `cron.schedule_in_database`. A DB-level scheduler, not app code. |
| **File storage** | **Mounted volume** (Azure Files for landing; **Azure Blob preferred for archive** and for Kestra internal storage) | Four locations: `landing/`, `archive/`, `error/`, `logs/`. The platform's first use of file storage — see §3. |
| **Operator surface** | **Kestra UI behind an Entra-authenticated reverse proxy** (Container Apps built-in auth — Easy Auth) | There is no application UI in v1. Authentication and access logging happen at the proxy; Kestra OSS itself sees one shared credential. |
| **Local development** | **Docker Compose**, extending the app repo's existing `docker-compose.dev.yml` and its custom `infra/docker/postgres` image (`pg_partman` + `pg_cron` baked in) | Runs the **same custom worker image** and the **process runner** as production. **The Docker socket is never mounted** — ACA provides no Docker daemon, so a local Docker task runner would let a developer write flows that cannot work in production. |
| **Price source** | **`product` / `ordering` / `inventory` schemas**, `SELECT` only | Effective-dated price resolution reads `product.product_offering_price` (start-dated chain, end bound derived by `lead()`), the pinned `product_offering` version, and `ordering.order_item_price_override`. |

---

## 2. System boundaries — repository and folder ownership

**This module spans two repositories.** That is the primary structural delta: `architecture.md` §2 describes folder ownership inside one deployable, and the rating module's logic does not live there.

| Repository / path | Owns | Must NOT contain |
| --- | --- | --- |
| `enterprise-billing-app` → `db/schema/rating/**` | Drizzle schema for the four `rating` tables; the `pg_partman` registration for `udr_rated` and `process_log`; the `event_catalog` seed. Contributed to the **one existing Drizzle migration history**, exactly like `product` and `billing`. | Rating logic; flow definitions; any write path into `rating.*` at runtime. |
| `enterprise-billing-app` → `db/bootstrap/rating-db-roles.sql` | The `rating_runtime` role, its enumerated grants, the explicit `REVOKE` on `billing` writes, and the **column-scoped** `GRANT UPDATE` to `app_runtime` on `udr_rated`. Follows the existing per-table enumerated-grant precedent (the pgledger exclusion block). | Schema DDL; seeds. |
| `enterprise-billing-app` → `db/repositories/rating/**` | **Read-only** repositories the app uses to display or claim rating data, plus the bill run's six-column claim write. The only place SQL touching `rating.*` lives on the app side. | Any write outside the six claim columns. |
| *(rating repo)* → `flows/**` | Kestra flow definitions. **Contains the rating logic** — PRP mediation and validation rules, RP price resolution and calculation, RL guards and load sequencing. Deployed to Kestra independently of the app. | Credentials; DDL; anything that writes `billing.*`. |
| *(rating repo)* → `worker/**` | Dockerfile and any code baked into the custom worker image; the pinned Kestra base version. | Flow logic that belongs in `flows/**`. |
| *(rating repo)* → `infra/**` | Container Apps definitions for the engine, the volume mounts, the reverse-proxy configuration, and Key Vault wiring for the three credentials. | Application code. |
| *(rating repo)* → `dev/**` | The local development stack: `docker-compose.dev.yml` joining the app stack's network, bind-mounted `landing`/`archive`/`error`/`logs`, sample usage fixtures, `.env.example` with dummy values. | Real credentials; a Docker socket mount; any production-only definition. |

**What this module does not own, in the app repo:** no `app/**` route, no `actions/**`, no `components/**`, no `validation/**` entry for a user-facing input, and **no `core.PERMISSIONS` rows**. A module with no pages declares no page permissions; §4 explains what replaces them.

**Cross-schema boundary.** `rating` ⇄ `billing` are joined by plain-text `(billrun_ref_id, billrun_ban_id, billrun_attempt)` — **no cross-schema foreign keys in either direction**, so the two deployables' migrations stay decoupled. `rating` → `product`/`ordering`/`inventory` references are likewise plain-text (`udr_subscriber_ref_id`, `udr_price_ref`, `udr_price_override_ref`), not FKs, because rating must be able to record what it resolved even if the referenced row is later retired.

---

## 3. Storage model — database vs file vs cache

`architecture.md` §3 states **"All application data lives in Postgres… no file storage or cache tier in v1"** and **"User-uploaded files: none in v1."** This module is the first exception: usage files are the module's input, and the archived raw file is the evidentiary record behind every charge.

| Store | What | Notes |
| --- | --- | --- |
| **Postgres — `rating` schema** | `udr_rated`, `udr_batch`, `process_log`, `event_catalog` | System of record for rated usage. See the column detail in `ratemgmt-project-overview.md` and `_newmodule-rating-engine-plan.md`. |
| **Postgres — partitioned** | `udr_rated`, `process_log` — monthly RANGE on a **`date` control column** (`partition_period`); **detach-and-archive at 7 years for `udr_rated`, 24 months for `process_log`** | Matches the billing tables' partitioned-table pattern and their DETACH-not-drop retention (**the column here is `partition_period`**; `period_partition` is the billing module's spelling and is not used in `rating`), rather than `audit_log`'s drop-on-expiry. `udr_batch` and `event_catalog` are **not** partitioned (files and catalog rows are low-volume). Granularity is fixed when an environment is first built — changing it on a live table is a physical re-partition with downtime, not a config flip. |
| **Postgres — second database** | Kestra queue, executions, **flow revisions** | Not the billing database. Note that with rating logic in the flow definitions, this database holds **part of the rating audit trail** — its backup retention must therefore match the 7-year rating retention, and flow definitions must be independently recoverable. *(Open: the git process for flow definitions is deferred by decision.)* |
| **File — `landing/`** | Incoming raw usage files | Written by upstream. Files are **claimed in the database**, never by filesystem rename (§6, Inv #7). |
| **File — `archive/`** | Processed raw usage files, **7-year retention** | The evidentiary record behind any dispute; retention matches the immutability contract on posted rated rows. Moved **only after** the DB transaction commits. Azure Blob preferred — Azure Files performs poorly on many small files and its locking makes the move non-atomic across concurrent workers. |
| **File — `error/`** | Reject files with per-record reason codes, **24-month retention** | The fix path is "upstream reissues the file", never "edit the row", so rejects need no queryable table and no workbench. |
| **File — `logs/`** | Component log files pending load, **24-month retention** | Swept into `process_log` by a scheduled job independent of the rating flows, so a crashed flow's logs still land. |
| **Cache** | **None** | Per platform. Batch counts and reconciliation are read live from `udr_batch`. |
| **Config** | **All rating configuration lives in Kestra**, not in Postgres | `core.SYSTEM_CONFIG` covers the rest of the application; no rating rows go in it and no `rating` config table exists. **Output-affecting config** (rounding mode, reject threshold) lives in the flow definition or a namespace file **deployed from git**, so it moves with `rating_flow_revision`; the runtime-editable namespace KV store is acceptable only for config that cannot change a rated number (expected cadence, chunk size). Partition granularity and the business timezone remain **build-time** — both re-bucket financial periods, the reasoning `um29` used to make `APP_TIMEZONE` an env var. See `specs/rm00-build-plan.md` §Configuration. |

**Deviations from platform storage conventions, and why.**

| Platform convention | This module | Why |
| --- | --- | --- |
| Human-readable IDs = prefix + zero-padded sequence | `udr_rated.udr_id` and `process_log.log_id` are **`uuid` from `core.generate_ulid()`** | Matches `core.audit_log`, the platform's existing high-volume partitioned table. Sequences are wrong at this row count. `udr_batch.batch_id` **does** use the convention (`UDRBAT` + 8 digits) — it is a low-volume domain table. |
| Money is `numeric(18,2)` | Amounts `numeric(18,2)`; **rates `numeric(18,6)`** | A `$0.0035/MB` unit rate rounds to `0.00` at two decimals and the charge silently becomes zero. Both raw and rounded amounts are stored. |
| `services/accounts/money.ts` is the only place money arithmetic is implemented | Rating performs its own `quantity × rate` multiplication | `money.ts` works in integer sen and throws `MoneyPrecisionError` above 2 dp, so a sub-cent rate cannot pass through it. Rating rounds **once**, and only the rounded amount is handed to `money.ts`. This carve-out must be recorded in `ratemgmt-code-standards.md` so it does not read as a violation. |
| JSONB allowed only when Zod-validated, discriminated per type column | `udr_rate_detail` is Zod-validated, discriminated by `udr_rate_type` | Consistent with the platform rule — noted because it is the mechanism that lets `BLOCK` and the tiering variants be added without a migration. |

---

## 4. Authentication, authorization & data ownership

**There is no human authentication path in this module.** It has no pages and no Server Actions, so the Better-Auth session model in `architecture.md` §5 does not apply to anything it owns. Access is governed at three layers instead:

| Layer | Mechanism | What it protects |
| --- | --- | --- |
| **Operator access** | Kestra UI behind an **Entra-authenticated reverse proxy**; ingress restricted to the corporate network | Who can reach the engine at all. Per-user identity and access logging exist **at the proxy**, using the same Entra identities the app uses. |
| **Engine internals** | Kestra OSS **instance-wide Basic Auth**, credential in Key Vault | Nothing meaningful. The OSS edition has no users, no roles, no read-only, and no per-user action history. |
| **Data access** | **Postgres roles and grants** | The real boundary. What each deployable can read and write is a database fact, not a convention. |

**Accepted risk — stated, not implied.** Anyone who passes the proxy holds full instance rights inside Kestra, which — because rating logic lives in the flow definitions — means **the ability to change how money is calculated, in production, with no per-user audit record inside the engine.** The proxy records who accessed the UI; it cannot record what they changed. This is a deliberate, signed-off accepted risk for v1, mitigated by network restriction and proxy-level logging, with migration to the Kestra Enterprise edition (scoped, revocable per-flow tokens and a user model) as the phase-2 path.

**Three credentials, distinct blast radius:**

| Credential | Direction | Store | Blast radius |
| --- | --- | --- | --- |
| Kestra Basic Auth | Human/app → engine | Key Vault | Effectively instance-admin on the engine |
| App bearer service token | Engine → app M2M | Kestra Secret, sourced from Key Vault, masked at runtime | Scoped to the bill-run ingest endpoints |
| `rating_runtime` DB password | Engine → Postgres | Key Vault via Managed Identity | `SELECT`/`INSERT` on `rating.*`, `UPDATE` on `udr_rated` limited to `status`, **no `DELETE` anywhere**; `SELECT` on seven enumerated tables elsewhere |
| `kestra_engine` DB password | Engine → its own database | Key Vault via Managed Identity | `CONNECT` + `CREATE` on the `kestra` database only; **no `CONNECT` on the billing database** (Inv #18) |
| Internal-storage credential | Engine → Azure Blob | Managed Identity role assignment (preferred) or Key Vault | Read/write on the internal-storage container only |
| Entra app-registration client secret | Proxy → Entra | Key Vault | rm05's Easy Auth; **not** `.env`, because rm05 is `infra/**` and has none |

**Authorization — grants, not RBAC.** The module adds **no `core.PERMISSIONS` rows**, because it has no pages. The equivalent of the permission matrix is the grant set:

| Role | On `rating.*` | On `billing.*` | On `product`/`ordering`/`inventory` |
| --- | --- | --- | --- |
| `rating_runtime` | `SELECT`, `INSERT`, and `UPDATE` **restricted to lifecycle columns** (§6, Inv #2). No `DELETE`. Connection limit set. | **`SELECT` only**, with an explicit `REVOKE` on every write | `SELECT` only |
| `app_runtime` | `SELECT` on all four tables; **`GRANT UPDATE` scoped to exactly six columns** of `udr_rated` — `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime` | unchanged | unchanged |
| `app_migrate` | Owns the DDL; `ALTER DEFAULT PRIVILEGES **FOR ROLE app_migrate**` grants `SELECT` on future `rating` tables to `app_runtime` | unchanged | unchanged |

The `FOR ROLE app_migrate` form is load-bearing and already documented in `bootstrap-db-roles.sql`: default privileges must attach to the role that creates future tables, not to the bootstrap superuser.

**Data ownership (write boundary).** Each schema has exactly one writer: the rating engine writes `rating.*`; the app writes `billing.*`; Accounts writes `billing.document`/pgledger. **The one deliberate exception** is the bill run's six-column claim write into `rating.udr_rated` — column-scoped at the grant level, so "billing writes only the claim columns" is enforced by Postgres rather than asserted in a document.

**Audit.** Platform Inv #8 requires every mutation to write `core.AUDIT_LOG` with an actor. Rating's writes have **no human actor** — they are machine batch operations — so they do not write `core.AUDIT_LOG` and could not populate its `actor` column honestly. The module's audit surface is instead `rating.udr_batch` (what file arrived, what it produced, which flow revision and image processed it) plus `rating.process_log` (what happened and at what severity). Operator-initiated actions — triggering a reprocess — are recorded at the reverse proxy and in the engine's execution history, **not** in `core.AUDIT_LOG`. This is a recorded deviation, not an oversight; see §7.

---

## 5. Background tasks & AI

Consistent with `architecture.md` §6: **no AI/ML components**, and **the application still runs no schedulers, cron jobs, or background workers.** Everything scheduled in this module runs outside the application:

| Mechanism | Where it runs | Why it is not an app job |
| --- | --- | --- |
| **Rating pipeline** (PRP → RP → RL) | **Kestra**, triggered by file arrival in `landing/` | A separate deployable. It cannot bypass app authorization because it is not application code; it is bounded by its Postgres grants instead. |
| **Log sweep** | **Kestra**, scheduled, independent of the rating flows | Deliberately not a task inside the rating flow — a crashed flow would never load its own crash. |
| **Completeness check** | **Kestra**, scheduled per `udr_type` | Compares `udr_batch` against the configured expected cadence and raises a clearable `FILE_NOT_RECEIVED`. |
| **Stranded-batch reconciliation** | **Kestra**, on flow start | Resolves `udr_batch` rows left at `PROCESSING` by a killed worker, releasing the claim that would otherwise block reprocessing permanently. |
| **Partition maintenance** | **`pg_cron`** via `pg_partman` | A database scheduler. Registered on the existing daily maintenance job; no second `cron.schedule_in_database` is introduced. |

**Concurrency control.** Flow-level `concurrency: limit: 1` per `udr_type`, backed by the `UNIQUE (file_key, batch_run_num)` claim and, as the final backstop, the live-row unique constraint. Kestra offers no atomic once-only guarantee, so none of the three is optional.

No email/SMTP in v1.

---

## 6. Module invariants

Rules this module must never violate, **in addition to** the platform invariants in `architecture.md` §7. Platform **Inv #18** (financially significant rows are immutable; corrections insert a successor) applies directly and is refined by Inv #2 below. Each is testable; those marked **[CRITICAL]** silently corrupt financial data when violated.

1. **[CRITICAL] Rating never writes `billing`.** Enforced by **three** things, not one: `rating_runtime` holds `SELECT` on two enumerated `billing` tables and no write grant anywhere; an explicit `REVOKE` of every write on `billing.*` as a declaration of intent a reviewer reads and a test asserts; **and `REVOKE EXECUTE … FROM PUBLIC` on the four `billing` `SECURITY DEFINER` pgledger functions**. The third is neither optional nor redundant: `PUBLIC` holds `EXECUTE` by default and a `SECURITY DEFINER` function runs as its owner, so without that revoke `rating_runtime` can post ledger transfers while holding zero table grants — verified on PG 16. Revoking from the role alone is a **no-op** while `PUBLIC` holds the privilege. Asserted by tests that attempt an insert **and** a function call and expect permission errors, plus a standing assertion that no `billing` `SECURITY DEFINER` function is `EXECUTE`-able by `PUBLIC` — so a fifth such function added later without a matching revoke fails the build.

2. **[CRITICAL] Financial content on `udr_rated` is immutable after insert.** Quantity, rate, amounts, currency, price references, lineage and the version columns are never UPDATEd. The **complete** set of updatable columns, by role:

   | Column | `rating_runtime` | `app_runtime` (bill run) |
   | --- | --- | --- |
   | `status` (and therefore the generated `is_live`) | ✔ | ✔ |
   | `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum` | — | ✔ |
   | `upsert_datetime` | — | ✔ |
   | everything else | — | — |

   Six columns for `app_runtime`, one for `rating_runtime`; `status` is the only column both hold, and the `status` CHECK bounds the vocabulary but cannot separate which value each role may set — an accepted residual. **There is no `superseded_by_udr_id` and no `supersede_reason` column on `udr_rated`**; earlier revisions of this invariant listed both. rm01 D11 moved the lineage to `udr_batch` (`superseded_by_batch_id`, `supersede_reason`) because supersession marks predecessors *before* inserting successors, so a per-row successor pointer is not populatable at the moment it would have to be written. Enforced by **column-scoped grants**, per role. **No role holds `DELETE`** — a rated row leaves the table only when its partition is detached. *(Refines platform Inv #18: a correction inserts a successor and marks the predecessor `SUPERSEDED`; it never edits the predecessor's numbers.)*

3. **[CRITICAL] At most one live row per natural key, enforced by the database.** `UNIQUE (partition_period, start_datetime, udr_key, is_live)`, where `is_live` is `GENERATED` from `status`. `udr_key` is indexed directly — no hash column; `CHECK (char_length(udr_key) <= 512)` keeps the index entry clear of the 2,704-byte btree limit (worst case 2,048 bytes at four-byte UTF-8). Two live rows for one usage record must abort the transaction even when the application logic that should have prevented it is wrong, raced, or skipped. Application-level checks are a better error message, never the guarantee.

4. **`udr_rated` has no run-number column, so no run number can enter its uniqueness constraint.** `batch_run_num` lives on `udr_batch`, where it *is* half of the file-claim key `UNIQUE (file_key, batch_run_num)` — the one uniqueness constraint it belongs to (Inv #7). Including it would mean run 2 never collides with run 1, and the constraint would fire on exactly nothing.

5. **[CRITICAL] Supersession is by `file_key`, across all partitions.** `file_key` is the logical identity of a delivery, derived by PRP **from the filename** using a rule predefined per `udr_type` — never from file content, because the claim happens before parsing (Inv #7). **Never scope supersession by `source_file`** — a reissue under a different physical filename would then supersede nothing, and a reissue with corrected timestamps would leave both versions live. `source_file` is forensics only. A corrected record may carry a corrected `start_datetime` that moves it into a different partition, where the unique constraint cannot see its predecessor. Supersession that scopes itself to the current period leaves two live rows and double-bills.

6. **[CRITICAL] A batch colliding with a live `BILL_APPROVED` row is refused whole.** RL writes nothing and raises `LOAD_BLOCKED_BILLED`. This is a deliberate exception to the record-level default: a collision with an approved invoice means the file's assumptions about the period are wrong, which is a human decision, not a per-record disposition.

7. **File claiming is a database constraint, never a filesystem operation.** `UNIQUE (file_key, batch_run_num)` on `udr_batch` decides who owns a file. Rename-to-`processing` is not the mechanism, and flow-level locking is not a substitute — the engine provides no atomic once-only guarantee.

8. **[CRITICAL] The transaction boundary is inside RL.** The `BILL_APPROVED` guard, the supersede, and the insert are one transaction or none of them happened. PRP → RP → RL are three processes with no shared transaction; flow-level recovery is re-running the batch, which is safe only because of Inv #3.

9. **The raw file is archived only after the database transaction commits.** A worker killed before the commit must leave the file recoverable in `landing/`.

10. **Never fan out per record.** Tasks are per file or per chunk. The OSS JDBC queue makes every task state transition a polled database row; per-record tasks at this volume would degrade the engine and its host instance. A design that tempts toward per-record tasks is the signal the engine is being used wrongly.

11. **Per-record rejects never become per-record log rows.** Rejects go to the reject file; the batch emits **one** summarised `process_log` row with counts and a pointer. Otherwise `process_log` becomes the largest table in the database and alerting drowns.

12. **Rating logic is fully identified by two columns.** `rating_engine_version` (worker image tag — which can vary **within** a batch during a rolling Container Apps revision) and `rating_flow_revision` (the Kestra flow revision, which cannot). Both are stored on every rated row because rating logic lives in both artefacts. Neither alone reconstructs a historical charge.

13. **Price resolution is event-time and snapshotted.** RP resolves the price effective at `start_datetime` through the pinned `product_offering` version, and writes the resolved inputs — rate, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`, `udr_rounding_mode` — onto the row. The arithmetic must be reproducible **without** re-resolving against product data. This is not optional: `ordering.order_item_price_override` carries no temporal columns, so a later override would otherwise retroactively change what earlier usage re-rates to.

14. **[CRITICAL] Every emitted `event_code` resolves in `event_catalog`, and severity is never hardcoded at a call site.** Resolution has **three** outcomes and they must stay distinguishable: a catalog row carrying a severity → that severity; a catalog row whose `default_severity` is **NULL** → `perceived_severity` NULL, meaning *catalogued and deliberately not alarm-worthy*; **no catalog row → `INDETERMINATE`**, the hygiene metric, whose count must be zero. Whether an event alarms **at all** is therefore a catalogued fact, not a judgement the emitting component makes — the same reason the severity value itself is not. The resolver keys off **row presence**, never severity nullity: `COALESCE(default_severity, 'INDETERMINATE')` collapses the second outcome into the third and permanently voids the metric. Alert rules key off `event_code`, never log text.

15. **`partition_period` always matches `start_datetime`.** RL writes it, so it can be wrong, and a wrong value files a row where the unique constraint cannot see its twin. Enforced by a `CHECK` constraint using an **explicit** `AT TIME ZONE` — `date_trunc` on a `timestamptz` without one is session-dependent and will accept a row in one session and reject the identical row in another. The literal is **`UTC`**, centralised in the `IMMUTABLE` helper `rating.period_of()` (§7 item 12; rm01 D3): `partition_period` is a physical storage bucket, not the billing month.

16. **[CRITICAL] Rated rows for an approved run are immutable and retained for the invoice's statutory life.** The rating subsystem may not purge or overwrite a run's charge rows once the run is `APPROVED`. This is the rating side of the cross-team contract in `billmgmt-architecture.md` Inv #14, and it is what makes `customer_bill.charge_checksum` meaningful. Retention is by partition DETACH, never `DELETE`.

16a. **`udr_resource` is nullable and its semantics are deferred.** It is reserved for additional rating context and carries no defined meaning in v1. Do not populate it with an improvised value; a column filled by whatever the first implementer assumed is worse than an empty one. Defining it is a spec change.

17. **No cross-schema foreign keys in either direction.** `rating` ⇄ `billing` join on plain-text `(run, ban, attempt)`; `rating` → `product`/`ordering`/`inventory` references are plain-text so a resolved price reference survives the referenced row being retired.

17a. **Grants are held on the parent table only, and all access goes through the parent.** Partitions carry an empty ACL. Verified: a partition created *after* the grant is reachable via `rating.udr_rated`, so `pg_partman` creating next month's partition never breaks access — but a query naming a partition directly is refused. Do not grant on partitions to "fix" that; route the query through the parent.

18. **Rating migrations never touch `billing`, and the engine's migrations never touch either.** `rating.*` DDL is contributed to the app's single Drizzle migration history, so the first half needs only code review. The second half is enforced by privilege — but **not by default**. `PUBLIC` holds `CONNECT` on every database unless revoked, and a role with no grants of any kind connects successfully (verified), so "the engine's role holds no `CONNECT`" is a statement about an ACL that must be **made** true: `REVOKE CONNECT ON DATABASE <billing> FROM PUBLIC`, then explicit grants to `app_runtime`, `app_migrate` and `rating_runtime` only. rm03 performs that revoke; rm03a creates `kestra_engine` afterwards. **The order is load-bearing** — a role created before the revoke inherits access through `PUBLIC` and this invariant is false from the moment the role exists. The same revoke is applied in the reverse direction on the `kestra` database, so `rating_runtime` and `app_runtime` cannot reach the engine's database either.

---

## 7. Recorded deviations from the platform architecture

Each of these contradicts a statement in `context/architecture.md`, or introduces a module-specific rule the platform standards do not carry. They are listed so the divergence is a decision on record rather than a discrepancy someone discovers later. Per that document's own header, changes to Platform Invariants require a documented design review — **items 1, 4, 6 and 7 warrant one, and none has happened** (rm00 open item 10).

| # | Platform statement | This module | Rationale |
| --- | --- | --- | --- |
| 1 | §4: *"All modules run on one Flexible Server instance and one logical database — no per-module database."* | Kestra's state lives in a **second database** on the same instance | Kestra runs its own schema migrations automatically on upgrade and its role needs `CREATE`. A separate database keeps a vendor-controlled DDL path out of the revenue tables. **Note the earlier wording said "structurally impossible rather than policed" — that was wrong.** Nothing is structural until `CONNECT` is revoked from `PUBLIC` (Inv #18); a `datacl` left at its default admits any role. It is now enforced, but by an ACL somebody must maintain, not by topology. PITR and autovacuum remain instance-wide and shared — accepted. |
| 2 | §3: *"All application data lives in Postgres — no file storage… User-uploaded files: none in v1."* | Four **mounted file locations**; archived raw files retained 7 years | Usage files are the module's input, and the archived raw file is the evidence behind every charge. The platform's stated future direction — binary to Azure Blob, DB stores a reference — is exactly what `udr_batch.archive_file_path` implements. |
| 3 | §4: *"One least-privilege role: DML on domain tables…"* | A **third role**, `rating_runtime` | The rating/billing boundary is only real if it is a grant. The role follows the existing per-table enumerated-grant precedent used to keep `app_runtime` off the pgledger internals. |
| 4 | Inv #8: *"Every mutation… writes an entry with actor, timestamp, target, and before/after."* | Rating writes do **not** write `core.AUDIT_LOG` | They have no human actor and could not populate `actor` honestly. The audit surface is `udr_batch` + `process_log`; operator actions are recorded at the reverse proxy and in the engine's execution history. Note the residual gap: **Kestra OSS records no per-user action history**, so "who triggered this reprocess" is answerable only from proxy logs. |
| 5 | §6: *"the external workflow engine (Kestra OSS) that orchestrates the bill-run pipeline"* | Kestra is also the **compute engine**, and rating logic lives in its flow definitions | Accepted for the target volume (100k–5M records/month) provided Inv #10 holds. Re-evaluate if volumes push toward per-record parallelism, if the worker-image coupling makes upgrades painful, or if the §4 access model proves unworkable. Nothing in the data model depends on Kestra; the contract to the bill run is a database schema, not an API. |
| 6 | §4 / `code-standards.md` §6.3: the shared `core` schema and the platform's role model | `rating_runtime` holds `USAGE ON SCHEMA core` and `EXECUTE ON core.generate_ulid()` | A `DEFAULT` that calls a function requires `EXECUTE` **by the inserting role** — verified. Without it every `udr_rated` and `process_log` insert fails. It works today only because `PUBLIC` holds `EXECUTE` by default, which is exactly the default deviation 7 removes elsewhere, so it is granted explicitly rather than inherited. |
| 7 | Platform practice: `PUBLIC` retains its default `CONNECT` and `EXECUTE` grants | A rating bootstrap script **revokes `CONNECT` on the billing database from `PUBLIC`**, and **revokes `EXECUTE` from `PUBLIC` on four `billing` `SECURITY DEFINER` functions** | Both are platform-wide ACL changes made from a rating unit, and both close holes that predate this module — any login role could connect to the billing database and post ledger transfers. Deviation 7 is the one that most needs the design review: it changes behaviour for every existing and future role, not just rating's. |
| 8 | `platform-architecture.md` Inv #13: *"the Entra client secret in `.env`, rotated by redeploy"* | rm05's Entra client secret lives in **Key Vault** | Inv #13 describes the Next.js app, which has a `.env`. rm05 is `infra/**` and has none, and `dev/**` must never hold real credentials. |
| 9 | `code-standards.md` §2.4: *"event-code unions … mirrored by a DB `CHECK` or FK"* | `process_log.event_code` carries **no `CHECK` and no FK** | An unrecognised code must resolve to `INDETERMINATE` and **still load**, because that row is the only evidence an uncatalogued event was emitted (Inv #14). A constraint would delete the evidence. |
| 10 | `platform-architecture.md` §4: `rating` tables reference `core` by FK | **No FK to `core.APPUSER`** from any `rating` table | Rating's writes have no human actor, so the column would be permanently NULL. Consistent with deviation 4. |
| 11 | Platform standards carry no rule about default privileges | In `rating`, `ALTER DEFAULT PRIVILEGES` grants **`SELECT` and nothing else** | `ALTER DEFAULT PRIVILEGES` **cannot be column-scoped** — Postgres rejects it outright, verified. Any default carrying `UPDATE` would be table-wide, silently granting a future rating table's money columns the moment it is created. A future table needing `INSERT` or a column-scoped `UPDATE` gets an explicit grant in the migration that creates it. |
| 12 | `context/architecture.md` §3 partitioning practice | `partition_period` buckets on **UTC**, not the business timezone | The literal lives in exactly one `IMMUTABLE` helper, `rating.period_of()`. `partition_period` is a **physical storage bucket, not the billing month** — a usage event at `2026-09-01 02:00+08` files under August. A future change to the business timezone therefore requires no data migration. The bill run must select its period by `start_datetime`, never by `partition_period`. |
| 13 | Uniform retention across partitioned tables | `udr_rated` 7 years, **`process_log` 24 months** | `process_log` is operational telemetry, aligned to the 24-month retention of the log *files* it is loaded from. |

**Superseded statements in `_newmodule-billrun-rating-workflow-plan.md`.** That document was written before this module was designed and describes rating as continuous, external and undefined. **Eight** of its statements no longer hold:

| # | Superseded statement | What holds instead |
|---|---|---|
| 1 | Rating is continuous / real-time (§1, §2, §9) | Rating is **batch**, file-driven |
| 2 | The app's grant is a single claim-marker column (§3.2) | The bill run writes **six** columns |
| 3 | The `period_partition` key convention (§3.1) | The column is **`partition_period`** |
| 4 | `rating.udr_exception` exists (§3.1, §9) | It does not; rejects go to the reject file and a `status` value |
| 5 | *"the engine's execution history is telemetry, never the audit trail"* (§2) | Rating logic lives in the flow definitions, so the flow revision **is** part of the audit trail |
| 6 | *"no billing logic lives in the workflow definition"* (§2) | Rating logic does; that is the whole design |
| 7 | *"reachable only from the app on a private network, never internet-exposed"* (§5) | Billing Ops operates the engine through its UI, so it is reachable by humans behind Easy Auth with an IP allow-list (rm05) |
| 8 | `ref_bill_run_id` as the claim column (§3.1, §4) | The column is **`billrun_ref_id`**; that document uses both spellings |

Also there: *"Rating role: full rights on `rating.*`"* (§3.2), which Inv #2 contradicts — **no role holds `DELETE`**.

**These are not all reconciled.** An earlier revision of this section claimed five and said all five were fixed; items 4, 6, 7 and 8 are still present in that document verbatim. `ratemgmt-ai-workflow-rules.md` §7.6 requires fixing it when a change contradicts it — that debt is now eight items, and every one of them misleads the billing module.
