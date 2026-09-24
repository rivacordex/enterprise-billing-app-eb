# pm56 — Ship gate (Pricing Components)

**Unit:** pm56 (Part 4, final unit). **Boundary:** `tests/guardrails/**`, the authz-matrix test, the companion docs, and the hand-off register. **No production code** — a ship gate that has to change production code is reporting that an earlier unit is incomplete, and that fix belongs in the unit that owns it, not here.
**Specs from:** `prodmgmt-ai-workflow-rules.md` §8 (the full run list), §7.2, §7.5, §7.10 · `prodmgmt-code-standards.md` §9 (guardrails 2, 13, 16, 27, 31–34), §7, §8, Appendix A rows A1–A9 · `prodmgmt-architecture.md` §3.7, §6 (Inv. #30–#44), §7 · `prodmgmt-update-overview.md` Success Criteria · `pm00-build-plan.md` Part 4.
**Depends on:** **pm46–pm55**, all merged (pm46–pm54 as the single G-E commit, pm55 independently).

---

## Goal

Prove the Pricing Components update in full on a database built from scratch: every guardrail landed rather than assumed, every invariant asserted, every companion doc telling the truth about the code, and every deferred item recorded where the phase that reopens it will find it.

---

## Design

### D1. A guardrail is landed, not assumed — and its evidence is named

Four guardrails are new, two are re-baselined and two are carried over with new fixtures. Each one is a file, a test and a result in this unit's evidence table (D8). "Guardrail 31 passes" is not evidence; "guardrail 31 greps 9 patterns across `app/`, `components/`, `db/`, `services/`, `validation/`, `types/`, `tests/` and finds zero, and `tsc` reports no referent for three deleted types" is.

| # | State | What it asserts |
| --- | --- | --- |
| **2** | carried, component fixtures | A successor insert leaves prior rows byte-identical; `updatePrice`/`deletePrice` succeed on a `DRAFT` parent and are refused for every other status, **including** on a direct SQL write (the trigger). Assertions unchanged; fixtures now components. |
| **13** | **re-baselined** (landed at pm46, re-run here) | The reshaped price table: `component_type` + `price_component`; the six per-`component_type` CHECKs; the rekeyed `NULLS NOT DISTINCT` unique constraint; the `component_type` index; the `product.pricing_steps_ok` function; and the **absence** of `price_type`, `pricing_model`, `amount`, `pricing_characteristics` and their four CHECKs. An exact diff, never a removal. |
| **16** | carried, extended | Grandfathering: after an activation, a pinned subscription's resolved components are **byte-identical, envelope included**. |
| **27** | **re-keyed** | Price completeness per `component_type`: a `usage_rate` without a unit, a `flat_fee` without `params.amount`, a `capacity_commitment` with `committedQuantity <= 0`, and a `capacity_motivation` with empty / duplicate / non-ascending `steps` each fail **in Zod and at the database**; seeds covered by the same assertions. Clears Appendix A row **A7**. |
| **31** | new | **Tiered is gone.** `pricing_model`, the `tiered` literal, `tierSchema`, `tieredPricingCharacteristicsSchema`, `TieredPricingCharacteristics` appear nowhere; `tsc` proves the deleted types have no referent. Grep-asserted (Inv. #41). |
| **32** | new | **Envelope strictness.** An unknown key in any branch is rejected, never stripped, and the DB CHECK refuses the same malformed object **independently of Zod** — two assertions per case, one per layer (Inv. #31). |
| **33** | new | **Cross-component validity.** `MODIFIER_WITHOUT_BASE_RATE`, `AMBIGUOUS_BASE_RATE` and `CURRENCY_MISMATCH` are each refused at the write boundary with their typed code (VI3–VI5). |
| **34** | new | **The override is untouched.** `ordering.order_item_price_override` is still one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`, and its repository still exports no `update*`/`delete*` (Inv. #39). |

### D2. The invariant sweep is a data assertion, not a code review

Over a database built from empty and seeded by pm48, assert on **every** `product_offering_price` row:

- `component_type = price_component ->> '@type'` (Inv. #30);
- `price_component ? 'specVersion'` and its value is `1` (Inv. #44) — the presence check pm46 deliberately left out of the CHECK because it is Zod's rule;
- `component_type` is one of the four persistable values, and no row is a `negotiated_override` (Inv. #39);
- money fields are strings matching the money regex and quantities are JSON numbers (Inv. #32);
- no row carries `end_date_time` (the column does not exist) and none carries a `sequence` field in its envelope (Inv. #37).

### D3. The permission map is confirmed explicitly, in writing

**This update changes no row** in architecture §4 or code-standards §8 — no page, route, permission, level or guard. Authoring a component is ordinary `products : EDIT` DRAFT price editing; viewing components is `products : READ` with no pricing-visibility split. The authz matrix (guardrail 1) gains **no row**.

Workflow §7.5 requires this be **stated at the gate**, not inferred from a green suite: an unexamined authz surface is the one thing a reviewer cannot read off CI. So this unit re-runs the matrix, diffs it against the pre-update baseline, and records "zero rows added, zero rows changed" as an evidence line.

### D4. The §3.7 reader inventory is re-checked and reported, not assumed closed

pm50, pm51 and pm52 re-keyed the three readers. This gate **re-derives the inventory from the repository** — a fresh grep for `price_type`, `pricing_model`, `amount` and `pricing_characteristics` across `services/`, `validation/`, `workflow-management/`, `tests/` and `db/seeds/` — and reports each hit with its verdict:

| Expected surviving hits | Why it is correct |
| --- | --- |
| `ordering.order_item_price_override.price_type` and everything reading it | Not dropped (PC13); O2 defers the `once` → `oneTime` rename |
| `billing.*` / `rating.*` amount columns | Different tables entirely |
| pm50's explicit two-axis mapping | The one legitimate translation site |

Any other hit is a miss from an earlier unit and is reported as such. **The inventory is the checklist, not this module's file list** (workflow §8.13).

### D5. Absence is asserted, not observed

Three absences are success criteria and each gets a test, because "we did not write one" is not evidence:

1. **No backfill / data-fix / relabelling script** anywhere in `db/migrations/**` or `scripts/**` (§1.30) — pm46's assertion, re-run here.
2. **No dual-read shim** — no code path reads `amount` "just in case", no view, alias or generated column reproduces a dropped column (§6.19).
3. **No TMF620 adapter, mapper, serializer, DTO, `toTmf620()`, SDK dependency or `app/api/product*` path** (Inv. #40, §5.3).

### D6. Doc truth is checked by grep, not by memory

Appendix A rows A1–A9 are cleared **only by grep** (workflow §7.2): A1, A3, A4, A8 at pm46; A2, A5 at pm47; A7 at pm56; A9 at pm50; A6 annotated with the G-C grant. A row that outlives its code is drift, and this gate is where that is caught.

Plus the documents that must no longer describe a price shape the code does not have:

| Doc | Required state |
| --- | --- |
| `prodmgmt-code-standards.md` §7 file tree | Matches the shipped tree, including the corrected pm53/pm54/pm55 unit markers |
| `prodmgmt-code-standards.md` §9 | Guardrails 31–34 recorded as landed, 13/27 as re-baselined |
| `prodmgmt-code-standards.md` §6.22 | Window recorded as pm46–pm54, green claimed at pm54 |
| `prodmgmt-architecture.md` §3.4, §7 | G-F recorded as resolved; the NULL-collision gap removed |
| `prodmgmt-architecture.md` §6 | Inv. #2/#4/#28 amended, #5 retired, #30–#44 in force |
| `context/architecture.md` §3 | The platform JSONB example names `component_type`, not `pricing_model` — **verify pm46 did it; do not do it twice** |
| `prodmgmt-ui-context.md` §2, §4, §5, §7 | Match what shipped, including the four warning copies and the `Mbps` case |
| `prodmgmt-update-overview.md` | Status moves from Planned to Delivered, with the date |
| `prodmgmt-progress-tracker.md` / `prodmgmt-completed-tracker.md` | pm46–pm56 recorded with their evidence |

### D7. G-A closes here, or is restated with its reason

The pm35–pm45 delivery record was false on 2026-09-21. If Part 3 and Part 4 are both genuinely in `main` when this gate runs, **G-A closes** and every "delivered" marker in the architecture, the code standards and the trackers becomes true and verified on that date — recorded with the verification command and its output. If any part is still missing, G-A stays open and this gate **does not claim delivery** for what is not there. Do not close a gate by assertion; close it by `git ls-tree` and a green suite.

### D8. The evidence table is the deliverable

This unit's output is a table — one row per verification item from workflow §8.1–§8.16 — carrying the command run, what it proved, and the result. A ship gate whose output is "all green" is not reviewable; a ship gate whose output names its evidence is.

---

## Implementation

### I1. Guardrails

1. **31 — no tiered residue.** A grep guardrail over the repo (excluding `node_modules`, `.git`, migrations' history comments if any legitimately narrate the change) for `pricing_model`, `pricingModel`, `'tiered'`, `tierSchema`, `tieredPricingCharacteristics`, `TieredPricingCharacteristics`; plus a `tsc`-backed assertion that `PricingModel`, `PriceType` and `TieredPricingCharacteristics` resolve to nothing.
2. **32 — envelope strictness.** For each of the five branches: an unknown key is rejected by Zod; and, for the four persistable ones, the same object inserted by raw SQL is refused by its per-`component_type` CHECK. Two independent assertions per case — the point is that neither layer is load-bearing alone.
3. **33 — cross-component validity.** One case per code through the **action/service boundary** (not the validator in isolation), asserting the typed code reaches the caller.
4. **34 — override frozen.** Column list, insert-only surface and repository exports, via the existing exported-surface guardrail.
5. **13 and 27** — re-run on the shipped schema; confirm 13's baseline matches the reshaped table exactly and 27's cases are `component_type`-keyed.
6. **2 and 16** — re-run with component fixtures; 16 extended to byte-identical envelopes after activation.

### I2. The workflow §8 sweep

Run every item and record it: guardrails (§8.1); composition contract's four figures (§8.2); DRAFT-only writes refused by repository **and** trigger (§8.3); uniqueness — two NULL-unit `flat_fee` rows rejected, dated successors accepted (§8.4); migrate-from-empty with the asserted absence of any backfill (§8.5); seeds failing twice on a malformed envelope (§8.6); row/envelope agreement and `specVersion` presence on every row (§8.7 = D2); UI — the four authorable types, read-only at `TESTING`, server-driven blocking banner, non-blocking warnings, no derived fields surfaced (§8.8); audit — one event per mutation, in-transaction, no new type (§8.9); authorization (§8.10 = D3); data layer — SQL only in `db/**`, no stored end, locked status reads, `tx`-first validator (§8.11); query budget after a component write (§8.12); the reader inventory (§8.13 = D4); documentation deliverables — `plaSpec` doc-block, TMF620 table, `AGENTS.md`/`README.md` cross-links (§8.14); build gates including SAST and the DAST baseline (§8.15); no forbidden edits (§8.16).

### I3. Cross-runtime re-verification

The rating flow and the bill run are re-run end to end on the merged `main`, and their outputs diffed against the pre-reshape baselines pm51 and pm52 captured. A green suite is not the claim; **identical numbers** are.

### I4. Documentation

Land D6's table in one change set. Clear Appendix A rows by grep, recording the grep for each. Move `prodmgmt-update-overview.md` to Delivered. Write the trackers.

### I5. The hand-off register

Rewrite `pm00-build-plan.md`'s register as the authoritative list of what Part 4 deliberately did not do, each with the trigger that reopens it:

- **O1, O5, O6, O7, O8, O9** — bill-run phase (base-rate semantics under a varying card; effectivity-aware binding; override × capacity; BAN grain; proration; rounding).
- **O2** — `once` → `oneTime` on the ordering override, plus the shared enum.
- **H1** — the unit vocabulary divergence (`'MBPS'` from rm07's feed vs the catalog's `Mbps`), now consequential because the capacity components bind by unit.
- **H2** — the rate-based basis for a `Mbps` capacity component. **pm55 shipped a placeholder warning; it is replaced, not supplemented, when a basis is modelled.**
- **H3** — `PER_UNIT` rating.
- **New, from pm52** — `recurring` and `oneTime` `flat_fee` rows share one uniqueness lane (both `flat_fee`, unit NULL), so a `oneTime` can supersede a `recurring` in lane terms. pm52 handles it at the bill-run boundary with its D4 decision; whether the **catalog** should also refuse that authoring is an open product-side question. Record the owner.
- **New, from pm46** — the `component_type` CHECK asserts shape, not `specVersion`; presence is Zod's rule and this gate's data assertion. If a `specVersion: 2` ever ships, both need revisiting together.

### I6. What this gate must not do

Not fix production code (D-header); not relax a gate to pass (§6.9); not close G-A by assertion (D7); not edit `ratemgmt-*` or `billmgmt-*` docs (workflow §7.9); not implement any register item to make a test easier (§5.2).

---

## Dependencies

**Packages to install: none.** Existing `vitest`, the guardrail harness, the live-DB integration setup, the repo's SAST and DAST baseline jobs.

**Commands used:** `npm run db:setup` from empty, `npm run db:seed-demo`, `npm run db:seed-sample`, `npm run test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, the SAST and DAST baseline jobs, the rating and bill-run flow runs, and `git ls-tree -r` for D7.

---

## Verification checklist

Guardrails

- [ ] 31, 32, 33, 34 exist as files, run in CI, and pass — each with named evidence, not a bare green.
- [ ] 13 re-baselined to the reshaped table, including the absences and the `NULLS NOT DISTINCT` constraint; 27 re-keyed to `component_type` and clearing A7.
- [ ] 2 and 16 pass with component fixtures; 16 asserts byte-identical envelopes after activation.
- [ ] All of guardrails 1–30 pass unchanged in substance.

Data and invariants

- [ ] Every stored row satisfies `component_type = price_component ->> '@type'` and carries `specVersion: 1`.
- [ ] No row is a `negotiated_override`; money is strings, quantities are numbers; no `sequence` field exists.
- [ ] Two NULL-unit `flat_fee` rows at one `start_date_time` are rejected; dated successors insert.
- [ ] A component write against any non-`DRAFT` parent is refused by the repository **and** by the trigger.
- [ ] `db:setup` + both seed sets run clean on an empty database; a malformed seed fails twice.
- [ ] The composition contract reproduces all four figures and exports nothing to production.

Absences

- [ ] No backfill, data-fix or relabelling script exists.
- [ ] No dual-read shim, view, alias or generated column reproduces a dropped column.
- [ ] No TMF620 adapter, mapper, DTO, SDK dependency or `app/api/product*` path exists.
- [ ] No rate-card table, lookup or query exists; `rateCardLookUp` resolves to nothing anywhere.

Cross-runtime

- [ ] The §3.7 reader inventory is re-derived by grep and every surviving hit is explained (D4).
- [ ] The rating flow and the bill run produce **identical** numbers to their pre-reshape baselines.
- [ ] No bootstrap role file was edited in the whole update.

Authorization

- [ ] The authz matrix gains **zero** rows; the permission map changes **zero** rows — stated explicitly here, with the diff as evidence.
- [ ] No route, page, segment, search param or permission was added by any unit in Part 4.

Build gates

- [ ] `tsc --noEmit`, ESLint, Prettier, the full test suite, SAST and the DAST baseline clean on a database built from scratch.
- [ ] Orders, Subscriptions, View Product and every Administration route green and unchanged.

Documentation

- [ ] Appendix A rows A1–A9 all cleared or annotated, each **by grep**, with the grep recorded.
- [ ] Every doc in D6's table matches the shipped code; no doc still describes a price shape the code no longer has.
- [ ] `context/architecture.md` §3's JSONB example names `component_type` — verified once, not done twice.
- [ ] The update overview reads Delivered; both trackers carry pm46–pm56 with their evidence.
- [ ] The hand-off register carries every item in I5, each with its reopening trigger and owner.
- [ ] **G-A** is closed with its verification command and output, or restated as open with the reason.

**Definition of done:** the catalog stores every price as one self-describing component, from an empty database through to a rendered panel and a bill run that charges exactly what it charged before — and the evidence table says, item by item, how each of those claims was proved rather than asserted.
