# Product Management — Module Code Standards

> module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Product Management specifics; everything else (TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `prodmgmt-project-overview.md` (product spec) and `prodmgmt-architecture.md` (technical design, numbered **Module Invariants**). Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

> **Status:** this doc now covers all three shipped surfaces — the read-only catalog (View Product), the CRUD fast-follow (Manage Products), and the **Product Ordering & Inventory update** (Orders/Subscriptions — `prodmgmt-update-overview.md`, architecture Inv. #15–22), ship-gate-verified as of pm34. Every Ordering-update addition below is marked *(Ordering update)*.

---

## 1. General Rules (module-specific)

1. **Writes flow exclusively through the mutation stack.** Every production code path that mutates `product.*` tables goes through `actions/product/**` → `services/product/*-write.service.ts` → repositories, gated by `products : EDIT`/`DELETE`. No `app/api/product*` route exists, or ever will — a PR adding one is rejected at review regardless of phase.
2. **Price rows are immutable and insert-only — enforced in code shape, not discipline.** The price repository exports no `update*` or `delete*` function, ever (module Inv. #1). Its only write is `insertPrice`, which INSERTs a new row (against the target `DRAFT`, branching first if the target is `ACTIVE`).
3. **View Product reads are not audited.** No `AUDIT_LOG` writes come from `services/product/list-offerings.ts` or `get-offering-detail.ts`. Every Manage Products mutation, by contrast, writes exactly one audit event per action inside the same transaction as the data change (general §1.7, atomic audit) — see §1 rule 9 below for the event-type list.
4. **The audit log is never a pricing/rating source** (module Inv. #7). Any code that reconstructs historical price state reads immutable price rows + `start_date_time` — never `AUDIT_LOG`.
5. **Additive-only held, with one disclosed exception.** The original schema, repositories, `services/product`, and Zod schemas were written so the CRUD fast-follow could add functions and actions without renaming, re-typing, or re-shaping what shipped first. That held for specifications and prices without exception. For offerings, it held with **one disclosed exception**: `family_offering_id` is a genuinely new column, not a reshaping of anything — reviewed and accepted, not a defect.
6. **The `(admin)` → `(app)` route-group rename changed no URL** (module Inv. #12, Decision #10, pm01 — historical). Every existing Administration URL and authz-matrix result stays byte-identical.
7. **Seeds obey the same validation as every other write.** Seed scripts pass `pricing_characteristics` through the per-`pricing_model` Zod schema and must trip the overlap constraint if wrong — no `INSERT` that bypasses validation, even in seed code (module Inv. #4).
8. **Template seed rows keep the `TOREMOVE-Template-` name prefix** so the go-live data migration can find and replace them; no production code may depend on these rows existing.
9. **`is_bundle` is never user-editable, in any form, ever.** Neither `create-offering.schema.ts` nor `update-offering.schema.ts` includes an `isBundle` field. `insertOffering` hardcodes `isBundle: false`. `branchOfferingAsDraft` copies whatever value the source row already has — the value survives cloning, but no code path lets a user set it.
10. **Editing an `ACTIVE` offering never mutates it in place.** Any write targeting an `ACTIVE` offering's own fields, its specifications, or its prices routes through `branchOfferingAsDraft` first (Inv. #14); there is no service function that `UPDATE`s an `ACTIVE` `product_offering` row's content columns.
11. **Discard and Retire are the same repository call with different audit events.** `retireOffering(tx, offeringId)` sets `lifecycle_status = RETIRED` regardless of the row's prior status; the calling service logs `PRODUCT_OFFERING_DISCARDED` when the source was `DRAFT` and `PRODUCT_OFFERING_RETIRED` when it was `ACTIVE`. Do not fork this into two repository methods — the DB-level operation is identical, only the audit semantics differ.
12. **Backdating tolerance is a service-layer check, not a DB constraint.** `insertPrice`'s caller rejects a `start_date_time` more than 3 days in the past (`BACKDATED_START_TOO_FAR`) and flags (non-blocking) anything backdated within that window; checked against the transaction's `now()`, not the Zod schema alone (Zod can validate "is this a valid date," not "is this within tolerance of the current instant at write time").
13. **Every status read that gates a branch-vs-in-place decision must happen inside the transaction, immediately before the decision, not before the transaction opens.** A pre-transaction read of `lifecycleStatus` (or a spec's current content) is a TOCTOU window — the row can change between the read and the write. Every write service (`updateOffering`, `addSpecification`/`updateSpecification`/`deleteSpecification`, `insertPrice`, `activateOffering`, `retireOffering`) re-reads its target's status via a locked (`FOR UPDATE`) query on `tx`, not `db`, as the last step before branching or writing.
14. **Cross-module transactional reads never call another module's service** *(Ordering update)*. `services/ordering/**` and `services/inventory/**` read another module's data two different ways depending on purpose: a display/form read (customer search, BAN list, offer detail) calls that module's own `services/*` function normally; an in-transaction precondition re-check (party `ACTIVE`, BAN non-closed, offering `ACTIVE ∧ billing_only ∧ is_sellable`) calls that other module's **repository's own locked (`FOR UPDATE`) finder directly** (e.g. `partyRoleRepository.findStatusByIdForUpdate`, `billingAccountRepository.findStateByIdForUpdate`), never a service function — a service of another module cannot participate in this module's open transaction. No cross-module SQL joins beyond the list-view joins each module's own repositories declare.

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions** (general §2.6), defined once as `as const` string-literal unions in the module's types:
   - `LifecycleStatus`: `'DRAFT' | 'ACTIVE' | 'RETIRED'`
   - `PriceType`: `'recurring' | 'usage' | 'once'`
   - `PricingModel`: `'flat' | 'tiered'`
2. **JSONB typing per general §6.17.** The owning Zod schemas are `ProductSpecCharacteristics` and `PricingCharacteristics` in `validation/product/`; the Drizzle `.$type<T>()` types derive from them — never a hand-written duplicate (general §2.8).
3. **`PricingCharacteristics` is a discriminated union on `pricing_model`.** The tiered branch is `{ tiers: Tier[] }` with `Tier = { from: number; to: number | null; rate: string }` (`to: null` = open-ended top tier); both the type and the contiguity/non-overlap rule come from the Zod schema, not ad-hoc checks.
4. **Money per general §2.15 / §6.16.** The module's monetary values are `amount` and tier `rate` — both `numeric` → `string`. No money arithmetic anywhere in this module.
5. **`end_date_time` exists only as a computed field.** Services return it as `endDateTime: Date | null` (null = open-ended, no successor) on the price read model. No type in the codebase gives a price row a *stored* end (module Inv. #3).
6. **Entity IDs are plain `string`s validated by Zod format schemas** — `PRDOFR`/`PRDSMD`/`PRDOFP` + zero-padded sequence (e.g. `/^PRDOFR\d{6}$/`). The `?offering=` searchParam is parsed against the offering-ID schema before any repository call; no branded-type machinery.
7. **Read models live in `types/` as composed shapes** (general §2.7): `OfferingListRow` (incl. `familyOfferingId`, `billingOnly`), `OfferingDetail` (offering + `lastEditedByName` resolved from `core.APPUSER`), `SpecificationCard`, `PriceCard` (row + computed `endDateTime`). Services return these, not raw Drizzle rows, so pages never re-join.
8. **`ProductOffering` read/insert types carry `familyOfferingId: string | null`**, mirroring the schema column. No new branded ID type — a family id is just another `PRDOFR…` value.
9. **The Manage Products family-grouped row shape** (current `ACTIVE` version, or latest `DRAFT` if the family never went live, plus its sibling versions) is a page-local shape built by grouping helpers in `manage-products/page.tsx`, not a repository-level read model — this was an explicit "implement whichever is simpler" call, not a missed abstraction.

---

## 3. Next.js Rules (module-specific)

1. **Both pages are thin RSC orchestrators.** `app/(app)/products/product-offering/page.tsx`: `await requirePermission('products', 'READ')` → `await` the `searchParams` prop (a `Promise` in this Next.js version — this version's breaking change, not a synchronous page-prop shape, per AGENTS.md) → parse with the `validation/product` list schema → call `services/product` → compose the four section components. `app/(app)/products/manage-products/page.tsx`: `await requirePermission('products', 'EDIT')` → fetch/group offerings → compose `ManageOfferingTable`. Neither does DB access or business rules inline (general §3.3); dialogs and forms are the `'use client'` interaction leaves.
2. **View Product's list and selection state lives in URL searchParams** — `q` (name search), `status` (lifecycle filter), `sort`, `page`, `offering` (selected row). No client-side state store, no `useState` mirror of the URL, no cookies/localStorage for view state. Manage Products has no comparable URL-selection state; a mutation's success path is `router.refresh()`, not URL navigation.
3. **searchParams are parsed, never trusted.** Invalid or unknown values fall back to schema defaults (page 1, default sort, RETIRED hidden) rather than erroring. A well-formed `?offering=` that matches no row renders the empty-detail state — not 404, not an error boundary.
4. **RETIRED is hidden server-side by default on View Product.** The default filter is applied in the service when `status` is absent; it is not a client-side row filter. Manage Products shows every lifecycle status (it's the CRUD surface) grouped by family, with RETIRED rows losing their row actions ("No actions — retired").
5. **Row selection on View Product is a `<Link>` that rewrites `?offering=`** (preserving the other params), so deep-linking and the back button work with zero client logic. No `onClick` + `router.push` + component state.
6. **`'use client'` only at interaction leaves** — search input, sort headers, pagination controls on View Product; dialogs and forms on Manage Products. Read-only section components (`OfferingDetail`, `SpecificationsPanel`, `PricesPanel`) stay server components.
7. **Every `actions/product/*` file follows one shape**: `requirePermission` → `isRedirectError` catch → `schema.safeParse` (where the mutation takes a payload) → delegate to the write service only → `revalidatePath` both product pages → typed `{ok, code}` result — same shape as `actions/roles/*.action.ts`.
8. **Nav renders regardless of permission; each guard enforces.** "View Product" and "Manage Products" both appear for every authenticated user (platform convention); an ungranted user who clicks through gets the no-access state from the respective page guard.
9. **Page metadata:** View Product's `metadata.title`/`H1` is **"View Product"**; Manage Products ships its own `metadata.title`, **"Manage Products"**. Both route segments ship `loading.tsx` and `error.tsx` per general §3.11.

---

## 4. Styling (module-specific)

1. **Shared indicator components** (general §4.8) — one visual treatment per domain value, created exactly with these names:
   - `LifecycleBadge` — `DRAFT | ACTIVE | RETIRED` (semantic tokens; no raw palette classes)
   - `PriceTypeBadge` — `recurring | usage | once`
2. **JSONB entries render as plain text, not dedicated widgets** (revised 2026-07-09 — density pass): spec characteristics (`SST_ID: 01`) and tiered-price bounds/rate render inline as `key: value` / `from–to: rate` text in the specifications and prices panels respectively; there is no `CharacteristicChip` or `TierTable` component. Open-ended top tier still reads "and above".
3. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for both the View Product offerings table and `ManageOfferingTable`; extend them if needed; never fork a parallel table implementation for this module.
4. **View Product's four-section layout is a responsive grid:** table full-width on top, detail below it, specs and prices side-by-side (`lg:` and up) collapsing to a single stacked column on narrow viewports in the order table → detail → specs → prices (general §4.10).
5. **Money formatting goes through one `lib/` formatter** — `formatCurrency(amount, currency, locale)` — used by flat-price cards and `PriceForm`. No inline `toFixed`, no hand-built currency strings, no currency symbol hardcoding.
6. **Datetime display** (`last_modified`, `start_date_time`, derived end) uses the platform `formatDatetime(date, locale, timezone, …)` with the timezone threaded as a prop (general §2.13); `<time dateTime>` stays ISO-8601 UTC.
7. **Boolean flags** (`is_bundle`, `is_sellable`, billing-only) render through one shared yes/no indicator, not per-card ad-hoc icons or text.
8. **Manage Products binding component names**: `ManageOfferingTable`, `OfferingForm`, `SpecificationForm`, `SpecificationsDialog` (one dialog swapping list/form views, plus a nested `AlertDialog` for delete), `PriceForm`, `RetireOfferingDialog` (one component; copy/title switch between "Retire" and "Discard draft" based on the target's status — not two components), `CreateOfferingDialog`, `AddPriceDialog`, `ActivateOfferingDialog`.
9. **`--action-cta-bg` is used exactly once**: the "New offering" button in the Manage Products page header — the page's only accent-filled primary action. Every other action (Edit, Add price, Activate confirm) uses the quieter secondary/ghost treatment; Retire/Discard use the danger role, only inside their confirmation dialogs.
10. **Row action buttons** on `ManageOfferingTable` are icon-only, `--text-secondary`/`text-muted-foreground` for quiet actions (Edit, Add price, Activate, Specifications) and `--text-danger`/`text-destructive` for Discard/Retire, always paired with `aria-label` — never color-only meaning. `RETIRED` rows show no action buttons.
11. **"This creates a new draft" warning** appears inside the Edit and Add Price dialogs whenever the target's current status is `ACTIVE` (never on a `DRAFT` target): warning background/text tokens, no icon, copy pattern *"`<Name>` is active. Saving will not change it — a new draft version is created instead."*
12. **Backdating warning** appears inside the Add Price form when the chosen start date is in the past but within the 3-day tolerance, same warning tokens as above. A start date beyond tolerance is a standard validation error, not this banner.
13. **Version-family grouping** on `ManageOfferingTable`: one row per family by default (its `ACTIVE` version, or latest `DRAFT` if never active), with a chevron expand affordance revealing sibling versions as indented, recessed (`--surface-sunken`) sub-rows. A family with only one row shows no expand chevron.

---

## 5. API Routes (module-specific)

1. **This module adds no Route Handlers, ever, in any phase.** `app/api/**` gains nothing from Product Management. Reads flow RSC page → `services/product` → repositories; writes flow through `actions/product/**` exclusively.
2. **A product Route Handler would require a platform design review first** (general §5.1 scope: auth provider, callbacks, M2M only) — not expected to ever be needed for this module.
3. **A PR adding any `app/api/product*` path is rejected at review.**

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `product` schema:** `product_offering`, `product_specifications`, `product_offering_price` — nothing else, and no identity/RBAC/session/config/audit tables (module Inv. #9). Cross-schema references go by FK to `core` (`last_edited_by` → `core.APPUSER`). The only schema addition beyond the original three tables is the `family_offering_id` column (+ index) on `product_offering`.
2. **ID prefixes** (format per general §6.18): `PRDOFR` (offering), `PRDSMD` (specification), `PRDOFP` (price) — one sequence per table.
3. **The price table has no `end_date_time` and no `last_update` column** (module Inv. #3). Effectivity end is derived at query time from the successor's `start_date_time` (window function in the repository query); it is never stored, cached, or backfilled.
4. **Overlap prevention is a DB constraint, not app logic** (module Inv. #2): a UNIQUE constraint on (`product_offering_id`, `price_type`, `start_date_time`) — effectivity windows are derived from successor starts, so they never overlap by construction (supersession: a new price truncates its predecessor from its start instant); the constraint's job is keeping that derivation well-defined. Violating seeds and inserts must fail at the database; the Zod layer is additional, not the enforcement.
5. **`amount` XOR tiers is a CHECK constraint** (module Inv. #5): `pricing_model = 'flat'` ⇒ `amount NOT NULL`; `pricing_model = 'tiered'` ⇒ `amount IS NULL` (tiers live in `pricing_characteristics` JSONB). Zod mirrors it; the DB owns it.
6. **`created_at` vs `start_date_time` are distinct and both required on prices:** `created_at` = insert time, `start_date_time` = billing effectivity; they differ for future-dated prices. Neither substitutes for the other in queries.
7. **`version` is a row's sequence number within its version family** (module Inv. #8): root = `1`, each branch = family max + 1, assigned once at insert, never changed after. Versioned offering rows are the norm; version-aware queries (`findActiveInFamily`) are a repository primitive, not an anti-pattern to avoid.
8. **JSONB writes are schema-guarded everywhere** (module Inv. #4): every write of `pricing_characteristics` or `product_spec_characteristics` — including seeds — passes the Zod schema for its `pricing_model`/spec shape first. Tiered tiers must be contiguous and non-overlapping (`tier[n].to === tier[n+1].from`, strictly increasing).
9. **Only `lifecycle_status = 'ACTIVE'` offerings are billable, at most one per family** (module Inv. #6): when later modules (Customer, Billing Service, Bill Run) add FKs to `product_offering`, their selection queries filter on ACTIVE; this module's repositories expose the status to make that filter trivial.
10. **Tier storage stays JSONB.** Migrating tiers to a child table is a deferred decision owned by the future rating module — do not pre-build the child table.
11. **Single-active-per-family is enforced transactionally, not by a DB constraint** (Inv. #13). `activateOffering` re-checks for a sibling `ACTIVE` row inside the transaction before flipping status — the same in-transaction re-check pattern `deleteRole` uses for its assignment-count race. Do not attempt to express this as a single unique index; the nullable-root design (`family_offering_id IS NULL` for roots) makes a clean partial-unique-index equivalent impossible — a deliberate, reviewed trade-off.
12. **A price or specification write against an `ACTIVE` offering always lands on a freshly branched `DRAFT`, never on the `ACTIVE` row** (Inv. #14). This is why `deleteSpecification`'s "only on a `DRAFT`" rule holds by construction: by the time any spec-write function is called, its target offering is guaranteed `DRAFT`.
13. **Reason/comment on activation and retirement/discard is captured in the audit event payload, not a new column.** `insertAuditEvent`'s `afterData` carries `{ ...fields, transitionReason: reason ?? null }`. No `product_offering` schema impact.

---

## 7. File Organization (module-specific)

Placement per general §7; the module's concrete tree:

```
app/(app)/products/product-offering/
  page.tsx            # ProductOfferingPage — guard (READ), parse params, fetch, compose
  loading.tsx
  error.tsx
app/(app)/products/manage-products/
  page.tsx            # ManageProductsPage — guard (EDIT), parse, fetch, compose
  loading.tsx
  error.tsx
actions/product/
  create-offering.action.ts
  update-offering.action.ts
  activate-offering.action.ts
  retire-offering.action.ts        # handles both Retire and Discard
  create-specification.action.ts
  update-specification.action.ts
  delete-specification.action.ts
  insert-price.action.ts
components/products/
  offering-table.tsx        # OfferingTable
  offering-detail.tsx       # OfferingDetail
  specifications-panel.tsx  # SpecificationsPanel
  prices-panel.tsx          # PricesPanel
  lifecycle-badge.tsx       # LifecycleBadge
  price-type-badge.tsx      # PriceTypeBadge
components/products/manage/
  manage-offering-table.tsx        # ManageOfferingTable
  create-offering-dialog.tsx       # CreateOfferingDialog
  offering-form.tsx                # OfferingForm (create + edit modes)
  add-price-dialog.tsx             # AddPriceDialog
  price-form.tsx                   # PriceForm
  specification-form.tsx           # SpecificationForm
  specifications-dialog.tsx        # SpecificationsDialog
  activate-offering-dialog.tsx     # ActivateOfferingDialog
  retire-offering-dialog.tsx       # RetireOfferingDialog
services/product/
  list-offerings.ts          # listOfferings(params): search/filter/sort/pagination
  get-offering-detail.ts     # getOfferingDetail(id): offering + specs + prices (+ derived end)
  create-offering.ts
  update-offering.ts
  add-specification.ts
  update-specification.ts
  delete-specification.ts
  insert-price.ts
  activate-offering.ts
  retire-offering.ts
db/schema/product.ts        # 3 tables, sequences, enums, constraints, family_offering_id + index
db/repositories/
  product-offering.ts        # finders + insertOffering, updateOfferingDraftInPlace,
                              #   branchOfferingAsDraft, activateOffering,
                              #   retireOffering, findActiveInFamily
  product-specification.ts   # finders + insertSpecification, updateSpecification, deleteSpecification
  product-offering-price.ts  # finders + insertPrice (only write, ever)
db/migrations/…             # schema + `products` PERMISSIONS seed row + family_offering_id migration
db/seeds/product.ts         # TOREMOVE-Template-* rows, validated via Zod
validation/product/
  offering-list.schema.ts           # searchParams: q/status/sort/page/offering
  pricing-characteristics.schema.ts # per-pricing_model discriminated schemas
  create-offering.schema.ts
  update-offering.schema.ts
  create-specification.schema.ts
  update-specification.schema.ts
  insert-price.schema.ts
  activate-offering.schema.ts
  retire-offering.schema.ts
tests/…                     # mirrors source; authz-matrix entries for both pages;
                             #   versioning-invariant + guardrail tests
```

*(Ordering update)* Additions to the tree above, ship-gate-verified as of pm34:

```
app/(app)/products/orders/
  page.tsx            # OrdersPage — guard (product_orders:READ), list + review seam
  loading.tsx
  error.tsx
app/(app)/products/subscriptions/
  page.tsx            # SubscriptionsPage — guard (product_inventory:READ), list + history
  loading.tsx
  error.tsx
actions/ordering/
  create-order.action.ts
  approve-order.action.ts
  reject-order.action.ts
actions/inventory/
  suspend-subscription.action.ts
  resume-subscription.action.ts
  terminate-subscription.action.ts
  update-characteristics.action.ts
actions/accounts/
  new-order-wizard-reads.ts  # cross-module wizard reads (disclosed pm29 placement call)
components/products/ordering/
  order-status-badge.tsx      # OrderStatusBadge
  orders-table.tsx            # OrdersTable
  new-order-wizard.tsx        # NewOrderWizard (3-step)
  wizard-step-customer.tsx, wizard-step-account.tsx, wizard-step-offer.tsx
  characteristics-editor.tsx  # CharacteristicsEditor
  override-price-fields.tsx   # OverridePriceFields
  order-review-panel.tsx      # OrderReviewPanel
  review-actions.tsx          # ReviewActions
components/products/inventory/
  subscription-status-badge.tsx  # SubscriptionStatusBadge
  subscriptions-table.tsx        # SubscriptionsTable
  status-history-rows.tsx        # StatusHistoryRows
  suspend-dialog.tsx, resume-dialog.tsx, terminate-dialog.tsx
  edit-characteristics-dialog.tsx
services/ordering/
  list-orders.ts, get-order-detail.ts     # read services
  order-preconditions.ts                  # shared checkOrderPreconditions
  create-order.ts, instantiate-order.ts   # shared instantiation primitive
  review-order.ts                         # approveOrder/rejectOrder
services/inventory/
  list-subscriptions.ts, get-subscription-detail.ts
  lifecycle-guards.ts   # shared isLegalTransition/isBackdatedTooFar/isBeforeLatestEffectiveDate
  suspend-subscription.ts, resume-subscription.ts, terminate-subscription.ts
  update-instance-characteristics.ts
db/schema/ordering.ts       # product_order, product_order_item, order_item_price_override
db/schema/inventory.ts      # product_inventory, inventory_status_history
db/repositories/ordering/
  product-order.repository.ts             # insert/finders + updateStatus (status-workflow only)
  product-order-item.repository.ts        # insert + finders only (Inv. #15)
  order-item-price-override.repository.ts # insert + finders only (Inv. #16)
db/repositories/inventory/
  product-inventory.repository.ts         # insert/finders + updateStatus/updateCharacteristics only
  inventory-status-history.repository.ts  # insert + finders only (Inv. #18)
validation/ordering/
  create-order.schema.ts, review-order.schema.ts, orders-list.schema.ts
validation/inventory/
  suspend.schema.ts, resume.schema.ts, terminate.schema.ts
  update-characteristics.schema.ts, subscriptions-list.schema.ts
tests/…                     # mirrors source; authz-matrix entries for both new pages
                             #   (tests/auth/guard.integration.test.ts); guardrail sweep
                             #   (tests/guardrails/ordering-module-boundaries.test.ts,
                             #   inventory-module-boundaries.test.ts,
                             #   ordering-inventory-ship-gate.test.ts); live-DB integration
                             #   suites per write path plus
                             #   tests/db/ship-gate-guardrails.integration.test.ts
tests/helpers/assert-inventory-gap-free.ts  # reusable Inv. #18 derivability assert (pm32),
                                             #   reused by the pm34 sweep
```

1. **The nav refactor lives in `components/admin-nav.tsx`** — `NAV_ITEMS` → `NAV_SECTIONS` (caption + items). Do not create a second nav component or a product-specific nav file.
2. **`services/product` stays framework-agnostic** — no `next/*` imports (general §3.14); functions accept parsed, typed params and return the §2.7 read models.
3. **The route-group rename** (historical, pm01) moved `app/(admin)/**` → `app/(app)/**` and updated every `@/app/(admin)/…` import in one commit; nothing else changed in that commit.
4. **`app/(app)/products/product-offering/**` may only ever be touched for its nav label and page `H1` text** beyond its original v1 scope — any other edit to that folder needs an explicit reason (it's the module's read-only guarantee made concrete).

---

## 8. Permission Names & Per-Page Permission Map

**Permission name** (general §8.1): `products` — single, page-level, code-seeded via migration. READ gates the View Product page **including prices**; there is no pricing-visibility split (module Inv. #10). EDIT gates offering/specification create-edit, branching, and price add on Manage Products; DELETE gates retirement and discard. Reference via the typed constant in `auth/` (`PERMISSIONS.PRODUCTS = 'products'`, general §8.5).

Authoritative; mirrors architecture §4. New pages are appended before they ship.

| Page | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| View Product — list + detail + specifications + prices | `/products/product-offering` | `ProductOfferingPage` → `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel` | `app/(app)/products/product-offering/` | `products` : **READ** |
| Manage Products — create / edit / branch / activate | `/products/manage-products` | `ManageProductsPage` → `ManageOfferingTable`, `OfferingForm`, `PriceForm`, `SpecificationForm` | `app/(app)/products/manage-products/`, `actions/product/` | `products` : **EDIT** |
| Manage Products — retire / discard | `/products/manage-products` | `RetireOfferingDialog` | `actions/product/retire-offering.action.ts` | `products` : **DELETE** |
| Orders — list + New order + Review *(Ordering update)* | `/products/orders` | `OrdersPage` → `OrdersTable`, `NewOrderWizard`, `OrderReviewPanel` | `app/(app)/products/orders/`, `actions/ordering/` | `product_orders` : **READ** (list) / **EDIT** (create/approve/reject) |
| Orders — approve / reject a `PENDING` order *(Ordering update)* | `/products/orders` | `ReviewActions` | `actions/ordering/{approve,reject}-order.action.ts` | `product_orders` : **EDIT** + **MANAGER role** + reviewer ≠ submitter |
| Subscriptions — list + lifecycle + edit characteristics *(Ordering update)* | `/products/subscriptions` | `SubscriptionsPage` → `SubscriptionsTable`, suspend/resume/terminate/edit-characteristics dialogs | `app/(app)/products/subscriptions/`, `actions/inventory/` | `product_inventory` : **READ** (list) / **EDIT** (mutations) |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable (general §9).
- A user without `products : READ` sees the "View Product" nav item but is stopped by the page guard → no-access state; no partial rendering of specs or prices under a weaker check (module Inv. #10). A user without `products : EDIT` sees "Manage Products" but is likewise stopped at the guard.
- Deep links (`?offering=PRDOFR000001`) pass through the View Product guard — the searchParam grants nothing.
- *(Ordering update)* `product_orders`/`product_inventory` carry no grant overlap with `products` or with each other, in either direction — ship-gate-proven both ways in `tests/auth/guard.integration.test.ts` (pm34) and, DB-free, in `tests/types/permissions.test.ts` (pm27/pm33). Neither permission has a `DELETE` level in use; both pages guard on `READ`, mutations are gated per-action on `EDIT`. Order approval is the module's only role-conditioned gate: `product_orders:EDIT` alone reaches `approveOrderAction`/`rejectOrderAction` but is refused `NOT_MANAGER` by the service unless the caller also holds the `MANAGER` role and is not the order's own submitter (architecture §4).

---

## 9. Module Guardrail Tests (CI gate §10.4)

The general test-suite gate includes this module's guardrail tests, all of which exist and are enforced pre-ship:

1. **Authz matrix** — both `/products/product-offering` and `/products/manage-products` × every role/level combination, including no-grant → no-access, and a dedicated proof that `products:EDIT` and `products:DELETE` are two different gates (an EDIT-only principal cannot retire/discard).
2. **Price immutability** — inserting a successor price leaves the old row untouched (byte-identical) and, when the target was already `DRAFT`, the offering's `version` is unchanged; the repository module exports no update/delete for prices (asserted structurally and behaviorally).
3. **Overlap constraint** — seeding two same-`price_type` prices with the same `start_date_time` on one offering fails at the DB.
4. **Derived effectivity** — the price effective "now" is resolved from `start_date_time`; a future-dated successor does not displace the current price early; open-ended prices return `endDateTime: null`.
5. **JSONB validation** — tiered `pricing_characteristics` with a gap or overlap in tier bounds fails the Zod schema; `flat` + `amount NULL` and `tiered` + `amount NOT NULL` both fail.
6. **Deep link** — `?offering=PRDOFR000001` in a fresh session reproduces the selected view on View Product; an unknown offering ID renders the empty-detail state.
7. **Rename invariance** — every pre-existing Administration route passes its authz-matrix tests unchanged under `(app)` with identical URLs (module Inv. #12).
8. **Single-active-per-family** — activating a version retires any sibling `ACTIVE` version in the same transaction; under two near-simultaneous activation attempts on siblings, exactly one family member ends up `ACTIVE`, never zero or two.
9. **Branch-not-mutate** — editing any field, specification, or price on an `ACTIVE` offering leaves that row and its exact children byte-for-byte unchanged in the database and produces exactly one new sibling `DRAFT`.
10. **Spec-delete unreachable on `ACTIVE`** — no code path calls `deleteSpecification` against an offering whose current status is `ACTIVE` (asserted directly, not just trusted from construction).
11. **View stays read-only** — `app/(app)/products/product-offering/**` and `components/products/*.tsx` (excluding `components/products/manage/`) import nothing from `actions/product/`, `components/products/manage/`, or any `*-write.service.ts`.
12. **Route manifest** — both `/products/product-offering` and `/products/manage-products` appear exactly once each in the frozen route manifest.
13. **Schema-diff check** — `db/schema/product.ts`'s only diff from its original shape is `family_offering_id` + its index on `product_offering`; `product_specifications` and `product_offering_price` are byte-identical to their original definitions.
14. **TOCTOU-safe status reads** — every write service that branches conditionally on `lifecycleStatus` reads that status via a locked query on the active transaction (`tx`), not a pre-transaction `db` read (module code-standards §1 rule 13).

*(Ordering update — pm34 ship gate.)* Numbered continuing the list above, per this unit's own Design section:

15. **Insert-only surfaces** — `order_item_price_override` (Inv. #16) and `inventory_status_history` (Inv. #18) repositories export no `update*`/`delete*`, ever; `product_order_item` is likewise write-once (Inv. #15). First landed in pm26 (`tests/db/ordering-repository-exports.test.ts`); that file is the permanent home for this guardrail, re-asserted here rather than duplicated.
16. **Grandfathering** — activating a new version of an ordered offering through the real catalog services (`branchOfferingAsDraft` + `activateOffering`, not a raw status flip) leaves an existing subscription's pinned `product_offering_id` unchanged and its `OrderPriceLine`/rating reads (`getOrderDetail`) resolving byte-identically from the now-`RETIRED` version's rows (Inv. #17). `tests/db/ship-gate-guardrails.integration.test.ts`.
17. **Gap-free history** — `assertInventoryGapFree` (pm32, `tests/helpers/assert-inventory-gap-free.ts`) run across every `product_inventory` instance a ship-gate run creates: latest history `to_status` ≡ the instance's `status` column; transitions read in insertion order (`inventoryStatusHistoryId`, not `created_at` — pm32's own concurrency fix) never regress in `effective_date`. `tests/db/ship-gate-guardrails.integration.test.ts`.
18. **Write-once core** — no code path updates `product_order_item` columns or inventory core columns: the item repository exports insert+finders only; the inventory repository's update surface is exactly `updateStatus` + `updateCharacteristics`, structurally asserted in `tests/db/ordering-repository-exports.test.ts` (pm26, same permanent home as guardrail 15).
19. **Boundary sweeps** — `EXPECTED_ORDERING_ACTION_FILES`/`EXPECTED_INVENTORY_ACTION_FILES` exact (`tests/guardrails/ordering-module-boundaries.test.ts`/`inventory-module-boundaries.test.ts`, pm29/pm33); `app/api/ordering*`/`app/api/inventory*`/`app/api/product*` absent (`tests/guardrails/ordering-inventory-ship-gate.test.ts`, pm34, alongside `product-module-boundaries.test.ts`'s pre-existing `product*` check); `components/products/*` (View Product) still imports nothing from the ordering/inventory write surface (`ordering-inventory-ship-gate.test.ts`, pm34); `db/schema/product.ts` still byte-identical to Phase 2's shape (`product-module-boundaries.test.ts`'s pre-existing schema-diff check — unaffected by pm25–33, re-confirmed not re-implemented by this unit).
20. **No-cycle-column** — schema introspection: no column name in `ordering.*`/`inventory.*` matches `%cycle%`/`%frequency%` (Inv. #20). `tests/guardrails/ordering-inventory-ship-gate.test.ts`.
21. **Route manifest** — `/products/orders` and `/products/subscriptions` each appear exactly once in the frozen manifest. `tests/guardrails/ordering-inventory-ship-gate.test.ts`.
22. **Reviewer ≠ submitter** — the DB CHECK (`product_order_reviewer_check`) fires on a direct SQL write, proven in `tests/db/review-order.integration.test.ts`'s `"the DB CHECK reviewed_by <> submitted_by rejects a direct SQL self-review write"` test (pm30); the service-layer `SELF_REVIEW` guard is covered in the same file. Referenced here as this guardrail's permanent home, not duplicated.
