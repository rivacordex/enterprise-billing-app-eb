# bm40 — Bill-run foundation repair: flow rename, extracted-SQL harness & DB-test safety

**Unit:** bm40 (Target Capacity Pricing update — "Unit 0"). **Boundary:** `workflow-management/flows/bill-run-processor/**` + `tests/**` + `vitest.integration.config.ts`. **No capacity logic, no app/UI change.** **Ships first, as its own PR, and deploys before any capacity unit (bm41+).** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` (TC43/TC44/TC58, §3), `billmgmt-update-overview.md` (Unit 0), `bm00-build-plan.md` Part 3 Unit 40.

> **Re-scope note (verified against `enterprise-billing-app`, 2026-10-04).** The capacity plan's original Unit 0 — "repair the bm29 resolver off `pop.amount`/`pricing_model`/`price_type`" — is **already shipped**: the flow reads the PC14 component model (`pop.price_component ->> 'priceType' = 'recurring'`, `pop.recurring_charge_period_length`, the `lead((pop.start_date_time …))` window; refs pm46/pm52/PC8/PC14), and neither the flow nor the test double carries any stale `pop.amount`/`pricing_model`/`pop.price_type`. bm40 is therefore re-based onto the gaps that are **still live**: (1) the `udr_subscriber_ref_id → udr_subscription_ref_id` rename never reached the flow; (2) the test double is still hand-copied (TC43 harness unbuilt); (3) the cross-cluster `DROP DATABASE … WITH (FORCE)` + the skip-loudly bug remain (TC58).

## Goal

Make the deployed bill-run processing flow runnable against the current `rating.udr_rated` schema by finishing the `udr_subscription_ref_id` rename in the flow, and make flow-vs-test drift impossible to mask by replacing the hand-copied test doubles with a harness that runs the flow's own extracted SQL — then make the DB-gated suite refuse to run against a non-disposable database.

## Design

### What is broken, and why the tests don't catch it

```
rating.udr_rated  (migration 0034, edited in place)        → column is `udr_subscription_ref_id`
bill_run_processing.yml  Collection/replay SQL             → joins `ur.udr_subscriber_ref_id`  ✗ (column gone)
tests/db/helpers/billrun-aggregate.ts  (hand-copied double)→ already updated to `udr_subscription_ref_id`  ✓
   ⇒ the DB suites pass against the double, while the DEPLOYED flow fails every account at Collection
     (`column "udr_subscriber_ref_id" does not exist`).
