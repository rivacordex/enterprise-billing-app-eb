# Rating Management Module — Project Overview

## Overview

The Rating Management Module is the subsystem of the Enterprise Billing App (Telco) that turns raw usage files into priced charge records the bill run can bill. It ingests usage files from a landing directory, runs them through three components on a workflow engine — **PRP** (Pre-Rating Processor: parse, validate, deduplicate, load lookups), **RP** (Rating Processor: resolve the price effective at the usage event and calculate the amount), and **RL** (Rating Loader: guard, supersede, and load inside one transaction) — and writes the result to `rating.udr_rated`, a monthly-partitioned table holding one row per rated usage record with the rate, the price row that produced it, and the version of the logic that computed it. It owns three supporting tables: `rating.udr_batch` (one row per processed file — the file claim, the reconciliation ledger, and the record of what arrived), `rating.process_log` (component activity, carrying both a syslog verbosity level and a nullable ITU X.733 alarm severity for IT monitoring), and `rating.event_catalog` (the seeded map from event code to default severity, so alerting keys off stable codes rather than log text). There is no front end in this release: the Billing Ops team operates the module through the workflow engine's own UI, and the module's correctness rests on database constraints rather than on application discipline — a second live row for one usage record is a state Postgres refuses to hold.

**PER_UNIT RAN-usage update (Phase G).** Reference: `_change-rating-configuration-plan.md`. Scope: Workstream A (rating engine), B (customer MNO key) and D (seeds); Workstream C (product-management UI) is deferred to a follow-up phase. Operated by BSS IT Operations. The module ingests raw RAN (Radio Access Network) usage records for mobile network operators, resolves each record to the right subscriber, prices it against that subscriber's product, and loads immutable rated usage into `rating.udr_rated` for the downstream bill run. This update defines the **actual PER_UNIT business logic** for the `rating-engine-ran-usage` flow (`PRP → RP → RL`), replacing the placeholder `FLAT`-only scaffolding the engine shipped with: it builds the real subscriber resolver (input MNO → customer → subscription), computes `rate × usage_volume` in exact decimal, and enforces data integrity (subscriber identity, completeness, duplicates, field agreement) with hard-stops **before any money is written**. Product and customer configuration is seeded/manual for this phase.

**Raw `udr_key` and `udr_resource` cell label (Phase H).** Reference: `_updatemodule-rating-udr-key-resource-plan.md` (companion: `_updatemodule-billing-invoice-template-phase3-billrun-plan.md`); units rm24–rm29; rolled into this overview 2026-10-27 (sections marked "Phase H"). Scope: the RAN-usage runtime — PRP, RP, RL — plus sample seeds, rating tests and the rule amendments in the plan §7; no schema change, no migration, no grant change, no billing code. Rollout: fresh database that round (decided 2026-10-14). The update changed what rating writes for each `RAN_USAGE` record so the invoice can print each polygon's original ID, its start date and its State-District label without adding a column to `rating.udr_rated` and without ever reading the rate card: `udr_key` keeps the polygon, MNO and commercial-unit values exactly as the feed sends them (the case-folding and trimming rule was removed), PRP matches each record to its rate-card cell by exact comparison, and PRP builds the label `state|district|polygon_start_date` once per matched card cell so RL writes it, at INSERT, into the existing `udr_resource` column. Billing reads the polygon from the `polygon_id=` segment of `udr_key`, and State, District and the start date from the three segments of `udr_resource`.

**Relationship to the bill run.** `_newmodule-billrun-rating-workflow-plan.md` was written before this module was designed and described rating as continuous, external and undefined. **Eight** of its statements are superseded by this design — continuous-vs-batch rating, the engine's execution history not being an audit trail, the `period_partition` convention, the existence of `rating.udr_exception`, and the app's grant being a single claim-marker column when the bill run in fact writes six, among them. `ratemgmt-architecture.md` §7 carries the authoritative list and their reconciliation status; **not all are yet corrected in that boundary document.** The claim-marker point matters twice over: rating logic *does* live in the workflow definition, which is why `rating_flow_revision` is stored on every rated row.

## Goals

