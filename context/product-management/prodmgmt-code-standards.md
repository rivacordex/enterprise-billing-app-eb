# Product Management — Module Code Standards

> Module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Product Management specifics; everything else — TypeScript strictness, the Server Action shape, styling tokens, API-route policy, file placement, CI gates — is inherited unchanged from the general file and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `prodmgmt-project-overview.md` and `prodmgmt-update-overview.md` (product spec) and `prodmgmt-architecture.md` (technical design, numbered **Module Invariants**). Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

> **Status:** covers all four catalog and ordering surfaces — View Product, Manage Products, Orders, Subscriptions. Every rule below is written as the standard **in force for the module's target state**, which includes the Manage Products rebuild & catalog lifecycle update (`_updatemodule-product-manage-page-refactor-plan.md`, decisions D1–D13). That update is planned, not yet in `main`: where the shipped code still follows an older rule, **Appendix A** lists the superseded wording and the code comments, tests and files that still assert it. Rules are stated once, in the present tense; the history lives only in Appendix A.

---

## 1. General Rules (module-specific)

1. **Writes flow exclusively through the mutation stack.** Every production code path that mutates `product.*` goes through `actions/product/**` → `services/product/**` → repositories, gated by `products : EDIT`/`DELETE`. No `app/api/product*` route exists, or ever will.
2. **Price rows are immutable once their version leaves DRAFT — enforced in code shape, not discipline.** The price repository exports exactly three writes: `insertPrice`, `updatePrice`, `deletePrice`. The latter two take the parent offering id and refuse unless its `lifecycle_status` is `DRAFT`, re-read under `FOR UPDATE` in the same transaction. No fourth write is ever added.
3. **View Product reads are not audited.** Every Manage Products mutation writes exactly one audit event inside the same transaction as the data change.
4. **The audit log is never a pricing/rating source** (Inv. #7). Historical price state is reconstructed from price rows + `start_date_time`. The single thing that lives only in the audit log is a hard-deleted DRAFT — content that was never billable.
5. **Schema changes are additive, with two disclosed exceptions:** `family_offering_id` (a genuinely new column) and the in-place edit of `0006_product.sql` under decision D11 (§6.14). Both are reviewed and accepted, not defects. Note that widening `LifecycleStatus` to five members is a breaking change for every exhaustive switch over it (§2.2) — that is intended and must not be softened with a `default` branch.
6. **The `(admin)` → `(app)` route-group rename changed no URL** (Inv. #12).
7. **Seeds obey the same validation as every other write.** Seed scripts pass `pricing_characteristics` through the per-`pricing_model` Zod schema and satisfy the per-`price_type` completeness rules (§6.5). A seed that omits a recurring charge period or a usage unit must fail — in `db/seeds/product.ts`, `db/seeds/demo/product-demo.ts` and `db/seeds/sample/**` alike.
8. **Template seed rows keep the `TOREMOVE-Template-` name prefix.** No production code depends on them existing.
9. **`is_bundle` is never user-editable, in any form, ever.** No `isBundle` field in any schema; `insertOffering` hardcodes `false`; `branchOfferingAsDraft` copies the source value through.
10. **Editing a released version never mutates it in place.** An edit targeting an `ACTIVE` version routes through `branchOfferingAsDraft` first. A `TESTING` version is not branched — it is returned to `DRAFT` and edited directly. `OBSOLETE` and `RETIRED` versions have no edit path at all: the UI offers none and the services refuse.
11. **Discard is a delete; withdrawal is a status change; they are three separate services.** `deleteOffering` hard-deletes a `DRAFT` or `TESTING` version that was never `ACTIVE`; `obsoleteOffering` moves `ACTIVE` → `OBSOLETE`; `retireOffering` moves `OBSOLETE` → `RETIRED` behind the subscription gate. Do not merge them: they differ in precondition, in audit event, and in whether rows survive.
12. **Backdating tolerance is a service-layer check, not a DB constraint.** `insertPrice` and `updatePrice` reject a `start_date_time` more than 3 days before the transaction's `now()` and flag anything backdated within the window; the Zod copy is a fast-fail only.
13. **Every status read that gates a branch-or-write decision happens inside the transaction, immediately before the decision.** A pre-transaction read is a TOCTOU window. This covers `updateOffering`, the three specification writes, `insertPrice`, `updatePrice`, `deletePrice`, `submitForTesting`, `returnToDraft`, `activateOffering`, `obsoleteOffering`, `retireOffering` and `deleteOffering`.
14. **Cross-module transactional reads never call another module's service.** A display or form read calls the other module's `services/*` function normally; an in-transaction precondition re-check calls that module's repository's locked (`FOR UPDATE`) finder directly. The retirement gate follows this rule: `retireOffering` calls `productInventoryRepository.countLiveForOfferingForUpdate(tx, offeringId)`, never `services/inventory/**`.
15. **One transition, one service, one audit event.** No generic `setLifecycleStatus(id, status)` helper exists in any layer, and no action takes a target status as a parameter. Each legal transition (Inv. #23) has its own service, preconditions and event type. A transition the state machine does not list has no code path.
16. **A list page never fans out to per-row detail.** A list renders from one paged query. Fetching per-row detail in a loop — `getOfferingDetail` per row, `Promise.all` over rows, or any concurrency-limited mapper over a row set — is prohibited in `app/**` and `services/product/**`. `fetchAllForStatus`, `fetchAllOfferingRows`, `fetchSpecificationsByOfferingId`, `mapWithConcurrencyLimit`, `groupIntoFamilies` and `MAX_COMBINED_ROWS` do not exist and are not to be reintroduced under other names.
17. **Grouping, filtering and paging happen in SQL, in the repository.** `findFamilyPage` returns rows the page renders as-is; a page never groups, slices or re-sorts a result set.
18. **The database is the backstop for every catalog rule that can be expressed there.** DRAFT-only child writes → trigger (§6.8); one open and one ACTIVE version per family → unique indexes (§6.7); price completeness per type → CHECK constraints (§6.5). The service-layer check stays in all three cases; the database is what holds when a direct SQL write or a future bug goes around it.
19. **A warning never blocks a save; a validation error never renders as a warning.** Unbillable-but-legal price shapes (tiered recurring, tiered usage) render the warning banner and save. A charge period outside the bill-run mapping, a unit outside the list, or a missing required field is a field-level error that refuses the save.
20. **Deleting is never offered for a version that was ever ACTIVE**, in the UI or in a service. The affordance is absent, not disabled-with-a-tooltip.

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions**, defined once as `as const` string-literal unions in `types/product.ts`:
   - `LifecycleStatus`: `'DRAFT' | 'TESTING' | 'ACTIVE' | 'OBSOLETE' | 'RETIRED'`. Declare the members in **lifecycle order**, not alphabetically — sort order in the UI derives from the array index, and nothing else may re-declare that order.
   - `PriceType`: `'recurring' | 'usage' | 'once'`
   - `PricingModel`: `'flat' | 'tiered'`
   - `UnitOfMeasure`: `'Mbps' | 'GB' | 'MB' | 'EA'` — **case-sensitive literals**. `'MBPS'`, `'mbps'` and `'Gb'` are not members and are not normalised on the way in.
   - `RecurringPeriodType`: `'months'` (single member pending plan open item O1). Adding a member requires a migration changing the CHECK **and** a confirmed mapping in the bill run's recurring resolver — never a TypeScript-only edit.
2. **Every map keyed by a domain union is a total `Record`.** `Record<LifecycleStatus, X>` for badge variants, labels, allowed actions and sort weight; `Record<PriceType, X>` for field requirements. Adding `TESTING`/`OBSOLETE` must break the build in every such map rather than fall through to a default. No `switch` over a domain union without an exhaustive `never` default.
3. **JSONB typing per general §6.17.** `ProductSpecCharacteristics` and `PricingCharacteristics` live in `validation/product/`; the Drizzle `.$type<T>()` types derive from them.
4. **`PricingCharacteristics` is a discriminated union on `pricing_model`** — `{ tiers: Tier[] }` with `Tier = { from: number; to: number | null; rate: string }`; contiguity comes from the Zod schema, not ad-hoc checks.
5. **Money per general §2.15.** `amount` and tier `rate` are `numeric` → `string`. No money arithmetic in this module.
6. **`end_date_time` exists only as a computed field** — `endDateTime: Date | null` on the read model. No stored end (Inv. #3).
7. **Entity IDs are plain `string`s validated by Zod format schemas** (`/^PRDOFR\d{8}$/` etc.). Both `?family=` and `?version=` are parsed against the offering-ID schema before any repository call.
8. **Price input types are discriminated by `priceType`.** The insert/update schema is a discriminated union: the `recurring` branch requires `recurringChargePeriodLength: number` + `recurringChargePeriodType: RecurringPeriodType` and forbids `unitOfMeasure`; the `usage` branch requires `unitOfMeasure: UnitOfMeasure` and forbids the period fields; the `once` branch forbids all three. Optional-and-nullable fields are not an acceptable substitute — the impossible combination must be untypeable, not merely rejected at runtime.
9. **Read models live in `types/` as composed shapes**, returned by services so pages never re-join:
   - `OfferingListRow`, `OfferingDetail`, `SpecificationCard`, `PriceCard` (with computed `endDateTime` and `effectivityStatus`) — unchanged.
   - `FamilyListRow` — `{ familyId, primaryVersionId, name, lifecycleStatus, version, versionCount, openVersionId: string | null, isSellable, billingOnly, lastModified }`, one row per family, built in SQL.
   - `FamilyPage` — `{ rows: FamilyListRow[]; total; page; pageSize }`, the same shape `OfferingListPage` already uses.
   - `VersionSummary` — `{ productOfferingId, version, lifecycleStatus, lastModified }` for the version bar.
   - `OfferingFamilyRow`, `selectPrimary` and `resolveFamilyId` (the page-local grouped shape) do not exist.
10. **Transition results are typed unions, never thrown errors** (general §2.9). Each transition service returns `{ ok: true; … }` or `{ ok: false; code: … }` with codes drawn from a single exported union per service — e.g. `RETIRE_BLOCKED_BY_SUBSCRIPTIONS` carries `liveCount: number` so the UI can state the number without a second query.
11. **`effectivityStatus` stays derived, `lifecycleStatus` stays stored.** Never add a derived "is billable" or "is orderable" column or field; both are functions of `lifecycleStatus` computed where they are needed, from the total `Record` in §2.2.

---

## 3. Next.js Rules (module-specific)

1. **Both catalog pages are thin RSC orchestrators.** `product-offering/page.tsx`: guard (READ) → await `searchParams` → parse → services → compose. `manage-products/page.tsx`: guard (EDIT) → await `searchParams` → parse `q`/`status`/`page`/`family`/`version` → `listFamilies` → compose the families table, and, when `family` is present, the version bar and the three panels. No fetch loop, no grouping, no DB access in the page.
2. **List and selection state lives in URL searchParams.** View Product: `q`, `status`, `sort`, `page`, `offering`. Manage Products: `q`, `status`, `page`, `family`, `version` — the same convention. No client-side store, no `useState` mirror of the URL.
3. **searchParams are parsed, never trusted.** Unknown or malformed values fall back to schema defaults. A `family` that matches no row renders the empty-selection state; a `version` that is not a member of that family is ignored and the family's primary version is selected instead — neither is a 404 and neither is an error boundary.
4. **Row selection is a `<Link>` that rewrites the searchParams**, preserving the others. This applies to Manage Products' family rows and version-bar entries too. No `onClick` + `router.push` + component state.
5. **Manage Products shows every lifecycle status**; View Product hides `RETIRED` by default, server-side. View Product's default filter hides `OBSOLETE` and `RETIRED`; the status filter can surface both.
6. **`'use client'` only at interaction leaves.** The families table, version bar, specification panel and price panel render as server components; the inline editors, the confirmation dialogs and the search box are the client leaves. A panel does not become a client component because one field inside it is editable — the editable field is its own leaf.
7. **Every `actions/product/*` file follows one shape**: `requirePermission` → `isRedirectError` catch → `schema.safeParse` → delegate to one write service → `revalidatePath` → typed `{ok, code}` result.
8. **Revalidate narrowly.** A mutation revalidates `/products/manage-products` and `/products/product-offering` as today, but the page must not re-fetch unselected families' details to satisfy it — §1.16 holds after a mutation exactly as it holds on first load. `router.refresh()` is no longer the success path; the action's `revalidatePath` is.
9. **Nav renders per the platform's permission-filtered registry**; each page guard enforces.
10. **Page metadata:** View Product's title and `H1` are "View Product"; Manage Products' are "Manage Products". Both segments ship `loading.tsx` and `error.tsx`. `manage-products/loading.tsx` renders the families-table skeleton only — not panel skeletons, which have nothing to load until a family is selected.
11. **`export const dynamic = 'force-dynamic'` stays on both pages** (authz-dependent data is never cached, general §3.8).

---

## 4. Styling (module-specific)

1. **Shared indicator components**, created exactly with these names: `LifecycleBadge`, `PriceTypeBadge`. `LifecycleBadge` covers all five statuses from a total `Record<LifecycleStatus, …>` (§2.2):

   | Status | Treatment | Icon |
   |---|---|---|
   | `DRAFT` | warning tint | `pencil-line` |
   | `TESTING` | info tint | `flask-conical` |
   | `ACTIVE` | success tint | `check-circle` |
   | `OBSOLETE` | neutral tint, row muted, still actionable (Retire) | `history` |
   | `RETIRED` | neutral tint, row muted, no actions | `archive` |

   Icon + label always; never colour-only meaning (`OBSOLETE` and `RETIRED` are both greyish by design — the icon disambiguates).
2. **JSONB entries render as plain text, not widgets** — spec characteristics as `key: value`, tiers as `from–to: rate`, semicolon-separated, open-ended top tier reading "and above". No `CharacteristicChip`, no `TierTable`.
3. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for the View Product table and the families table. Never fork a parallel table implementation.
4. **Four-section layout.** View Product: table, detail, then specs and prices side-by-side at `lg:`, stacking on narrow viewports. Manage Products uses the same grid with a version bar between the table and the panels, and stacks in the order table → version bar → detail → specifications → prices.
5. **Money formatting goes through `formatCurrency(amount, currency, locale)`.** No inline `toFixed`, no hardcoded symbols.
6. **Datetime display goes through `formatDatetime(date, locale, timezone, …)`** with the timezone threaded as a prop; `<time dateTime>` stays ISO-8601 UTC. Calendar dates (subscription `end_date` in the retirement message) use `formatCalendarDate`.
7. **Boolean flags** (`is_bundle`, `is_sellable`, billing-only) render through one shared yes/no indicator.
8. **Component names are binding**, created exactly as written: `FamilyTable`, `VersionBar`, `OfferingForm`, `SpecificationForm`, `ManageSpecificationsPanel`, `PriceForm`, `ManagePricesPanel`, `CreateOfferingDialog`, `SubmitForTestingDialog`, `ActivateOfferingDialog`, `ObsoleteOfferingDialog`, `RetireOfferingDialog` (OBSOLETE → RETIRED only), `DeleteVersionDialog`. There is no family-expand tree and no per-row action cluster.
9. **`--action-cta-bg` is used exactly once per view** — the "New offering" button in the Manage Products header. Version-level actions (Edit, Add price, Submit for testing, Activate) use the quiet secondary/ghost treatment; Obsolete, Retire and Delete use the danger role and only inside their confirmation dialogs.
10. **Version-level actions live in the selected version's header, not on every list row.** The families table carries navigation and status only; do not add row actions "for convenience".
11. **Inline editing affordances.** An editable panel row shows its value as text until activated, then an input with explicit Save and Cancel. No auto-save on blur, no optimistic row mutation — the server action's typed result is what updates the view. A panel on a non-`DRAFT` version renders the read-only variant with no disabled inputs.
12. **"This creates a new draft" warning** appears in the edit affordance whenever the selected version is `ACTIVE`, never on a `DRAFT` target. Warning tokens, no icon. Copy: *"`<Name>` is active. Saving will not change it — a new draft version is created instead."*
13. **Backdating warning** appears when a price start date is in the past but within the 3-day tolerance; beyond it, a standard `FieldError`.
14. **Unbillable-shape warning** reuses the same warning tokens: *"Nothing bills a tiered recurring price yet — this version will fail its bill run."* and *"Usage rating charges a flat amount today; tiers are stored but not applied."* Warning only (§1.19).
15. **Units and periods render with the numeric conventions already in use:** `--font-mono` for IDs and GL codes, `tabular-nums` for amounts, tier bounds, version numbers, charge-period lengths. A usage price shows `amount / unit` (e.g. `RM 0.05 / GB`); a recurring price shows `amount / period` (e.g. `RM 5,000.00 / month`) with the unit and period taken from the row, never inferred from the price type.
16. **Empty states** use `--text-muted` on `--surface-sunken`: no family selected, a family with one version (version bar renders the single entry, no affordance implying more), a DRAFT with no prices yet (with the "at least one price is required to submit for testing" hint).
17. **No AI/Iris-violet tokens and no marketing gradients on any product page** — unchanged module exclusion.

---

## 5. API Routes (module-specific)

1. **This module adds no Route Handlers, ever, in any phase** — including the Manage rebuild. `app/api/**` gains nothing from Product Management. Reads flow RSC page → `services/product` → repositories; writes flow through `actions/product/**`.
2. **A product Route Handler would require a platform design review first** (general §5.1 scope: auth provider, callbacks, M2M only).
3. **A PR adding any `app/api/product*` path is rejected at review**, and a guardrail test asserts the path's absence.

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `product` schema:** `product_offering`, `product_specifications`, `product_offering_price` — three, still three after the Manage rebuild. No identity/RBAC/session/config/audit tables.
2. **ID prefixes:** `PRDOFR`, `PRDSMD`, `PRDOFP`; one sequence per table; prefix + 8-digit zero-padded.
3. **The price table has no `end_date_time` and no `last_update` column** (Inv. #3). Effectivity end is derived at query time by the `lead()` window; never stored, cached or backfilled.
4. **Overlap prevention is a DB constraint** — UNIQUE (`product_offering_id`, `price_type`, `start_date_time`). A second price of the same type may only be **created** while the parent is `DRAFT`; the trigger in §6.8 is what enforces that, not the unique index.
5. **Price completeness is a CHECK constraint, mirrored in Zod**, one per rule, named so a violation is self-explaining (the four shipped by pm35 D4, in that order):
   - `product_offering_price_recurring_period_check` — `price_type = 'recurring'` ⇒ both `recurring_charge_period_length` and `recurring_charge_period_type` NOT NULL; otherwise both NULL. (The value bound on the length lives in `…_period_value_check`, not here.)
   - `product_offering_price_period_value_check` — `recurring_charge_period_type IS NULL`, or `recurring_charge_period_type = 'months' AND recurring_charge_period_length IN (1, 3, 12)`. Closed at months + (1, 3, 12); `'years'` is deliberately rejected (O1 resolved). Extend only with a confirmed bill-run mapping (§2.1).
   - `product_offering_price_usage_unit_check` — `price_type = 'usage'` ⇒ `unit_of_measure` NOT NULL; otherwise NULL.
   - `product_offering_price_unit_value_check` — `unit_of_measure IS NULL OR unit_of_measure IN ('Mbps','GB','MB','EA')`, exact case.
   The existing `amount` XOR tiers, `amount >= 0` and 3-character currency CHECKs are unchanged.
6. **`created_at` vs `start_date_time` stay distinct and both required.** Neither substitutes for the other in a query.
7. **Single-active and single-open per family are DB unique indexes on an expression**:
   - `product_offering_one_active_per_family` on `(COALESCE(family_offering_id, product_offering_id))` `WHERE lifecycle_status = 'ACTIVE'`
   - `product_offering_one_open_per_family` on the same expression `WHERE lifecycle_status IN ('DRAFT','TESTING')`
   `COALESCE` removes the NULL-root problem (a family root carries `family_offering_id IS NULL`, and NULLs do not collide in a plain partial index). The advisory lock and the in-transaction re-check in `activateOffering` **stay** — the index changes the failure mode, it does not replace the lock.
8. **Child writes require a `DRAFT` parent, enforced by a trigger**: `BEFORE INSERT OR UPDATE OR DELETE` on `product_specifications` and `product_offering_price`, rejecting any parent whose `lifecycle_status` is not `DRAFT`. The cascade in §6.9 must not be blocked by it — `deleteOffering` relies on parent-first cascade (the trigger exempts a child delete when the parent row is itself being deleted), the only path that works for a `TESTING` parent; deleting children first would be rejected because the parent is not `DRAFT`. Prove it in a test for both `DRAFT` and `TESTING`.
9. **Child FKs cascade on delete**: `product_specifications.ref_product_offering_id` and `product_offering_price.product_offering_id` are `ON DELETE cascade`. The self-referencing `family_offering_id` stays `restrict`.
10. **`version` is a row's sequence number within its family**, assigned once at insert, never changed (Inv. #8).
11. **`lifecycle_status` gates selection, not readability** (Inv. #6, #17): ordering filters `ACTIVE`; billing reads a pinned version whatever its status. A repository finder never filters out `OBSOLETE` or `RETIRED` rows on the caller's behalf — it exposes the status and lets the caller filter.
12. **JSONB writes are schema-guarded everywhere**, seeds included (Inv. #4).
13. **Tier storage stays JSONB.** The child-table migration remains the rating module's deferred decision; do not pre-build it.
14. **Migrations** *(D11 — this round only)*: `0006_product.sql` is edited in place for the five-value enum, the §6.5 CHECKs and the §6.9 cascades, on the stated assumption that no installation exists. Keep `db/schema/product.ts` in sync **by hand**; run no `drizzle-kit generate` (`db:generate`). Snapshots stop at `0026` in this repo — every migration from `0027` on is hand-written SQL with a hand-appended `meta/_journal.json` entry, and `drizzle-kit generate` is retired because it would emit one giant broken diff (`db/migrations/README.md`, `drizzle.config.ts`). The apply path never reads snapshots, so `meta/0006_snapshot.json` is left untouched and stale like every snapshot after `0026`, and `meta/_journal.json` is left byte-identical (the file is edited, not added). Other consequences that are part of the rule, not optional follow-up: guardrail 13 is re-baselined, and every environment rebuilds its database. **Never** write a migration that adds an enum value and uses it — the migrator runs all pending files in one transaction and Postgres rejects the use (`unsafe use of new value`); if the fresh-install assumption is withdrawn, the create-new-type-and-swap form is the only correct shape.
15. **The retirement gate is one repository predicate, written once**: a subscription counts as live when `status <> 'TERMINATED' OR (end_date IS NULL OR end_date >= current_date)`. It lives in `productInventoryRepository.countLiveForOfferingForUpdate` and is called by `retireOffering` inside its transaction. Do not re-express it in a service, a page or a test fixture.
16. **A hard delete's audit payload is the only surviving record**: `PRODUCT_OFFERING_DELETED.beforeData` carries the version id, name, `version`, `lifecycle_status`, and the counts of specifications and prices removed. Written in the same transaction as the delete.
17. **Reason text on a transition is captured in the audit payload (`transitionReason`), not a column.** This covers every transition in Inv. #23.

---

## 7. File Organization (module-specific)

Placement per general §7. The tree below shows the **catalog scope after the Manage rebuild**; `(new)` marks a file the rebuild adds, `(del)` one it removes. The Ordering & Inventory tree (`app/(app)/products/orders/`, `subscriptions/`, `actions/ordering/**`, `actions/inventory/**`, `components/products/ordering/**`, `components/products/inventory/**`, `services/ordering/**`, `services/inventory/**`, `db/schema/{ordering,inventory}.ts` and their repositories, validation and tests) is unchanged by this update and is not repeated here.

```
app/(app)/products/product-offering/
  page.tsx                            # ProductOfferingPage — guard (READ)
  loading.tsx, error.tsx
app/(app)/products/manage-products/
  page.tsx                            # ManageProductsPage — guard (EDIT); families + panels
  loading.tsx, error.tsx
actions/product/
  create-offering.action.ts
  update-offering.action.ts
  create-specification.action.ts
  update-specification.action.ts
  delete-specification.action.ts
  insert-price.action.ts
  update-price.action.ts              # (pm38)
  delete-price.action.ts              # (pm38)
  submit-for-testing.action.ts        # (pm42)
  return-to-draft.action.ts           # (pm42)
  activate-offering.action.ts
  obsolete-offering.action.ts         # (pm43)  ACTIVE → OBSOLETE
  retire-offering.action.ts           # (pm43)  re-purposed: OBSOLETE → RETIRED only
  delete-offering.action.ts           # (pm44)  hard delete of a never-released version
components/products/
  offering-table.tsx, offering-detail.tsx
  specifications-panel.tsx, prices-panel.tsx
  lifecycle-badge.tsx, price-type-badge.tsx
  price-effectivity.tsx                # (pm41)  shared effectivity tag + accent (read + edit)
components/products/manage/
  inline-row-editor.tsx               # (pm41)  shared Save/Cancel + keyboard shell
  family-table.tsx                    # (pm39)  FamilyTable
  version-bar.tsx                     # (pm40)  VersionBar
  manage-specifications-panel.tsx     # (pm41)  ManageSpecificationsPanel (server)
  manage-prices-panel.tsx             # (pm41)  ManagePricesPanel (server)
  editable-specifications.tsx         # (pm41)  DRAFT-only inline spec editor (client leaf)
  editable-prices.tsx                 # (pm41)  DRAFT-only inline price editor (client leaf)
  version-action-header.tsx           # (pm41)  offering Edit (DRAFT in-place / ACTIVE branch)
  manage-offering-table.tsx           # (removed pm39)
  # specifications-dialog.tsx, add-price-dialog.tsx  removed pm41 — the panels replace them
  offering-form.tsx, specification-form.tsx, price-form.tsx
  create-offering-dialog.tsx
  activate-offering-dialog.tsx
  submit-for-testing-dialog.tsx       # (pm42)
  obsolete-offering-dialog.tsx        # (pm43)
  retire-offering-dialog.tsx          # (pm43)  re-purposed (OBSOLETE → RETIRED)
  delete-version-dialog.tsx           # (pm44)
services/product/
  list-offerings.ts                   # View Product's list
  list-families.ts                    # (pm39)  Manage Products' list
  get-offering-detail.ts
  get-live-subscription-count.ts      # (pm43)  Retire blocked-state display read
  list-family-versions.ts             # (new)  version bar
  create-offering.ts, update-offering.ts
  add-specification.ts, update-specification.ts, delete-specification.ts
  insert-price.ts, update-price.ts    # update-price (pm38)
  delete-price.ts                     # (pm38)
  submit-for-testing.ts               # (pm42)
  return-to-draft.ts                  # (pm42)
  activate-offering.ts
  obsolete-offering.ts                # (pm43)
  retire-offering.ts                  # (pm43)  re-purposed + subscription gate
  delete-offering.ts                  # (pm44)
db/schema/product.ts                  # 3 tables; 5-value enum; new CHECKs; cascade FKs; 2 indexes
db/repositories/
  product-offering.ts                 # + findFamilyPage, findFamilyVersions, transition writes,
                                      #   deleteOffering
  product-specification.ts
  product-offering-price.ts           # insertPrice + updatePrice + deletePrice (pm38)
db/migrations/0006_product.sql        # edited in place (D11, §6.14)
db/migrations/…                       # trigger + indexes land with 0006's shape
db/seeds/product.ts, db/seeds/demo/product-demo.ts
validation/product/
  offering-list.schema.ts
  family-list.schema.ts               # (pm39)  q/status/page/family/version
  pricing-characteristics.schema.ts
  price-input.schema.ts               # (pm38)  discriminated by priceType; shared insert/update
  insert-price.schema.ts              # composes price-input + backdating (pm38)
  update-price.schema.ts              # (pm38)
  create-offering.schema.ts, update-offering.schema.ts
  create-specification.schema.ts, update-specification.schema.ts
  transition.schema.ts                # (pm42)  optional reason, shared by submit + return (activate keeps its own)
tests/…                               # mirrors source; authz matrix; guardrails (§9)
```

1. **The nav lives in the shared registry** (`lib/nav-registry.ts` + `components/nav-icons.ts`); no product-specific nav file.
2. **`services/product` stays framework-agnostic** — no `next/*` imports; parsed params in, §2.9 read models out.
3. **`app/(app)/products/product-offering/**` may only ever be touched for its nav label and page `H1`** beyond its original scope. Manage Products may **import from** `components/products/*` but nothing inside the View Product route folder is edited.
4. **One transition per file** — in `actions/product/` and `services/product/` alike. Do not collapse the five transition services into a state-machine module; the shared part (id + optional reason parsing) is the Zod schema, and that is the only thing they share.

---

## 8. Permission Names & Per-Page Permission Map

**Permission name:** `products` — single, page-level, code-seeded via migration; referenced as `PERMISSIONS.PRODUCTS`. READ gates View Product **including prices** (no pricing-visibility split, Inv. #10). EDIT gates authoring and release; DELETE gates removal and withdrawal. **The module has exactly one catalog permission**; every transition is distributed across its EDIT/DELETE split, and no transition gets a permission of its own.

Authoritative; mirrors architecture §4. Every page and every mutation appears here before it ships.

| Page / action | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| View Product — list + detail + specs + prices | `/products/product-offering` | `ProductOfferingPage` → `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel` | `app/(app)/products/product-offering/` | `products` : **READ** |
| Manage Products — families list, version bar, panels | `/products/manage-products` | `ManageProductsPage` → `FamilyTable`, `VersionBar`, `ManageSpecificationsPanel`, `ManagePricesPanel` | `app/(app)/products/manage-products/` | `products` : **EDIT** |
| — create offering / edit DRAFT / branch from ACTIVE | `/products/manage-products` | `CreateOfferingDialog`, `OfferingForm` | `actions/product/{create,update}-offering.action.ts` | `products` : **EDIT** |
| — add / update / delete a specification *(update, delete: DRAFT only)* | `/products/manage-products` | `ManageSpecificationsPanel`, `SpecificationForm` | `actions/product/*-specification.action.ts` | `products` : **EDIT** |
| — add / update / delete a price *(update, delete: DRAFT only)* | `/products/manage-products` | `ManagePricesPanel`, `PriceForm` | `actions/product/{insert,update,delete}-price.action.ts` | `products` : **EDIT** |
| — submit for testing / return to draft | `/products/manage-products` | `SubmitForTestingDialog`, `VersionBar` | `actions/product/{submit-for-testing,return-to-draft}.action.ts` | `products` : **EDIT** |
| — activate (TESTING → ACTIVE, supersedes to OBSOLETE) | `/products/manage-products` | `ActivateOfferingDialog` | `actions/product/activate-offering.action.ts` | `products` : **EDIT** |
| — stop selling (ACTIVE → OBSOLETE) | `/products/manage-products` | `ObsoleteOfferingDialog` | `actions/product/obsolete-offering.action.ts` | `products` : **DELETE** |
| — retire (OBSOLETE → RETIRED, subscription-gated) | `/products/manage-products` | `RetireOfferingDialog` | `actions/product/retire-offering.action.ts` | `products` : **DELETE** |
| — discard (hard delete a DRAFT/TESTING version) | `/products/manage-products` | `DeleteVersionDialog` | `actions/product/delete-offering.action.ts` | `products` : **DELETE** |
| Orders — list + New order + Review *(Ordering update)* | `/products/orders` | `OrdersPage` → `OrdersTable`, `NewOrderWizard`, `OrderReviewPanel` | `app/(app)/products/orders/`, `actions/ordering/` | `product_orders` : **READ** (list) / **EDIT** (create) |
| — approve / reject a `PENDING` order *(Ordering update)* | `/products/orders` | `ReviewActions` | `actions/ordering/{approve,reject}-order.action.ts` | `product_orders` : **EDIT** + **MANAGER role** + reviewer ≠ submitter |
| Subscriptions — list + lifecycle + characteristics *(Ordering update)* | `/products/subscriptions` | `SubscriptionsPage` → `SubscriptionsTable`, lifecycle dialogs | `app/(app)/products/subscriptions/`, `actions/inventory/` | `product_inventory` : **READ** (list) / **EDIT** (mutations) |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- A principal with `products : EDIT` but not `DELETE` reaches every authoring and release action and is refused `obsoleteOffering`, `retireOffering` and `deleteOffering` at the action guard — asserted in the authz matrix, both directions.
- Deep links grant nothing: `?offering=`, `?family=` and `?version=` all pass through their page's guard first.
- *(Ordering update)* `product_orders` / `product_inventory` carry no grant overlap with `products` in either direction, ship-gate-proven.

---

## 9. Module Guardrail Tests (CI gate §10.4)

Guardrails 1–22 are the shipped set (catalog 1–14, Ordering update 15–22) and stay in force as written, with the five re-scopings below. Guardrails 23–30 land with the Manage rebuild and map to the plan's verification items V1–V10.

**Re-scoped by the Manage rebuild**

| # | Change |
|---|---|
| 2 — Price immutability | Now asserts: a successor insert leaves prior rows byte-identical (unchanged); `updatePrice`/`deletePrice` exist, succeed on a `DRAFT` parent, and are refused for every other status — **and** a direct SQL update or delete against a non-`DRAFT` parent's price is rejected by the trigger. |
| 8 — Single-active-per-family | Keeps the two-concurrent-activations assertion; adds a direct-SQL insert of a second `ACTIVE` row being rejected by `product_offering_one_active_per_family`. |
| 11 — View stays read-only | Unchanged in direction: `components/products/*.tsx` (excluding `manage/`) and the View Product route import nothing from `actions/product/`, `components/products/manage/`, or a write service. The converse assertion is **dropped** — `manage/` importing View's read-only components is now correct (Inv. #29). |
| 13 — Schema-diff | Re-baselined to the post-rebuild shape: five-value enum, the §6.5 CHECKs, cascade child FKs, the two expression indexes and the trigger. Still an exact diff, not a removal. |
| 16 — Grandfathering | Asserts the superseded version is `OBSOLETE` (not `RETIRED`) and the pinned subscription's `OrderPriceLine`/rating reads resolve byte-identically from it. |

**New with the Manage rebuild**

23. **Lifecycle transition set** — every transition in Inv. #23 succeeds from its legal predecessor and every other ordered pair is refused with a typed code; no `setLifecycleStatus`-style helper exists (grep-asserted alongside the action-file list). *(plan V1)*
24. **DRAFT-only child writes** — a spec or price insert, update or delete against a `TESTING`, `ACTIVE`, `OBSOLETE` or `RETIRED` parent is refused by the repository **and**, on a direct SQL write, by the trigger. *(V2)*
25. **One open version per family** — two concurrent branch attempts on one family leave exactly one open version; a direct SQL insert of a second `DRAFT`/`TESTING` row in the family is rejected by the index, for a family root and for a branch. *(V3)*
26. **Hard delete** — discarding a `DRAFT` removes its specs and prices, leaves every other family member untouched, and writes one `PRODUCT_OFFERING_DELETED` event carrying the removed counts; no path deletes an `ACTIVE`, `OBSOLETE` or `RETIRED` version or its children. *(V4, V6)*
27. **Price completeness** — a recurring price without a charge period, a usage price without a unit, a `once` price carrying either, a unit outside the closed list (including `'MBPS'` and `'gb'`), and a period type outside the mapping each fail in Zod **and** at the database; seeds are covered by the same assertions. *(V7)*
28. **Retirement gate** — retiring is refused while a pinned subscription is not `TERMINATED`, or is `TERMINATED` with `end_date >= current_date`; the refusal carries the live count; retiring succeeds at zero. *(plan §4.1)*
29. **No detail fan-out** — the Manage Products first render issues one families query plus its count and no per-row detail query; selecting a family issues the version, detail, specification and price queries once each. Asserted by counting statements against the test database, not by reading the source. *(V9)*
30. **Status-literal sweep** — no code path outside `db/**` and `services/product/**` treats `OBSOLETE` as unbillable or unreadable; `'RETIRED'` comparisons elsewhere in the repo are enumerated and reviewed, including the flow SQL under `workflow-management/**`. *(V5)*

The authz matrix (guardrail 1) extends to every row of §8, including the EDIT-vs-DELETE split across the three withdrawal actions. *(V10)*