```

The fix is two-pronged and deliberately so: **correct the flow** (so it runs) and **retire the hand-copied doubles** (so this class of drift cannot recur). The rename alone would turn the lights green again but leave the next drift equally invisible; the harness is what removes the mask.

### Structural decisions

- **D1 — the rename is a pure identifier swap** in the flow, its template, and its README. No column is added or dropped (the schema already carries the new name); no task logic, GUC, callback, or stage taxonomy changes.
- **D2 — the extracted-SQL harness replaces BOTH hand-copied doubles** (`billrun-aggregate.ts` and `billrun-verify.ts`). It parses the deployed YAML, strips Kestra `{{ }}` pebble, rebinds the GUCs, and runs the step heredocs in one transaction (TC43). This is a real build item, not "swap a string in the double."
- **D3 — DB-test safety is fail-closed in `globalSetup`**, which runs _before_ any test module imports `db/client.ts`. `db/client.ts:5` does `import { config } from "@/lib/config"` and line 13 opens `postgres(config.DATABASE_URL, …)` at module load, so `@/lib/config` validation throws before a per-file `describe.skipIf` can evaluate — the gate must live in `globalSetup` (which the DB-gated project currently lacks).
- **D4 — bm40 ships and deploys first.** No capacity unit (bm41+) starts until bm40 exits: the flow must actually run before capacity logic is layered onto it.

## Implementation

### 1. Finish the flow rename (`udr_subscriber_ref_id → udr_subscription_ref_id`)

- `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` — live joins at lines **159, 248, 570, 812** (`ON pi.product_inventory_id = ur.udr_subscriber_ref_id`) and comments at **151, 745**. Swap every occurrence.
- `workflow-management/flows/bill-run-processor/bill_run_processing.template.yml` — the 3 occurrences (keep the non-deployable template contract in lock-step with the deployed flow).
- `workflow-management/flows/bill-run-processor/README.md` — the 1 occurrence.
- Redeploy the flow to the `billrun` namespace (`flow-deploy`). No other task touched.

### 2. Extracted-SQL test harness (TC43)

- New `tests/db/helpers/extract-flow-sql.ts`: (a) parse `bill_run_processing.yml`; (b) pull the named step heredocs (the `aggregation` / `verification` psql bodies); (c) strip/neutralise the Kestra `{{ }}` pebble expressions; (d) rebind the GUCs the flow sets via `set_config`/`current_setting` (`run_id`, `ban`, `attempt`, `period_start`/`period_end`, `gl_event_at`, the force-fail guard) to test values; (e) run the heredocs in one `sql.begin` transaction matching the flow's `BEGIN; … COMMIT;`.
- Retire `tests/db/helpers/billrun-aggregate.ts` and `tests/db/helpers/billrun-verify.ts` (the hand-copied doubles); point the existing `aggregation` / `recurring` / `volume` / `verification` / `checksum` suites at the harness so they execute the flow's real SQL.
- Harness self-tests (its own failure modes, per §17/TC43): a heredoc that reads an unset GUC fails loudly; an unstripped pebble expression is detected, not silently run.

### 3. DB-test safety (TC58)

- Add a `globalSetup` to `vitest.integration.config.ts` (the DB-gated project; it has none today — it only sets `include: ["tests/**/*.integration.test.ts", …]`). It must **refuse** unless BOTH:
  1. `process.env.DESTRUCTIVE_DB_OK === "1"` (explicit opt-in), **and**
  2. the target DB carries a disposable sentinel (e.g. a `_meta.disposable = true` row the provisioning writes) — **not** a name match, which is spoofable.
     On either miss, `throw` a clear message and exit before any `db/client.ts` import. This also fixes the skip-loudly bug (the gate now runs before `@/lib/config` throws on an unset `DATABASE_URL`).
- `tests/db/billrun-db-roles.integration.test.ts:351` — remove the cross-cluster `DROP DATABASE IF EXISTS "kestra" WITH (FORCE)`: drop the `FORCE` (never terminate other connections), and reset a _schema_ inside the disposable DB rather than the whole `kestra` _database_; keep the teardown gated behind the §3 preflight.

## Dependencies

- **npm packages:** none expected — the harness parses YAML in TypeScript, so the one possible add is a YAML parser (`yaml`) **if `package.json` does not already carry one** (the app is Next/Drizzle; verify before adding). `postgres` is already a dependency. No runtime package changes.
- **Prerequisite artifacts (must already exist — verified shipped):** the rating-config `udr_subscription_ref_id` rename on migration `0034` + the rating runtime + `rated-lines.repository.ts`; the PC14 component price model and the already-shipped recurring-resolver repair. bm40 needs **no** capacity column or compute.
- **Downstream:** bm41–bm46 all build on bm40; none may start until bm40 exits and the flow is redeployed.

## Verification checklist

- [ ] `grep -r udr_subscriber_ref_id workflow-management/flows/bill-run-processor` returns **nothing** (flow, template, README all on `udr_subscription_ref_id`); the flow redeploys to `billrun`.
- [ ] A live-Kestra run on the `_SAMPLE_` `ci` seed reaches `PROCESSED`: Collection's join resolves against `udr_subscription_ref_id`, proving the **deployed** flow runs on the current schema (not only the double).
- [ ] The `aggregation` / `recurring` / `volume` / `verification` / `checksum` DB suites run the **extracted** flow SQL; `tests/db/helpers/billrun-aggregate.ts` and `billrun-verify.ts` no longer hold hand-copied SQL bodies; the harness self-tests pass.
- [ ] **Drift guard:** renaming one identifier in the flow only (and not the schema) now **fails** a DB suite — the mask is gone.
- [ ] `vitest.integration.config.ts` `globalSetup` refuses a non-disposable target (missing `DESTRUCTIVE_DB_OK` **or** missing sentinel → a clear throw) before any `db/client.ts` import; an unset `DATABASE_URL` refuses loudly rather than crashing inside `@/lib/config`.
- [ ] No `DROP DATABASE … WITH (FORCE)` remains anywhere under `tests/**`; the roles suite's teardown stays inside the disposable DB and cannot reach a co-located engine.
- [ ] `tsc` / eslint / the DB-free unit suite green; the DB-gated suite green against a **disposable** Postgres with `DESTRUCTIVE_DB_OK=1`.
- [ ] Docs synced: the capacity plan's Unit-0/TC44 note and `bm00-build-plan.md` Part 3 record "resolver repair already shipped; bm40 = flow rename straggler + extracted-SQL harness + DB-test safety."