1. Make **why a charge came out at that amount** a queryable fact years later, by storing the rate applied, the price row and its effective date, the override that applied, the rounding mode used, and both the engine version and flow revision that produced the number — so a dispute is answered with a `SELECT`, not an archaeology exercise.
2. Make double-billing **structurally impossible** rather than procedurally avoided: a `UNIQUE (partition_period, udr_key, is_live)` constraint means two live rows for one cell per billing month abort the transaction, even when the application logic that should have prevented it is wrong, raced, or skipped. The constraint compares raw `udr_key` values (Inv 27), so two records for one cell that differ only in case or whitespace are different keys and both load — an accepted risk (plan R4), asserted by a test rather than guarded by a normalising index.
3. Make reprocessing a corrected file a **routine, safe operation** — supersede-then-insert in one transaction, old rows retained as `SUPERSEDED` with a pointer to what replaced them, so audit history survives every correction.
4. Make it **impossible to silently rewrite a billed charge**: RL refuses an entire batch if any incoming record collides with a live `BILL_APPROVED` row, so a correction to already-invoiced usage surfaces as a `MAJOR` alarm instead of corrupting a posted invoice or tripping `customer_bill.charge_checksum` during a dispute.
5. Turn **absence into a signal**. A file that never arrives produces no error, no reject and no log entry — only silence, which looks exactly like success. A scheduled check compares `rating.udr_batch` against the expected cadence per `udr_type` and raises a clearable `FILE_NOT_RECEIVED`.
6. Make every batch **reconcile arithmetically**: `parsed = rated + rejected + discarded`, with an imbalance treated as `CRITICAL`, and a reissued file smaller than its predecessor treated as `MAJOR` — because a shrinking reissue supersedes records nothing replaces, and that is silent revenue loss.
7. Give IT monitoring an **alarm surface it can build rules on**: stable `event_code` values, severity resolved from a seeded catalog rather than hardcoded at each call site, and an `alarm_key` that pairs a raise with its clear so a fixed problem stops showing as an open alarm.
8. Keep `process_log` **proportionate**: per-record rejects go to a reject file, and a batch emits one summarised row with counts and a pointer — never one row per rejected record.
9. Enforce the rating/billing boundary as a **Postgres grant, not a convention**: the rating role holds `SELECT` only on the billing and product tables it rates from with explicit `REVOKE` on all billing writes, and the app role holds `SELECT` on `rating.*` plus column-scoped `UPDATE` on exactly the six columns the bill run writes.
10. Keep the workflow engine **swappable**. Nothing in the data model depends on Kestra; the contract to the bill run is a database schema, not an API. If Kestra proves unsuitable as a compute engine, the tables and the guards survive the swap.

**PER_UNIT RAN-usage update (Phase G):**

11. Replace the placeholder subscriber resolver (which treats the fed value as an already-resolved `product_inventory_id`) with the real chain: input `mno_public_id` → `party_role_specification` → customer → the RAN_USAGE subscription.
12. Implement `PER_UNIT` rating (`ratePerUnit × usage_volume`) in Python `Decimal` with `HALF_UP` rounding, replacing the `FLAT` (quantity-ignored) computation.
13. Guarantee every record rates against the correct subscription via a **three-factor identity lock**, all hard-stop.
14. Enforce input integrity before rating: no missing columns/data, no duplicates, full ratecard↔input mapping (both directions), and `service_code` + `udrType` agreement.
15. Source the rate and the unit from the **product definition** (scalar `usage_rate` component + its `unit_of_measure`), never from the feed or the ratecard's `rate_per_unit`.
16. Keep reload/reprocessing on the existing flow (`batch_run_num` + rm10 supersession); fail the whole batch on any parse failure (`reject_threshold: "0"`).
17. Make the input filename/landing contract and the completeness enforcement mode **configurable flow variables**.
18. Align month/partition boundaries and datetime parsing to the **system timezone** (`Asia/Kuala_Lumpur`).
19. Correct the data-model names so they say what they hold: `udr_rated.udr_subscription_ref_id` = the subscription instance; `ratecard_ran_usage_lkp.lkp_subscriber_ref_id` = the customer.

**Raw `udr_key` / `udr_resource` update (Phase H):**

20. Store the polygon ID in `udr_key` exactly as the feed sends it (original case and spacing, e.g. `ABCD_25 DISTRICT2`); remove the `strip().casefold()` normalisation but keep the key shape — sorted key names, `name=value`, joined by `|`.
21. Match each feed record to its rate-card cell by exact, case- and whitespace-sensitive comparison; no exact match stays a whole-batch `INPUT_UNMAPPED` hard stop.
22. Write `udr_resource = state|district|polygon_start_date` (ISO `YYYY-MM-DD`; a blank label is an empty segment) for every `RAN_USAGE` row, once, at INSERT, from the matched rate-card cell; non-RAN usage types write `NULL`.
23. Add no column to `rating.udr_rated`, no migration file and no grant change; `udr_resource` already existed as nullable `text`. Leave the bm48 `state`/`district` columns as they were. *(The second half is reversed 2026-10-27: Phase J removes those columns — `_change-rating-drop-udr-rated-geo-columns-plan.md`.)*
24. Fail the batch before rating if a rate-card `state` or `district` label contains `|` (`RATECARD_LABEL_INVALID`), so the label can always be split into three segments.
25. Record the reversal of the protected rules ("fixed" canonical key; "`udr_resource` is reserved") in every rating document that states them, and state the accepted trade-off — records that differ only in case or whitespace are different keys — with a test.

