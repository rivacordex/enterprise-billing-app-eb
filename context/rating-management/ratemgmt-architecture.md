# Rating Management Module — Architecture

**As-is design.** Extends `context/architecture.md` (platform stack, folder boundaries, DB design, auth platform, platform invariants) and records **only what Rating Management adds or does differently**. Reflects the PER_UNIT RAN-usage rating build. Functional design and flows: `ratemgmt-update-overview.md`.

This is the platform's only **non-Next.js** module: no pages, Server Actions, components, or RBAC permissions. Rating logic lives **outside the app repo**, in Kestra flow definitions; the module owns the platform's **first file storage** and **second database**, runs as its **own Postgres role**, and is operated through the **workflow engine's UI behind an Entra proxy** — not an application UI.

> **Decision (eng-review, X1+X2).** `partition_period` is intentionally the **billing month** — `period_of()` truncates in the config TZ (`Asia/Kuala_Lumpur`, a fixed `+8`), and the live-row key is `(partition_period, udr_key, is_live)` (one live row per cell per billing month). This **amends** the platform's earlier UTC-physical-bucket choice (Inv 15), justified because a Malaysian deployment's business TZ never changes and billing-month-aligned partitions make bill-run's dominant read a single-partition prune (and each archived partition exactly one billing month).

---

## 1. Stack — module additions

The application stack (`context/architecture.md` §1) is unchanged. The rating module adds:

| Layer | Technology | Role |
| --- | --- | --- |
| Rating compute + orchestration | **Kestra** (OSS) — `workflow-engine`, `rating` namespace | Both orchestrator and **compute engine**; rating logic lives in the flow definitions, so `rating_flow_revision` is stamped on every rated row. Computes **`PER_UNIT`** charges (`ratePerUnit × usage_volume`), replacing the earlier FLAT-only path. |
| Worker runtime | Custom Kestra worker image (process runner) | ACA has no Docker daemon; tasks run in-process in the worker container. A Kestra upgrade means rebuilding + revalidating the image. |
| Engine state store | **Second Postgres database**, same Flexible Server | Kestra queue/executions/flow-revisions. Separate DB so its auto-run migrations hold **no `CONNECT`** on the billing DB. Holds part of the rating audit trail → backup retention matches the 7-year rating retention. |
| Table partitioning | `pg_partman` + `pg_cron` | Monthly RANGE-partitioning of `udr_rated` (7-yr) and `process_log` (24-mo) on the `partition_period` `date` column; detach-and-archive on the existing daily maintenance job. |
| File storage | Mounted volume (Azure Files landing; Blob for archive + Kestra internal storage) | Four locations: `landing/`, `archive/`, `error/`, `logs/`. §3. |
| Operator surface | Kestra UI behind an **Entra reverse proxy** (ACA Easy Auth) | No application UI. Auth + access logging at the proxy; Kestra OSS sees one shared credential. |
| Resolution + price source (read-only) | `customer`, `product`, `ordering`, `inventory` schemas, `SELECT` only | Subscriber resolution reads `customer.party_role.party_role_specification`; rate/unit from the pinned offering's scalar `usage_rate` component; completeness/mapping/fields from `product.ratecard_ran_usage_lkp` + `ratecard_version`; the flow's product config from `product.product_specifications`. |

---

## 2. System boundaries — folder & schema ownership

The module spans two surfaces: the app repo (schema, roles, read repos) and `workflow-management/**` (flows, worker, infra, dev). The rating **logic** lives in the flows, not the app.

| Path | Owns | Must NOT contain |
| --- | --- | --- |
| `db/schema/rating/**` | Drizzle schema for the four `rating` tables; `pg_partman` registration; `event_catalog` seed. One shared migration history. | Rating logic; flow definitions; any runtime write path into `rating.*`. |
| `db/bootstrap/rating-db-roles.sql` | The `rating_runtime` role, its enumerated grants, the `REVOKE` on `billing` writes, and the column-scoped `GRANT UPDATE` to `app_runtime` on `udr_rated`. | Schema DDL; seeds. |
| `db/repositories/rating/**` + `db/repositories/billing/rated-lines.repository.ts` | Read-only repos the app uses to display/claim rating data + the bill-run six-column claim write; the bill-run read path over `udr_subscription_ref_id`. | Any write outside the six claim columns. |
| `workflow-management/flows/rating-engine/**` | Kestra flow definitions — **the rating logic** (PRP validation, RP resolution + PER_UNIT calc, RL guards + load). | Credentials; DDL; any write to `billing.*`. |
| `workflow-management/worker/workflow-engine/**` | Worker Dockerfile + runtime modules (`prp.py`, `rp.py`, `rl.py`); pinned Kestra base. | Flow logic that belongs in `flows/**`. |
| `workflow-management/{infra,dev}/**` | ACA/volume/proxy/Key-Vault wiring; the local Docker-Compose stack (no Docker socket mount). | Application code; real credentials. |

