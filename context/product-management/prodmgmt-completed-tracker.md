# Product Management — Completed Tracker

Archive of delivered work for the Product Management module. **Every phase through Part 5 is COMPLETE:** pm01–pm34 (Phases 1–3) are in `main`; **Part 3 (pm35–pm45)**, **Part 4 — Pricing Components (pm46–pm56, pm46a, pm56a, pm56b)** and **Part 5 — Rate Card Lookup (pm57a–pm68)** are complete on `dev1` and land in `main` together at gates G-0/G-A. Part 6 (pm69–pm75) is tracked in `prodmgmt-progress-tracker.md`. Full detail for any unit lives in its `specs/pmXX-*.md` and in `git log`; known defects are in `prodmgmt-issues-tracker.md`.

## Carried-forward residuals (non-blocking, owned outside the delivered units)

- **pm46a rollout:** redeploy `bill_run_processing` (`deploy_workflow_flows`) in the same rollout as `0049`, or the pre-pm46a flow's shared-lane `lead()` can tie when a recurring and a one-time fee share a start. Local dev DB picks up `0049` on its next `db:migrate`.
- **PM-ISS-002:** lookup-row immutability (Inv. #46) is repository-enforced only (guardrail 37); a DB trigger like `child_write_requires_draft` (`0040`) is owed to a follow-up migration.
- **`ratecard` role grant:** `0043` seeds the permission but no role grant, so the Rate Card page stays hidden until a role-grant follow-up grants `ratecard : READ`.
- **A14 (deliberate):** the rate-card read surface ships ahead of any consumer.
- **G-RC6:** the migrator gates on `entry.when`, not content hashes — a DB that applied the original `0041` must be rebuilt from empty (`db:setup`).

## Delivered ledger — Parts 3–5 (pm35–pm68, COMPLETE)

| Unit  | Delivered (compact)                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pm35  | Catalog schema target state — 5-value lifecycle enum, per-type price-completeness CHECKs, cascade FKs (`0006` edited in place).                             |
| pm36  | Family uniqueness indexes + DRAFT-guard trigger `product.child_write_requires_draft()` (`0040`).                                                            |
| pm37  | Domain types, total lifecycle maps, lifecycle badges; View Product hides OBSOLETE + RETIRED by default.                                                     |
| pm38  | Price completeness + DRAFT-only price mutation (`updatePrice` / `deletePrice`).                                                                             |
| pm39  | Manage Products families list — `findFamilyPage` CTE + page rewrite.                                                                                        |
| pm40  | Version bar + read-only panels; `resolveSelectedVersion`.                                                                                                   |
| pm41  | Inline editing of a DRAFT version (spec/price panels).                                                                                                      |
| pm42  | Release path `DRAFT → TESTING → ACTIVE` (+ `TESTING → DRAFT`); activation supersedes prior ACTIVE.                                                          |
| pm43  | Withdrawal path — stop selling and retire.                                                                                                                  |
| pm44  | Discard — hard delete of a never-released version.                                                                                                          |
| pm45  | Ship gate (Part 3) — guardrails, authz matrix, docs.                                                                                                        |
| pm46  | Price table reshape — `component_type` + `price_component` envelope; uniqueness rekey.                                                                      |
| pm46a | Flat-fee lane key — `0049` `NULLS NOT DISTINCT` index keyed on `priceType`; `lead()` + bill-run resolver rekeyed. Resolved PM-ISS-003; guardrail 41 (PM-ISS-004). |
| pm47  | Component envelope — Zod discriminated union, domain types, `plaSpec` catalog.                                                                              |
| pm48  | Seeds emit envelopes (four-component demo offering).                                                                                                        |
| pm49  | Component write path — repository, services, actions, cross-row validator.                                                                                  |
| pm50  | Ordering override-target re-key (G-G).                                                                                                                      |
| pm51  | Rating price-resolution window re-key (`rp.py`, G-G).                                                                                                       |
| pm52  | Bill-run recurring resolver re-key (G-G).                                                                                                                   |
| pm53  | `PricingComponentBadge` + View Product prices panel.                                                                                                        |
| pm54  | Authoring picker + component error banner.                                                                                                                  |
| pm55  | Capacity components authoring (motivation steps editor).                                                                                                    |
| pm56  | Ship gate (Part 4) — guardrails 31–34.                                                                                                                      |
| pm56a | Fixture sweep + guardrail-31 scope correction; resolved PM-ISS-001.                                                                                         |
| pm56b | Ordering-wizard `PriceCard` re-key — last residue closed.                                                                                                   |
| pm57  | Superseded by pm57a (v1 card schema, reversed 2026-09-27).                                                                                                  |
| pm57a | Card schema — `0041` rewritten in place (row key `(version_id, mno, commercial_unit, polygon_id)`); `0043` `ratecard` permission.                          |
| pm58  | Upload contract validation — Zod `ratecard.schema.ts`, closed violation set. Pure.                                                                          |
| pm59  | CSV parser `parse-csv.ts` (sole `csv-parse/sync` importer) + `file_checksum`.                                                                               |
| pm60  | Card repository `db/repositories/ratecard.ts` — no row-level update/delete (Inv. #46); guardrail 37.                                                       |
| pm61  | Upload service + action; `RATECARD_VERSION_UPLOADED`; replace-open-draft; `CONCURRENT_UPLOAD_CONFLICT`.                                                     |
| pm62  | Diff `diffAgainstActive` — read-only, two-query budget.                                                                                                     |
| pm63  | Activate — `RATECARD_VERSION_ACTIVATED`; locked read; demote-then-promote.                                                                                  |
| pm64  | Rollback — `RATECARD_VERSION_ROLLED_BACK`; status-flip only; `CONCURRENT_ACTIVATION_CONFLICT`; `PRODUCT_ACTION_FILES` closed at 17.                         |
| pm65  | Rate Card page + read UI, nav entry, four authz rows, guardrail 40.                                                                                         |
| pm66  | Write UI (upload/activate/rollback dialogs, diff panel); `bodySizeLimit` 5mb.                                                                               |
| pm67  | Demo seed — one `RAN_USAGE` card (v1 SUPERSEDED → v2 ACTIVE) via the real services.                                                                         |
| pm68  | Ship gate (Part 5) — guardrail re-scoping, §8 sweep, doc amendments, Appendix A reconciliation, hand-off register. **COMPLETE.**                            |

## Delivered ledger — Phases 1–3 (pm01–pm34, in `main`)

| Unit | Delivered (compact)                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| pm01 | Route-group rename `(admin)` → `(app)`; route-manifest guardrail.                                                         |
| pm02 | `product` schema (3 tables, enum, sequences), permission wiring, validation, seeds; `0007` FK/CHECK follow-up.           |
| pm03 | Read backend — finder-only repositories, `listOfferings`/`getOfferingDetail`; `0008`.                                     |
| pm04 | Sectioned `NAV_SECTIONS` + "Products" section.                                                                            |
| pm05 | View Product page shell — guard, `LifecycleBadge`, `OfferingTable`, three-seam detail region.                             |
| pm06 | `OfferingDetail` (Details seam).                                                                                          |
| pm07 | `SpecificationsPanel` (Specifications seam).                                                                              |
| pm08 | `formatCurrency`, `PriceTypeBadge`, `PricesPanel` (Prices seam).                                                          |
| pm09 | Phase-1 ship gate — authz matrix + module-boundaries guardrail; `product` grant block fix.                                |
| pm10 | `family_offering_id` self-reference + index + CHECK (`0010`).                                                             |
| pm11 | `insertOffering` + `createOffering` (+ `_CREATED` audit).                                                                 |
| pm12 | `branchOfferingAsDraft` copy-on-write primitive.                                                                          |
| pm13 | `updateOffering` four-way routing (DRAFT in place / branch / reject).                                                     |
| pm14 | Specification CRUD services (branch-first); TOCTOU fix.                                                                   |
| pm15 | `insertPrice` (insert-only, Inv. #1) + 3-day backdating tolerance; TOCTOU fix.                                            |
| pm16 | Lifecycle backend — activate/retire/discard, family lock, advisory-lock branch serialization.                             |
| pm17 | Nav — "View Product" + "Manage Products".                                                                                 |
| pm18 | Manage Products page shell with row-action seams.                                                                         |
| pm19 | Create Offering UI + action.                                                                                              |
| pm20 | Edit Offering UI + action; TOCTOU fix.                                                                                    |
| pm21 | Specification management UI + actions.                                                                                    |
| pm22 | Add Price UI + action (tier editor, backdating warning).                                                                  |
| pm23 | Activate / Retire / Discard UI + actions.                                                                                 |
| pm24 | Phase-2 ship gate — guardrail rewrite, authz split, backfilled integration tests.                                         |
| pm25 | `ordering` / `inventory` schemas (`0022`/`0023`), permissions, validation, seeds, grants.                                 |
| pm26 | Ordering/inventory repositories (insert-only) + orders read services.                                                     |
| pm27 | Orders/Subscriptions nav + Orders page (read).                                                                            |
| pm28 | Order submission backend (full-rollback deviation flagged).                                                               |
| pm29 | New Order wizard UI + action.                                                                                             |
| pm30 | Approval backend — MANAGER ≠ submitter, races tested 4×.                                                                  |
| pm31 | Review UI + approve/reject actions.                                                                                       |
| pm32 | Subscription lifecycle backend (history keyed on sequence id).                                                            |
| pm33 | Subscriptions page + lifecycle UI.                                                                                        |
| pm34 | Phase-3 ship gate — authz matrix, guardrails 15–22, doc sync.                                                             |