## Core user flow

The primary flow — a `RAN_USAGE` file for 14 August arrives, rates, partially fails, and is reprocessed after upstream reissues it.

1. Upstream drops `RAN_USAGE_20260814.dat` into the landing directory on the volume mounted to the workflow engine container. The flow's file trigger picks it up.
2. **PRP claims the file first, before anything can fail.** It first derives the **`file_key`** — the logical identity of this delivery — from the rule configured for `RAN_USAGE`, refusing the file with `FILE_KEY_UNRESOLVED` if the rule does not resolve rather than guessing. It then inserts a `rating.udr_batch` row with `status = RECEIVED`, `batch_run_num = 1` (`max+1` within that `file_key`), the file checksum, and the size. The `UNIQUE (file_key, batch_run_num)` constraint means the database — not the flow — decides who owns the file, so a file-watcher double-fire, a manual run alongside the scheduled one, or a task retry cannot produce two concurrent loads.
3. PRP parses the file, maps each record to the `udr_rated` key fields, and validates: malformed records, unknown subscriber references, out-of-range values, and duplicates already present. It builds `udr_key` from the feed's raw values — key names sorted, `name=value` joined by `|`, no trimming or case folding (Inv 27); records that differ only in case or whitespace are different keys, an accepted risk. It loads the lookup tables RP needs.
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

**RAN_USAGE PER_UNIT flow (Phase G), start to finish.**

1. **Configure the product (seed/manual).** Create the RAN offering with specs `udrType = "RAN_USAGE"`, `singleSubInstPerCust = "true"`, `productCardLookUp = "RATECARD_RAN_USAGE_LKP"`, and one **scalar** `usage_rate` price component (`ratePerUnit` set, `rateCardLookUp = null`, `plaSpecId = null`, `unit_of_measure = "Mbps"`).
2. **Configure the customer (seed/manual).** Set `customer.party_role.party_role_specification = {"mnoPublicKey1": "MNO-001"}`; create the customer's single RAN subscription (`inventory.product_inventory`), pinned to the offering (`singleSubInstPerCust` blocks a second RAN subscription).
3. **Provision the ratecard.** Upload and activate a `ratecard_version`; each `ratecard_ran_usage_lkp` row maps `mno_public_key | commercial_unit_public_key | polygon_id` → `lkp_subscriber_ref_id = party_role_id`, plus `state`, `district`, `service_code` (and `rate_per_unit` left NULL/unused).
4. **File arrives.** `rating-input-file-<YYYYMMDDHHMI>.udr` lands in `/data/landing` (no header; CSV content; 7 columns: `mno_public_id, commercial_unit, polygon_id, datetime_YYYYMMDDHHMI, usage_volume, district_name, service_code`).
5. **Trigger + pre-rating (PRP).** The `PT1M` file trigger fires; PRP claims the batch (`UNIQUE (file_key, batch_run_num)`), parses per `feed_profile`, and runs every validation — structural (missing column/data), duplicate (deduped on `trunc(start_datetime, month) | mno | cu | polygon`), the three identity locks, `service_code` verify, ratecard↔input completeness (both directions), and `udrType` confirmation. Any integrity failure **hard-stops the whole batch** (`reject_threshold: "0"`).
6. **Rating (RP).** RP resolves the subscriber (`party_role_id` + `product_inventory_id`) and the rate (scalar `usage_rate` as-of `start_datetime`), computes `PER_UNIT` (`ratePerUnit × usage_volume`), sets `udr_usage_unit` from the product's `unit_of_measure`, snapshots the price/version fields, and emits rated chunks.
7. **Loading (RL).** RL inserts the rated rows into `rating.udr_rated` at status `RATED` in one transaction, supersedes any prior live rows for the same `file_key`, reconciles `parsed = rated + rejected + discarded`, then archives the file `landing/ → archive/`.
8. **Consume + operate.** Rated usage is available for bill-run. The operator monitors the run; on a hard-stop, they fix the source/config and **re-drop the same filename** to reprocess (supersedes the prior attempt).

