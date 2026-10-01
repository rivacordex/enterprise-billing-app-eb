# rm15 — `udr_rated` shape migration (rename + X1 + X2) — Spec

- **Unit:** rm15 of Phase G (`rm00-build-plan.md`, PER_UNIT RAN-usage update)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/migrations/0034_rating.sql` + `db/schema/rating/udr-rated.ts` + the migration's Drizzle meta + the app-repo call sites (seeds, bill-run repo) + `tests/rating`
- **Authorizes from:** `_change-rating-configuration-plan.md` (A8, X1/X2, the rename sweep); `ratemgmt-architecture.md` Inv 3, 15, 22 (updated); `ratemgmt-code-standards.md` §0, §5.2, §5.7; `ratemgmt-ai-workflow-rules.md` §0 rules 10–13.

## Goal

Reshape `rating.udr_rated` for the PER_UNIT update by **editing `0034_rating.sql` in place** (fresh-install regime): rename `udr_subscriber_ref_id` → **`udr_subscription_ref_id`**, retarget `rating.period_of()` to the configured business timezone so `partition_period` **is the billing month** (X1), and tighten the live-row unique constraint to **`(partition_period, udr_key, is_live)`** (X2) — sweeping every app-repo call site in the same change set so no `udr_subscriber_ref_id` reference remains.

## Design

- **Edit-in-place, not a forward migration — gated.** Per the module's fresh-install regime (same discipline as pm57a's G-RC6): the change is only valid if **no environment has applied `0034` against live data**. Verify empirically and record it. If any persistent environment holds rated rows, **stop** — the change ships as a forward `0042` instead (this spec does not cover that path; escalate).
- **`period_of()` is shared** by `udr_rated` **and** `process_log` (0034:78, 0034:169). Changing its literal changes **both** tables' partition buckets to the billing month. Accepted: `process_log` is telemetry, and fresh-install means no rows to re-bucket. The change is a single edit to one `IMMUTABLE` helper.
- **The TZ literal is a deploy-time constant, not a runtime lookup.** `period_of()` must stay `IMMUTABLE` (it is used in a `CHECK`), so the zone is a hardcoded literal sourced from the system-config timezone **at migration-authoring time** — `'Asia/Kuala_Lumpur'`, matching `APP_TIMEZONE` / `getAppTimezone()`. A later business-TZ change is a new migration regenerating the function (not applicable to a fixed `+8`).
- **`is_live` stays `GENERATED ALWAYS … STORED` (true-or-NULL).** Dropping `start_datetime` from the unique key makes it "one **live** row per `(partition_period, udr_key)`" — superseded rows (`is_live = NULL`) still coexist without limit under SQL's default `NULLS DISTINCT`. This is the double-billing backstop (Inv 3); it is never weakened or made deferrable.
- **X2 is table-wide.** `udr_rated` is shared across all `udr_type`s; this key binds every future feed to a monthly grain. Correct for RAN_USAGE (monthly); a future sub-monthly `udr_type` needs a `udr_type`-scoped partial index — **out of scope, recorded as a deferred item** (do not build it here).
- **The rename is one atomic change set** — the SQL column, the index, the Drizzle field + index definition, the regenerated Drizzle meta, and every TS reference land together. A half-rename leaves the app repo red.

## Implementation

### 1. Fresh-install gate (do first; blocking)
Confirm no persistent/shared database (CI, staging, any long-lived local) has applied `0034` — inspect each `__drizzle_migrations` journal for the `0034` entry. Record the check with its date in `infra/docs/db-role-verification.md` (or the migration PR). **Only proceed on a clean result.**

### 2. `period_of()` retarget — X1 (`0034_rating.sql` ~line 18)
- Change the function body literal:
  ```sql
  -- was: SELECT date_trunc('month', ts AT TIME ZONE 'UTC')::date
  SELECT date_trunc('month', ts AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  ```
- Update the leading comment (0034:15–17): it currently says "literal is UTC — a physical storage bucket, **not** the billing month". Rewrite to: the literal is the config TZ (`Asia/Kuala_Lumpur`), so `partition_period` **is** the billing month; deploy-time constant; a TZ change is a migration. Keep the "not runtime-configurable / immutable" point.

### 3. Live-row constraint tighten — X2 (`0034_rating.sql:76`)
```sql
-- was: CONSTRAINT "udr_rated_live_uq" UNIQUE ("partition_period","start_datetime","udr_key","is_live")
CONSTRAINT "udr_rated_live_uq" UNIQUE ("partition_period","udr_key","is_live")
```
- Update the comment (0034:29) — `is_live` carries "one live row per `(partition_period, udr_key)`" (per cell per billing month). Leave the `CHECK (partition_period = rating.period_of(start_datetime))` (0034:78) unchanged — it still holds, now against the billing-month `period_of`.

### 4. Column rename — SQL (`0034_rating.sql:42`, comment 0034:32)
```sql
-- was: "udr_subscriber_ref_id" text NOT NULL,
"udr_subscription_ref_id" text NOT NULL,
```
Update the block comment (0034:31–33) listing the plain-text refs to say `udr_subscription_ref_id`.

### 5. Index rename — SQL (`0034_rating.sql:87`)
```sql
-- was: CREATE INDEX "udr_rated_subscriber_start_idx" ... (udr_subscriber_ref_id, start_datetime)
CREATE INDEX "udr_rated_subscription_start_idx" ON "rating"."udr_rated"
  USING btree (udr_subscription_ref_id, start_datetime);
```
(Rename the index so its name matches the renamed column; the other three indexes are unaffected.)

### 6. Drizzle schema (`db/schema/rating/udr-rated.ts`)
- Line 60: `udrSubscriberRefId: text("udr_subscriber_ref_id").notNull()` → `udrSubscriptionRefId: text("udr_subscription_ref_id").notNull()`.
- Lines 190–191: rename the index builder to `udr_rated_subscription_start_idx` and `.on(t.udrSubscriptionRefId, t.startDatetime)`.

### 7. Drizzle meta regeneration (scoped to 0034)
Per pm57a D1: an in-place SQL edit makes the stored `meta/_journal.json` hash and `meta/000X_snapshot.json` for `0034` diverge from the SQL, so the migrator errors or skips. Regenerate the `0034` journal hash **and** snapshot to match the rewritten SQL (drop `0034`'s entries and let `drizzle-kit` re-add for that one file, or regenerate scoped to `0034`). This is the one relaxation of code-standards §6.25's "no `drizzle-kit generate`", for the metadata only; the schema `.ts` stays hand-synced. **Verify the regenerated hash matches** before the unit is done.

### 8. TS call-site sweep — rename `udrSubscriberRefId` → `udrSubscriptionRefId`
- `db/seeds/sample/udr-rated-sample.ts` — line 64 (`udrSubscriberRefId: spec.subscriberRefId`) + comment line 81.
- `db/seeds/sample/seed-billrun-sample.ts` — lines 353, 361 (`udrRated.udrSubscriberRefId`) + comments 858, 921.
- `db/repositories/billing/rated-lines.repository.ts` — the **bill-run read path**: lines 150, 204, 215, 228 (`udrRated.udrSubscriberRefId`) + comments 107, 178. (The column still holds a `product_inventory_id`; only the name changes, so the joins to `inventory.product_inventory` are unchanged.)

### 9. Tests (`tests/rating/rm01-schema.integration.test.ts` and any referencing the column)
- Assert the tightened constraint: a second **live** row for the same `(partition_period, udr_key)` aborts; a same-cell/**different-billing-month** pair both stay live; a superseded (`is_live` NULL) row coexists.
- Assert `period_of()`: a record at `2026-03-01 02:00+08` lands in `partition_period = 2026-03-01` (not February), and the `CHECK` behaves identically across ≥3 session timezones.
- Update every test literal `udr_subscriber_ref_id` / `udrSubscriberRefId`.

## Dependencies

**None** — no packages to install. Uses the existing `drizzle-kit` (already a dev dependency) for the scoped meta regeneration in step 7. This is a schema/SQL + TS-rename change only.

## Verification checklist

- [ ] **Fresh-install gate recorded** — no environment applied `0034` against data; the check + date is written down. (If it fails, the unit stops and re-scopes to a forward migration.)
- [ ] `0034_rating.sql` rewritten in place; **Drizzle `0034` journal hash + snapshot regenerated** and verified to match the SQL.
- [ ] `grep -rn "udr_subscriber_ref_id\|udrSubscriberRefId" enterprise-billing-app/` returns **zero** hits (migration, schema, seeds, repo, tests all swept).
- [ ] `period_of()` returns the billing-month date in `+8`: the `2026-03-01 02:00+08` boundary record files in March; identical result across `UTC` / `America/New_York` / `Asia/Singapore` sessions.
- [ ] Live-row uniqueness: a second live row per `(partition_period, udr_key)` raises a unique violation; a test that deliberately skips supersede **aborts the transaction** (not the app code — the constraint is the guarantee); a same-cell/different-month pair inserts; superseded rows coexist.
- [ ] The index `udr_rated_subscription_start_idx` exists on `(udr_subscription_ref_id, start_datetime)`; the old name is gone.
- [ ] `process_log` still applies cleanly — its `period_of(log_datetime)` CHECK uses the same retargeted helper; empty DB, no re-bucket.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; `npm run db:setup`/migrate applies on an empty DB; rm01's refreshed constraint suite is green against a live DB.
- [ ] `rated-lines.repository.ts` compiles and still resolves the billing account via `udr_subscription_ref_id` → `inventory.product_inventory`.
- [ ] Diff is app-repo only; no `workflow-management/` change (the `rp.py`/`rl.py` rename is rm19, per §2.2).
