# Rating Management Module — Code Standards

These standards **extend `context/code-standards.md`** (the platform-wide conventions and CI gates every module inherits) and record **only what the Rating Management module adds or does differently**. Technical design and the numbered Invariants live in `ratemgmt-architecture.md`; scope and flows in `ratemgmt-project-overview.md`; the design reasoning in `_newmodule-rating-engine-plan.md`.

**Status:** Planning. Every general standard holds unless a numbered rule below states otherwise.

**The shape of the delta.** This module has **no pages, no Server Actions, no components, and no permissions**, so four sections of the general standards have nothing to bind to. It adds three the other modules do not have: **workflow-definition standards** (§3), **logging and event standards** (§7), and **grants in place of a permission map** (§9). Rating logic lives in Kestra flow definitions in a **separate repository** — the app repo holds only schema, roles, and read repositories.

---

## 1. General Rules (module-specific)

1. **Name the engine.** Unlike Bill Run, which deliberately says "the workflow engine", this module names **Kestra** in code, comments and docs. The engine is load-bearing here — rating logic lives in its flow definitions — so vendor-neutral naming would obscure where the logic actually is.
2. **Two repositories, two release cycles.** The app repo (`enterprise-billing-app`) holds `rating.*` schema, the role bootstrap, and read repositories. The rating repo holds flow definitions, the worker image, and engine infrastructure. **A single change set never spans both repos.** Land the schema first, in its own PR, before the flow that depends on it.
3. **The database is the guarantee; code is the error message.** Where a rule can be expressed as a constraint or a grant, express it that way. Application-level checks exist to fail early with a readable message, never to be the sole enforcement. A PR that enforces an Invariant only in code, where a constraint was available, is rejected at review.
4. **No `console.*` anywhere.** Components emit structured log lines (§7), never raw stdout writes. The log sweep parses those lines; unstructured output is lost.
5. **No `TODO` in flow definitions.** A stub is a named, documented section with an explicit `# STUB:` comment stating what will replace it and which spec section owns it. `TODO` is not a stub marker.

---

## 2. TypeScript Conventions (module-specific)

The app-side TypeScript surface for this module is small — schema, role bootstrap, read repositories. General §2 applies unchanged, plus:

1. **Money stays `string` end-to-end** (general §2.15, §6.16). `numeric(18,2)` and `numeric(18,6)` both map to `string` in Drizzle. Never parse a money or rate column into `number` in TypeScript.
2. **`services/accounts/money.ts` is not used for rate arithmetic.** It works in integer sen and throws `MoneyPrecisionError` above 2 dp, so a sub-cent unit rate cannot pass through it. **This is a documented carve-out**, not a violation of the "only place money arithmetic is implemented" rule:
   - Rating computes `quantity × rate` at full precision **inside the rating engine**, not in app TypeScript.
   - Rating rounds **once**, per `udr_rounding_mode`.
   - Only the rounded `numeric(18,2)` value is ever handed to `money.ts` or summed by the bill run.
   - No app-side TypeScript in this module performs rate multiplication. If a future unit needs it, it is a spec change, not an implementation detail.
3. **`udr_rate_detail` is typed via `.$type<T>()`** where `T` is `z.infer` of a discriminated union in `validation/rating/`, keyed on `udr_rate_type` (general §6.17). Every write passes the schema first. **There is no well-formed-only JSONB exemption in this module.**
4. **Status, severity, rate-type and event-code unions are typed constants**, defined once, mirrored by a DB `CHECK` or FK. A string literal typed inline is a compile error waiting to diverge from the constraint.

---

## 3. Workflow Definition Standards (replaces general §3, Next.js Rules)

Rating logic lives in Kestra flow definitions. These are binding conventions for that code.

