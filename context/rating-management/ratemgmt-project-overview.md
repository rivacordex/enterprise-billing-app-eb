# Rating Management Module — Project Overview

## Overview

The Rating Management Module is the subsystem of the Enterprise Billing App (Telco) that turns raw usage files into priced charge records the bill run can bill. It ingests usage files from a landing directory, runs them through three components on a workflow engine — **PRP** (Pre-Rating Processor: parse, validate, deduplicate, load lookups), **RP** (Rating Processor: resolve the price effective at the usage event and calculate the amount), and **RL** (Rating Loader: guard, supersede, and load inside one transaction) — and writes the result to `rating.udr_rated`, a monthly-partitioned table holding one row per rated usage record with the rate, the price row that produced it, and the version of the logic that computed it. It owns three supporting tables: `rating.udr_batch` (one row per processed file — the file claim, the reconciliation ledger, and the record of what arrived), `rating.process_log` (component activity, carrying both a syslog verbosity level and a nullable ITU X.733 alarm severity for IT monitoring), and `rating.event_catalog` (the seeded map from event code to default severity, so alerting keys off stable codes rather than log text). There is no front end in this release: the Billing Ops team operates the module through the workflow engine's own UI, and the module's correctness rests on database constraints rather than on application discipline — a second live row for one usage record is a state Postgres refuses to hold.

**Relationship to the bill run.** `_newmodule-billrun-rating-workflow-plan.md` was written before this module was designed and described rating as continuous, external and undefined. **Eight** of its statements are superseded by this design — continuous-vs-batch rating, the engine's execution history not being an audit trail, the `period_partition` convention, the existence of `rating.udr_exception`, and the app's grant being a single claim-marker column when the bill run in fact writes six, among them. `ratemgmt-architecture.md` §7 carries the authoritative list and their reconciliation status; **not all are yet corrected in that boundary document.** The claim-marker point matters twice over: rating logic *does* live in the workflow definition, which is why `rating_flow_revision` is stored on every rated row.

## Goals

1. Make **why a charge came out at that amount** a queryable fact years later, by storing the rate applied, the price row and its effective date, the override that applied, the rounding mode used, and both the engine version and flow revision that produced the number — so a dispute is answered with a `SELECT`, not an archaeology exercise.
2. Make double-billing **structurally impossible** rather than procedurally avoided: a `UNIQUE (partition_period, start_datetime, udr_key, is_live)` constraint means two live rows for one usage record abort the transaction, even when the application logic that should have prevented it is wrong, raced, or skipped.
3. Make reprocessing a corrected file a **routine, safe operation** — supersede-then-insert in one transaction, old rows retained as `SUPERSEDED` with a pointer to what replaced them, so audit history survives every correction.
4. Make it **impossible to silently rewrite a billed charge**: RL refuses an entire batch if any incoming record collides with a live `BILL_APPROVED` row, so a correction to already-invoiced usage surfaces as a `MAJOR` alarm instead of corrupting a posted invoice or tripping `customer_bill.charge_checksum` during a dispute.
5. Turn **absence into a signal**. A file that never arrives produces no error, no reject and no log entry — only silence, which looks exactly like success. A scheduled check compares `rating.udr_batch` against the expected cadence per `udr_type` and raises a clearable `FILE_NOT_RECEIVED`.
6. Make every batch **reconcile arithmetically**: `parsed = rated + rejected + discarded`, with an imbalance treated as `CRITICAL`, and a reissued file smaller than its predecessor treated as `MAJOR` — because a shrinking reissue supersedes records nothing replaces, and that is silent revenue loss.
7. Give IT monitoring an **alarm surface it can build rules on**: stable `event_code` values, severity resolved from a seeded catalog rather than hardcoded at each call site, and an `alarm_key` that pairs a raise with its clear so a fixed problem stops showing as an open alarm.
8. Keep `process_log` **proportionate**: per-record rejects go to a reject file, and a batch emits one summarised row with counts and a pointer — never one row per rejected record.
9. Enforce the rating/billing boundary as a **Postgres grant, not a convention**: the rating role holds `SELECT` only on the billing and product tables it rates from with explicit `REVOKE` on all billing writes, and the app role holds `SELECT` on `rating.*` plus column-scoped `UPDATE` on exactly the six columns the bill run writes.
10. Keep the workflow engine **swappable**. Nothing in the data model depends on Kestra; the contract to the bill run is a database schema, not an API. If Kestra proves unsuitable as a compute engine, the tables and the guards survive the swap.