**No application surface:** no `app/**`, `actions/**`, `components/**`, user-facing `validation/**`, or `core.PERMISSIONS` rows.

**Cross-schema references — plain-text, no FK in any direction** (so migration histories stay decoupled and a resolved reference survives the referenced row being retired):
- `rating` ⇄ `billing`: `(billrun_ref_id, billrun_ban_id, billrun_attempt)`.
- `rating` → `inventory`: `udr_subscription_ref_id` = a `product_inventory_id` (the subscription instance).
- `rating` → `customer`: reads `party_role.party_role_specification` for resolution (read-only; nothing written back).
- `product.ratecard_ran_usage_lkp.lkp_subscriber_ref_id` = a `party_role_id` (the subscriber/customer) — distinct from `udr_subscription_ref_id`.

---

## 3. Storage model — database vs file vs cache vs config

Usage files are the module's input; the archived raw file is the evidence behind every charge (the platform's first file storage).

| Store | What |
| --- | --- |
| Postgres `rating` | `udr_rated`, `udr_batch`, `process_log`, `event_catalog` — system of record for rated usage. `udr_rated`/`process_log` monthly-partitioned; `udr_batch`/`event_catalog` not. |
| Postgres — second DB | Kestra queue/executions/flow-revisions. Backup retention = 7 years (part of the audit trail). |
| File `landing/` | Incoming raw usage files (`rating-input-file-<YYYYMMDDHHMI>.udr`, `.udr` extension, CSV content, no header). Claimed **in the database**, never by filesystem rename. |
| File `archive/` | Processed raw files, 7-yr retention (Blob preferred). Moved **only after** the RL transaction commits. |
| File `error/` | Reject files with per-record reason codes, 24-mo. Fix path = upstream reissues the file. |
| File `logs/` | Component logs pending load, 24-mo; swept into `process_log` by a job independent of the rating flows. |
| Cache | **None.** |
| Rating config | In **Kestra** (flow variables from git — `feed_profile`, `file_key_rule`, `ratecard_coverage_enforcement`, `reject_threshold`, `landing_dir`, the subscription/product pin). Output-affecting config moves with `rating_flow_revision`. **Product config** the flow consumes (`udrType`, `singleSubInstPerCust`, `productCardLookUp`) lives in `product.product_specifications` — product-owned data, read like price, not a rating config table. |

**Deviations from platform storage conventions (as-is):**

