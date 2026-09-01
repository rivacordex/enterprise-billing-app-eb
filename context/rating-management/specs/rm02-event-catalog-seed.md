# rm02 — `event_catalog` seed — Spec

- **Unit:** rm02 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase A)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/seeds/`
- **Builds:** the seeded rows that map every `event_code` the module can emit to its default severity, X.733 classification and clearing behaviour.
- **Depends on:** rm01 (the `rating.event_catalog` table) — **and carries an amendment to it, see §A**.
- **Sources:** `ratemgmt-code-standards.md` §7 (logging and event standards), §10.10 (which pins `RECON_IMBALANCE` at `CRITICAL` and `SHRINKING_REISSUE` at `MAJOR`), §10.11 (event-catalog completeness) · `ratemgmt-architecture.md` Inv #14 · `ratemgmt-project-overview.md` goals 6–7, success criterion 10 · `rm00-build-plan.md` Unit rm02.

> **Revision note.** This spec replaces a first draft that had six defects: a citation to a non-existent §8.5 rubric, `is_auto_clearing = 'n/a'` on a `boolean NOT NULL` column, two rows contradicting its own D5, fifteen missing `NOT NULL` descriptions, `default_severity`/`is_active` absent from every row table, and no rule for when `perceived_severity` is NULL. All six are closed below; the sixth produced §A.

> **rm11 amendment.** `rm11-stranded-batch-recovery.md` D5 adds a **seventeenth** code, `BATCH_STRANDED` (`MAJOR`, component `SCHEDULER`) — the stranded-batch reconcile's resolution of a `udr_batch` row stuck at `PROCESSING` beyond the configured threshold. Added to the `MAJOR` table, the locally-defined-cause table (D4), the `RATING_EVENT_CODES` constant and the seed in the same change set (ai-workflow-rules §7.3); the counts below (sixteen → seventeen rows, seven → eight `BATCH_COMPLETE`-clearers) are updated in place rather than narrated as a diff, matching how this spec already reads as current state.

---

## Goal

Seed `rating.event_catalog` so severity, X.733 event type and probable cause are resolved **from data at emit time**, never hardcoded at a call site — making a severity re-tune a migration rather than a release, making every emitted `event_code` classifiable, and making "this event is not alarm-worthy" a catalogued fact rather than an emitter's judgement.

---

## A. Amendment to rm01 — `default_severity` becomes nullable

**This unit cannot be built against rm01 as written.** rm01 declares:

| `default_severity` | `text` | ~~NOT NULL~~ | ~~CHECK, same enum as `process_log`~~ |

But `process_log.perceived_severity` is **nullable**, and `ratemgmt-code-standards.md` §7.1 requires it be "populated only on alarm-worthy rows". If severity always resolves from the catalog (Inv #14) and the catalog can never hold NULL, then nothing ever writes NULL — and every routine `BATCH_COMPLETE` lands in the alarm stream. The two rules are unsatisfiable together.

**Amend rm01 §5 to:**

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `default_severity` | `text` | **NULL** | CHECK; **NULL means the code is logged but never alarms** |

```sql
CONSTRAINT "event_catalog_severity_check" CHECK (default_severity IS NULL OR default_severity IN
  ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED'))
```

Mirroring `process_log_severity_check` exactly (rm01 line 354), so the two columns can never disagree about the vocabulary.

**Why nullable rather than an `is_alarm` boolean.** An `is_alarm` column would encode one fact in two places that can drift apart — a row with `is_alarm = false` and `default_severity = 'MAJOR'` is a contradiction the database would happily hold. Collapsing them means the absence of a severity *is* the statement that nothing alarms. There is no second value to keep in sync.

**Why not gate on `alarm_key` instead.** That was considered and rejected: it moves the alarm/not-alarm decision to whichever component supplies the key, which is exactly what Inv #14 exists to prevent. The decision belongs in the catalog with the severity it governs.

---

### A1. The consequence that must not be got backwards

With `default_severity` nullable, **a NULL severity no longer means "unrecognised code."** Three outcomes must stay distinguishable:

| Catalog lookup | `perceived_severity` written | Meaning |
| --- | --- | --- |
| Row found, `default_severity` is a value | that value | An alarm. |
| Row found, `default_severity` is NULL | **NULL** | Catalogued, deliberately not alarm-worthy. |
| **No row** | **`INDETERMINATE`** | Uncatalogued — the hygiene metric (Inv #14). |

The resolution query must therefore test **row presence**, never severity nullity:

```sql
SELECT CASE WHEN c.event_code IS NULL THEN 'INDETERMINATE'
            ELSE c.default_severity END AS perceived_severity,
       c.event_type, c.probable_cause
FROM (SELECT $1::text AS event_code) e
LEFT JOIN rating.event_catalog c ON c.event_code = e.event_code AND c.is_active;
```

`COALESCE(c.default_severity, 'INDETERMINATE')` is **wrong** and is the specific mistake to guard against: it silently reclassifies every deliberately-non-alarming event as an unclassified one, and the `INDETERMINATE` count — success criterion 10, the metric that is supposed to trend to zero — becomes permanently non-zero and permanently meaningless. Verification item 14 asserts against exactly this.

---

## Design

### D1. The catalog is the alerting contract

IT monitoring builds alert rules against `event_code` and `perceived_severity`. Those two columns are a **published interface**, not internal detail. Renaming a code or silently changing its severity breaks alerting downstream with no compile error and no test failure anywhere in this repo.

Consequences:

- A code is **added** by migration; once emitted in production it is never removed, only marked `is_active = false`.
- A severity **change** is a migration with a stated reason in the commit, reviewed like any other change to operational behaviour.
- Codes are `SCREAMING_SNAKE_CASE`, stable, and describe **the condition**, not the message text.

### D2. Severity comes from the catalog, never from the emitter

A component emits `event_code` plus the row-specific fields (`specific_problem`, `managed_object`, `alarm_key`, `additional_info`). It does **not** decide severity, and — per §A — it does not decide whether the event alarms at all. The writer resolves `perceived_severity`, `event_type` and `probable_cause` by lookup.

### D3. X.733 probable causes are partly local, and that is stated

X.733's `probableCause` is an extensible enumeration whose standard values are oriented at telecom **equipment** faults — `lossOfSignal`, `powerProblem`, `enclosureDoorOpen`. Several rating conditions have no honest match: "a reissued file was smaller than its predecessor" is not any standard cause.

The standard permits locally-defined values. This catalog uses:

- **Standard X.733 causes** where one genuinely fits — `corruptData`, `configurationOrCustomizationError`, `underlyingResourceUnavailable`, `thresholdCrossed`.
- **Locally-defined causes** where none does, in the same lowerCamelCase style, listed in D4 so they are visibly local rather than mistaken for standard values.

Forcing a business-rule refusal into `equipmentMalfunction` would be worse than a local value: it misleads anyone who knows the standard.

### D4. Locally-defined probable causes

| Local cause | Used by | Means |
| --- | --- | --- |
| `expectedFileAbsent` | `FILE_NOT_RECEIVED` | A delivery the schedule expected did not arrive |
| `deliveryWindowMissed` | `FILE_LATE` | Arrived, but outside its expected window |
| `duplicateDelivery` | `DUPLICATE_BATCH` | Byte-identical redelivery, discarded |
| `incompleteRedelivery` | `SHRINKING_REISSUE` | A reissue carried fewer records than its predecessor |
| `abandonedClaim` | `BATCH_STRANDED` | A batch's `PROCESSING` claim outlived the worker that held it (rm11) |
| `billedRecordCollision` | `LOAD_BLOCKED_BILLED` | Incoming records collide with an approved invoice |
| `crossPeriodCorrection` | `CROSS_PERIOD_SUPERSEDE` | Supersession crossed a partition boundary |
| `retrySucceeded` | `TASK_RETRY_OK` | Recovered on a later attempt |
| `normalCompletion` | `BATCH_COMPLETE` | Clean run |

### D5. Clearing is declared per code, and `is_auto_clearing` implies a clearer

Two columns carry it:

- **`is_auto_clearing`** — whether the condition resolves itself when the next success occurs. `true` means monitoring may pair a raise with a later `CLEARED` on the same `alarm_key`.
- **`clear_event_code`** — which code performs the clear.

**The two move together.** `is_auto_clearing = true` with `clear_event_code = NULL` is a contradiction — auto-clearing with nothing that clears it — and verification item 8 rejects it. Every row is one of exactly two shapes:

| Shape | `is_auto_clearing` | `clear_event_code` |
| --- | --- | --- |
| Self-clearing | `true` | a code that exists in the catalog |
| Needs a human, or is not a condition at all | `false` | `NULL` |

**Conditions that require a human are deliberately not auto-clearing.** `LOAD_BLOCKED_BILLED`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `FILE_KEY_UNRESOLVED` and `CURRENCY_MISMATCH` all mean something is wrong with the *data*, and a later clean batch does not make the earlier problem untrue. Auto-clearing them would erase the evidence.

**Informational events are also `false`.** `DUPLICATE_BATCH` and `CROSS_PERIOD_SUPERSEDE` are records of something that happened and completed, not open conditions — nothing is waiting to be cleared. (The first draft had both as `true` with a NULL clearer; that was the contradiction this design point now forbids.)

### D6a. `CLEARED` is a catalogued code, because `process_log.event_code` is `NOT NULL`

An earlier draft seeded fifteen codes and described clearing purely as a relationship between two of them. That left the clearing row itself with no `event_code` to carry — and rm01 makes that column `NOT NULL`. The row would have had to reuse `BATCH_COMPLETE` (whose catalogued severity is NULL, so the clear would never appear in the alarm stream) or carry an uncatalogued literal (which resolves to `INDETERMINATE` and permanently breaks success criterion 10 — §A1's exact failure).

So `CLEARED` is the sixteenth catalogued code. It carries `default_severity = 'CLEARED'` — the X.733 value that exists for precisely this — and it is itself never cleared.

**Both mechanisms are needed and they are different things.** `clear_event_code` on a raised code declares *which occurrence may clear it*. `CLEARED` is *the row written when that happens*, carrying the original `alarm_key`. A `BATCH_COMPLETE` following an open `FILE_NOT_RECEIVED` therefore writes **two** rows: its own (severity NULL, routine) and a `CLEARED` against the missed delivery's key.

### D6. `clear_event_code` is a relationship, not a severity

`BATCH_COMPLETE` carries `default_severity = NULL` — a clean run is not an alarm — while still serving as the `clear_event_code` for **eight** other codes (rm11 adds `BATCH_STRANDED` as the eighth: the reprocessed batch's own `BATCH_COMPLETE` is what a stranded-batch alarm is waiting for).

These do not conflict. `default_severity` is the severity of the event **as a standalone occurrence**. Clearing is a **pairing**: when `BATCH_COMPLETE` occurs and an `alarm_key` raised earlier is still open, a row with `event_code = 'CLEARED'` is written against *that key* (D6a). Its severity comes from `CLEARED`'s own catalog row, not from `BATCH_COMPLETE`'s.

The practical result: a clean batch in a quiet system writes one `INFO` row with `perceived_severity` NULL, and the alarm stream stays silent. A clean batch that follows a missed delivery writes that row **and** a `CLEARED` against the open `FILE_NOT_RECEIVED:RAN_USAGE:2026-08-21` key. Which is the behaviour §7.5 asks for.

### D7. Seed style follows the existing pattern

Seeds live in `db/seeds/`, are idempotent, and are re-runnable so an environment can be brought to the current catalog without a manual diff. Follow `db/seeds/product.ts` / `db/seeds/ordering-inventory.ts` for structure.

**Idempotent as `ON CONFLICT DO UPDATE`, not `DO NOTHING`** — because the seed is how a severity re-tune reaches an existing environment. `DO NOTHING` would leave production on the old severity forever, and D1's "a re-tune is a migration" would be false in practice.

---

## Implementation

### 1. The seed data — `db/seeds/rating-event-catalog.ts`

Seventeen codes. Every column that the table declares appears here; `description` is `NOT NULL` and its text is given, not left to the implementer.

`component` values are drawn from the same set `process_log_component_check` allows — `PRP`, `RP`, `RL`, `LOG_SWEEP`, `SCHEDULER` — or `NULL` for "any component".

**`CRITICAL` — the pipeline cannot proceed, or financial integrity is at risk**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DB_WRITE_FAILURE` | `RL` | `CRITICAL` | `processingErrorAlarm` | `underlyingResourceUnavailable` | `true` | `BATCH_COMPLETE` | The rating loader could not write to the database and the batch transaction was rolled back. |
| `RECON_IMBALANCE` | `RL` | `CRITICAL` | `processingErrorAlarm` | `corruptData` | `false` | `NULL` | A batch failed the arithmetic check `parsed = rated + rejected + discarded`, so records are unaccounted for. |

**`MAJOR` — an isolated unit failed completely**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LOAD_BLOCKED_BILLED` | `RL` | `MAJOR` | `processingErrorAlarm` | `billedRecordCollision` | `false` | `NULL` | A batch was refused whole because one or more incoming records collide with a live row already on an approved invoice. |
| `SHRINKING_REISSUE` | `RL` | `MAJOR` | `processingErrorAlarm` | `incompleteRedelivery` | `false` | `NULL` | A reissued file carried fewer records than the run it supersedes, so records were retired with nothing replacing them. |
| `FILE_NOT_RECEIVED` | `SCHEDULER` | `MAJOR` | `qualityOfServiceAlarm` | `expectedFileAbsent` | `true` | `BATCH_COMPLETE` | A usage file the configured cadence expected has not arrived within its window. |
| `FILE_KEY_UNRESOLVED` | `PRP` | `MAJOR` | `processingErrorAlarm` | `configurationOrCustomizationError` | `false` | `NULL` | The configured derivation rule could not extract a `file_key` from the filename, so the file's logical delivery identity is unknown. |
| `PARSE_FAILURE` | `PRP` | `MAJOR` | `processingErrorAlarm` | `corruptData` | `true` | `BATCH_COMPLETE` | A usage file could not be parsed at all, or its reject count exceeded the configured threshold for its `udr_type`. |
| `LOOKUP_MISS` | `RP` | `MAJOR` | `processingErrorAlarm` | `underlyingResourceUnavailable` | `true` | `BATCH_COMPLETE` | A price, offering, subscription or inventory lookup returned no row for a record that requires one. |
| `CURRENCY_MISMATCH` | `RL` | `MAJOR` | `processingErrorAlarm` | `configurationOrCustomizationError` | `false` | `NULL` | The currency on the resolved price does not match the billing account's currency. |
| `BATCH_STRANDED` | `SCHEDULER` | `MAJOR` | `processingErrorAlarm` | `abandonedClaim` | `true` | `BATCH_COMPLETE` | A `udr_batch` row stuck at `PROCESSING` beyond the configured threshold — a worker was killed mid-load — was resolved (`FAILED`) by the stranded-batch reconcile, releasing the file's claim for reprocessing. |

**`MINOR` — degraded, but the unit completed**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BATCH_PARTIAL` | `RL` | `MINOR` | `qualityOfServiceAlarm` | `thresholdCrossed` | `true` | `BATCH_COMPLETE` | A batch completed with some records rejected, below the configured threshold; the reject file names them. |
| `TASK_RETRY_OK` | `NULL` | `MINOR` | `processingErrorAlarm` | `retrySucceeded` | `true` | `BATCH_COMPLETE` | A task failed and succeeded on a later attempt; the work completed but the underlying instability did not. |

**`WARNING` — nothing failed, but someone should know**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FILE_LATE` | `SCHEDULER` | `WARNING` | `qualityOfServiceAlarm` | `deliveryWindowMissed` | `true` | `BATCH_COMPLETE` | A usage file arrived outside the window its configured cadence expects. |
| `DUPLICATE_BATCH` | `PRP` | `WARNING` | `qualityOfServiceAlarm` | `duplicateDelivery` | `false` | `NULL` | A byte-identical redelivery of an already-processed file was discarded before parsing. |
| `CROSS_PERIOD_SUPERSEDE` | `RL` | `WARNING` | `processingErrorAlarm` | `crossPeriodCorrection` | `false` | `NULL` | Supersession retired a predecessor row in a different monthly partition, meaning a corrected timestamp moved the record across a period boundary. |

**No severity — logged, never alarmed (§A)**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BATCH_COMPLETE` | `RL` | **`NULL`** | `processingErrorAlarm` | `normalCompletion` | `false` | `NULL` | A batch completed cleanly with counts that reconcile and the source file archived. |

**The clearing event itself**

| `event_code` | `component` | `default_severity` | `event_type` | `probable_cause` | `is_auto_clearing` | `clear_event_code` | `description` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CLEARED` | `NULL` | `CLEARED` | `processingErrorAlarm` | `normalCompletion` | `false` | `NULL` | A previously raised alarm condition on this `alarm_key` no longer holds. |

All seventeen rows carry `is_active = true`.

Descriptions state **the condition**, never the remediation. Remediation belongs in `ratemgmt-ops-context.md`, which changes far more often than the catalog does; a runbook step embedded here would go stale inside a migration nobody thinks to write.

### 2. The typed constant

`event_code` values are referenced from TypeScript (the sweep, the tests) and from flow definitions. Define them once, alongside the seed:

```ts
export const RATING_EVENT_CODES = [
  "DB_WRITE_FAILURE", "RECON_IMBALANCE", "LOAD_BLOCKED_BILLED",
  "SHRINKING_REISSUE", "FILE_NOT_RECEIVED", "FILE_KEY_UNRESOLVED",
  "PARSE_FAILURE", "LOOKUP_MISS", "CURRENCY_MISMATCH", "BATCH_STRANDED",
  "BATCH_PARTIAL", "TASK_RETRY_OK", "FILE_LATE",
  "DUPLICATE_BATCH", "CROSS_PERIOD_SUPERSEDE", "BATCH_COMPLETE",
  "CLEARED",
] as const;
export type RatingEventCode = (typeof RATING_EVENT_CODES)[number];
```

A test asserts the constant and the seeded rows are the same set **in both directions**, so a code added to one and not the other fails the build.

`INDETERMINATE` is deliberately **not** a code and never a seeded row — it is the severity written when a lookup finds nothing (§A1).

### 3. Upsert

```sql
INSERT INTO rating.event_catalog (event_code, component, default_severity, event_type,
                                  probable_cause, description, is_auto_clearing,
                                  clear_event_code, is_active)
VALUES (…)
ON CONFLICT (event_code) DO UPDATE SET
  component        = EXCLUDED.component,
  default_severity = EXCLUDED.default_severity,
  event_type       = EXCLUDED.event_type,
  probable_cause   = EXCLUDED.probable_cause,
  description      = EXCLUDED.description,
  is_auto_clearing = EXCLUDED.is_auto_clearing,
  clear_event_code = EXCLUDED.clear_event_code,
  is_active        = EXCLUDED.is_active;
```

`default_severity` must be bound as an explicit nullable parameter, not omitted from the row — an omitted column in a multi-row `VALUES` list is a type error, and `DO UPDATE` must be able to set a severity **back** to NULL when a code is downgraded out of the alarm stream.

**Never `DELETE` a code.** Retire with `is_active = false`; historical `process_log` rows still reference it, and there is deliberately no FK to stop the reference dangling (rm01 D6).

### 4. Wire into the seed runner

Add to whichever npm script the repo already uses for seeds (`db:seed` or equivalent), following the existing seed modules. The seed must be safe to run against an environment that already holds the catalog.

---

## Dependencies (packages to install)

**None.** Uses the existing `drizzle-orm` client and the repo's existing seed runner.

---

## Verification checklist

**Schema amendment (§A)**

1. `rating.event_catalog.default_severity` is nullable, and `event_catalog_severity_check` accepts NULL and the six X.733 values and rejects anything else — asserted against `information_schema`, so rm01 shipping without the amendment fails here rather than at seed time.
2. The severity vocabulary in `event_catalog_severity_check` is **identical** to `process_log_severity_check`; a value valid in one is valid in the other.

**Catalog completeness**

3. All seventeen codes are present after the seed runs.
4. `RATING_EVENT_CODES` and the seeded rows are the **same set**, asserted in both directions.
5. Every row has a non-null `description`, `event_type`, `probable_cause` and `is_active`.
6. Exactly one row — `BATCH_COMPLETE` — has `default_severity IS NULL`. `CLEARED` carries `'CLEARED'`, not NULL: a clear *is* an alarm-stream event.
7. Every `component` value is either NULL or one of `PRP`/`RP`/`RL`/`LOG_SWEEP`/`SCHEDULER`, matching `process_log_component_check`.

**Clearing integrity (D5, D6)**

8. **No row has `is_auto_clearing = true` with `clear_event_code IS NULL`, and none has `is_auto_clearing = false` with a non-null `clear_event_code`** — the two shapes in D5 are the only ones permitted.
9. Every non-null `clear_event_code` names a code that **exists in the catalog** — asserted in the test, since there is deliberately no self-referencing FK.
10. `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `LOAD_BLOCKED_BILLED`, `FILE_KEY_UNRESOLVED`, `CURRENCY_MISMATCH`, `DUPLICATE_BATCH` and `CROSS_PERIOD_SUPERSEDE` are **not** auto-clearing.
11. `BATCH_COMPLETE` and `CLEARED` are not themselves auto-cleared; no row names a clearer other than `BATCH_COMPLETE`; and **exactly eight** rows do name it (rm11 adds `BATCH_STRANDED`) — a count assertion, so adding a clearable code without revisiting D6 fails here.

**Severity resolution (§A1 — the part that is easy to get backwards)**

12. A known alarming code resolves to its catalogued severity, event type and probable cause.
13. **`BATCH_COMPLETE` resolves to `perceived_severity` NULL**, and the `process_log` row is still written with its `log_level` — a clean batch produces no alarm-stream entry.
14. **An unknown code resolves to `INDETERMINATE`, not NULL** — and the row is still written (rm01 D6), proving the missing FK is deliberate. Run items 13 and 14 **in the same test**: they are the pair that a `COALESCE(default_severity,'INDETERMINATE')` implementation collapses into one, and either alone passes against the broken version.
15. A code seeded with `is_active = false` is treated as uncatalogued by the resolver — `INDETERMINATE`, not its stored severity.
16. Counting `perceived_severity = 'INDETERMINATE'` over a run containing only catalogued codes returns **zero**, including runs that emit `BATCH_COMPLETE` — success criterion 10 is not satisfied by accident.

**Idempotency**

17. Running the seed twice leaves seventeen rows, not thirty-four.
18. Changing a severity in the seed and re-running **updates** the existing row — proving `DO UPDATE`, not `DO NOTHING`.
19. Changing a severity **to NULL** in the seed and re-running sets the stored value to NULL — a code can be downgraded out of the alarm stream, not only re-tuned within it.
20. The seed does not delete or deactivate any code absent from its list — a code retired by a later migration stays retired.

**Build hygiene**

21. `tsc --noEmit`, ESLint, Prettier clean.
22. The seed is registered in the repo's seed runner and runs green from an empty database after rm01's migration.
23. No `core.PERMISSIONS` row, no page, no route added.

---

## Open items raised by this unit

| # | Item | Blocks | Note |
| --- | --- | --- | --- |
| O1 | ~~rm01 must be amended per §A~~ — **DONE.** rm01 §5 now declares `default_severity` nullable and carries `event_catalog_severity_check`. | — | Closed |
| O2 | ~~`ratemgmt-code-standards.md` §7 does not say who decides what is alarm-worthy~~ — **DONE.** §7.2a now states it: the catalog does, via a nullable `default_severity`, and the resolver keys off row presence. | — | Closed |
| O3 | ~~`ratemgmt-architecture.md` Inv #2 lists columns that do not exist~~ — **DONE.** Inv #2 now carries the seven-column table and states explicitly that `superseded_by_udr_id` and `supersede_reason` are not on `udr_rated`. The same correction was applied to code-standards §5.10/§5.11, the overview, and rm00's rm10 entry. | — | Closed |
| O4 | **`CLEARED` is now a seeded code (D6a).** Any monitoring rule or query written against the earlier fifteen-code list needs the sixteenth added. | rm12 | Carry into rm12's clearing logic |