**Raw-key / `udr_resource` flow (Phase H), what changed in the steps above.** Worked example: rate-card row `mno_public_key = MNO-001`, `commercial_unit_public_key = CU-5G`, `polygon_id = ABCD_25 DISTRICT2`, `state = STATE-1`, `district = DISTRICT-1`, `polygon_start_date = 2026-01-01`.

1. **Provision the rate card.** If any row's `state` or `district` contains `|`, PRP stops the batch when it loads the card (`RATECARD_LABEL_INVALID`).
2. **PRP builds the key from raw values:** `commercial_unit=CU-5G|mno_public_id=MNO-001|polygon_id=ABCD_25 DISTRICT2`. A blank key field is still `MISSING_KEY_FIELD`.
3. **PRP matches by exact lookup** in an in-memory index of the ACTIVE card, keyed by the same raw serialisation. Had the feed sent `abcd_25 district2` there would be no match: `INPUT_UNMAPPED`, whole batch refused.
4. **PRP stamps the matched cell's `udr_resource = STATE-1|DISTRICT-1|2026-01-01`** (built once per cell when the card is loaded; a blank district gives `STATE-1||2026-01-01`) and, until Phase J, the cell's `state`/`district` as well. *(From rm32 PRP stamps only `udr_resource`.)*
5. **RP passes `udr_resource` through** unchanged and prices the record `PER_UNIT`. *(Until Phase J it also passed `state`/`district`.)*
6. **RL loads the batch** including `udr_resource`; the live-row constraint and the billed/in-flight collision guard compare raw keys.
7. **Billing prints** the polygon `ABCD_25 DISTRICT2` from the `polygon_id=` segment, the group label `STATE-1 - DISTRICT-1` and the start date from `udr_resource`, and never reads the rate card.

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
- `udr_key` holds the feed's raw values (sorted `name=value|…`), indexed directly. **`udr_key` is capped at 512 characters** by `CHECK (char_length(udr_key) <= 512)` — even at the worst case that permits (512 four-byte UTF-8 characters = 2,048 bytes) the index entry stays clear of the Postgres btree limit of 2,704 bytes, which would otherwise reject an insert at load time rather than at design time.

### Rating and price provenance

- Event-time price resolution: the price effective at `start_datetime`, resolved through the pinned `product_offering` version, not the price current at rating time.
- Snapshot-on-first-rate of every resolved input — rate, price row, price effective date, override reference — making a reprocess months later reproduce the original arithmetic.
- Rate types `FLAT` and **`PER_UNIT`** — the latter added for `RAN_USAGE` by the PER_UNIT update (Phase G; `_change-rating-configuration-plan.md`), computing `ratePerUnit × usage_volume` — with the enum also defining `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE` and `ZERO_RATED` (unimplemented); graduated and volume tiering are separate values because they produce different numbers for identical input.
- Type-specific rating data in `udr_rate_detail` JSONB, Zod-validated and discriminated by `udr_rate_type`, so adding `BLOCK` later is a schema change in validation rather than a database migration.
- Money at `numeric(18,2)` for amounts and `numeric(18,6)` for rates, with both raw and rounded values stored and the applied rounding mode recorded per record.
- Currency taken from the resolved price row, with RL asserting it matches `billing_account.currency` and raising `CURRENCY_MISMATCH` on disagreement — nothing in the existing schema constrains the two to agree.

### Deduplication, supersession and guards

