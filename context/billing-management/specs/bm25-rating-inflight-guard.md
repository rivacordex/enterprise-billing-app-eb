# bm25 — Rating In-Flight Guard + `LOAD_BLOCKED_INFLIGHT` _(cross-module — rating)_

**Unit:** bm25 (Phase 3 · Phase K). **Boundary:** the **rating** module — `workflow-management/worker/workflow-engine/runtime/rl.py`, `db/bootstrap/rating-db-roles.sql`, and the rating event catalog (`db/seeds/rating-event-catalog.data.ts` + `context/rating-management/specs/rm02-event-catalog-seed.md`). **Build to `ratemgmt-ai-workflow-rules.md`, not billing's rules.** **One change set — do not split** (rating §3.3/§3.5). **Specs from:** `billmgmt-ai-workflow-rules.md` §3.6 (authorization + the four binding rating rules), `ratemgmt-architecture.md` §6 **Inv #6** (amended here), `ratemgmt-ai-workflow-rules.md` §1.4/§3.3/§3.5/§5.5, `bm00-build-plan.md` Unit 25.

> **Framing.** A usage file must not be loaded while a bill run holds those same records in flight. Today `rl.py` refuses a batch only when it collides with a live **`BILL_APPROVED`** row (`LOAD_BLOCKED_BILLED`, MAJOR). Phase 3 claims rows to **`BILL_DRAFT`** during processing, and once reject/rerun **release** those rows back to `RATED` (bm24), a fresh load landing mid-run would collide with `BILL_DRAFT` rows the run still owns — a TOCTOU race between the loader's pre-check and its claim. This unit widens the refusal to cover `BILL_DRAFT` and, crucially, backs it with a **database trigger** (`rating.rating_status_guard`) so the guarantee holds even when the application pre-check loses the race. It is authorized rating-side work (Khek, rating module owner, 2026-09-13) and lands as one atomic change set.
>
> **Scope note (planning):** this spec fully specifies the rating changes; the rating-module docs (`ratemgmt-architecture.md` Inv #6, `rm02-event-catalog-seed.md`, `RATING_EVENT_CODES`) are **amended when this unit is implemented**, together with the code, per rating §3.3/§3.5 — not in advance.

## Goal

Refuse a usage-file load whole when its records collide with a bill run's in-flight `BILL_DRAFT` rows: widen `rl.py`'s pre-check to `status IN ('BILL_DRAFT','BILL_APPROVED')`, emit the new `MINOR` `LOAD_BLOCKED_INFLIGHT` event naming the blocking `bill_run_id`, and enforce the guarantee structurally with a `rating.rating_status_guard` trigger that refuses any `rating_runtime` UPDATE of a row out of `BILL_DRAFT`/`BILL_APPROVED` — so the invariant survives a bypassed pre-check.

## Design

**Structural decisions (obeying `ratemgmt-ai-workflow-rules.md`)**

- **The trigger is the guarantee; the pre-check is only a readable error (rating §1.4).** A widened `_GUARD_SQL` alone is a breach — it loses a TOCTOU race between reading and claiming. `rating.rating_status_guard` is **mandatory**: a `BEFORE UPDATE` trigger on `rating.udr_rated` that, for `session_user = 'rating_runtime'`, refuses any UPDATE that would supersede/overwrite a row currently at `BILL_DRAFT` or `BILL_APPROVED`. The pre-check gives the operator a clean whole-batch refusal; the trigger makes it impossible to slip past.
- **Refuse whole, per the batch-level exception (Inv #6, amended).** In-flight collision is a batch-level refusal like the billed collision — the file's assumptions about the period are wrong, a human decision, not a per-record disposition. `udr_batch.status = REFUSED`, nothing written.
- **`MINOR`, not `MAJOR` (authorized).** `LOAD_BLOCKED_INFLIGHT` is `MINOR` (`billmgmt-ai-workflow-rules.md` §3.6): an in-flight run is recoverable — reject/rerun the run or wait for it to finish, then reload. A `BILL_APPROVED` collision stays `MAJOR` (financial finality). `probableCause: claimedRecordCollision` (distinct from billed's `billedRecordCollision`); `isAutoClearing: false`, `clearEventCode: null`.
- **A new event code ships as three coordinated parts (rating §3.3).** The `rm02` catalog seed row, the `RATING_EVENT_CODES` constant entry, and the emitting flow (`rl.py`'s `BatchRefused` raise) land **together** — a code emitted without a catalog row fails the guardrail test; the constant/seed set-equality test fails if either is missing.
- **A constraint change updates the Invariants in the same set (rating §3.5).** `ratemgmt-architecture.md` Inv #6 is amended to carry the in-flight guard and its authorization line, in the same change set as the trigger.
- **Amend, never overwrite (house convention).** Every edit to an existing `rm` spec or `ratemgmt` doc in this change set is expressed as an **amendment** — append the new clause and preserve the existing text and history; a superseded rule becomes a tombstone, not a deletion. Inv #6 gains the in-flight clause beside its `BILL_APPROVED` text (not a rewrite); `rm02`'s register gains a row (not a restructure); `rm09` gains a note. No clean overwrite of any rating doc.
- **`billrun_status_guard` narrows to `RATED → BILL_DRAFT` (coupling with bm24).** After bm24 no path produces `udr_rated.status = 'REJECTED'`, so the `billrun_status_guard` (in `billrun-db-roles.sql`) allowance `(RATED | REJECTED) → BILL_DRAFT` is narrowed to `RATED → BILL_DRAFT`, retiring the vestigial `REJECTED` re-claim. This is the one billing-owned edit in an otherwise rating-side unit, and it depends on bm24 having landed.

## Implementation

### 1. `rl.py` — widen the pre-check and rename the collision helper

- Widen `_GUARD_SQL`'s status filter from `ur.status = 'BILL_APPROVED'` to `ur.status IN ('BILL_DRAFT','BILL_APPROVED')`, and return each colliding row's `status` and `billrun_ref_id` so the caller can classify (in-flight vs billed) and name the blocking run.
- Rename `find_bill_approved_collisions` to `find_billed_or_inflight_collisions` (set-based, one query per chunk — Inv #10 unchanged).
- At the call site, partition the collisions by `status`: any `BILL_APPROVED` collision → `BatchRefused(event_code="LOAD_BLOCKED_BILLED", …)` as today; otherwise (`BILL_DRAFT`) → `BatchRefused(event_code="LOAD_BLOCKED_INFLIGHT", specific_problem="… collide with a live BILL_DRAFT row held by bill run <billrun_ref_id>; the whole batch is refused", additional_info={blocking bill_run_id(s), collision_count, sample})`. A billed collision takes precedence if both are present. The existing `BatchRefused` handler already writes `udr_batch.status = REFUSED` and emits via `emit_event` — unchanged.

### 2. `db/bootstrap/rating-db-roles.sql` — the `rating.rating_status_guard` trigger

Add, alongside the existing `rating.udr_rated` grants (`GRANT SELECT, INSERT` + `GRANT UPDATE("status")` to `rating_runtime`), a role-aware guard mirroring the shape of `billrun_status_guard` but binding `rating_runtime`:

```sql
-- bm25-spec §Implementation §2. The in-flight guarantee as a DATABASE TRIGGER
-- (rating §1.4) — the widened rl.py pre-check is a readable error, this is the
-- guarantee. Refuses any rating_runtime UPDATE that would supersede/overwrite a
-- row a bill run holds in flight: while OLD.status IN ('BILL_DRAFT','BILL_APPROVED'),
-- rating_runtime may not change is_live or any content column (it may only be the
-- billing side, via its own six-column grant, that moves the row on). app_runtime
-- and billrun_runtime are untouched (this fires only for session_user='rating_runtime').
CREATE OR REPLACE FUNCTION "rating".rating_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF session_user = 'rating_runtime'
     AND OLD.status IN ('BILL_DRAFT','BILL_APPROVED') THEN
    RAISE EXCEPTION 'rating_runtime may not supersede a row held in flight by a bill run (status=%, billrun_ref_id=%)', OLD.status, OLD.billrun_ref_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rating_status_guard_trg ON "rating"."udr_rated";
--> statement-breakpoint
CREATE TRIGGER rating_status_guard_trg
  BEFORE UPDATE ON "rating"."udr_rated"
  FOR EACH ROW EXECUTE FUNCTION "rating".rating_status_guard();
```

(Exact column-set the guard inspects — whether it blocks all `rating_runtime` UPDATEs while claimed, or only `is_live`/content supersession — is a rating-owned detail to finalize against `rl.py`'s supersession path in rm09/rm10; the spec's intent is: `rating_runtime` cannot supersede or re-issue a row a bill run holds at `BILL_DRAFT`/`BILL_APPROVED`.)

> **Known limitation — deferred to bm27/rm10 (recorded 2026-09-15, code-review finding #1).** The `rl.py` pre-check (`scan_and_guard`) tests **incoming** `(start_datetime, udr_key)` keys, but the rm10 supersede (`_SUPERSEDE_SQL`) retires **prior-run** live rows by `udr_ref_batch_id` — a different key space. A corrected-timestamp or shrinking reissue can therefore have a prior-run row that is held in flight (`BILL_DRAFT`/`BILL_APPROVED`) yet is **not** in the incoming key set: the pre-check passes, then `supersede_batch` (as `rating_runtime`) tries to retire that row and `rating_status_guard` `RAISE`s. That exception is a raw `psycopg` error, not a `BatchRefused`, so `rl.py`'s `main()` does not convert it to a clean `LOAD_BLOCKED_INFLIGHT` — the load transaction rolls back and the batch is left stranded at `PROCESSING` for rm11's stranded-batch reconcile to resolve to `FAILED`. **This is fail-closed-safe** — the in-flight claim is protected, no row is superseded, no data is corrupted — but **ungraceful** (opaque error + rm11 round-trip instead of a readable whole-batch refusal). It is **fully latent until bm27** (no real Collection claim produces `BILL_DRAFT` rows before then). **bm27/rm10 prerequisite:** when Collection is made real, reconcile the supersede-vs-inflight path — the clean fix is a symmetric pre-supersede check that refuses the whole batch (`LOAD_BLOCKED_INFLIGHT`/`LOAD_BLOCKED_BILLED`, naming the blocking run) when a prior-run row it would retire is held in flight, so the guarantee reads identically whether the collision is on an incoming key or a superseded prior-run key. Fixing it now was deferred deliberately: it touches rm10's supersede path and cannot be exercised end-to-end until real claims exist.

### 3. `billrun-db-roles.sql` — narrow `billrun_status_guard` to `RATED → BILL_DRAFT`

Change the `billrun_status_guard` status check from `OLD.status IN ('RATED','REJECTED') AND NEW.status = 'BILL_DRAFT'` to `OLD.status = 'RATED' AND NEW.status = 'BILL_DRAFT'`, and the claim-column clause's `OLD.status IN ('RATED','REJECTED')` to `OLD.status = 'RATED'`. Depends on bm24 (no `REJECTED` rows are produced any longer). Update the trigger's inline comment to match.

### 4. Event catalog — `LOAD_BLOCKED_INFLIGHT` (three parts, one change set)

- **Seed row** in `db/seeds/rating-event-catalog.data.ts`, mirroring `LOAD_BLOCKED_BILLED`:
  ```ts
  {
    eventCode: "LOAD_BLOCKED_INFLIGHT",
    component: "RL",
    defaultSeverity: "MINOR",
    eventType: "processingErrorAlarm",
    probableCause: "claimedRecordCollision",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A batch was refused whole because one or more incoming records collide with a live BILL_DRAFT row held by an in-flight bill run.",
  },
  ```
- **Constant**: add `"LOAD_BLOCKED_INFLIGHT"` to `RATING_EVENT_CODES` (after `"LOAD_BLOCKED_BILLED"`) — the set-equality test between the constant and the seeded rows keeps them in lockstep.

### 5. Rating-module doc amendments (prescribed — applied with the code change set, not now)

When this unit is implemented, in the **same change set** (rating §3.5/§5.5). **Every edit below is an amendment, not a clean overwrite** — the existing text stays, the new clause/row/note is added; nothing in the rating docs is rewritten or replaced wholesale:
- **`ratemgmt-architecture.md` Inv #6** — **amend** (append, do not rewrite) to add the in-flight guard beside the existing billed-refusal text, carrying the authorization line (Khek, 2026-09-13): a batch colliding with a live `BILL_DRAFT` row (an in-flight bill run) is also refused whole, emitting `LOAD_BLOCKED_INFLIGHT` (MINOR); the guarantee is the `rating.rating_status_guard` trigger, not the pre-check. The `BILL_APPROVED` clause is untouched.
- **`rm02-event-catalog-seed.md`** — **add** (append) the `LOAD_BLOCKED_INFLIGHT` row to the register and bump the seeded-code count; existing rows and structure are unchanged.
- **`rm09`** (owns `rl.py`) — **add** a note recording the widened guard + the trigger, beside the existing guard description. **`rating-management` progress tracker** — append the resolution so the next agent does not re-ask.

### 6. Guardrail tests (rating-side, land with the unit)

- Reloading a usage file whose records collide with a run's `BILL_DRAFT` rows is refused whole: `udr_batch.status = REFUSED`, `LOAD_BLOCKED_INFLIGHT` at `MINOR` naming the blocking `bill_run_id`; nothing written to `udr_rated`.
- A `BILL_APPROVED` collision still yields `LOAD_BLOCKED_BILLED` (MAJOR) — precedence preserved.
- **Trigger backstop:** with the application pre-check bypassed, a direct `rating_runtime` UPDATE that would supersede a `BILL_DRAFT`/`BILL_APPROVED` row is refused by `rating_status_guard` (the DB-gated rating grants suite, `tests/rating/grants.integration.test.ts`-style).
- The `RATING_EVENT_CODES` ↔ seeded-catalog set-equality test passes with the new code present in both.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm24 (reject/rerun/cancel release to `RATED`, so `REJECTED` is no longer produced and the `billrun_status_guard` narrowing is safe); bm22 (real Postgres + deployed rating engine to run the DB-gated rating suites); the delivered rating module (rm01 `udr_rated`, rm02 catalog, rm03 `rating_runtime` role, rm09 `rl.py`).
- **Authorization:** granted — Khek, rating module owner, 2026-09-13 (`billmgmt-ai-workflow-rules.md` §3.6). No other rating change belongs in this set.

## Verification checklist

- [ ] `rl.py`'s pre-check refuses a batch colliding with a live `BILL_DRAFT` row: `udr_batch.status = REFUSED`, `LOAD_BLOCKED_INFLIGHT` (MINOR, `claimedRecordCollision`) naming the blocking `bill_run_id`; nothing written to `udr_rated`.
- [ ] A `BILL_APPROVED` collision still yields `LOAD_BLOCKED_BILLED` (MAJOR); billed takes precedence when both classes are present.
- [ ] **Trigger backstop:** with the pre-check bypassed, a direct `rating_runtime` UPDATE superseding a `BILL_DRAFT`/`BILL_APPROVED` row is refused by `rating.rating_status_guard`.
- [ ] `LOAD_BLOCKED_INFLIGHT` is in **both** `RATING_EVENT_CODES` and the seeded `event_catalog`; the set-equality guardrail passes.
- [ ] `billrun_status_guard` now permits only `RATED → BILL_DRAFT` (the `REJECTED` allowance retired), consistent with bm24.
- [ ] Change set is atomic (trigger + pre-check + catalog + constant together); the prescribed rating-doc amendments (Inv #6, rm02, rm09, rating progress tracker) are applied in the same change set at implementation.
- [ ] `billmgmt-progress-tracker.md` records bm25 delivered and cross-references the rating-module doc updates.