| Convention | This module |
| --- | --- |
| IDs = prefix + sequence | `udr_rated.udr_id`, `process_log.log_id` are `uuid` from `core.generate_ulid()` (high-volume, like `core.audit_log`). `udr_batch.batch_id` uses `UDRBAT` + 8 digits. |
| Money is `numeric(18,2)` | Amounts `numeric(18,2)`, **rates `numeric(18,6)`**; both raw and rounded amounts stored (a sub-cent rate rounds to 0 at 2 dp). |
| `services/accounts/money.ts` owns money math | Rating does its own `ratePerUnit × usage_volume` (money.ts throws above 2 dp); rating rounds **once** (HALF_UP), then hands the rounded amount on. |
| JSONB only when Zod-validated per type column | `udr_rate_detail` validated by `perUnitRateDetailSchema` (`{rateType:"PER_UNIT", ratePerUnit, quantity, amountRaw}`), discriminated by `udr_rate_type`. |
| Business timezone | `period_of()` truncates in the config TZ (`Asia/Kuala_Lumpur`, deploy-time constant), so `partition_period` **is the billing month** (intentional — amends the platform's UTC-bucket choice; justified by fixed `+8` + billing-month-aligned partitions). |

---

## 4. Authentication, authorization & data ownership

**No human authentication path** (no pages, no Server Actions). Access is governed at three layers:

| Layer | Mechanism | Protects |
| --- | --- | --- |
| Operator access | Kestra UI behind an Entra reverse proxy; ingress network-restricted | Who can reach the engine. Per-user identity + access logging **at the proxy**. |
| Engine internals | Kestra OSS instance-wide Basic Auth (Key Vault) | Nothing meaningful (OSS has no user model). |
| Data access | **Postgres roles and grants** | The real boundary. |

**Accepted risk:** anyone past the proxy holds full instance rights in Kestra and can change how money is calculated in production with no per-user audit *inside the engine*; the proxy records access, not changes. Mitigated by network restriction + proxy logging; Kestra Enterprise (per-flow tokens, user model) is the phase-2 path.

**Grants (the permission matrix equivalent — no `core.PERMISSIONS` rows):**

| Role | `rating.*` | `billing.*` | `customer` / `product` / `ordering` / `inventory` |
| --- | --- | --- | --- |
| `rating_runtime` | `SELECT`, `INSERT`; `UPDATE` restricted to `status` (→ generated `is_live`); **no `DELETE`** | `SELECT` on two enumerated tables; explicit `REVOKE` on every write; `REVOKE EXECUTE … FROM PUBLIC` on the four `billing` SECURITY DEFINER pgledger functions | `SELECT` only — enumerated: `customer.party_role`, `product.product_offering(_price)`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version`, `ordering.*`, `inventory.product_inventory` |
| `app_runtime` (bill run) | `SELECT`; `GRANT UPDATE` scoped to exactly six columns of `udr_rated` (`status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime`) | unchanged | unchanged |
| `app_migrate` | Owns DDL; `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate` grants **`SELECT` only** on future `rating` tables | unchanged | unchanged |

**Credentials — one per direction/destination:** Kestra Basic Auth (human/app → engine); app bearer service token (engine → app M2M); `rating_runtime` DB password; `kestra_engine` DB password (`CONNECT`+`CREATE` on the kestra DB only, no `CONNECT` on billing); internal-storage credential (Blob); Entra client secret (proxy). All in Key Vault (via Managed Identity where possible), never in a flow definition, never logged.

**Data ownership:** each schema has one writer — the engine writes `rating.*`, the app writes `billing.*`. The one exception is the bill-run six-column claim write into `udr_rated`, column-scoped at the grant.

**Audit:** rating writes have no human actor, so they do **not** write `core.AUDIT_LOG` (its `actor` couldn't be populated honestly). The audit surface is `udr_batch` (file → output → flow revision + image) + `process_log`. Operator reprocess actions are recorded at the proxy + engine execution history.

---

## 5. Background tasks & AI

**No AI/ML.** No application schedulers; everything scheduled runs outside the app:

| Mechanism | Where |
| --- | --- |
| Rating pipeline (PRP → RP → RL) | Kestra, triggered by a `landing/` file arrival (`PT1M` poll, `action: NONE`) |
| Log sweep / completeness check / stranded-batch reconciliation | Kestra, scheduled / on flow start |
| Partition maintenance | `pg_cron` via `pg_partman` on the existing daily job |

**Concurrency:** flow `concurrency: limit: 1` per `udr_type`, backed by `UNIQUE (file_key, batch_run_num)` and the live-row constraint. Kestra gives no atomic once-only guarantee, so none is optional. No email/SMTP.

---

## 6. Module invariants

In addition to the platform invariants (`context/architecture.md` §7). Each is testable; **[CRITICAL]** ones silently corrupt financial data when violated.

1. **[CRITICAL] Rating never writes `billing`.** Enforced by three things: `rating_runtime` holds no `billing` write grant; an explicit `REVOKE` of every `billing` write; **and `REVOKE EXECUTE … FROM PUBLIC` on the four `billing` SECURITY DEFINER functions** (`PUBLIC` holds `EXECUTE` by default, and a definer function runs as its owner — revoking from the role alone is a no-op). A standing test asserts no `billing` definer function is `EXECUTE`-able by `PUBLIC`.
2. **[CRITICAL] Financial content on `udr_rated` is immutable after insert.** Only `status` (→ generated `is_live`) is updatable by `rating_runtime`; the bill run may update six columns (`status`, `billrun_*`, `upsert_datetime`); everything else by nobody. **No role holds `DELETE`** — a row leaves only by partition detach. Enforced by column-scoped grants. Supersession lineage lives on `udr_batch` (`superseded_by_batch_id`, `supersede_reason`), not on `udr_rated`.
3. **[CRITICAL] At most one live row per cell per billing month, DB-enforced.** `UNIQUE (partition_period, udr_key, is_live)` — `partition_period` is the billing month (Inv 15), `is_live` is `GENERATED` from `status` (`true`-or-`NULL`). `CHECK (char_length(udr_key) <= 512)` keeps the index under the btree limit. **Shared-table note:** this grain binds every `udr_type` on `udr_rated`; correct for RAN_USAGE (a monthly feed). A future sub-monthly `udr_type` would need separate handling — deferred until such a feed is planned.
4. **No run-number in the uniqueness key.** `batch_run_num` lives on `udr_batch` as half of `UNIQUE (file_key, batch_run_num)`; it never enters `udr_rated`'s key (run 2 must be able to supersede run 1).
5. **[CRITICAL] Supersession is by `file_key`, across all partitions.** `file_key` is derived by PRP **from the filename** (rule per `udr_type`), before parsing. Never scope by `source_file` or by the current period — a reissue would leave both versions live and double-bill. **Operational rule:** reprocess/correct a batch by **re-dropping the same filename** (same `file_key`) — RL supersedes the prior live rows then reloads, in one transaction. A correction under a **new** filename is a new `file_key`: it supersedes nothing, its rows collide with the still-live originals (Inv 3), and the batch is **blocked** (never silently duplicated). Reprocess also requires the prior rows still at `RATED` (Inv 6).
6. **[CRITICAL] A batch colliding with a live `BILL_APPROVED` row is refused whole** (`LOAD_BLOCKED_BILLED`); a live `BILL_DRAFT` collision is refused whole at `MINOR` (`LOAD_BLOCKED_INFLIGHT`, recoverable). The guarantee is the `rating.rating_status_guard` `BEFORE UPDATE` trigger, not the RL pre-check (which loses the TOCTOU race).
7. **File claiming is a database constraint, never a filesystem operation.** `UNIQUE (file_key, batch_run_num)` decides ownership; rename-to-processing and flow locking are not substitutes.
8. **[CRITICAL] The transaction boundary is inside RL.** The `BILL_APPROVED`/`BILL_DRAFT` guard, the supersede, and the insert are one transaction or none. PRP → RP → RL share no transaction; recovery is re-running the batch (safe only because of Inv 3).
9. **The raw file is archived only after the DB transaction commits.** A worker killed before commit leaves the file recoverable in `landing/`.
10. **Never fan out per record.** Tasks are per file or per chunk (the OSS JDBC queue makes every task a polled DB row).
11. **Per-record rejects never become per-record log rows.** Rejects go to the reject file; the batch emits one summarised `process_log` row with counts + a pointer.
12. **Rating logic is fully identified by two columns:** `rating_engine_version` (worker image tag) + `rating_flow_revision` (Kestra flow revision). Both stamped on every rated row; neither alone reconstructs a historical charge.
13. **Price resolution is event-time and snapshotted.** RP resolves the price effective at `start_datetime` through the pinned `product_offering` version and writes the resolved inputs (rate, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`, `udr_rounding_mode`) onto the row; re-rating never re-resolves against product data.
14. **[CRITICAL] Every `event_code` resolves in `event_catalog`; severity is never hardcoded at a call site.** Row present → its severity; `default_severity` NULL → deliberately not alarm-worthy; **no row → `INDETERMINATE`** (a hygiene metric that must stay zero). Alert rules key off `event_code`, never log text. `process_log.event_code` carries no `CHECK`/FK (an uncatalogued code must still load as the evidence it was emitted). **New codes to seed (this update):** `UNKNOWN_SUBSCRIBER`, `CARD_DRIVEN_RATING_UNSUPPORTED`, the three identity-lock failures (party_role_spec / `lkp_subscriber_ref_id` / family-pin mismatch), `SERVICE_CODE_MISMATCH`, and the ratecard↔input completeness/mapping hard-stops each need an `event_catalog` row with a severity, or they resolve to `INDETERMINATE`.
15. **`partition_period` is the billing month, matching `start_datetime`.** Enforced by a `CHECK` using an explicit `AT TIME ZONE` (deterministic), centralised in the `IMMUTABLE` helper `rating.period_of()`; the literal is the **config TZ `Asia/Kuala_Lumpur`** (fixed `+8`), so `partition_period` **is** the billing month and bill-run may prune by it. *Amends the platform's earlier UTC-physical-bucket choice — justified because a Malaysian deployment's business TZ never changes; accepted cost: a business-TZ change would require a re-partition (not applicable to fixed `+8`). **Amendment authorized by Khek (module owner), 2026-09-30.*** **Cross-doc:** this reverses the old *"bill-run selects its period by `start_datetime`, never `partition_period`"* guidance — reconcile `billmgmt-architecture.md` and `_newmodule-billrun-rating-workflow-plan.md` so bill-run may prune by `partition_period`.
16. **No cross-schema foreign keys in any direction.** `rating` ⇄ `billing` join on plain-text `(run, ban, attempt)`; `rating` → `customer`/`product`/`ordering`/`inventory` references are plain-text.
17. **Grants are held on the parent table only; all access goes through the parent.** Partitions carry an empty ACL (a partition created after the grant stays reachable via `rating.udr_rated`).
18. **Rating migrations never touch `billing`; the engine's migrations never touch either.** Enforced by `REVOKE CONNECT ON DATABASE <billing> FROM PUBLIC` then explicit grants (order is load-bearing — a role created before the revoke inherits `PUBLIC` access), applied in both directions.
19. **`udr_resource` is nullable with deferred semantics** — do not populate it with an improvised value.