- Natural key `(partition_period, udr_key)` for `RAN_USAGE` — one live row per cell per **billing month** (the PER_UNIT update, X2, drops `start_datetime` from the live-row key; `partition_period` becomes the billing month, X1). `udr_batch_run_num` is deliberately excluded — including it would mean run 2 never collides with run 1, and the constraint would fire on nothing.
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
- `rating.udr_rated.state` / `.district` (bm48, migration `0045`, nullable `text`): the matched RAN ratecard cell's labels, captured by PRP and written once by RL at INSERT; no role may UPDATE them. `NULL` = rated before bm48, a card label left blank, or a usage type that reads no ratecard. Consumed by the billing invoice's usage section (billing bm49); no index (the bill run reads by `billrun_*`). `udr_resource` carries `state|district|polygon_start_date` of the matched cell (Inv 28); once billing slice 2 ships, the invoice reads State, District and the start date from it instead of these columns. *(Reversed 2026-10-27, `_change-rating-drop-udr-rated-geo-columns-plan.md` D1/D4: the two columns are removed in Phase J (rm31–rm33); `0045` is rewritten in place to drop them under that round's fresh-DB setup; `udr_resource` is the only geo carrier.)*
- Four mounted locations: landing, archive, error, logs. Raw archive retained 7 years; reject and log files 24 months.

### Access, isolation and deployment

- A dedicated `rating_runtime` Postgres role with `SELECT`/`INSERT` on `rating.*`, `UPDATE` on `udr_rated` limited to `status`, no `DELETE` anywhere, `SELECT` only on the product, ordering, inventory and billing tables it rates from, explicit `REVOKE` on all billing writes, and a connection limit — following the per-table enumerated-grant pattern the codebase already uses to keep `app_runtime` off the pgledger internals.
- Column-scoped `GRANT UPDATE` to `app_runtime` on exactly the six `udr_rated` columns the bill run writes.
- No cross-schema foreign keys in either direction, so the two deployables' migrations stay decoupled.
- Workflow engine state in a separate database on the same server, so its automatic schema migrations hold no `CONNECT` on the billing database.
- Workflow engine UI behind an Entra-authenticated reverse proxy, giving per-user authentication and access logging at the proxy layer.
- `rating.*` tables as Drizzle migrations in the existing app repository (one migration history); flow definitions and the worker image in their own repository, so a rating rule change does not redeploy the billing web app.

### RAN_USAGE PER_UNIT rating (Phase G)

**Input and collection**
- Configurable landing contract: `landing_dir` (`/data/landing`) and `file_key_rule` (retargeted to `^(?P<file_key>rating-input-file-\d{12})(?:_v\d+)?\.udr$`).
- Header-less CSV parsing of the 7-column `.udr` feed via the `feed_profile` flow variable; the feed carries **no unit** (unit comes from the product).
- Datetime parsed in the system-config timezone (`Asia/Kuala_Lumpur`).

**Pre-rating validation (PRP) — all hard-stop unless noted**
- Structural checks: every row has all columns, all columns have data.
- Duplicate detection on the identity key `trunc(start_datetime, month) | mno | cu | polygon` (one usage record per cell per month).
- **Three-factor subscriber identity lock:** (1) resolve via `party_role_specification` → `party_role_id`; (2) ratecard `lkp_subscriber_ref_id` must equal that `party_role_id`; (3) resolved offering family id `COALESCE(family_offering_id, product_offering_id)` must equal the pinned flow variable.
- `service_code` verified against the matched ratecard row.
- Ratecard↔input completeness: every active ratecard entry must appear in input (default `HARD_STOP`, configurable to `WARN` via `ratecard_coverage_enforcement`); every input row must map to a ratecard entry (`HARD_STOP`).
- `udrType` (`RAN_USAGE`) confirmed against the offering's `udrType` spec.
- All-or-nothing on parse failure (`reject_threshold: "0"`).

**Rating (RP)**
- Real subscriber resolver (`party_role_specification->>'mnoPublicKey1'` → customer → RAN_USAGE subscription); empty `{}` spec → `UNKNOWN_SUBSCRIBER`.
- `udr_rate_type` derived from `component_type` (`usage_rate → PER_UNIT`).
- `PER_UNIT` compute: `udr_rated_price_raw (18,6) = ratePerUnit × usage_volume`; `udr_rated_price (18,2) = round(raw − discount, HALF_UP)`; discount `= 0`.
- Explicit `perUnitRateDetailSchema`: `{ rateType: "PER_UNIT", ratePerUnit, quantity, amountRaw }` (Zod + Python mirror).
- `udr_usage_unit` sourced from the product's `usage_rate.unit_of_measure`.
- Loud `CARD_DRIVEN_RATING_UNSUPPORTED` error if a card-driven `usage_rate` is resolved and its card carries cell rates or has no ACTIVE version; a card with no cell rates falls back to the product's `ratePerUnit` (rm30, 2026-10-22).

**Loading (RL)**
- Unchanged behavior, verified: single-transaction `COPY` insert at `RATED`, rm10 supersession by `file_key`, reconciliation identity, archive-after-commit.
- Verified for the new `raw ≠ rated` divergence PER_UNIT introduces and the `udr_rate_detail` JSON contract.

**Product and customer configuration**
- Product specs: `udrType`, `singleSubInstPerCust`, `productCardLookUp` (seed data, no schema change).
- Scalar `usage_rate` price component (existing pricing invariant untouched).
- MNO key on `party_role_specification` (`mnoPublicKey1`; path pinned; index deferred).
- Product lifecycle `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`; a price change is a new offering version with grandfather-on-ACTIVE (single price card, no future-dated secondary).

**Data model and DDL (fresh-install, edit-in-place)**
- Rename `udr_rated.udr_subscriber_ref_id` → `udr_subscription_ref_id` (column + index + all call sites incl. the bill-run repo).
- `period_of()` truncation timezone set to the system-config zone (deploy-time constant).
- Tighten the live-row unique constraint to `(partition_period, udr_key, is_live)`.

**Reload and reprocessing**
- Re-drop the same filename → same `file_key`, incremented `batch_run_num`, prior live rows superseded. The tightened live-row constraint backstops accidental overlap.

### Raw `udr_key` and `udr_resource` cell label (Phase H)

**Key construction and matching (PRP)**
- `build_udr_key(profile, row)` replaced `canonical_udr_key`: key names sorted once per profile, each value exactly as parsed, joined `name=value` with `|`; `_normalise_value` removed; the 512-character cap and the `MISSING_KEY_FIELD` check unchanged.
- The card index is keyed by the same raw serialisation of `mno_public_key`, `commercial_unit_public_key`, `polygon_id`. Case/whitespace variants are distinct cells (`ratecard_ran_usage_lkp_row_key_unique` already rejects exact duplicates); the fail-closed guard in `extract_ratecard` fires only on a serialisation collision. `INPUT_UNMAPPED` and `RATECARD_COVERAGE_GAP` unchanged.

**Cell label (PRP → RP → RL)**
- `_RATECARD_SQL` selects `polygon_start_date`; `RatecardCell` carries `state`, `district`, `polygon_start_date` and a precomputed `udr_resource` string; a `|` in a label refuses the batch (`RATECARD_LABEL_INVALID`, `PRP`, `MAJOR`, not self-clearing — rm25 seed row and `RATING_EVENT_CODES`).
- `ParsedRow` and the chunk carry `udr_resource`; RP passes it through; RL COPYs it — required and non-empty for `RAN_USAGE` (a chunk missing it raises), `NULL` for other usage types (a value carried on one raises too).
- Written once at INSERT under `rating_runtime`'s table-level INSERT; no role holds UPDATE on it, so a later card re-version never changes a rated row.

**Loading and guards (RL)** — no code change: the live-row constraint, the billed/in-flight collision guard and supersession by `file_key` compare raw keys. Two `RATED` rows whose keys differ only in case both load (accepted, tested).

**Seeds and tests** — sample seeds and `rating-ran-harness.ts` emit raw keys and a populated `udr_resource` (`formatUdrResource`), with one RAN row left `NULL` for billing's fail-loud path; `rm01`, `rm07`, `rm09`, `rm13`, `rm23`, `rm27` and `grants` extended (code-standards §10 tests 17–20). `rating_flow_revision` / `rating_engine_version` bumped so raw-key rows are distinguishable.

## In scope

- The `rating` schema: `udr_rated`, `udr_batch`, `process_log`, `event_catalog` — real tables, real constraints, real partitioning, real grants.
- The `rating_runtime` Postgres role and the column-scoped grant to `app_runtime`.
- The workflow template with all three components (PRP, RP, RL) present as named, wired sections carrying their guards, their logging contract, and their transaction boundary — with the rating computation itself stubbed (replaced for `RAN_USAGE` by the PER_UNIT update, below).
- File ingestion: landing pickup, database-backed claiming, checksum, archive-after-commit, startup reconciliation of stranded batches.
- Validation, reject files, per-`udr_type` threshold configuration.
- Deduplication, batch-level supersession, and the `BILL_APPROVED` refusal guard.
- Batch reconciliation and shrinking-reissue detection.
- The expected-cadence completeness check.
- Structured logging, the log sweep, `event_catalog` seeding, and `alarm_key` clear semantics.
- Infrastructure: workflow engine container deployment, custom worker image, separate engine database, Entra reverse proxy, mounted storage, Key Vault secret wiring, `pg_partman` registration.

**PER_UNIT RAN-usage update (Phase G):**

- The real subscriber resolver in `rp.py` (party_role_spec → RAN_USAGE subscription).
- `PER_UNIT` rating math + `perUnitRateDetailSchema` (Zod + Python mirror).
- All PRP validations above, including the three-factor identity lock and the widened dedup key.
- The 7-column `feed_profile`, `file_key_rule` retarget, `ratecard_coverage_enforcement`, and `reject_threshold: "0"` flow variables.
- Product specs `udrType` / `singleSubInstPerCust` / `productCardLookUp` and a scalar `usage_rate` price (seed).
- Customer `party_role_specification` MNO-key shape + the one-MNO→one-customer PRP guard.
- The three `udr_rated` DDL touches: the `udr_subscription_ref_id` rename, the `period_of()` timezone constant, and the live-row constraint tighten.
- Scope-doc reconciliation: update `ratemgmt-ai-workflow-rules.md` (§2.5/§3), this overview, `code-standards` (§2.3) to bring PER_UNIT + the real resolver in scope; banner the affected rm specs (`rm01/06/07/08/09/10/12`); banner/update pm57a (ratecard `lkp_subscriber_ref_id` semantics).
- Test coverage for all new paths + the three regressions (FLAT→PER_UNIT refresh; dedup widening; input→ratecard behavior change).

**Raw `udr_key` / `udr_resource` update (Phase H):**

- `build_udr_key` and the removal of `_normalise_value` / the normalising `canonical_udr_key`, with every docstring and comment that described canonical behaviour updated.
- The exact-match card index and the reworded serialisation-collision guard in `extract_ratecard`.
- `polygon_start_date` in the card query; `RatecardCell.udr_resource` built once per cell; the `|`-in-label fail-closed check and its event code.
- `udr_resource` carried through `ParsedRow`, the chunk Parquet, RP and RL `COPY_COLUMNS` (RAN required, other types `NULL`).
- The version bump; seeds, harness and the tests in the plan §5, including the case-variant test; the rule and document amendments in the plan §7 (rm24).

## Out of scope

- **The rating computation itself** — *superseded by the PER_UNIT update (Phase G).* PRP mapping/validation, RP `PER_UNIT` pricing (`ratePerUnit × usage_volume`) and the real subscriber resolver are now **in scope for `RAN_USAGE`** (see the PER_UNIT update sections of this overview). Rate types beyond `FLAT`/`PER_UNIT` (`TIERED_*`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED`) remain out of scope.
- **Any front end.** No pages, no Server Actions, no RBAC permissions, no components. Billing Ops works in the workflow engine UI.
- **The bill run's claim path.** The bill run stamping `billrun_ref_id` and moving records to `BILL_DRAFT` is the contract this module delivers against, not something it builds.
- **Adjustments and credit notes** for corrections to already-billed usage. This release ships the guard that refuses the load; the remedy is a later phase.
- **Minimum commitments and caps.** Common in enterprise contracts, and not rate types — a subscription's shortfall against its monthly minimum is unknowable until the whole period is rated, making these bill-run-time adjustments over the rated set.
- **Allowance and bundle consumption**, which requires per-subscription-per-period balance state.
- **Real-time and online charging.** Files only.
- **Automated retry with backoff** for failed batches. Recovery is operator-triggered from the workflow engine UI.
- **Per-user authorization inside the workflow engine.** The OSS edition has no user model; the reverse proxy provides authentication and access logging, and the residual risk — anyone past the proxy holds full instance rights, including editing rating logic — is an accepted, documented risk with the Enterprise edition as the phase-2 path.
- **Flow definition version control process** and the **testing approach for rating logic expressed in workflow definitions** — both deferred by decision, to be defined before the rating computation is built.

**PER_UNIT RAN-usage update (Phase G):**

- **Workstream C — Product-management UI** (list/view/amend/retire) and the `product_catalog` permission — deferred; config is seed/manual this phase.
- **`singleSubInstPerCust` ordering-layer enforcement** — no code guard this phase (seed discipline only); lands with the ordering UI.
- **Maker-checker** on product lifecycle — single-operator `MANAGER`.
- **Multi-MNO-per-customer** (`mnoPublicKey2..N`) — the resolver is written as "first of N" but only the single key is wired.
- **Card-driven PER_UNIT rating** (`PLA_USAGE_RATE`) from card rates — not built; RP raises `CARD_DRIVEN_RATING_UNSUPPORTED` when the card carries rates. A card with no rates falls back to `ratePerUnit` (rm30).
- **Other rate types** (TIERED_GRADUATED / TIERED_VOLUME / BLOCK / PERCENTAGE / ZERO_RATED) — enum-present, unbuilt.
- **Usage-level discounts** — all discount fields `0`/NULL.
- **Effective-dated pricing for existing customers** — grandfather-until-re-subscribe only.
- **Normalized `customer_mno_key` table + DB uniqueness** — jsonb + PRP runtime guard for now.
- **A `party_role_specification` index** — deferred (tiny table at pilot).
- **Any data migration** — the two constraint/function DDLs and the rename are edit-in-place on an empty `udr_rated` (fresh-install regime).

**Raw `udr_key` / `udr_resource` update (Phase H):**

- Any new column on `rating.udr_rated`, any migration, any grant change.
- Reversing bm48: the `state` and `district` columns stay, and their consumers are untouched. *(Reversed 2026-10-27: Phase J removes them — `_change-rating-drop-udr-rated-geo-columns-plan.md`.)*
- Rewriting or backfilling existing `udr_rated` rows (none on the fresh database); a cutover guard; a normalised uniqueness backstop (e.g. a `lower(trim(udr_key))` index).
- Changing the 512-character cap, the live-row constraint, supersession by `file_key`, the rate-card schema or upload screen, or the feed format; normalising values at the feed.
- `udr_resource` for non-RAN usage types (they write `NULL`); new rate types, discounts, or PER_UNIT pricing changes; billing code, the invoice layout and the usage query (companion billing plan).

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

**PER_UNIT RAN-usage rating (Phase G)**

22. A sample `rating-input-file-<YYYYMMDDHHMI>.udr` dropped in `/data/landing` produces `rating.udr_rated` rows at status `RATED` where `udr_rate_type = "PER_UNIT"`, `udr_rated_price_raw = ratePerUnit × usage_volume`, and `udr_rated_price = round(raw, HALF_UP)` — verified end-to-end (the refreshed rm13 journey).
23. `udr_subscription_ref_id` = the resolved `product_inventory_id`; `udr_usage_unit` = the product's `unit_of_measure`; `udr_rate_detail` validates against `perUnitRateDetailSchema`.
24. Each of the three identity locks hard-stops the batch on a forced mismatch (bad MNO key, wrong ratecard `lkp_subscriber_ref_id = party_role_id`, wrong pinned family id), and a customer with an empty `{}` spec yields `UNKNOWN_SUBSCRIBER`.
25. A file with a missing column, a blank field, a duplicate `(month|mno|cu|polygon)` row, an unmapped input row, a `service_code` mismatch, or a missing ratecard polygon (under `HARD_STOP`) refuses the **whole batch**; the same missing-polygon file under `WARN` rates and logs the gap.
26. A customer holding a second (non-RAN) active subscription still resolves to the RAN subscription (offering filter), and a second RAN subscription is rejected at ordering (`singleSubInstPerCust`).
27. Re-dropping the same filename supersedes the prior batch; a same-cell/same-month second live row is rejected by the tightened constraint.
28. Month bucketing and datetime parsing use `Asia/Kuala_Lumpur`; a record near a month boundary lands in the correct Malaysian-calendar month.
29. The bill-run read path resolves usage through `udr_subscription_ref_id` with no broken reference after the rename.
30. The rating test suite is green: all new-path tests pass, and the three regressions (R1 FLAT→PER_UNIT, R2 dedup widening, R3 input→ratecard hard-stop) are covered.
31. The scope/rules docs and rm-spec banners are updated so the suite tracks PER_UNIT scope rather than the retired FLAT-only scope.

**Raw `udr_key` / `udr_resource` (Phase H)**

32. A `RAN_USAGE` row for polygon `ABCD_25 DISTRICT2` loads with `udr_key` containing exactly `polygon_id=ABCD_25 DISTRICT2`; two records differing only in polygon case produce two keys and both load (RL's half injects the pair directly, rm28); a feed polygon differing from the card only by case or a trailing space is refused `INPUT_UNMAPPED` and the batch stops under `HARD_STOP`.
33. The matched cell's row has `udr_resource = STATE-1|DISTRICT-1|2026-01-01`; a blank district gives `STATE-1||2026-01-01`; the date is always `YYYY-MM-DD`; a card with `|` in a label fails the batch before any record is rated.
34. No new column and no migration file; `udr_resource` is in no role's column UPDATE privilege and an UPDATE by `rating_runtime`, `app_runtime` or `billrun_runtime` is refused; activating a new card version afterwards leaves the rated row's `udr_resource` unchanged.
35. A `RAN_USAGE` chunk missing `udr_resource` makes RL raise; a non-RAN chunk writes `NULL`; a batch whose raw keys collide with a live `BILL_APPROVED` row is still refused whole (`LOAD_BLOCKED_BILLED`).
36. The `rm13` journey passes with the raw key and expected `udr_resource`; `rm07`, `rm09`, `rm13`, `rm23`, `rm27`, `rm01` and `grants` pass with the extended cases; no rating document still calls `udr_key` canonical or `udr_resource` reserved, and billing slice 2 reads polygon, State-District and start date from `udr_rated` alone.
