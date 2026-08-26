# rm01 — `rating` schema foundation — Spec

- **Unit:** rm01 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase A)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/schema/rating/**`, `db/migrations/`, `db/bootstrap/`
- **Builds:** the `rating` schema, its four tables, every constraint that carries an Invariant, and the `pg_partman` registration.
- **Depends on:** platform Postgres with `pg_partman` ≥ 5 and `pg_cron` plus the existing daily maintenance job; `core.generate_ulid()`.
- **Sources:** `ratemgmt-architecture.md` (Inv #2, #3, #4, #5, #7, #15, #16a, #17, #17a), `ratemgmt-code-standards.md` §5, `ratemgmt-project-overview.md` (column detail), `context/code-standards.md` §6, `context/architecture.md` §3–4.

---

## Goal

Create the `rating` schema with `udr_rated`, `udr_batch`, `process_log` and `event_catalog`, carrying every constraint the module's Invariants depend on, so that a second live row for one usage record is rejected by the database before any pipeline code exists. Ship monthly `pg_partman` registration for the two high-volume tables on the existing daily maintenance job.

---

## Design

### D1. The constraint is the deliverable, not the tables

This unit's visible result is a **passing constraint suite**, not "four tables exist". Every acceptance item in §Verification is an assertion that the database refuses something. Tables without their constraints do not satisfy this unit.

### D2. The migration is hand-authored SQL; Drizzle declares for typing only

`drizzle-kit generate` cannot express declarative partitioning, `create_parent`, `CREATE EXTENSION`, or a `pg_cron` schedule. The codebase settled this in `um27-audit-log-ulid-partitioning.md` §2.6, *"Ownership of DDL — hand-authored SQL is the source of truth"*:

- The **DDL of record is a hand-authored migration file**, not a generated one. `0001_audit.sql` set the precedent; `0027_bill_run_account.sql` follows it — the billing progress tracker records it as *"hand-authored raw SQL (not drizzle-kit generated) — Drizzle can't express `PARTITION BY`, so it follows the `0001_audit.sql` precedent exactly (composite PK, default partition, journal entry added by hand)"*.
- The **Drizzle TypeScript schema declares the table for query typing only**, annotated with a comment that the physical DDL lives in SQL. Partitioning is *annotated, not declared*.
- **The Drizzle meta snapshot and journal entry are updated by hand** so migration state stays consistent.

So the sequence for this unit is: write the `.sql` file directly, write the matching `db/schema/rating/*.ts` for typing, and hand-add the journal entry. Do **not** run `drizzle-kit generate` and patch its output — that is not what the existing partitioned tables did.

**Copy the annotation style** from `db/schema/billing/bill-run-account.ts`, which opens with a comment block explaining that the table is partitioned via `pg_partman`, that Drizzle cannot express partitioning or the composite PK, and that the declaration exists for query typing.

### D3. One timezone literal, in one function

`partition_period` cannot be a generated column (Postgres rejects generated columns as partition keys) and cannot be derived by a trigger (**partition routing happens before row-level triggers fire** — a `BEFORE INSERT` trigger on the partition never gets the chance). The loader must supply the value, so the loader can supply it wrong.

The guard is a CHECK, and the business-timezone literal lives in **exactly one place** — an `IMMUTABLE` helper function:

```sql
CREATE FUNCTION rating.period_of(ts timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$$ SELECT date_trunc('month', ts AT TIME ZONE 'UTC')::date $$;
```

Verified session-independent across `UTC`, `America/New_York` and `Asia/Singapore` sessions, and it still rejects a deliberate mismatch. **RL uses the same function to compute the value it inserts**, so the CHECK is a cross-check against a loader that bypasses it, not a tautology against one that does not.

**Why this guard is not optional:** a wrong timezone misfiles only records within 8 hours of a month boundary — a fraction of a percent. It passes every test and surfaces months later as sporadic double-billing, because a misfiled row sits in a partition where the unique index cannot see its twin.

**Decided: the literal is `UTC`.** `partition_period` is therefore a **physical storage bucket, not the billing month** — a usage event at `2026-09-01 02:00+08` files under **August**, because that is `2026-08-31 18:00` UTC. Three consequences, all deliberate:

1. **It matches `core.audit_log`**, which is likewise UTC-keyed (`um29` §2.10 lists audit partition keys among the things that stay UTC).
2. **A future change to the business timezone requires no data migration.** Under a business-local literal, every stored `partition_period` would become wrong; under UTC, the labels are shelf numbers and only queries change.
3. **The bill run must select its period as a range predicate on `start_datetime` in business-local time**, not as an equality match on `partition_period`. Partition pruning still applies — the range touches at most two partitions. This is a note for the billing module, and it is already recorded as the zero-activity-accounts open item's neighbour in `_newmodule-billrun-rating-workflow-plan.md` §11.

The literal is not runtime-configurable and no environment variable feeds it. Changing it re-buckets stored periods and is a documented never-do.

### D4. `is_live` carries the uniqueness constraint

`is_live` is `GENERATED ALWAYS … STORED` from `status`, so it cannot drift from the value it derives from. Live rows hold `TRUE` and collide; superseded rows hold `NULL` and coexist without limit under SQL's default `NULLS DISTINCT`. Zero live rows is a valid state.

Verified: updating `status` recomputes `is_live` with no separate `UPDATE` grant on the generated column, which is what makes the column-scoped grant model in rm03 work.

### D5. Timestamp precision is part of the natural key

`start_datetime` is half the natural key. **Store it at full precision** (`timestamptz`, no precision modifier — Postgres default 6). Do **not** copy the `precision: 3` used on billing's operational timestamps: if the feed carries sub-millisecond granularity and the column truncates to milliseconds, two distinct usage events collapse to one key, the second is rejected as a duplicate, and that is silent revenue loss.

Operational timestamps (`insert_datetime`, `upsert_datetime`, `received_at`, …) use `precision: 3`, matching house style.

### D6. `event_code` deliberately has no foreign key

`process_log.event_code` is **not** an FK to `event_catalog`, even though both live in `rating` and an intra-schema FK would be permitted (Inv #17 bans only cross-schema FKs).

The reason is a design requirement that a constraint would break: an unrecognised `event_code` must **resolve to `INDETERMINATE` and still load**, so it can be counted as the hygiene metric. An FK would reject the row and destroy the only evidence that an unclassified event was emitted. This is a deliberate exception to `ratemgmt-code-standards.md` §1.3 ("the database is the guarantee") and is recorded here so it does not read as an oversight.

### D11. Lineage is batch-level, because supersession is

Three columns an earlier draft placed on `udr_rated` are **not** there:

| Dropped from `udr_rated` | Why | Where it lives now |
| --- | --- | --- |
| `udr_batch_run_num` | Identical for every row of a batch; reachable via `udr_ref_batch_id` | `udr_batch.batch_run_num` |
| `supersede_reason` | Identical for every row a given batch retires | `udr_batch.supersede_reason` |
| `superseded_by_udr_id` | **Not populatable.** Supersession marks prior rows *before* inserting the new ones, so at supersede time the successor does not exist. Back-filling it would need a fourth pass matching 50,000 rows by natural key — and where a corrected timestamp changed the key, the match fails | `udr_batch.superseded_by_batch_id` |

The per-row pointer implied a row-to-row relationship the mechanism never establishes. Nothing is lost by removing it: **a specific row's successor is the live row with the same natural key**, which the uniqueness constraint guarantees is unique — derivable, not stored. A superseded row with *no* successor is the revenue-leakage case, already found by `WHERE is_live IS NULL`.

**Consequence for the supersede predicate (rm10).** With `udr_batch_run_num` gone from `udr_rated`, "supersede live rows from this file at run < N" becomes a join against `udr_batch` rather than a column comparison:

```sql
UPDATE rating.udr_rated SET status = 'SUPERSEDED'
 WHERE is_live
   AND udr_ref_batch_id IN (
         SELECT batch_id FROM rating.udr_batch
          WHERE file_key = $1 AND batch_run_num < $2);
```

`udr_batch` is small and `udr_ref_batch_id` is indexed, so this is cheap — and it makes `udr_batch` the single authority on which batches exist for a file, rather than trusting a denormalised copy.

**`udr_source_file` is deliberately kept** on `udr_rated` even though it is equally derivable. It is there for the same reason `udr_rounding_mode` is: a rated row should be readable in a dispute without a join. That is a stated principle, not an oversight — if it is ever dropped, `udr_rounding_mode` should go with it for consistency.

### D12. `file_key` is the grouping identity; `source_file` is only the physical name

**The problem this solves.** Every claim and supersession predicate originally keyed off `source_file` equality, which assumes a corrected file arrives under the **identical filename**. If upstream reissues `RAN_USAGE_20260814.dat` as `RAN_USAGE_20260814_v2.dat`, that assumption fails in two ways:

- **Timestamps unchanged** — both batches get `batch_run_num = 1`, both load as live, every record collides on the uniqueness constraint, and the batch fails wholesale with a confusing error.
- **Timestamps corrected** — the natural keys differ, nothing collides, and **both versions go live**. A silent double-bill, which is precisely the failure the whole design exists to prevent.

**The fix.** `udr_batch` carries a **`file_key`**: the logical identity of a delivery, **extracted by PRP from the filename** using a rule predefined per `udr_type`. Both `RAN_USAGE_20260814.dat` and `RAN_USAGE_20260814_v2.dat` resolve to one `file_key`.

**From the filename, never from file content — and that is forced, not merely simpler.** PRP's first action is to claim the file, *before* parsing, so that a file which dies during parsing still leaves a `udr_batch` row. A content-derived key would require reading and parsing the file before it could be claimed, inverting that order and destroying the guarantee. The filename is the only identifier available at claim time.

**The consequence: the filename convention becomes a contract with upstream.** If a reissue arrives under a name the rule cannot parse — `corrected_file.dat`, say — the key does not resolve and PRP refuses the file. That is the designed behaviour (refuse rather than guess), but it makes the naming convention an operational dependency that must be agreed with the file provider, not assumed.

| Concern | Column | Used for |
| --- | --- | --- |
| Logical delivery identity | `file_key` | The claim constraint, `batch_run_num` assignment, supersession scope |
| Physical filename as delivered | `source_file` | Forensics, log correlation, operator recognition. **Never a grouping key.** |
| Which rule produced the key | `file_key_rule` | Traceability when a derivation rule changes |

**`batch_run_num` assignment — specified here because nothing previously specified it.** PRP computes it inside the claim insert:

```sql
INSERT INTO rating.udr_batch (file_key, source_file, file_key_rule, udr_type, batch_run_num, …)
SELECT $file_key, $source_file, $rule, $udr_type,
       COALESCE(max(batch_run_num), 0) + 1, …
  FROM rating.udr_batch WHERE file_key = $file_key;
```

The `UNIQUE (file_key, batch_run_num)` constraint makes this safe under concurrency: two workers computing the same `max+1` produce the same tuple and one loses.

**Order of checks in PRP** — the sequence matters:

1. **Derive `file_key`.** If no rule is configured for the `udr_type`, or the file does not match the rule, **refuse the file** and raise `FILE_KEY_UNRESOLVED` at `MAJOR`. **Never fall back to treating it as new** (see the risk below).
2. **Compute the checksum.** If a prior batch for this `file_key` has the identical checksum, this is a redelivery, not a reissue — discard as `DUPLICATE_BATCH` before any parsing cost.
3. **Assign `batch_run_num`** as above and insert the claim.

**The risk this introduces, stated plainly.** A derivation rule that is too greedy makes tomorrow's file resolve to yesterday's `file_key`, and supersession then retires a whole day of correct records. That is worse than the problem it fixes. Two guards:

- **Refuse rather than guess** (step 1). An unresolvable key is an alarm, never a default.
- **A `file_key` must be distinguishing.** Its derivation must include whatever identifies the delivery period or sequence. Fixture tests must assert that files for two different content periods never produce the same key — this is a required test in rm07, not an optional one.

### D7. Two retentions, not one

| Table | Retention | Expiry | Rationale |
| --- | --- | --- | --- |
| `udr_rated` | **7 years** | **DETACH** | Financial record; matches the billing tables' archival contract and the invoice's statutory life |
| `process_log` | **24 months** | **DETACH** | Operational telemetry, aligned to the 24-month retention of the log *files* it is loaded from |
| `udr_batch` | 7 years | not partitioned | Low volume; the reconciliation and file-receipt record behind `udr_rated` |
| `event_catalog` | indefinite | not partitioned | Reference data |

### D8. The `DEFAULT` partition must stay empty

Each partitioned table gets a bootstrap `DEFAULT` partition so the parent is valid before `pg_partman` takes over (the `audit_log` / `bill_run_account` precedent).

**A row landing in a `DEFAULT` partition is an alarm, not a normal state.** It means partition pre-creation fell behind. It also has a concrete cost: with a non-empty default, creating the next bounded partition requires a full scan of the default under `ACCESS EXCLUSIVE`. Monitor the default partitions' row counts; the expected value is zero.

### D9. `udr_type` is unconstrained text

**Decided:** no CHECK, no lookup table. New charge types need no migration.

**Accepted consequence, stated so it is a decision:** a typo in a flow silently creates a phantom `udr_type`. Nothing rejects it, and the completeness check (rm12) is keyed by `udr_type`, so a phantom type gets no expected-cadence entry and its absence is never alarmed. The mitigation is a monitoring query — `SELECT DISTINCT udr_type` against the configured list — not a constraint. Add it when rm12 lands.

### D10. `udr_resource` is reserved and stays NULL

Nullable, no defined semantics in v1 (Inv #16a). **Do not populate it.** A column filled with one implementer's assumption asserts a meaning that downstream consumers will read and that a migration cannot honestly undo, because the rows are financial and immutable. NULL is queryable and honest.

---

## Implementation

### 1. Schema and helper function — `db/migrations/00NN_rating.sql`

Take the next migration number in sequence. Statements separated by `--> statement-breakpoint`, matching the existing files.

```sql
CREATE SCHEMA "rating";
--> statement-breakpoint
-- The single home of the business-timezone literal (D3). IMMUTABLE so it can
-- be used in a CHECK constraint; verified session-independent.
CREATE FUNCTION "rating"."period_of"(ts timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$$ SELECT date_trunc('month', ts AT TIME ZONE 'UTC')::date $$;
--> statement-breakpoint
CREATE SEQUENCE "rating"."udr_batch_seq" INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1;
```

### 2. `rating.udr_rated` — `db/schema/rating/udr-rated.ts`

Columns, in the order they appear in `ratemgmt-project-overview.md`:

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `udr_id` | `uuid` | NOT NULL | `DEFAULT core.generate_ulid()` |
| `partition_period` | `date` | NOT NULL | partition key, `mode: "string"` |
| `udr_type` | `text` | NOT NULL | unconstrained (D9) |
| `start_datetime` | `timestamptz` | NOT NULL | **full precision** (D5) |
| `end_datetime` | `timestamptz` | NOT NULL | full precision |
| `status` | `text` | NOT NULL | CHECK, default `'RATED'` |
| `is_live` | `boolean` | — | `GENERATED ALWAYS … STORED` (D4) |
| `udr_subscriber_ref_id` | `text` | NOT NULL | → `inventory.product_inventory`, plain text |
| `udr_key` | `text` | NOT NULL | CHECK ≤ 512 |
| `udr_resource` | `text` | NULL | reserved (D10) |
| `udr_usage_quantity` | `numeric(20,6)` | NOT NULL | `mode: "string"` |
| `udr_usage_unit` | `text` | NOT NULL | |
| `udr_usage_rate` | `numeric(18,6)` | NULL | `mode: "string"` |
| `udr_rate_type` | `text` | NOT NULL | CHECK, `FLAT` in v1 |
| `udr_rate_detail` | `jsonb` | NULL | `.$type<T>()` from `validation/rating/` |
| `udr_rated_price` | `numeric(18,2)` | NOT NULL | billable, rounded |
| `udr_rated_price_raw` | `numeric(18,6)` | NOT NULL | pre-rounding |
| `udr_rounding_mode` | `text` | NOT NULL | CHECK |
| `udr_discount_amount` | `numeric(18,2)` | NULL | |
| `udr_discount_amount_raw` | `numeric(18,6)` | NULL | |
| `udr_discount_type` | `text` | NULL | CHECK `fixed`/`percentage` |
| `udr_discount_rate` | `numeric(18,6)` | NULL | |
| `udr_discount_authority_ref` | `text` | NULL | |
| `udr_currency` | `char(3)` | NOT NULL | matches `billing_account.currency` shape |
| `udr_subscription_rateplan_ref` | `text` | NULL | |
| `udr_price_ref` | `text` | NULL | → `product.product_offering_price`, plain text |
| `udr_price_effective_date` | `timestamptz` | NULL | |
| `udr_price_override_ref` | `text` | NULL | → `ordering.order_item_price_override`, plain text |
| `billrun_ref_id` | `text` | NULL | written by bill run |
| `billrun_ban_id` | `text` | NULL | written by bill run |
| `billrun_attempt` | `integer` | NULL | written by bill run |
| `billrun_checksum` | `text` | NULL | written by bill run |
| `udr_ref_batch_id` | `text` | NOT NULL | → `rating.udr_batch`, plain text. **The single lineage anchor** (D11) |
| `udr_source_file` | `text` | NOT NULL | Kept for self-explaining rows (D11) |
| `rating_engine_version` | `text` | NOT NULL | worker image tag |
| `rating_flow_revision` | `integer` | NOT NULL | Kestra flow revision |
| `udr_loader_instance_id` | `text` | NULL | workflow execution id |
| `rated_datetime` | `timestamptz(3)` | NULL | RP time |
| `insert_datetime` | `timestamptz(3)` | NOT NULL | `DEFAULT now()` |
| `upsert_datetime` | `timestamptz(3)` | NULL | written by bill run |

**Generated column** — declare in Drizzle and verify the emitted SQL matches:

```sql
"is_live" boolean GENERATED ALWAYS AS
  (CASE WHEN status IN ('RATED','BILL_DRAFT','BILL_APPROVED') THEN true END) STORED
```

**Constraints:**

```sql
CONSTRAINT "udr_rated_pk" PRIMARY KEY ("partition_period","udr_id"),
CONSTRAINT "udr_rated_live_uq" UNIQUE ("partition_period","start_datetime","udr_key","is_live"),
CONSTRAINT "udr_rated_udr_key_length_check" CHECK (char_length(udr_key) <= 512),
CONSTRAINT "udr_rated_period_matches_check" CHECK (partition_period = rating.period_of(start_datetime)),
CONSTRAINT "udr_rated_status_check" CHECK (status IN
  ('RATED','BILL_DRAFT','BILL_APPROVED','REJECTED','SUPERSEDED','BILL_NOTUSED')),
CONSTRAINT "udr_rated_rate_type_check" CHECK (udr_rate_type IN
  ('FLAT','PER_UNIT','TIERED_GRADUATED','TIERED_VOLUME','BLOCK','PERCENTAGE','ZERO_RATED')),
CONSTRAINT "udr_rated_discount_type_check" CHECK (udr_discount_type IS NULL OR udr_discount_type IN ('fixed','percentage')),
CONSTRAINT "udr_rated_rounding_mode_check" CHECK (udr_rounding_mode IN ('HALF_UP','HALF_EVEN','TRUNCATE')),
CONSTRAINT "udr_rated_end_after_start_check" CHECK (end_datetime >= start_datetime)
```

Then, hand-edited onto the `CREATE TABLE`:

```sql
) PARTITION BY RANGE ("partition_period");
```

**Indexes:**

```sql
CREATE INDEX "udr_rated_subscriber_start_idx" ON "rating"."udr_rated" (udr_subscriber_ref_id, start_datetime);
CREATE INDEX "udr_rated_billrun_idx" ON "rating"."udr_rated" (billrun_ref_id, billrun_ban_id, billrun_attempt)
  WHERE billrun_ref_id IS NOT NULL;
CREATE INDEX "udr_rated_batch_idx" ON "rating"."udr_rated" (udr_ref_batch_id);
CREATE INDEX "udr_rated_orphan_idx" ON "rating"."udr_rated" (udr_key) WHERE is_live IS NULL;
CREATE TABLE "rating"."udr_rated_default" PARTITION OF "rating"."udr_rated" DEFAULT;
```

**No foreign keys.** Not to `core.APPUSER`, not to `rating.udr_batch`, not anywhere (Inv #17). `udr_ref_batch_id` is plain text.

### 3. `rating.udr_batch` — `db/schema/rating/udr-batch.ts`

Not partitioned. `batch_id` uses the prefix + 8-digit sequence convention.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `batch_id` | `text` | NOT NULL | `DEFAULT 'UDRBAT' \|\| lpad(nextval('rating.udr_batch_seq')::text, 8, '0')`, PK |
| `file_key` | `text` | NOT NULL | **The logical file identity** — derived by PRP, groups reissues of the same delivery (D12) |
| `source_file` | `text` | NOT NULL | The physical filename as delivered; forensics only, never a grouping key |
| `file_key_rule` | `text` | NOT NULL | Which configured derivation rule produced `file_key`, so a rule change is traceable (D12) |
| `udr_type` | `text` | NOT NULL | |
| `batch_run_num` | `integer` | NOT NULL | `DEFAULT 1`; assigned as `max+1` within `file_key` (D12) |
| `file_checksum` | `text` | NULL | populated at receipt |
| `file_size_bytes` | `bigint` | NULL | |
| `status` | `text` | NOT NULL | CHECK, `DEFAULT 'RECEIVED'` |
| `received_at` | `timestamptz(3)` | NOT NULL | `DEFAULT now()` |
| `started_at` | `timestamptz(3)` | NULL | |
| `completed_at` | `timestamptz(3)` | NULL | |
| `declared_record_count` | `integer` | NULL | from manifest/trailer if present |
| `parsed_count` | `integer` | NULL | |
| `rated_count` | `integer` | NULL | |
| `rejected_count` | `integer` | NULL | |
| `discarded_count` | `integer` | NULL | |
| `superseded_count` | `integer` | NULL | |
| `reject_file_path` | `text` | NULL | |
| `archive_file_path` | `text` | NULL | populated only after commit |
| `workflow_execution_id` | `text` | NULL | |
| `workflow_flow_revision` | `integer` | NULL | recovers the config that applied |
| `rating_engine_version` | `text` | NULL | |
| `superseded_by_batch_id` | `text` | NULL | The batch that retired this batch's rows (D11) |
| `supersede_reason` | `text` | NULL | Why, recorded once per batch (D11) |
| `error_summary` | `text` | NULL | |

```sql
CONSTRAINT "udr_batch_pk" PRIMARY KEY ("batch_id"),
CONSTRAINT "udr_batch_file_key_run_uq" UNIQUE ("file_key","batch_run_num"),
CONSTRAINT "udr_batch_status_check" CHECK (status IN
  ('RECEIVED','PROCESSING','COMPLETE','PARTIAL','FAILED','REFUSED')),
CONSTRAINT "udr_batch_run_num_positive_check" CHECK (batch_run_num >= 1)
```

```sql
CREATE INDEX "udr_batch_file_key_idx" ON "rating"."udr_batch" (file_key, batch_run_num DESC);
```

`UNIQUE (file_key, batch_run_num)` is the file claim (Inv #7) — the reason a file-watcher double-fire cannot produce two concurrent loads. **Scoped to `file_key`, not `source_file`** (D12). Do not weaken it.

### 4. `rating.process_log` — `db/schema/rating/process-log.ts`

Partitioned monthly on `partition_period`, derived from `log_datetime`.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `log_id` | `uuid` | NOT NULL | `DEFAULT core.generate_ulid()` |
| `partition_period` | `date` | NOT NULL | partition key |
| `log_datetime` | `timestamptz(3)` | NOT NULL | when the activity happened |
| `component` | `text` | NOT NULL | CHECK |
| `log_level` | `text` | NOT NULL | CHECK |
| `perceived_severity` | `text` | **NULL** | CHECK; set only on alarm-worthy rows |
| `event_code` | `text` | NOT NULL | **no FK** (D6) |
| `event_type` | `text` | NULL | X.733 class |
| `probable_cause` | `text` | NULL | |
| `specific_problem` | `text` | NULL | the actual error message |
| `managed_object` | `text` | NULL | source file / batch id / component |
| `alarm_key` | `text` | NULL | pairs raise with clear |
| `source_file` | `text` | NULL | |
| `batch_id` | `text` | NULL | plain text, no FK |
| `workflow_execution_id` | `text` | NULL | |
| `additional_info` | `jsonb` | NULL | Zod-validated at the write boundary |
| `insert_datetime` | `timestamptz(3)` | NOT NULL | `DEFAULT now()`; lag vs `log_datetime` is a health metric |

```sql
CONSTRAINT "process_log_pk" PRIMARY KEY ("partition_period","log_id"),
CONSTRAINT "process_log_period_matches_check" CHECK (partition_period = rating.period_of(log_datetime)),
CONSTRAINT "process_log_component_check" CHECK (component IN ('PRP','RP','RL','LOG_SWEEP','SCHEDULER')),
CONSTRAINT "process_log_level_check" CHECK (log_level IN ('DEBUG','INFO','WARN','ERROR')),
CONSTRAINT "process_log_severity_check" CHECK (perceived_severity IS NULL OR perceived_severity IN
  ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED'))
) PARTITION BY RANGE ("partition_period");
```

```sql
CREATE INDEX "process_log_alarm_idx" ON "rating"."process_log" (perceived_severity, log_datetime)
  WHERE perceived_severity IS NOT NULL;
CREATE INDEX "process_log_alarm_key_idx" ON "rating"."process_log" (alarm_key) WHERE alarm_key IS NOT NULL;
CREATE INDEX "process_log_batch_idx" ON "rating"."process_log" (batch_id);
CREATE INDEX "process_log_event_code_idx" ON "rating"."process_log" (event_code);
CREATE TABLE "rating"."process_log_default" PARTITION OF "rating"."process_log" DEFAULT;
```

The partial alarm index is what makes monitoring an index scan rather than a full-table text filter.

### 5. `rating.event_catalog` — `db/schema/rating/event-catalog.ts`

Table only. **The seed is rm02**, not this unit.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `event_code` | `text` | NOT NULL | PK |
| `component` | `text` | NULL | emitting component, or NULL for any |
| `default_severity` | `text` | **NULL** | CHECK; **NULL means the code is logged but never alarms** (rm02 §A) |
| `event_type` | `text` | NULL | X.733 class |
| `probable_cause` | `text` | NULL | |
| `description` | `text` | NOT NULL | |
| `is_auto_clearing` | `boolean` | NOT NULL | `DEFAULT false` |
| `clear_event_code` | `text` | NULL | self-reference by value, no FK |
| `is_active` | `boolean` | NOT NULL | `DEFAULT true` |

### 6. Partman registration — `db/bootstrap/rating-partman-setup.sql` + `.ts`

Mirror `db/bootstrap/billing-partman-setup.{sql,ts}` exactly: the `.ts` reads the sibling `.sql`, splits on `--> statement-breakpoint`, and executes under `BOOTSTRAP_DATABASE_URL` with `max: 1`.

**Open with the preflight assertion** (`_risk-database-extension-version-drift.md` §4.1) — this is new, and should be retrofitted to the existing two files in the same PR:

```sql
DO $$
DECLARE v text;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'pg_partman';
  IF v IS NULL THEN RAISE EXCEPTION 'pg_partman is not installed on this server'; END IF;
  IF split_part(v, '.', 1)::int < 5 THEN
    RAISE EXCEPTION 'pg_partman % found; this script uses the v5 named-parameter create_parent() signature.', v;
  END IF;
END $$;
```

Then two registrations with **different retentions** (D7):

```sql
SELECT partman.create_parent(
  p_parent_table  := 'rating.udr_rated',
  p_control       := 'partition_period',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
UPDATE partman.part_config
   SET retention = '7 years', retention_keep_table = true,
       infinite_time_partitions = true
 WHERE parent_table = 'rating.udr_rated';
```

```sql
SELECT partman.create_parent(
  p_parent_table  := 'rating.process_log',
  p_control       := 'partition_period',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
UPDATE partman.part_config
   SET retention = '24 months', retention_keep_table = true,
       infinite_time_partitions = true
 WHERE parent_table = 'rating.process_log';
```

`retention_keep_table = true` is **DETACH, not drop** — the billing convention, deliberately unlike `audit_log`.

**Do not add a `cron.schedule_in_database` call.** The single `audit-log-partman-maintenance` job already sweeps every registered parent; `billing-partman-setup.sql` says so explicitly and this file must repeat that comment.

Add an npm script `db:setup-partman-rating`, or extend the existing `db:setup-partman` to run this file too — match whichever the repo already does.

### 7. Index export — `db/schema/index.ts`

Export the four tables so `drizzle-kit` sees them and `db/schema` consumers can import them.

### 8. Tests — `tests/rating/rm01-schema.test.ts`

Integration tests against a live database (`vitest.integration.config.ts`), not mocks. See §Verification for the assertions; each acceptance item is one test.

---

## Dependencies (packages to install)

**None.** This unit installs no packages.

It relies on what is already present: `drizzle-orm@^0.45.2` (supports `check()`, `pgSchema`, generated columns), `drizzle-kit@^0.31.10`, the `pg` client, and `vitest` with the existing integration config. `pg_partman` and `pg_cron` are provided by the database image (`infra/docker/postgres/Dockerfile`) and by `azure.extensions` in Azure — neither is an npm dependency.

**One infrastructure change is a prerequisite, not a package:** pin the local image to `postgres:16-bookworm` to match Azure (`_risk-database-extension-version-drift.md` §4.2). Verified that PGDG ships `pg_partman` 5.0.1 for PG 16, so the partman major does not change.

---

## Verification checklist

Run every item against a live database. Each is a test in `tests/rating/rm01-schema.test.ts`.

**The uniqueness guarantee (Inv #3)**

1. Inserting a second **live** row with the same `(partition_period, start_datetime, udr_key)` raises a unique violation.
2. Four consecutive supersede-then-insert cycles on one natural key leave exactly **one** live row and **four** `SUPERSEDED` rows.
3. Setting the only live row to `SUPERSEDED` leaves **zero** live rows without error — a valid state.
4. Updating `status` recomputes `is_live` with no direct write to `is_live`; attempting to write `is_live` directly is rejected.
5. A `REJECTED` row and a `RATED` row for the same natural key coexist (the bill-run rejection path).

**Key length**

6. A `udr_key` of 512 ASCII characters inserts.
7. A `udr_key` of 512 four-byte UTF-8 characters (2,048 bytes) inserts — the worst case the CHECK permits, still clear of the 2,704-byte btree limit.
8. 513 characters is rejected by `udr_rated_udr_key_length_check`, **not** by a btree index-row error.

**Partition correctness (Inv #15)**

9. A row whose `partition_period` disagrees with `rating.period_of(start_datetime)` is rejected.
10. The identical row inserts successfully under `SET TimeZone` of `UTC`, `Asia/Singapore` and `America/New_York` — the CHECK is session-independent.
11. `rating.period_of('2026-09-01 02:00+08')` returns **`2026-08-01`** — the UTC month, not the Singapore/KL month. This asserts the D3 decision explicitly, so a later change of the literal fails a test rather than silently re-bucketing.
12. Same three assertions for `process_log.partition_period` against `log_datetime`.

**Structural invariants**

13. No foreign key exists between `rating` and any other schema, in either direction — a query against `pg_constraint` returns zero rows.
14. `process_log` has no FK on `event_code`; an unrecognised code inserts successfully (D6).
15. `udr_rated` has **no** `udr_batch_run_num`, `supersede_reason` or `superseded_by_udr_id` column (D11), and `udr_batch` **has** `batch_run_num`, `supersede_reason` and `superseded_by_batch_id` — asserted against `information_schema.columns`.
15a. `batch_run_num` appears in exactly one unique constraint — `udr_batch_file_key_run_uq` — and in no index on `udr_rated` (Inv #4).
16. Money columns have the specified precision and scale: amounts `(18,2)`, rates `(18,6)`, quantity `(20,6)` — asserted against `information_schema.columns`.
17. `start_datetime` and `end_datetime` have **no** precision modifier (D5); operational timestamps have precision 3.

**File claim (Inv #7)**

18. Two inserts with the same `(file_key, batch_run_num)` — the second raises a unique violation.
19. The same `file_key` with `batch_run_num = 2` inserts successfully.
19a. Two **differently named** files that derive the **same** `file_key` collide on run 1 — proving a renamed reissue is recognised as the same logical delivery (D12).
19b. `udr_batch` has a `file_key` column that is `NOT NULL`, and no unique constraint references `source_file` — asserted against `information_schema`, so a future change cannot quietly revert the grouping key.

**Partitioning and maintenance**

20. `partman.part_config` holds both parents with `p_premake = 4`, `infinite_time_partitions = true`, and retentions of `7 years` / `24 months` respectively, both with `retention_keep_table = true`.
21. Running `partman.run_maintenance_proc()` creates the expected forward partitions for both tables.
22. **No new `cron.schedule_in_database` entry was added** — `SELECT count(*) FROM cron.job` is unchanged from before the migration.
23. Both `*_default` partitions exist and contain **zero** rows (D8).
24. The preflight assertion raises when run against a server with `pg_partman` below 5 (simulate by asserting the guard's SQL directly).

**Build hygiene**

25. `tsc --noEmit`, ESLint and Prettier clean.
26. The migration is new and ordered; no applied migration was edited.
27. `ratemgmt-architecture.md` §1/§3, `ratemgmt-code-standards.md` §5.8, `ratemgmt-project-overview.md` and `rm00-build-plan.md` all record `process_log` retention as **24 months** and `udr_rated` as 7 years — done; re-assert on any change, because a single uniform figure is the stale form.
28. No `core.PERMISSIONS` row, no page, no route, no `core.AUDIT_LOG` write was added.