## Core user flow

The primary flow — a `RAN_USAGE` file for 14 August arrives, rates, partially fails, and is reprocessed after upstream reissues it.

1. Upstream drops `RAN_USAGE_20260814.dat` into the landing directory on the volume mounted to the workflow engine container. The flow's file trigger picks it up.
2. **PRP claims the file first, before anything can fail.** It first derives the **`file_key`** — the logical identity of this delivery — from the rule configured for `RAN_USAGE`, refusing the file with `FILE_KEY_UNRESOLVED` if the rule does not resolve rather than guessing. It then inserts a `rating.udr_batch` row with `status = RECEIVED`, `batch_run_num = 1` (`max+1` within that `file_key`), the file checksum, and the size. The `UNIQUE (file_key, batch_run_num)` constraint means the database — not the flow — decides who owns the file, so a file-watcher double-fire, a manual run alongside the scheduled one, or a task retry cannot produce two concurrent loads.
3. PRP parses the file, maps each record to the `udr_rated` key fields, and validates: malformed records, unknown subscriber references, out-of-range values, and duplicates already present. It computes the canonical `udr_key` — sorted keys, UTC, fixed numeric formats — because two logically identical keys serialised differently would be two live rows and one double bill. It loads the lookup tables RP needs.
4. 37 of 50,000 records fail. PRP writes them to a reject file in the error directory with reason codes, and compares the 0.07% reject rate against the threshold configured for `RAN_USAGE`. Below the threshold, processing continues with the remaining 49,963; above it, the whole file would be refused instead.
5. **RP resolves the price as of `start_datetime`, not as of now.** It walks the effective-dated chain on `product.product_offering_price` through the `product_offering` version the subscription is pinned to, applies any `order_item_price_override`, and calculates. It writes the resolved inputs onto each record — `udr_usage_rate`, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref` — so the arithmetic can be reproduced without re-resolving against product data that will have changed. Price overrides carry no temporal columns, so this snapshot is the only thing protecting August from an override added in October.
6. RP computes both `udr_rated_price_raw` at full precision and `udr_rated_price` rounded per record to 2 decimal places using the method recorded in `udr_rounding_mode` (`HALF_UP`/`HALF_EVEN`/`TRUNCATE`), so the charge stays reproducible. Round-at-aggregation is the bill run's stage, not rating's — storing the raw value is what enables it.
7. **RL runs the guards and the load in one transaction.** It checks every incoming natural key against existing `BILL_APPROVED` rows — none here — then inserts 49,963 rows at `status = RATED`. It updates `udr_batch` with `parsed_count`, `rated_count`, `rejected_count` and `discarded_count`, sets `status = PARTIAL`, and commits.
8. **Only after the commit** does the flow move the raw file to the archive directory. A worker killed before this point leaves the file in landing and the transaction rolled back; the batch row stranded at `PROCESSING` is resolved by startup reconciliation, which also releases the claim that would otherwise block reprocessing forever.
9. Each component writes structured log entries to the log directory throughout. A scheduled sweep — deliberately independent of the flows, so a crashed flow still gets its logs loaded — reads them into `rating.process_log`. The batch emits **one** `BATCH_PARTIAL` row at `MINOR` with the counts and a pointer to the reject file, not 37 rows.
10. Billing Ops sees the `MINOR` in monitoring, signs in to the workflow engine UI through the Entra reverse proxy, opens the execution, reads the task logs, and follows `batch_id` to the `udr_batch` row and the reject file. The 37 records failed because a mediation timestamp offset was wrong upstream.
11. Ops requests a corrected file. Upstream reissues **all 50,000 records** — every reprocess is a near-total duplicate submission by design, which is why deduplication is the load-bearing mechanism of reprocessing rather than a validation nicety.
12. The corrected file loads as `batch_run_num = 2`. RL runs the guard again, marks every live row from that **`file_key`** at `batch_run_num < 2` as `SUPERSEDED` **across all partitions** — not just the current period, because a corrected timestamp may have moved a record into a different month where the unique constraint cannot see its predecessor — records `superseded_by_batch_id` and `supersede_reason` once on the retired `udr_batch` row (the retired `udr_rated` rows change only `status`), then inserts the run-2 rows.
13. `udr_batch` compares the run-2 record count against run 1. Equal here; a smaller reissue would raise `SHRINKING_REISSUE` at `MAJOR`. The batch reaches `COMPLETE`, and `BATCH_COMPLETE` clears any standing alarm on that `alarm_key`.
14. Had the 37 records already been on an approved invoice, step 12 would instead have refused the entire batch, set `udr_batch.status = REFUSED`, and raised `LOAD_BLOCKED_BILLED` at `MAJOR` naming the colliding keys and their `billrun_ref_id`. The remedy — an adjustment or credit note — is a later phase; this release ships the guard.
15. On the morning of the bill run, the scheduled completeness check confirms every expected `RAN_USAGE` file for the period is present in `udr_batch` and every batch reconciles. Rated records sit at `RATED`, unclaimed, waiting for the bill run's collection stage to stamp `billrun_ref_id` and move them to `BILL_DRAFT` — the boundary this module delivers against but does not itself build.

## Features

### Ingestion and file lifecycle

- File pickup from a mounted landing directory, with the raw file retained in an archive directory for the invoice's statutory life (7 years).
- Database-backed file claiming via `UNIQUE (file_key, batch_run_num)` on `rating.udr_batch` — not filesystem rename, not flow-level locking. **`file_key` is the logical delivery identity**, extracted by PRP **from the filename** using a rule predefined per `udr_type`, so a corrected file reissued under a varied name still resolves to the same delivery and supersedes it. `source_file` records the physical name for forensics only. An unresolvable key refuses the file with `FILE_KEY_UNRESOLVED` rather than guessing.
- File checksum recorded at receipt, so a byte-identical redelivery is discarded as `DUPLICATE_BATCH` before any parsing cost.
- Archive-after-commit ordering, so a failed load never leaves the source file unrecoverable.
- Startup reconciliation of batches stranded at `PROCESSING`, releasing claims left by a killed worker.

### Validation and rejection

- Record-level processing with quarantine: valid records rate and load while invalid ones go to a reject file, with per-`udr_type` configurable failure policy and an error threshold (`threshold = 0` yields file-level all-or-nothing).
- Reject files written to a dedicated error directory with reason codes; no per-record exception table and no in-app reject workbench, because the fix path is always "upstream reissues the file", never "edit the row".
- Canonical `udr_key` serialisation, indexed directly, so serialisation differences cannot manufacture duplicate live rows. **`udr_key` is capped at 512 characters** by `CHECK (char_length(udr_key) <= 512)` — even at the worst case that permits (512 four-byte UTF-8 characters = 2,048 bytes) the index entry stays clear of the Postgres btree limit of 2,704 bytes, which would otherwise reject an insert at load time rather than at design time.

### Rating and price provenance

- Event-time price resolution: the price effective at `start_datetime`, resolved through the pinned `product_offering` version, not the price current at rating time.
- Snapshot-on-first-rate of every resolved input — rate, price row, price effective date, override reference — making a reprocess months later reproduce the original arithmetic.
- Rate types `FLAT` (v1) with the enum defined to `PER_UNIT`, `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE` and `ZERO_RATED`; graduated and volume tiering are separate values because they produce different numbers for identical input.
- Type-specific rating data in `udr_rate_detail` JSONB, Zod-validated and discriminated by `udr_rate_type`, so adding `BLOCK` later is a schema change in validation rather than a database migration.
- Money at `numeric(18,2)` for amounts and `numeric(18,6)` for rates, with both raw and rounded values stored and the applied rounding mode recorded per record.
- Currency taken from the resolved price row, with RL asserting it matches `billing_account.currency` and raising `CURRENCY_MISMATCH` on disagreement — nothing in the existing schema constrains the two to agree.

### Deduplication, supersession and guards

- Natural key `(start_datetime, udr_key)`, with `udr_batch_run_num` deliberately excluded — including it would mean run 2 never collides with run 1, and the constraint would fire on nothing.
- `is_live` generated from `status`, carrying the uniqueness constraint; superseded rows hold `NULL` and coexist without limit under SQL's default `NULLS DISTINCT`.
- Batch-level supersession by `file_key` across all partitions. Retired rows change **only `status`**; the lineage — `superseded_by_batch_id` and `supersede_reason` — is recorded once on `udr_batch`, because predecessors are marked before successors exist.
- RL refusal of any batch colliding with a live `BILL_APPROVED` row — batch-level, a deliberate exception to the record-level default, because a collision with an approved invoice means the file's assumptions about the period are wrong.
- `SUPERSEDED` (reprocessing) kept distinct from `REJECTED` (bill run), since they have different causes and different audit meaning.

### Completeness and reconciliation

- Per-batch arithmetic reconciliation (`parsed = rated + rejected + discarded`), with imbalance raised as `CRITICAL`.
- Expected-cadence configuration per `udr_type`, with a scheduled check raising a clearable `FILE_NOT_RECEIVED` when a file does not arrive.
- Shrinking-reissue detection comparing run-N against run-(N−1) counts.
- Detection of usage superseded and never replaced, via natural keys whose rows are all non-live.

### Logging, alarms and monitoring

- Structured **JSON Lines** log entries from every component carrying `log_datetime`, `component`, `log_level`, nullable `perceived_severity`, `event_code`, `specific_problem`, `managed_object`, `alarm_key`, `source_file`, `batch_id`, `workflow_execution_id` and `additional_info`.
- Two orthogonal severity columns: `log_level` (`DEBUG`/`INFO`/`WARN`/`ERROR`) for verbosity, and a nullable `perceived_severity` (ITU X.733: `CRITICAL`/`MAJOR`/`MINOR`/`WARNING`/`INDETERMINATE`/`CLEARED`) populated only on alarm-worthy rows.
- `rating.event_catalog` mapping stable `event_code` values to default severity, X.733 event type and probable cause, so alert rules survive log-text changes and severity is re-tunable by migration.
- `alarm_key` pairing raises with clears, so a resolved condition stops presenting as an open alarm.
- Unclassified events resolving to `INDETERMINATE`, whose count trending to zero is a hygiene metric.
- A log sweep independent of the rating flows, so a crashed flow's logs still reach the database.

### Storage and partitioning

- `rating.udr_rated` and `rating.process_log` partitioned monthly by `pg_partman` on a `date` control column, registered on the existing daily maintenance job, **detached, never dropped** — `udr_rated` at 7 years, `process_log` at 24 months — matching the billing tables' archival contract rather than `audit_log`'s drop-on-expiry.
- Partition granularity chosen when an environment is first built, not changeable at runtime: changing it on a live table is a physical re-partition with downtime.
- `rating.udr_batch` unpartitioned — files are low-volume.
- Four mounted locations: landing, archive, error, logs. Raw archive retained 7 years; reject and log files 24 months.

### Access, isolation and deployment

- A dedicated `rating_runtime` Postgres role with `SELECT`/`INSERT` on `rating.*`, `UPDATE` on `udr_rated` limited to `status`, no `DELETE` anywhere, `SELECT` only on the product, ordering, inventory and billing tables it rates from, explicit `REVOKE` on all billing writes, and a connection limit — following the per-table enumerated-grant pattern the codebase already uses to keep `app_runtime` off the pgledger internals.
- Column-scoped `GRANT UPDATE` to `app_runtime` on exactly the six `udr_rated` columns the bill run writes.
- No cross-schema foreign keys in either direction, so the two deployables' migrations stay decoupled.
- Workflow engine state in a separate database on the same server, so its automatic schema migrations hold no `CONNECT` on the billing database.
- Workflow engine UI behind an Entra-authenticated reverse proxy, giving per-user authentication and access logging at the proxy layer.
- `rating.*` tables as Drizzle migrations in the existing app repository (one migration history); flow definitions and the worker image in their own repository, so a rating rule change does not redeploy the billing web app.

## In scope

- The `rating` schema: `udr_rated`, `udr_batch`, `process_log`, `event_catalog` — real tables, real constraints, real partitioning, real grants.
- The `rating_runtime` Postgres role and the column-scoped grant to `app_runtime`.
- The workflow template with all three components (PRP, RP, RL) present as named, wired sections carrying their guards, their logging contract, and their transaction boundary — with the rating computation itself stubbed.
- File ingestion: landing pickup, database-backed claiming, checksum, archive-after-commit, startup reconciliation of stranded batches.
- Validation, reject files, per-`udr_type` threshold configuration.
- Deduplication, batch-level supersession, and the `BILL_APPROVED` refusal guard.
- Batch reconciliation and shrinking-reissue detection.
- The expected-cadence completeness check.
- Structured logging, the log sweep, `event_catalog` seeding, and `alarm_key` clear semantics.
- Infrastructure: workflow engine container deployment, custom worker image, separate engine database, Entra reverse proxy, mounted storage, Key Vault secret wiring, `pg_partman` registration.

## Out of scope

- **The rating computation itself.** PRP mapping rules, RP pricing logic and the lookup table definitions ship as comments in the RP component, to be built in a later stage. `udr_rate_type` is `FLAT` only in this release.
- **Any front end.** No pages, no Server Actions, no RBAC permissions, no components. Billing Ops works in the workflow engine UI.
- **The bill run's claim path.** The bill run stamping `billrun_ref_id` and moving records to `BILL_DRAFT` is the contract this module delivers against, not something it builds.
- **Adjustments and credit notes** for corrections to already-billed usage. This release ships the guard that refuses the load; the remedy is a later phase.
- **Minimum commitments and caps.** Common in enterprise contracts, and not rate types — a subscription's shortfall against its monthly minimum is unknowable until the whole period is rated, making these bill-run-time adjustments over the rated set.
- **Allowance and bundle consumption**, which requires per-subscription-per-period balance state.
- **Real-time and online charging.** Files only.
- **Automated retry with backoff** for failed batches. Recovery is operator-triggered from the workflow engine UI.
- **Per-user authorization inside the workflow engine.** The OSS edition has no user model; the reverse proxy provides authentication and access logging, and the residual risk — anyone past the proxy holds full instance rights, including editing rating logic — is an accepted, documented risk with the Enterprise edition as the phase-2 path.
- **Flow definition version control process** and the **testing approach for rating logic expressed in workflow definitions** — both deferred by decision, to be defined before the rating computation is built.

## Success criteria

**Correctness**

1. Loading the same file twice with a live copy present fails on the unique constraint, not on application logic — demonstrated by a test that deliberately skips the supersede step and asserts the transaction aborts.
2. Reprocessing a corrected file supersedes exactly the prior run's live rows for that `file_key`, including rows whose corrected timestamp moved them into a different partition, and leaves exactly one live row per natural key.
3. A batch colliding with a live `BILL_APPROVED` row is refused whole, writes no rows, and raises `LOAD_BLOCKED_BILLED` naming the colliding keys.
4. Four consecutive reprocessings of one record leave four `SUPERSEDED` rows and one live row, each retired batch pointing at the batch that replaced it.
5. A record rated in August and re-rated in October produces the same amount, because RP resolves the price as of `start_datetime` and RL rewrites the same snapshotted inputs.
6. `partition_period` cannot disagree with `start_datetime` — a deliberately mismatched insert is rejected by the CHECK constraint.
7. A `udr_key` longer than 512 characters is rejected by `CHECK (char_length(udr_key) <= 512)` at insert, not by an opaque btree index-row error — and a 512-character four-byte UTF-8 key (2,048 bytes, the worst case the constraint permits) still inserts successfully.

**Observability**

8. Every batch produces a `udr_batch` row whose counts reconcile, including batches that failed before parsing completed.
9. A 20%-reject 50,000-record file produces one summarised `process_log` row, not 10,000.
10. Every `event_code` emitted by any component resolves in `event_catalog`; the `INDETERMINATE` count is zero.
11. A raised `FILE_NOT_RECEIVED` is cleared by the late file's successful batch, verified by matching `alarm_key`.
12. A crashed flow's log entries still reach `process_log`, because the sweep runs independently of the flows.

**Boundary and isolation**

13. The `rating_runtime` role cannot write any `billing` table — asserted by a test that attempts an insert and expects a permission error.
14. `app_runtime` can update the six bill-run columns on `udr_rated` and no others — asserted per column.
15. The workflow engine's database role has no `CONNECT` on the billing database.
16. No cross-schema foreign key exists between `rating` and `billing` in either direction.

**Operational**

17. A worker killed mid-load leaves the source file in landing, no rows in `udr_rated`, and a `udr_batch` row that startup reconciliation resolves — after which the file reprocesses cleanly.
18. Two concurrent flow executions against the same file result in exactly one batch; the second fails on the claim constraint.
19. A 50,000-record file completes without any per-record fan-out in the workflow engine — verified by asserting the execution's task count is bounded by chunk count, not record count.
20. Billing Ops can reach, from a monitoring alert, the failing execution, its task logs, the `udr_batch` row and the reject file, without a database client.
21. Partitions are created ahead by `pg_partman` and expire by DETACH, verified against the existing daily maintenance job with no second cron schedule introduced.
