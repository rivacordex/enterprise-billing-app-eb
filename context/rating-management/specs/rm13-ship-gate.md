# rm13 — Ship gate — Spec

- **Unit:** rm13 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase F — sign-off)
- **Repo:** both · **Boundary:** tests / CI (changes only CI configuration)
- **Builds:** the assembly + CI wiring that runs the full guardrail suite, the end-to-end journey test, the migration-boundary assertion, and the SAST/DAST gate.
- **Depends on:** rm01–rm12.
- **Sources:** `rm00-build-plan.md` Unit rm13 · `ratemgmt-code-standards.md` §10 (the 16-test table) · `ratemgmt-ai-workflow-rules.md` §8 (verification) · the platform `infra/azure-pipelines.yml` (5 gated stages, Semgrep SAST) · rm04/rm06 (the rating-repo pipeline).

> **rm13 assembles and runs; it does not build the behavioral tests.** Each of the sixteen guardrail tests ships with its **owning unit** (code-standards §10). rm13 wires them into one gate and adds **only test #15** (no-per-record-fan-out), whose assertion mechanism is settled here. It adds no new test tree in the rating repo (code-standards §8).

---

## Goal

Assemble and run the full guardrail suite (16 tests, each owned by its unit) plus one end-to-end journey, assert no rating migration touches `billing`, and gate on SAST + a DAST baseline with no high/critical finding — so the complete operator journey passes end to end and every Invariant has a test that fails when the Invariant is deliberately violated.

---

## Design

### D1. Assemble + run, don't rebuild

The sixteen guardrail tests already ship with their owning units (rm01–rm12; code-standards §10). rm13 **assembles** them into the CI gate and **runs** them against a live database and a running engine. It writes **only** test #15.

### D2. Test #15 — no per-record fan-out (the one rm13 owns)

Settle the mechanism: after an end-to-end run of the 50,000-record fixture, query the Kestra execution's **task-run count** and assert it is bounded by **chunk count** — `fixed_flow_tasks + ceil(records / chunk_size)` — not ~50,000. A design guard, not a release blocker (§10.15): it proves the pipeline never tempts toward per-record tasks (Inv #10).

### D3. The end-to-end journey

One test exercising the whole spine, composed from the units: a `RAN_USAGE` file lands → PRP claims and rejects the 37 bad rows (`PARTIAL`) → RP rates the survivors → RL loads at `RATED` and archives → upstream reissues → rm10 supersedes → the completeness check runs clean. Proves the units **compose**, not just pass in isolation.

### D4. Migration-boundary assertion (Inv #18)

A CI check that **no rating migration touches `billing`** — a scan of the `rating` migration SQL for any DDL/DML against `billing.*`, failing the build if found. The runtime half (the engine's role holds no `CONNECT` on billing) is already asserted by the grant tests (rm03); this is the source-level half.

### D5. SAST + DAST gate

- **SAST:** the platform pipeline already runs Semgrep (the `test_scan` stage); rm13 confirms it covers the rating repo, with **no high/critical** finding.
- **DAST:** an **OWASP ZAP baseline** scan against the engine (behind Easy Auth, rm05), with **no high/critical** finding — the baseline authenticates or scans the login surface only, since the UI is gated.

### D6. Spans both repos, changes only CI

rm13 runs the app-repo test suite and the rating-repo flows against a live engine, but adds **no new behavioral test tree** — the rating repo has no `tests/` directory (code-standards §8). It changes only CI configuration.

### D7. Every Invariant fails-when-violated

The gate's contract (ai-workflow-rules §5.4, the "prove the constraint, not the code" posture): each Invariant's guardrail test **fails when the Invariant is deliberately violated** — e.g. skipping the supersede step aborts on the unique constraint, a widened grant fails the per-column assertion, a per-record log write fails log-proportionality.

---

## Implementation

### 1. Assemble the suite

Wire the sixteen tests (owned by rm01–rm12, plus #15 here) into the CI gate — the app-repo `vitest` integration suite against a live database, and the rating-repo flows against a local/CI engine (Azurite + the local `kestra` DB, rm04 D9).

### 2. Test #15 (`tests/rating/no-fan-out.test.ts`)

Run the 50k fixture end to end; read the Kestra execution's task-run count; assert `≤ fixed_flow_tasks + ceil(records / chunk_size)`.

### 3. End-to-end journey test

The composed scenario in D3, asserting the terminal states at each stage.

### 4. Migration-boundary CI check

A pipeline step scanning the `rating` migration(s) for `billing.*` writes; fail on any match.

### 5. SAST + DAST

Confirm Semgrep covers the rating repo in the `test_scan` stage; add an OWASP ZAP baseline stage against the deployed engine; gate on no high/critical.

### 6. The green gate

The gate is green only when: all 15 release-blocking guardrail tests pass, test #15 runs and reports (non-blocking design guard, D2), the e2e journey passes, the migration-boundary check passes, and SAST + DAST report no high/critical.

---

## Dependencies (packages to install)

**None new for the app/worker.** The gate uses the existing `vitest` integration config and the `kestra` CLI (rm06). **Pipeline tooling:** OWASP ZAP (DAST) added to the pipeline image; Semgrep already present. No npm/Python package installs.

---

## Verification checklist

The CI gate itself is the deliverable.

1. The **complete operator journey** passes end to end — file lands → PRP `PARTIAL` → RP rates → RL loads + archives → reissue → supersession → completeness clean.
2. **Every Invariant** has a test that **fails when the Invariant is deliberately violated** (spot-checked: skip-supersede aborts; widened grant fails; per-record log fails proportionality).
3. All **16** guardrail tests run in the gate; the 15 release-blocking tests are green (test #15 runs and reports as a non-blocking design guard, D2).
4. **Test #15:** a 50,000-record run's task count is bounded by **chunk count**, not record count.
5. The **migration-boundary** check fails a migration that writes `billing.*` and passes the real rating migrations.
6. **SAST** (Semgrep) covers the rating repo with no high/critical finding.
7. **DAST** (OWASP ZAP baseline) against the engine reports no high/critical finding.
8. rm13 adds **no** new behavioral test tree in the rating repo; it changes only CI.
9. The gate is **red** if any of: a release-blocking guardrail test (any of the 15; test #15 is a non-blocking design guard, D2), the e2e journey, the migration check, SAST, or DAST fails.
