# rm22 — PER_UNIT ship gate: E2E + regressions + RL verification — Spec

- **Unit:** rm22 of Phase G (`rm00-build-plan.md`)
- **Repo:** both · **Boundary:** `tests/rating/**` + CI + `worker/workflow-engine/runtime/rl.py` (verification)
- **Authorizes from:** `_change-rating-configuration-plan.md` (test coverage + R1–R3; OV-6); `rm13` (the existing ship gate this refreshes).
- **Depends on:** rm14–rm21.

## Goal

Refresh the rm13 end-to-end journey to PER_UNIT, verify RL loads PER_UNIT correctly (the "verified no-change" checklist), land the three CRITICAL regressions (R1–R3), and gate on zero stale `udr_subscriber_ref_id` references — the PER_UNIT ship gate.

## Design

- **rm13 already assembles the guardrail suite + one E2E journey + CI assertions.** rm22 refreshes that journey and suite for PER_UNIT; it does not build a second test tree.
- **RL needs no logic change beyond the rename** (done in rm19). rm22 *verifies* RL — a checklist, not a redesign (OV-6): the `COPY` list uses the renamed column, the new `raw ≠ rated` divergence loads, `udr_rate_detail` (PER_UNIT) is carried as opaque text and written, and reconciliation still balances with `input→ratecard` now a PRP hard-stop.
- **The three regressions are the CRITICAL set** — each authored by its owning unit (R1 in rm19's rm08 refresh, R2/R3 in rm21's rm07 refresh) but **assembled and asserted here as ship-blocking**, each with a "fails when the invariant is deliberately violated" test.

## Implementation

### 1. E2E journey (rm13's journey test, refreshed to PER_UNIT)
`rating-input-file-<YYYYMMDDHHMI>.udr` (the 3-row sample) lands → PRP resolves + validates (all locks pass on the seeded Sample-5G data) → RP rates `PER_UNIT` → RL loads at `RATED` → `udr_rated` carries `udr_rate_type="PER_UNIT"`, `udr_rated_price_raw = ratePerUnit × usage_volume`, `udr_subscription_ref_id` = the subscription → re-drop the **same filename** → supersession retires the prior live rows, loads the new set. Assert the PER_UNIT values, `udr_usage_unit = "Mbps"`, and one live row per `(partition_period, udr_key)`.

### 2. RL verified-no-change checklist (`rl.py`)
Confirm (adjust only if a check fails):
- the `COPY` column list uses `udr_subscription_ref_id` (rename landed in rm19);
- `_money` and the numeric columns load the PER_UNIT `raw ≠ rated` values (FLAT had `raw == rate`);
- `udr_rate_detail` (the PER_UNIT variant) is carried as opaque text and written unchanged;
- the `BILL_APPROVED`/`BILL_DRAFT` guard, `file_key` supersession, and the reconciliation `parsed = rated + rejected + discarded` hold — the latter with `input→ratecard` misses now a PRP whole-batch refusal (not RP `LOOKUP_MISS` discards).

### 3. Regressions (assembled, CRITICAL, ship-blocking)
- **R1** — FLAT→PER_UNIT: rm01/rm08/rm09 FLAT assertions are **refreshed** to PER_UNIT, never deleted; a test asserts `udr_rate_type="PER_UNIT"` end to end.
- **R2** — dedup widened: a same-cell/same-billing-month duplicate is rejected; a same-cell/different-month pair is both kept.
- **R3** — `input→ratecard`: an unmapped input row refuses the **whole batch** (was a per-record `LOOKUP_MISS`); test the new hard-stop and document the changed operator experience.

### 4. Rename gate (CI)
A CI step asserts `grep -rn "udr_subscriber_ref_id\|udrSubscriberRefId"` across **both** the app repo and `workflow-management/` returns zero — the rename is complete, no stale reference.

### 5. Ship-gate assertions (unchanged from rm13, re-run)
No rating migration touches `billing`; SAST + OWASP ZAP DAST baseline green, no high/critical; the assembled guardrail suite runs against a live database.

## Dependencies

**None.** Test/CI assembly plus RL verification.

## Verification checklist

- [ ] The full PER_UNIT operator journey passes E2E: file → PRP → RP → RL → `udr_rated` (PER_UNIT values) → reissue → supersession, all green.
- [ ] RL loads PER_UNIT rows at `RATED`; a same-filename reissue supersedes; reconciliation balances; the `BILL_APPROVED`/`BILL_DRAFT` guards are intact.
- [ ] R1, R2, R3 each pass **and** each fails when its invariant is deliberately violated.
- [ ] The CI rename gate reports **zero** `udr_subscriber_ref_id` / `udrSubscriberRefId` across both repos.
- [ ] Every changed Invariant (20–25, X1, X2) has a test that fails on deliberate violation.
- [ ] No rating migration touches `billing`; SAST + DAST green; the suite runs against a live DB, not mocks.
- [ ] `tsc`/ESLint/Prettier clean; the ship gate is green.