**Update invariants (PER_UNIT RAN-usage):**

20. **[CRITICAL] Three-factor subscriber identity — all must agree or PRP hard-stops the batch:** (a) MNO → `party_role_specification->>'mnoPublicKey1'` → `party_role_id`; (b) ratecard `lkp_subscriber_ref_id` = that `party_role_id`; (c) resolved offering **family id** `COALESCE(family_offering_id, product_offering_id)` = the pinned flow variable (the friendly product name is display/log only).
21. **Resolution filters by the RAN_USAGE offering**, never "the customer's active subscription." `singleSubInstPerCust = "true"` guarantees exactly one such subscription per customer (ordering-enforced; **seed-discipline only this phase** — the ordering guard is deferred with Workstream C, an accepted risk).
22. **`udr_subscription_ref_id` (subscription instance) and `lkp_subscriber_ref_id` (customer/`party_role_id`) are distinct by design.** The customer ref is stable across re-subscribe; the subscription ref is the billing anchor.
23. **Rate and unit come from the product**, never the feed or the ratecard: `udr_usage_rate` = the scalar `usage_rate` `ratePerUnit`; `udr_usage_unit` = its `unit_of_measure`; `ratecard.rate_per_unit` is never read for rating. **Single usage_rate lane per offering is assumed, not enforced (accepted risk, same class as Inv #21).** RP (rm20) selects the lane by `(product_offering_id, component_type='usage_rate')` as-of `start_datetime` with **no** `unit_of_measure` discriminator (the feed carries no unit — rm19/rm20). The DB *permits* >1 `usage_rate` unit per offering (unique key includes `unit_of_measure`), and `db/schema/product.ts`'s own comment says runtime readers must partition on the unit too — so **multi-unit `usage_rate` pricing is out of scope** and the ≤1-unit-per-offering guarantee is owed at the **product write side** (authoring validation / Workstream C), not the rating read-path. Until then it is seed-discipline; a multi-unit offering would mis-resolve (owner-confirmed out of scope, 2026-10-04).
24. **[CRITICAL] A card-driven `usage_rate` (`plaSpecId = 'PLA_USAGE_RATE'`) is not rateable** — RP raises a loud `CARD_DRIVEN_RATING_UNSUPPORTED`, never a silent/partial result.
25. **Every input row must map to a ratecard entry (hard-stop batch);** ratecard→input completeness is enforced with `ratecard_coverage_enforcement` (default `HARD_STOP`, `WARN` tolerates zero-traffic cells). The reconciliation identity `parsed = rated + rejected + discarded` holds because the refusal lives in PRP.

---

## 7. Platform deviations (as-is)

Each contradicts a `context/architecture.md` statement and is deliberate: second Postgres database (Kestra state, kept off the revenue tables by a revoked `PUBLIC` `CONNECT`); file storage (four mounted locations, 7-yr archive); a third DB role (`rating_runtime`); rating writes do not write `core.AUDIT_LOG` (no human actor; audit surface is `udr_batch` + `process_log`, no FK to `core.APPUSER`); Kestra is the compute engine (rating logic in flow definitions); `rating_runtime` holds `USAGE`/`EXECUTE` on `core.generate_ulid()`; `process_log.event_code` has no `CHECK`/FK; `ALTER DEFAULT PRIVILEGES` grants `SELECT` only. Retention: `udr_rated` 7 years, `process_log` 24 months.
