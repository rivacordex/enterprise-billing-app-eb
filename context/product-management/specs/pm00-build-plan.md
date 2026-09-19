# Product Module — Build Plan (pm00)

Dependency-ordered build units for the Product Management module. Governing docs: `prodmgmt-project-overview.md` (shipped catalog + Ordering & Inventory update), `prodmgmt-update-overview.md` (the Manage Products rebuild & catalog lifecycle update), `prodmgmt-architecture.md` (module invariants #1–29), `prodmgmt-code-standards.md`, `prodmgmt-ai-workflow-rules.md`. Decisions: `_newmodule-product-module-plan.md` + `_change-product-crud-plan.md` (catalog), **Q1–Q20** in `_updatemodule-product-ordering-inventory-plan.md`, **D1–D13** in `_updatemodule-product-manage-page-refactor-plan.md`.

Stack (inherited unchanged, `architecture.md` §1 + `prodmgmt-architecture.md` §1): Next.js ≥ 15 App Router with RSC on Node ≥ 22, TypeScript strict; Server Actions over a framework-agnostic `services/` layer, no Route Handlers in this module, ever; Azure PostgreSQL 17 via Drizzle ORM, `product` schema, JSONB guarded by Zod; Better-Auth sessions with app-layer RBAC (`products` READ/EDIT/DELETE), no RLS; Azure Container Apps + Azure DevOps; no cache tier, no CDN, no background jobs. Part 3 adds **no stack component, no table, no permission, no npm dependency and no DB extension**.

Unit rules applied: one visible result per unit · one system boundary per unit · dependencies just-in-time · always-together work merged · no unit without a standalone visible result.

Numbering continues from pm34 (delivered units are never renumbered); this overwrite of pm00 is the explicit user instruction `prodmgmt-ai-workflow-rules.md` §2 requires for continuing the pm sequence. Part 3's units supersede the coarse U1–U5 grouping in the plan document — the mapping is in §Sequencing notes.

---

## Part 1 — Delivered baseline (pm01–pm24)

Catalog phases 1–2, shipped and ship-gate-verified. Unit-by-unit history in `prodmgmt-completed-tracker.md`; per-unit specs in this folder. Retained for dependency reference.

| # | Unit | Visible result | Depends on |
|---|---|---|---|
| pm01 | Route-group rename `(admin)` → `(app)` | All Administration URLs byte-identical; rename-invariance CI proof | — |
| pm02 | Product data layer (schema + validation + seeds) | Seeded catalog queryable; bad seeds provably fail | pm01 |
| pm03 | Read backend (repositories + `services/product`) | List/detail unit tests green; derived effectivity proven | pm02 |
| pm04 | Nav refactor `NAV_ITEMS` → `NAV_SECTIONS` | "Products" section renders | pm01 |
| pm05–pm08 | View Product page (table → detail → specs → prices) | Four-section read-only page, deep-linkable | pm02–pm04 |
| pm09 | Authz matrix + guardrail sweep (v1 ship gate) | CI green, 7 guardrails | pm01–pm08 |
| pm10 | `family_offering_id` schema addition | Version-lineage column + index migrated | pm02 |
| pm11–pm16 | CRUD backend (create/update/branch/spec/price/lifecycle services) | Write services tested incl. concurrency | pm10 |
| pm17 | Nav relabel + "Manage Products" entry | Two Products nav items | pm04 |
| pm18 | Manage Products page shell | Family-grouped table with inert action seams | pm03, pm17 |
| pm19–pm23 | CRUD UI + actions | Each mutation usable end-to-end | pm11–pm16, pm18 |
| pm24 | Phase-2 ship gate (guardrails 8–14) | Full CI gate suite green | pm10–pm23 |

---

## Part 2 — Ordering & Inventory update (pm25–pm34)

Shipped. Orders and Subscriptions pages, `ordering`/`inventory` schemas, `product_orders`/`product_inventory` permissions, zero changes to the `product` schema. Full unit text in each `pm25-spec.md` … `pm34-spec.md`.

| # | Unit | Visible result | Depends on |
|---|---|---|---|
| pm25 | Ordering & inventory data layer | Seeded order → subscription story queryable; bad seeds fail at the DB | pm02, pm10, accounts ac02/ac03, customer module |
| pm26 | Repositories + orders read services | List/detail tests green; insert-only surfaces structurally asserted | pm25 |
| pm27 | Nav + Orders page (read surface) | Orders list renders with badges; no-grant → `/no-access` | pm26 |
| pm28 | Order submission backend | Standard order creates order + subscription atomically; each rejection fires server-side | pm26 |
| pm29 | New Order wizard UI + action | RevOps places a real order end-to-end | pm27, pm28 |
| pm30 | Approval backend | Approve/reject race serializes; self-review refused; full re-validation under locks | pm28 |
| pm31 | Review UI + actions | Manager approves or rejects a `PENDING` order in the UI | pm29, pm30 |
| pm32 | Subscription lifecycle backend + read services | Suspend/resume/terminate tested; history gap-free | pm26 |
| pm33 | Subscriptions page + lifecycle UI | Subscriptions list with history sub-rows and lifecycle dialogs | pm31, pm32 |
| pm34 | Update ship gate (guardrails 15–22) | CI green; both new routes in the authz matrix | pm25–pm33 |

---

## Part 3 — Manage Products rebuild & catalog lifecycle (pm35–pm45)

Rebuilds Manage Products into the four-section shape, extends the lifecycle to `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`, makes DRAFT content editable, and completes the price fields the bill run reads. Spec: `prodmgmt-update-overview.md`. Decisions: D1–D13. Verification items V1–V10 and open items O1–O3 live in the plan.

### Gates — both clear before pm35 starts

**G1 — Invariant amendments approved.** `architecture.md` §7 Inv. #18 and `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17 each need the documented design review their Status lines require. No schema, repository write or service for Part 3 is built until the user records that approval.

**G2 — `'RETIRED'` literal audit complete (V5).** Every comparison against `'RETIRED'` outside `db/schema/product.ts` — `services/**`, `db/repositories/**`, `components/**`, `tests/**`, and the flow SQL under `workflow-management/**` — enumerated with a decision per site. The value's meaning changes in this update; app-code fixes land in pm37, workflow findings are reported, not edited.

### Gate status — both closed (2026-09-19)

**G1 — APPROVED (Khek, 2026-09-19).** The five invariant amendments (`architecture.md` Inv. #18; `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17) are approved for Part 3. Schema/repository/service work may proceed.

**G2 — COMPLETE (2026-09-19).** Repo-wide `'RETIRED'` sweep run; decision per site:

- **Flow SQL / billing layer — SAFE, no change.** `workflow-management/**` has **zero** `lifecycle_status`/`RETIRED`/`OBSOLETE` references; the bill-run and distribution flows read the pinned offering version via `product_inventory` regardless of status (Inv. #17), and their only `status = 'ACTIVE'` filters are on subscription status (`product_inventory.status`), not offering lifecycle. This confirms success criterion 12 — nothing outside the product module treats `OBSOLETE` as unbillable. The ordering gate `actions/accounts/new-order-wizard-reads.ts` (`lifecycleStatus !== 'ACTIVE'`) is correct as-is: only `ACTIVE` is orderable, so `OBSOLETE`/`RETIRED` are excluded by construction.
- **Product module — changes owned by the later units (per "app-code fixes land in pm37+"):**
  - Default list filter `db/repositories/product-offering.ts` (`ne(lifecycleStatus, 'RETIRED')`) → hide `OBSOLETE` **and** `RETIRED` → **pm37/pm39**.
  - Edit-guard services (`update-offering`, `add`/`update`/`delete-specification`, `insert-price`) use `=== 'RETIRED'`, which now wrongly lets `TESTING`/`OBSOLETE` through → make DRAFT-only (TESTING→return-to-draft; OBSOLETE/RETIRED refuse) → **pm38/pm41/pm42**.
  - `services/product/activate-offering.ts` sets the superseded sibling to `RETIRED` → must set `OBSOLETE` (grandfathering, guardrail 16) → **pm42**.
  - `services/product/retire-offering.ts` (guard + set `RETIRED`, currently backing both retire and discard) → OBSOLETE→RETIRED behind the subscription gate → **pm43**; the discard path → hard delete → **pm44**.
  - `types/product.ts` `LIFECYCLE_STATUSES` is still 3-value (DB enum is now 5; TS temporarily narrower); `lifecycle-badge.tsx`, `offering-table.tsx`/`offering-detail.tsx` display → widen union + add `TESTING`/`OBSOLETE` badges/muting → **pm37**.
  - `manage-products/page.tsx` (`fetchAllForStatus('RETIRED')` + `find ACTIVE`), `manage-offering-table.tsx`, `specifications-dialog.tsx`, `add-price-dialog.tsx` → rewritten/retired by **pm39–pm41**; `retire-offering-dialog.tsx` re-purposed by **pm43**.
  - Product-lifecycle tests (product-repositories, ordering-read, subscription-lifecycle, ship-gate-guardrails, offering-table, manage-offering-table, lifecycle-badge, create-order, retire-offering-dialog, list-offerings) → updated with their owning units (overlaps the recurring/usage fixture rework flagged in the pm35 code review).
- **Unrelated `'RETIRED'` (different domains) — no action:** `core.system_config` status enum (`db/schema/system-config.ts`, its repository/components/types/tests); accounts `ALREADY_RETIRED`/`CYCLE_RETIRED` (bill-cycle / GL / reason-code services + components); rating `RETIRED_PROBE`/`LEGACY_RETIRED` event-code test strings; the bm33 placeholder-mode retirement guardrail; frozen drizzle snapshots (`meta/*.json`, stale by D2).

**No pm35 code change results from G2** — the enum reorder is order-safe (no code does ordinal `<`/`>`/`ORDER BY` on `lifecycle_status`), and every product-lifecycle `'RETIRED'` fix belongs to pm37–pm44.

### Units

| # | Unit | Builds | Visible result | Depends on |
|---|---|---|---|---|
| **pm35** | **Catalog schema target state** | Edits `0006_product.sql` in place (D11, the one authorised exception): five-value `lifecycle_status` enum; per-`price_type` CHECKs (`recurring` ⇒ charge period, `usage` ⇒ unit of measure, `once` ⇒ neither); `unit_of_measure IN ('Mbps','GB','MB','EA')`; `recurring_charge_period_type` value list; cascade FKs from `product_specifications` and `product_offering_price` to `product_offering`. Keeps `db/schema/product.ts` in sync **by hand** — no `drizzle-kit generate`; snapshots stop at `0026`, so the `0006` snapshot and `meta/_journal.json` are left untouched and stale (D2). Re-baselines guardrail 13, and reworks `db/seeds/sample/seed-billrun-sample.ts` (D6): the `_SAMPLE_` offering is inserted `DRAFT` → priced → promoted to `ACTIVE` in one idempotent transaction (ahead of pm36's DRAFT-guard trigger), and its teardown deletes the offering row only, letting the new cascade remove the children. `db/seeds/demo/product-demo.ts` is already compliant (recurring carries `1`/`months`, usage carries a unit, `once` carries neither) and `db/seeds/product.ts` holds only the ADMIN grant — neither is edited. Seeds still merge into this unit because a non-compliant seed would break the moment the CHECKs land. | `npm run db:migrate` + `db:seed-demo` on an empty database produce the target schema and a loading catalog; a seed missing a charge period or unit provably fails at the DB; guardrail 13 green against the new baseline. | G1, G2 |
| **pm36** | **Family uniqueness + DRAFT guard (DDL)** | Forward migration adding the two expression unique indexes — `product_offering_one_active_per_family` and `product_offering_one_open_per_family` on `COALESCE(family_offering_id, product_offering_id)` — and the `BEFORE INSERT OR UPDATE OR DELETE` trigger on both child tables rejecting any parent whose status is not `DRAFT`, written so it does not block pm35's cascade. | Direct SQL proves it: a second `ACTIVE` row and a second open row in one family are rejected for a family root and for a branch; a price update against a non-`DRAFT` parent is rejected; deleting a DRAFT parent still cascades. | pm35 |
| **pm37** | **Domain types, total maps, badges** | `LifecycleStatus` widened to five members in lifecycle order; `UnitOfMeasure` and `RecurringPeriodType` unions; every union-keyed map converted to a total `Record` (badge variant, label, allowed actions, sort weight); `LifecycleBadge` gains `TESTING` (info tint, `flask-conical`) and `OBSOLETE` (neutral-600, `history`, muted row); View Product's default server-side filter hides `OBSOLETE` and `RETIRED`; the G2 audit's app-code fixes applied. | View Product renders the five badges and offers the five filter values; `tsc` proves no non-exhaustive map remains. | pm35, G2 |
| **pm38** | **Price completeness + DRAFT-only price mutation** | One vertical slice: the discriminated price-input schema (period fields on `recurring`, unit on `usage`, neither on `once`) shared by insert and update; `updatePrice` and `deletePrice` on the price repository, both refusing a parent that is not `DRAFT` re-read under `FOR UPDATE`; `update-price` / `delete-price` services and actions with the backdating check; `PriceForm` gains the charge-period and unit fields plus the unbillable-shape warning. | In the existing Add/Edit price dialog a user sets a monthly recurring price and a `GB` usage price; editing and deleting a DRAFT price works; the same calls against a `TESTING` or `ACTIVE` version are refused by the service and by the trigger. | pm36, pm37 |
| **pm39** | **Families list (read model + page rewrite)** | `findFamilyPage` (grouped, filtered, server-paged in SQL) and `listFamilies`; `manage-products/page.tsx` rewritten to render one row per family from that one query; `FamilyTable`; deletion of `fetchAllForStatus`, `fetchAllOfferingRows`, `fetchSpecificationsByOfferingId`, `mapWithConcurrencyLimit`, `groupIntoFamilies`, `MAX_COMBINED_ROWS`, `OfferingFamilyRow`, `selectPrimary`, `resolveFamilyId`; `loading.tsx` reduced to the table skeleton. | Manage Products loads one row per family with search, status filter and paging, issuing exactly one list query plus its count and no per-row detail query — the query-count assertion is this unit's proof. | pm37 |
| **pm40** | **Version bar + read-only panels** | `findFamilyVersions` + `listFamilyVersions`; `?family=&version=` searchParams schema and parsing with the documented fallbacks; `VersionBar`; the detail, specifications and pricing panels on Manage Products, importing View Product's read-only presentational components (Inv. #29). | Selecting a family shows its versions and the selected version's specs and prices **on Manage Products** — the update's primary pain point closed; deep links reproduce the view. | pm39 |
| **pm41** | **Inline editing of a DRAFT** | `ManageSpecificationsPanel` and `ManagePricesPanel` editable variants (value-as-text → input with explicit Save/Cancel, read-only variant on every other status); add/edit/delete spec rows; add/edit/delete price rows wired to pm38's actions; retirement of `SpecificationsDialog` and `AddPriceDialog`. | A user edits a spec and a price in place on a DRAFT version and sees the panel update; the same version at `TESTING` renders read-only with no disabled controls. | pm38, pm40 |
| **pm42** | **Release path** | `submitForTesting` (moves today's activation preconditions — ≥ 1 price, ≥ 1 spec, every mandatory spec resolved — to this step), `returnToDraft`, and `activateOffering` reworked to supersede the family's previous `ACTIVE` version to `OBSOLETE` in the same transaction; their actions; `SubmitForTestingDialog` and the revised `ActivateOfferingDialog`; three new audit event types with their `AUDIT_EVENT_CATEGORY_MAP` entries and the `audit-log-filters.test.tsx` count fix. | A draft is submitted for testing, returned to draft, and activated; the family's previously live version shows `OBSOLETE` and its subscriptions keep billing unchanged. | pm36, pm40 |
| **pm43** | **Withdrawal path** | `obsoleteOffering` (`ACTIVE` → `OBSOLETE`, stop selling with no replacement); `retireOffering` rewritten as `OBSOLETE` → `RETIRED` behind the subscription gate, reading `productInventoryRepository.countLiveForOfferingForUpdate` inside its transaction (the only new inventory-side code in Part 3); `ObsoleteOfferingDialog` and the re-purposed `RetireOfferingDialog` with its blocked state; two audit event types. | Stop selling moves a live version to `OBSOLETE`; retiring is refused while subscriptions still bill from it, showing the live count, and succeeds once they end. | pm42 |
| **pm44** | **Discard — hard delete** | `deleteOffering`: re-reads status under lock, refuses anything that was ever `ACTIVE`, deletes children then the row in one transaction, writes `PRODUCT_OFFERING_DELETED` carrying the version id, name, version number and removed counts; `DeleteVersionDialog`; removal of the discard-sets-`RETIRED` path and the `PRODUCT_OFFERING_DISCARDED` event. | Discarding a DRAFT or TESTING version removes it with its specs and prices, leaves siblings untouched, and leaves one audit record; discard is absent for every other status. | pm36, pm42 |
| **pm45** | **Ship gate** | Guardrails 23–30 (transition set, DRAFT-only child writes, family uniqueness, hard delete, price completeness, retirement gate, query budget, status-literal sweep); re-scoped guardrails 2, 8, 11, 13, 16; authz-matrix rows for the five new actions including the EDIT-vs-DELETE split; the §9 doc amendments landed; `prodmgmt-code-standards.md` and `prodmgmt-ai-workflow-rules.md` Appendix A rows cleared; V1–V10 evidence recorded. | Full CI suite green on a database built from scratch; Orders, Subscriptions and every Administration route unchanged; no doc still describes a rule the code no longer follows. | pm35–pm44 |

---

## Dependency graph (Part 3)

```
G1 (invariant amendments) ─┐
G2 (RETIRED literal audit) ─┴─► pm35 (schema + seeds) ──► pm36 (indexes + trigger) ──┬──► pm38 (price completeness + DRAFT price writes) ──┐
                                      │                                              │                                                     │
                                      └──► pm37 (types + badges) ──► pm39 (families list) ──► pm40 (version bar + panels) ──► pm41 (inline editing)
                                                                                      │                                     │
                                                                                      └──► pm42 (release path) ──► pm43 (withdrawal path)
                                                                                                    │
                                                                                                    └──► pm44 (discard) ──► pm45 (ship gate)
```

pm37 depends on pm35 for the enum values it types, and on G2 for the literal fixes it applies. pm41 needs pm38's actions and pm40's panels. pm45 needs everything.

---

## Sequencing notes (Part 3)

**Mapping to the plan's U1–U5.** U1 → pm35 + pm36. U2 → pm38 (price writes) + pm42, pm43, pm44 (transitions). U3 → merged into pm38, where the schema has a caller. U4 → pm39, pm40, pm41. U5 → pm45. The plan's five buckets are correct in dependency order but two of them span three boundaries each; this list is the buildable form.

**Validation is not its own unit.** A Zod schema has no standalone visible result. The price-input schema lands in pm38 with the repository write, service, action and form field that make it demonstrable — the same reasoning that merged migrations and Zod into pm02 and pm25.

**Seeds merge into pm35, not into a later unit.** The new CHECKs make every existing seed row invalid the moment they land. Splitting them would leave the tree red between units, which the general workflow rules forbid outright.

**pm36 is separate from pm35 despite both being DDL.** pm35 is the edit-in-place exception with snapshot and guardrail-baseline work; pm36 is new forward DDL whose proof is concurrency behaviour under direct SQL. They have different risks and different evidence, and pm36's trigger must be written against pm35's cascade, not alongside it.

**pm39 before pm40 is the performance fix before the feature.** The page's cost problem is the fan-out, not the panels. Landing the paged families list first means the query-count assertion is made against a page that has no panels to blame, and pm40 then adds exactly three queries on selection.

**Backend and UI split per transition family, not per action** — pm42 release, pm43 withdrawal, pm44 discard. Each family shares preconditions, dialogs and audit wiring, and each is one demonstrable behaviour. Splitting finer produces units whose only visible result is a passing service test; merging further hides the subscription gate inside a UI diff.

**pm43 owns the only cross-module reach in Part 3.** The locked live-subscription finder on `product_inventory` is added there and nowhere else. A unit that finds itself editing `ordering/**` or `inventory/**` beyond that one read-only finder is out of bounds and must stop.

**O1 blocks pm35's CHECK, not the whole unit.** If the bm29 charge-period mapping is still unconfirmed when pm35 starts, build everything else and leave `product_offering_price_period_type_check` for a same-unit follow-up commit — do not guess the accepted combinations.

---

## Explicitly not units in Part 3

- **A `TESTING` workflow.** The status is created, rendered, and reversible; what testing *does* is a later phase.
- **Per-unit, tiered or block rating; tiered recurring support in bm29.** Rating-side work, hand-offs H1–H3.
- **Unit normalisation between the catalog and the rating feed**, including making rm07's profile emit `Mbps`.
- **A relabelling migration, backfill or data-fix script.** D11's fresh-install assumption removes the need; writing one anyway reintroduces an invariant violation.
- **A permission split or any new permission.** The five new actions use the existing `products : EDIT` / `DELETE`.
- **A `policy` column implementation, bundles, tier child tables, or a TMF620 API.**
- **Nav changes.** Both product pages already exist in `NAV_REGISTRY`; this update adds no route.