1. **Flow definitions are version-controlled and deployed from the repository.** **Never edit a flow in the Kestra UI.** Kestra OSS has no per-user action history, so a UI edit is an untracked change to how money is calculated, invisible to review and to `git log`. The UI is read-only in practice; treat it as such.
2. **Fan out per file or per chunk. Never per record.** (`ratemgmt-architecture.md` Inv #10.) A 50,000-record file is one task or a bounded set of chunk tasks. `EachSequential` / `ForEach` over records is a review-blocking defect: the OSS JDBC queue makes every task state transition a polled database row.
3. **Chunk size is configuration, not a literal.** Declared per `udr_type`, not embedded in the flow body.
4. **Tasks pass file URIs, never record payloads.** Kestra persists task `outputs` in its database; returning a large JSON output bloats the execution tables directly. Internal storage points at Blob, never the container filesystem.
5. **The three components are three named sections** — `prp`, `rp`, `rl` — in that order, each with its stub marker, its logging block, and its named guards. Do not merge them, reorder them, or inline one into another.
6. **RL's guard, supersede and insert are one transaction.** (Inv #8.) A flow that splits them across tasks is wrong regardless of how it retries.
7. **Every flow declares `concurrency: limit: 1` per `udr_type`.** This is one of three layers (with the batch claim and the live-row constraint), not a substitute for either.
8. **Secrets are referenced, never interpolated.** `{{ secret('…') }}` only; never string-manipulated, never logged, never echoed into a task output.
9. **Every flow reports its terminal outcome via both the error and finally handlers.** The error handler fires only on failure; `finally` always runs, so a killed execution still reports.
10. **Pin the Kestra base version in the worker image.** An unpinned base means a rating result that cannot be reproduced from `rating_engine_version`.

---

## 4. Sections of the General Standards That Do Not Apply

State these explicitly so their absence reads as a decision rather than an omission. Do not invent module equivalents.

| General section | Status here | Why |
| --- | --- | --- |
| §3 Next.js Rules | **N/A** | No pages, no Server Actions, no Route Handlers. Replaced by §3 above. |
| §4 Styling | **N/A** | No UI in v1. Billing Ops works in the Kestra UI. |
| §5 API Routes | **N/A** | This module exposes no HTTP surface. The bill run's M2M ingest belongs to `billmgmt`. |
| §8 Permission Naming / §9 Per-Page Permission Map | **N/A** | The module adds **no `core.PERMISSIONS` rows**. A module with no pages declares no page permissions. Replaced by the grant table in §9 below. |

If a later phase adds a UI, these sections come back into force and this table is deleted — not amended.

---

## 5. Data and Storage Rules (module-specific)

1. **All module tables live in the `rating` schema** (general §6.3): `udr_rated`, `udr_batch`, `process_log`, `event_catalog`. No identity, RBAC, session, config or audit tables. **No FK into or out of `billing.*`, `product.*`, `ordering.*` or `inventory.*`** (Inv #17) — cross-schema references are plain text, so a resolved price reference survives the referenced row being retired.
2. **The live-row uniqueness constraint is `UNIQUE (partition_period, start_datetime, udr_key, is_live)`.** `is_live` is `GENERATED ALWAYS` from `status`. **Do not drop, weaken, or make this constraint deferrable.** It is the only thing that makes double-billing structurally impossible (Inv #3).
3. **`udr_rated` carries no run-number column**, so no run number can enter its uniqueness constraint (Inv #4). `batch_run_num` lives on `udr_batch` and *is* half of the file-claim key there. Including it makes run 2 unable to collide with run 1 — the constraint would fire on nothing.
4. **`udr_key` is `text` with `CHECK (char_length(udr_key) <= 512)`.** Use `char_length`, matching the codebase's existing style (`product_offering_price_currency_check`). The cap keeps the index entry clear of Postgres's 2,704-byte btree row limit even at the worst case it permits (512 four-byte UTF-8 characters = 2,048 bytes). **Do not add a hash column**; `udr_key` is indexed directly.
5. **ID conventions are split by volume** (general §6.18): `udr_rated.udr_id` and `process_log.log_id` are `uuid` defaulting to `core.generate_ulid()`, matching `core.audit_log`. `udr_batch.batch_id` uses the prefix + 8-digit sequence convention (`UDRBAT`). Do not apply sequences to the high-volume tables or ULIDs to the low-volume one.
5a. **Partitioned-table DDL follows general §6.20 without deviation** — hand-authored migration, Drizzle for typing only, composite PK including the partition key, bootstrap `DEFAULT` partition kept empty, separate `db/bootstrap/rating-partman-setup.{sql,ts}`, no second cron job, version preflight assertion, grants on the parent only. That rule was written from this module's findings and the `audit_log` precedent; it is platform-wide, not rating-specific.
6. **`udr_rated` and `process_log` are partitioned on `partition_period`**, a `date` control column derived from `start_datetime`. **Do not partition on a `timestamptz` column** — `pg_partman` generates every bound, and a `timestamptz` control column leaves bound generation to the server timezone.
7. **The `partition_period` CHECK uses an explicit `AT TIME ZONE 'UTC'`, centralised in the `IMMUTABLE` helper `rating.period_of()`** (rm01 D3; architecture §7 item 12). The literal is UTC — a physical storage bucket, not the business timezone. `date_trunc` on a `timestamptz` without an explicit zone is not immutable: the constraint is accepted at DDL time and then accepts a row in one session and rejects the identical row in another (Inv #15).
8. **Partitioning is registered, not hand-rolled** — a `partman.part_config` row per partitioned table (`pg_partman`, monthly, **`udr_rated` 7-year / `process_log` 24-month** retention, **detach-and-archive**, matching the billing convention rather than `audit_log`'s drop-on-expiry). Register on the **existing** daily maintenance job; **do not add a second `cron.schedule_in_database`.**
9. **Money columns:** amounts `numeric(18,2)`, rates `numeric(18,6)` — both mapped to `string`. Store **both** `udr_rated_price_raw` (full precision) and `udr_rated_price` (rounded), and record `udr_rounding_mode`. Never store a rate at 2 dp; never compute a billable amount from `_raw` at read time.
10. **Financial content is immutable after insert** (Inv #2, refining platform Inv #18). Only lifecycle columns may be updated, and the list is exactly six distinct columns: `status` (both roles), the bill run's four `billrun_*` columns and `upsert_datetime` (`app_runtime` only). **`superseded_by_udr_id` and `supersede_reason` are not on `udr_rated`** — the lineage is batch-level, on `udr_batch` (rm01 D11). This is enforced by **column-scoped grants**, not by convention. **No role holds `DELETE` on `udr_rated`** — a rated row leaves the table only by partition detach.
11. **Supersession never edits the predecessor's numbers.** A correction inserts a successor and sets the predecessor's `status = 'SUPERSEDED'` — **`status` is the only column that update touches**. The reason and the superseding batch are recorded once on `udr_batch` (`supersede_reason`, `superseded_by_batch_id`), because predecessors are marked before successors exist. An `UPDATE` that changes an amount is a review-blocking defect.
12. **`UNIQUE (file_key, batch_run_num)` on `udr_batch` is the file claim.** Do not implement file claiming as a filesystem rename, a lock file, or flow-level state. **`file_key`, not `source_file`** — `file_key` is the logical delivery identity **extracted by PRP from the filename** (never from file content: the claim precedes parsing) so that a reissue under a varied name is still recognised as the same delivery; `source_file` records the physical name for forensics and is never a grouping key. An unresolvable `file_key` refuses the file with `FILE_KEY_UNRESOLVED`; it never falls back to treating the file as new.
13. **`rating.udr_exception` does not exist. Do not create it.** Items deliberately not billed carry `status = 'BILL_NOTUSED'`.
14. **Rating writes do not enter `core.AUDIT_LOG`** (Inv, architecture §7 item 4). They have no human actor. The audit surface is `udr_batch` + `process_log`. Do not add an audit-log write to a rating path to "satisfy" platform Inv #8.
15. **`udr_currency` comes from the resolved price row**, and RL asserts it equals `billing_account.currency`, raising `CURRENCY_MISMATCH`. Nothing in the schema constrains the two to agree, so the assertion is the only check.

---

## 6. Price Resolution Standards

1. **Resolve as of `start_datetime`, never as of now.** Walk the start-dated chain on `product.product_offering_price` through the `product_offering` version the subscription is **pinned to**, not the current offering.
2. **Snapshot every resolved input onto the row**: `udr_usage_rate`, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`, `udr_rounding_mode`. The arithmetic must be reproducible **without** re-resolving against product data.
3. **This is mandatory, not an optimisation.** `ordering.order_item_price_override` carries **no temporal columns** — an override added later would otherwise retroactively change what earlier usage re-rates to.
4. **Do not pull all price rows and filter in application code.** The existing `db/repositories/product-offering-price.ts` pattern (derive the end bound with `lead()`, filter in JS) is correct for one order-detail page and wrong for 50,000 records. Use an as-of SQL predicate or a per-batch snapshot.

---

## 7. Logging and Event Standards

1. **Two orthogonal columns, never blended.** `log_level` (`DEBUG`/`INFO`/`WARN`/`ERROR`) is verbosity. `perceived_severity` (ITU X.733: `CRITICAL`/`MAJOR`/`MINOR`/`WARNING`/`INDETERMINATE`/`CLEARED`) is alarm severity and is **nullable** — populated only on alarm-worthy rows.
2. **Severity is never hardcoded at a call site.** Every emitted event carries an `event_code`; severity, X.733 event type and probable cause are resolved from `rating.event_catalog` (Inv #14). Re-tuning what counts as `MAJOR` is a migration, not a release.
2a. **Whether an event alarms at all is also the catalog's decision, not the emitter's.** `event_catalog.default_severity` is **nullable**; NULL means the code is logged and never alarms. Resolution has three outcomes — severity value, NULL, or `INDETERMINATE` for a code with **no catalog row**. The resolver tests **row presence**, never severity nullity. `COALESCE(default_severity,'INDETERMINATE')` is the specific wrong implementation: it reclassifies every deliberately-non-alarming event as unclassified and permanently voids §7.3's metric.
2b. **`log_level` is the emitter's, and the catalog does not carry one.** The emitting task states `DEBUG`/`INFO`/`WARN`/`ERROR`; the sweep passes it through unchanged. Level and severity are orthogonal (§7.1) and neither is derived from the other.
3. **Every `event_code` must exist in `event_catalog`.** An unclassified event resolves to `INDETERMINATE`; that count **is zero**, asserted in CI (§10.11).
4. **Per-record rejects go to the reject file. Never one log row each.** A 20%-reject 50,000-record file emits **one** summarised row with counts and a pointer (Inv #11). A per-record log write is a review-blocking defect.
5. **Every alarm-worthy event carries an `alarm_key`** (e.g. `FILE_NOT_RECEIVED:RAN_USAGE:2026-08-21`) so a later success can emit `CLEARED` against the same key. Each catalog row declares whether its code is self-clearing.
6. **Every log line carries the correlation set:** `component`, `source_file`, `batch_id`, `workflow_execution_id`. A line that cannot be traced to a batch is not diagnostic.
7. **Reference values go in `additional_info` JSONB**, not concatenated into `specific_problem`. Bill run id, subscription id, colliding keys — structured, so monitoring can filter them.
8. **Never log a secret, a connection string, or a full record payload.**
9. **The physical format is JSON Lines** — one JSON object per line, UTF-8, newline-delimited. Not a delimited format: `specific_problem` carries raw error text, which is exactly where delimiters, quotes and newlines appear, and `additional_info` is `jsonb`. The line's keys map one-for-one onto `rating.process_log` columns: `log_datetime`, `component`, `log_level`, `perceived_severity`, `event_code`, `specific_problem`, `managed_object`, `alarm_key`, `source_file`, `batch_id`, `workflow_execution_id`, `additional_info`. **`partition_period` is not a log-line field** — it is `NOT NULL` with no default, and the sweep computes it as `rating.period_of(log_datetime)` at insert.
10. **The sweep is idempotent.** `process_log` has no content-unique constraint and `log_id` is a fresh ULID per insert, so a retry or a second scheduled run would silently duplicate every line. Sweeping the same file twice must leave the row count unchanged.
11. **The catalogued event codes are listed in `specs/rm02-event-catalog-seed.md`, and that spec is the register.** This section states the rules; it does not hold the list. A new `event_code` ships in one change set: the seed row in rm02, the `RATING_EVENT_CODES` constant, and the emitting flow.

---

## 8. File Organization (module-specific)

Placement per general §7 for the app repo; the rating repo is new and its layout is defined here.

**App repository — `enterprise-billing-app`**

```
db/migrations/
  00NN_rating.sql              # HAND-AUTHORED. The DDL of record - Drizzle cannot
                               # express PARTITION BY. Platform §6.20.
db/schema/rating/
  udr-rated.ts                 # Drizzle declarations, for query typing only
  udr-batch.ts
  process-log.ts
  event-catalog.ts
db/schema/index.ts             # export the four tables so drizzle-kit sees them
db/bootstrap/
  rating-db-roles.sql          # rating_runtime role, enumerated grants, REVOKEs,
  rating-db-roles.ts           # column-scoped GRANT UPDATE to app_runtime,
                               # REVOKE CONNECT/EXECUTE from PUBLIC
  kestra-db-roles.sql          # rm03a: the kestra database and kestra_engine
  kestra-db-roles.ts
  rating-partman-setup.sql     # partition registration (existing cron job)
  rating-partman-setup.ts
db/seeds/
  rating-event-catalog.ts      # event_code -> severity/type/cause seed
validation/rating/
  udr-rate-detail.schema.ts    # discriminated union keyed on udr_rate_type
                               # (ships with rm01, which declares the column)
infra/docs/
  db-role-verification.md      # EXTENDED, not created: the rating provisioning
                               # order and the manual ALTER ROLE ... PASSWORD steps
tests/rating/
  constraints.test.ts          # rm01's constraint suite
  grants.test.ts               # rm03 + rm03a's grant and CONNECT assertions
```

**`db/repositories/rating/` does not exist in v1.** Read repositories have no consumer — there is no UI and the bill run's claim path is out of scope — so no unit builds them. They arrive with the bill run's collection stage, in that module's plan. rm03's grant assertions are raw SQL.

**Rating repository**

```
flows/
  ran-usage-rating.yaml        # the PRP/RP/RL template
  log-sweep.yaml
  completeness-check.yaml
  stranded-batch-reconcile.yaml
worker/
  Dockerfile                   # Kestra base pinned BY DIGEST + rating runtime
infra/
  container-app.bicep          # engine deployment, volume mounts, ingress
  keyvault.bicep
  easy-auth.bicep              # rm05: Entra authentication + IP allow-list
dev/
  docker-compose.dev.yml       # joins the app stack's network, same Postgres
  .env.example                 # dummy values only
  landing/ archive/ error/ logs/   # bind mounts, .gitkeep + sample fixtures
```

**No `tests/` directory in the rating repo.** rm13 runs the assembled suite from the app repo and changes only CI configuration; it does not create a second test tree.

1. **The app repo contains no rating logic.** If a file under `enterprise-billing-app` computes a rate, applies a discount, or decides a supersession, it is in the wrong repository.
2. **`db/repositories/rating/` is read-only** except for the bill run's six-column claim write, which lives in `db/repositories/billing/` (it is a billing operation on a rating table).
3. **Flow file names match their `udr_type`** where a flow is type-specific.

---

## 9. Access & Grants (replaces general §8/§9)

The module's authoritative access table. Every grant below is asserted by a test (§10.1–10.2); `specs/rm03-rating-runtime-role-grants.md` is the implementation of record and must not diverge from this table.

**Per-table grants — `rating` schema**

| Table | `rating_runtime` | `app_runtime` | `app_migrate` |
| --- | --- | --- | --- |
| `udr_rated` | `SELECT`, `INSERT`, `UPDATE (status)` | `SELECT`, `UPDATE` on **six** columns: `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime` | `ALL` |
| `udr_batch` | `SELECT`, `INSERT`, `UPDATE` on the lifecycle, count and outcome columns — **never** `batch_id`, `file_key`, `source_file`, `file_key_rule`, `udr_type`, `batch_run_num` or `received_at` | `SELECT` | `ALL` |
| `process_log` | `SELECT`, `INSERT` | `SELECT` | `ALL` |
| `event_catalog` | **`SELECT` only** (seeded under `app_migrate`) | `SELECT` | `ALL` |
| any `rating` table | **no `DELETE`, no `TRUNCATE`, ever** | **no `INSERT`, no `DELETE`, no `TRUNCATE`** | — |

**Everything outside `rating`**

| Grantee | Grant |
| --- | --- |
| `rating_runtime` | `USAGE` on `rating`, `product`, `ordering`, `inventory`, `billing`, `core`. `SELECT` on **seven enumerated tables only**: `product.product_offering`, `product.product_offering_price`, `ordering.product_order_item`, `ordering.order_item_price_override`, `inventory.product_inventory`, `billing.billing_account`, `billing.bill_cycle`. **Never `ON ALL TABLES IN SCHEMA`** — that widens silently every time another module ships a table. Explicit `REVOKE` of every write on `billing.*`. `CONNECT` on the billing database, granted explicitly after `PUBLIC` loses it. Connection limit set. |
| `rating_runtime` — functions and sequences | `USAGE ON SEQUENCE rating.udr_batch_seq`; `EXECUTE ON rating.period_of(timestamptz)` (called from a `CHECK`) and `core.generate_ulid()` (called from a `DEFAULT`). **Omit any one and every insert fails.** Granted explicitly, never inherited from `PUBLIC`. |
| `app_runtime` | `USAGE ON SCHEMA rating`; `EXECUTE ON rating.period_of(timestamptz)`. Unchanged elsewhere. |
| `app_migrate` | Owns the `rating` DDL. `ALTER DEFAULT PRIVILEGES **FOR ROLE app_migrate**` grants **`SELECT` and nothing else** on future `rating` tables, to both `rating_runtime` and `app_runtime`, plus `USAGE, SELECT` on future sequences to `rating_runtime`. |
| `PUBLIC` | **`CONNECT` revoked** on the billing database and on the `kestra` database. **`EXECUTE` revoked** on the four `billing` `SECURITY DEFINER` pgledger functions. |
| `kestra_engine` | `CONNECT` + `CREATE` on the `kestra` database only. **No `CONNECT`** on the billing database. Connection limit set. |

0. **Grant on the parent table, never on a partition.** Partitions have an empty ACL; access via the parent covers partitions created later, so `pg_partman` never breaks the grant model. A query that names a partition directly is refused — that is expected, and the fix is to query the parent, not to add a grant. *(Verified: column-scoped `GRANT UPDATE` on a partitioned table is accepted, updating a base column recomputes its `GENERATED` column with no separate grant, and a non-granted column is still refused.)*
1. **`ALTER DEFAULT PRIVILEGES` attaches to `app_migrate`, not the bootstrap superuser.** Default privileges must hang off the role that creates future tables. This is already documented in `bootstrap-db-roles.sql`; repeating the mistake silently leaves new tables ungranted.
2. **Add a grant with the table that needs it,** in the same change set. A new `rating` table shipped without its grant line is rejected at review.
3. **Widening a grant is a spec change.** Do not add a column to the six-column `app_runtime` grant, do not add a column to `rating_runtime`'s single-column `udr_rated` grant, and do not add `DELETE` to any role, without an approved change to `ratemgmt-architecture.md` Inv #2.
4. **`ALTER DEFAULT PRIVILEGES` may never carry `UPDATE` in `rating`.** Postgres rejects a column-scoped default outright (*"default privileges cannot be set for columns"*), so any default carrying `UPDATE` is necessarily table-wide and would grant a future rating table's money columns the moment it is created. Defaults grant `SELECT`; a table needing more gets an explicit grant in the migration that creates it.
5. **Revoking a `PUBLIC` grant from a role is a no-op.** If a role reaches a privilege through `PUBLIC`, `REVOKE … FROM <role>` changes nothing — the revoke must name `PUBLIC`. Verified.
6. **The per-column assertion enumerates `pg_attribute`; it is not a hand-written list.** A column added to `udr_rated` in a later migration is then covered automatically, and lands on the correct side of the boundary or fails the build.

---

## 10. Module Guardrail Tests (CI gate, general §10.4)

Each ships with the unit that introduces the behavior; **rm13 assembles and runs the suite and owns only test #15 (the ship-gate no-per-record-fan-out guard), whose assertion mechanism is settled at the ship gate** — earlier wording had rm13 "building the full guardrail suite", which overstated its role. Where a test spans two units, both halves are named below and each unit ships its half. All are assertions against a live database, not mocks.

| # | Test | Owning unit(s) |
| --- | --- | --- |
| 1 | Grant isolation | rm03 |
| 2 | Column-scoped update | rm03 |
| 3 | No cross-schema FK | rm01 |
| 4 | Live-row uniqueness | rm01 (the constraint) + rm10 (the skipped-supersede case) |
| 5 | Key length | rm01 |
| 6 | Partition correctness | rm01 |
| 7 | Supersession scope | rm10 |
| 8 | Approved-record guard | rm09 |
| 9 | Batch claim | rm01 (the constraint) + rm07 (two filenames → one `file_key`; two periods → never the same key) |
| 10 | Reconciliation | rm09 (`RECON_IMBALANCE`) + rm10 (`SHRINKING_REISSUE`) |
| 11 | Event catalog completeness | rm02 |
| 12 | Log proportionality | **rm07** — it writes the reject file, so it owns proving one summarised row regardless of reject count |
| 13 | Price snapshot reproducibility | rm08 |
| 14 | Archive ordering | rm09 (file + rows) + rm11 (the stranded batch it resolves) |
| 15 | No per-record fan-out | rm13 |
| 16 | **Log-line contract and sweep idempotency** | **rm06** — the format round-trips an error message containing quotes, newlines and delimiters; sweeping one file twice leaves the row count unchanged; an alarming code, a non-alarming code and an uncatalogued code resolve to a severity, NULL and `INDETERMINATE` respectively |

1. **Grant isolation** — `rating_runtime` attempting an `INSERT`/`UPDATE`/`DELETE` on any `billing` table raises a permission error. `rating_runtime` has no `DELETE` on `udr_rated`.
2. **Column-scoped update** — `app_runtime` can update each of the six permitted `udr_rated` columns and is refused on every other column, asserted **per column** so a widened grant fails the build.
3. **No cross-schema FK** — a structural assertion that no foreign key exists between `rating` and any other schema in either direction.
4. **Live-row uniqueness** — inserting a second live row for one natural key raises a unique violation. Repeated supersede-then-insert cycles leave exactly one live row and N superseded rows. **A test that deliberately skips the supersede step must abort the transaction** — this proves the constraint, not the code, is the guarantee.
5. **Key length** — a 512-character four-byte UTF-8 `udr_key` inserts; 513 characters is rejected by the CHECK, not by a btree index-row error.
6. **Partition correctness** — a row whose `partition_period` disagrees with `start_datetime` is rejected by the CHECK; the CHECK behaves identically under at least three session timezones.
7. **Supersession scope** — supersession finds and retires a predecessor in a **different** partition (the corrected-timestamp case), and emits `CROSS_PERIOD_SUPERSEDE`.
8. **Approved-record guard** — a batch containing any record colliding with a live `BILL_APPROVED` row writes zero rows, sets `udr_batch.status = REFUSED`, and emits `LOAD_BLOCKED_BILLED` naming the colliding keys.
9. **Batch claim** — two concurrent attempts on the same `(file_key, batch_run_num)` produce exactly one batch; the second fails on the constraint. Two **differently named** files deriving the same `file_key` are recognised as one logical delivery; files for two different content periods never derive the same key.
10. **Reconciliation** — `parsed = rated + rejected + discarded` for every batch; a deliberate imbalance emits `RECON_IMBALANCE` at `CRITICAL`; a run-N record count below run-(N−1) emits `SHRINKING_REISSUE` at `MAJOR`.
11. **Event catalog completeness** — every `event_code` emitted by any component resolves in `event_catalog`; the `INDETERMINATE` count is zero.
12. **Log proportionality** — a batch with N rejected records emits exactly one `process_log` row for those rejects, independent of N.
13. **Price snapshot reproducibility** — a record rated, then re-rated after the underlying price row and override have changed, produces the same amount from its snapshotted inputs.
14. **Archive ordering** — a simulated failure during the RL transaction leaves the source file in `landing/`, zero rows in `udr_rated`, and a `udr_batch` row that stranded-batch reconciliation resolves.
15. **No per-record fan-out** — a 50,000-record file's execution task count is bounded by chunk count, not record count. *(Assertion mechanism to be settled at the ship-gate spec; this is a design guard, not a release blocker.)*
