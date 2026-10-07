# bm46 — Target Capacity Ship Gate

**Unit:** bm46 (Target Capacity Pricing update · final). **Boundary:** cross-cutting — tests + docs/tracker. **No new build** — audit, assemble, sign off (bm13/bm21/bm35/bm39 discipline). **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §1.1 (anchors), §15/§16 (test matrix), §17 (live-Kestra gate, TC54), the O-TC/TC register; `billmgmt-code-standards.md` capacity guardrails 36–42; `billmgmt-architecture.md` invariants #29–#38; `bm00-build-plan.md` Part 3 Unit 46. **Depends on:** bm40–bm45.

> **Framing.** The bm21/bm35/bm39 pattern: audit the assembled update against its guardrails, run the full journey as the proof, fix only what auditing surfaces, and sync the owning docs — do not rebuild. The Target Capacity proof is that a capacity account bills **end-to-end on its own** — `SCHEDULED → COMPLETED` through a **real Kestra execution** (not only the extracted-SQL harness — Inv #38/TC54) — with the four anchors correct, every guard loud, the two verification models agreeing under the gate, the checksum covering `rated_amount`, and the per-polygon appendix on the posted PDF. This unit owns the live-Kestra capacity run, the "no new migration beyond bm41" confirmation, and the tracker/known-issues closeout.

## Goal

Audit that the capacity aggregation (bm42), verification + Model-2 gate (bm43), checksum append + read-model surfacing (bm44), and invoice appendix (bm45) are present and green; drive the full local `SCHEDULED → COMPLETED` capacity journey on the `_SAMPLE_` `capacity` seed through a real Kestra execution as the update's proof; confirm no migration beyond bm41's `0044`; and sync `billmgmt-progress-tracker.md`, `billmgmt-known-issues.md`, and the overview/architecture docs.

## Design

**Structural decisions**

- **Audit, don't rebuild.** Every capacity behaviour was delivered by bm40–bm45 with its own tests; this unit confirms they are present and green and assembles the update-level proof, fixing only a genuine gap surfaced while auditing (the bm13/bm21 precedent).
- **The live-Kestra journey is the gate (TC54, Inv #38).** The extracted-SQL harness (bm40/TC43) proves the logic; it strips Kestra pebble, so logic-green ≠ runs. The sign-off is a **deployed, pebble-rendered** flow executing on the `capacity` seed against the local stack (real Postgres + Kestra), reaching `COMPLETED` — because the module's historical bugs were all pebble/execution-layer (T1).
- **The four anchors are the money proof (§1.1).** 800 → 100,000; 1000 → 100,000; 2000 → net 150,000 (gross 200,000, discount 50,000); 0 → 100,000 — each with its `additional_info` trace, each reconciling under Model-1 and Model-2.
- **Every guard must fire loud and isolate.** The six HARD guards (bm42) each fail only their own account to `PROCESSING_FAILED` while siblings bill; the `CAPACITY_RATE_MATCHING` gate (bm43) HARD-fails ON and WARN-proceeds OFF; `capacity_max_bands` admits N bands by config (TC52).
- **"No new migration beyond bm41" is an explicit assertion.** The capacity update is flow SQL + app repo/template + one bm41 migration (`0044_customer_bill_line_capacity.sql`); the gate confirms the migrations set added exactly that and nothing else, so the data-risk story is reviewable.
- **Guardrails carried forward.** `billmgmt-code-standards.md` guardrails 36–42 (the capacity set) are confirmed as greppable assertions: inline-SQL-only capacity logic (no `billing.capacity_charge()` function, no Python task), `additional_info` never hashed, `rated_amount` the last checksum element, the extracted-SQL harness is the only flow-SQL source (no hand-copied double), the appendix reads only the snapshot.
- **Docs closeout.** `billmgmt-known-issues.md` records the ratified residuals (the bm45 D2 rating coupling and D4 ratecard-version resolution; the TC40/TC55 fractional-rounding drift; **O-TC7 partial-period** stays a deferred business decision — partial-period capacity accounts remain EXCLUDED); `billmgmt-progress-tracker.md` records the update delivered.

## Implementation

### 1. Guardrail audit

Confirm present + green, per boundary: bm42 — capacity identification off the pinned version, the six HARD guards, the N-band calc, `rated_amount` on all USAGE lines, the zero-usage capacity line, the `additional_info` trace, `capacity_max_bands`; bm43 — the `rated_amount` replay, the capacity replay by `(offering, unit, udrType)`, the internal identities, Model-2, the `CAPACITY_RATE_MATCHING` gate (ON/OFF); bm44 — the `rated_amount` checksum append (last element, Inv #35), the read-model surfacing, the discount render; bm45 — the appendix snapshot, the canonical-key join, the card-missing surface, the ≤10K guard, final-invoice-only render; bm40 — no `udr_subscriber_ref_id` remains, the extracted-SQL harness is the flow-SQL source, the DB-test safety preflight.

### 2. Full-journey proof (live Kestra, TC54)

Drive the `_SAMPLE_` `capacity` seed through the deployed flow on the local stack: materialise → trigger → **self-driven** capacity aggregation + verification to `PROCESSED` (the four anchors + the multi-polygon appendix account) → approve (four-eyes) → post (checksum covers `rated_amount`) → render + store the posted invoice **with the per-polygon appendix** → `INVOICED` → distribute → `COMPLETED`; plus a **mis-configured sibling** (e.g. a non-PER_UNIT / rate-mismatch row) settling to `PROCESSING_FAILED` via the terminal signal while the valid accounts bill; plus a gate-OFF run showing the mismatch WARN-proceeds on Model 1.

### 3. No-new-migration confirmation

Assert the migrations directory / `_journal.json` added exactly `0044_customer_bill_line_capacity.sql` (bm41) since the capacity update began, and nothing else; the gate fails if any other `00NN` appears (the flow SQL, app repo, template, and seeds carry no migration).

### 4. Docs

- `billmgmt-code-standards.md`: confirm capacity guardrails 36–42 are stated as greppable assertions.
- `billmgmt-architecture.md`: confirm invariants #29–#38 describe the shipped behaviour; no drift.
- `billmgmt-known-issues.md`: record the ratified residuals — the bm45 D2 rating-feed coupling and D4 ratecard-version resolution (ACTIVE-of-named-card, durable pin deferred to a rating stamp), the TC40/TC55 fractional-rounding drift (accepted), and **O-TC7** (partial-period billing — business, unresolved; capacity accounts stay EXCLUDED until business settles whether/how to pro-rate).
- `billmgmt-progress-tracker.md`: record bm40–bm46 delivered; the Target Capacity update leaves Outstanding; note O-TC7 as the one open business decision blocking any future partial-period unit.
- `billmgmt-update-overview.md` / `billmgmt-project-overview.md`: fold the capacity update into the delivered narrative (drop any "in-flight" callout).

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm40 (the repaired flow + extracted-SQL harness + DB-test safety), bm41 (the columns + grants), bm42 (aggregation), bm43 (verification + gate), bm44 (checksum + read model), bm45 (appendix); the provisioned local stack and the `_SAMPLE_` `capacity` seed. PER_UNIT rating (TC45) shipped.

## Verification checklist

- [ ] The full capacity journey passes end-to-end via a **real Kestra execution** on the `_SAMPLE_` `capacity` seed against real Postgres/Kestra: self-driven `PROCESSED` → approve → post → render+store (posted PDF carries the per-polygon appendix) → `INVOICED` → distribute → `COMPLETED`.
- [ ] The four anchors are correct and reconcile under **both** Model 1 and Model 2: 800 → 100,000; 1000 → 100,000; 2000 → net 150,000 (gross 200,000, discount 50,000); 0 → 100,000 — each with its `additional_info` trace.
- [ ] Every guard fires loud and isolates: each of the six HARD guards fails only its own account to `PROCESSING_FAILED` while siblings bill; the `CAPACITY_RATE_MATCHING` gate HARD-fails ON and WARN-proceeds OFF (billing Model 1, logged); `capacity_max_bands` admits N bands by config without a SQL edit (TC52).
- [ ] A posted capacity line's `charge_checksum` covers `rated_amount` (tamper changes the hash); `additional_info` is **not** hashed; the Customers & Bills view shows the capacity line with its discount.
- [ ] The posted invoice renders the per-polygon appendix by state → district; a card-missing polygon is surfaced (not dropped); an over-10K account HARD-fails `CAPACITY_APPENDIX_OVER_LIMIT`; the draft PRO-FORMA does not render the appendix.
- [ ] **No new migration** beyond bm41's `0044`; capacity logic is inline SQL only (no `billing.capacity_charge()` function, no Python task); the flow-SQL source is the extracted-SQL harness (no hand-copied double); no `udr_subscriber_ref_id` remains anywhere.
- [ ] Capacity guardrails 36–42 are present + green; invariants #29–#38 match shipped behaviour.
- [ ] `tsc`/lint/the DB-free unit suite green; the DB-gated capacity suites green on a disposable Postgres; the live-Kestra capacity smoke green.
- [ ] **Doc sync:** `billmgmt-progress-tracker.md` records bm40–bm46 delivered and O-TC7 as the open business decision; `billmgmt-known-issues.md` records the bm45 D2/D4 residuals and the TC40/TC55 drift; `billmgmt-update-overview.md`/`billmgmt-project-overview.md` fold the update into the delivered narrative; `billmgmt-architecture.md`/`billmgmt-code-standards.md` show no drift.
