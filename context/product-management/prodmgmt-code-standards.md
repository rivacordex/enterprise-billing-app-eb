# Product Management — Module Code Standards

> **PLANNED** — module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Product Management specifics; everything else (TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `prodmgmt-project-overview.md` (product spec) and `prodmgmt-architecture.md` (technical design, numbered **Module Invariants**). Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

---

## 1. General Rules (module-specific)

1. **v1 is read-only.** No production code path mutates `product.*` tables (module inv. #11). No `actions/product/` folder, no product Route Handlers, no mutation service methods are merged in v1 — not even "disabled" or feature-flagged ones. Mutation code arrives only with the CRUD fast-follow behind `products : EDIT`/`DELETE`.
2. **Price rows are immutable — enforce it in code shape, not discipline.** The price repository exports no `update*` or `delete*` function, ever (module inv. #1). The only future write is `insertPrice`, which INSERTs the successor row and bumps the offering `version` in the same transaction.
3. **Reads are not audited.** This module adds **no** `AUDIT_LOG` event types in v1 (architecture §5). Do not write audit rows from list/detail reads; general §1.7 (atomic audit) applies only when CRUD mutations arrive.
4. **The audit log is never a pricing/rating source** (module inv. #7). Any code that reconstructs historical price state reads immutable price rows + `start_date_time` — never `AUDIT_LOG`.
5. **CRUD-ready means additive-only.** Schema, repositories, `services/product`, and Zod schemas are written so the editing fast-follow adds functions and actions without renaming, re-typing, or re-shaping what v1 ships. A v1 design that would force a breaking change in the fast-follow is a review-blocking defect.
6. **The `(admin)` → `(app)` route-group rename is the first UI change and changes no URL** (module inv. #12, Decision #10). Every existing Administration URL and authz-matrix result stays byte-identical; CI proves it before any product page lands.
7. **Seeds obey the same validation as future writes.** Seed scripts pass `pricing_characteristics` through the per-`pricing_model` Zod schema and must trip the overlap constraint if wrong — no `INSERT` that bypasses validation, even in seed code (module inv. #4).
8. **Template seed rows keep the `TOREMOVE-Template-` name prefix** so the go-live data migration can find and replace them; no production code may depend on these rows existing.

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions** (general §2.6), defined once as `as const` string-literal unions in the module's types:
   - `LifecycleStatus`: `'DRAFT' | 'ACTIVE' | 'RETIRED'`
   - `PriceType`: `'recurring' | 'usage' | 'once'`
   - `PricingModel`: `'flat' | 'tiered'`
2. **JSONB typing per general §6.17.** The owning Zod schemas are `ProductSpecCharacteristics` and `PricingCharacteristics` in `validation/product/`; the Drizzle `.$type<T>()` types derive from them — never a hand-written duplicate (general §2.8).
3. **`PricingCharacteristics` is a discriminated union on `pricing_model`.** The tiered branch is `{ tiers: Tier[] }` with `Tier = { from: number; to: number | null; rate: string }` (`to: null` = open-ended top tier); both the type and the contiguity/non-overlap rule come from the Zod schema, not ad-hoc checks.
4. **Money per general §2.15 / §6.16.** The module's monetary values are `amount` and tier `rate` — both `numeric` → `string`. No money arithmetic is expected in v1.
5. **`end_date_time` exists only as a computed field.** Services return it as `endDateTime: Date | null` (null = open-ended, no successor) on the price read model. No type in the codebase gives a price row a *stored* end (module inv. #3).
6. **Entity IDs are plain `string`s validated by Zod format schemas** — `PRDOFR`/`PRDSMD`/`PRDOFP` + zero-padded sequence (e.g. `/^PRDOFR\d{6}$/`). The `?offering=` searchParam is parsed against the offering-ID schema before any repository call; no branded-type machinery.
7. **Read models live in `types/` as composed shapes** (general §2.7): `OfferingListRow`, `OfferingDetail` (offering + `lastEditedByName` resolved from `core.APPUSER`), `SpecificationCard`, `PriceCard` (row + computed `endDateTime`). Services return these, not raw Drizzle rows, so the page never re-joins.

---

## 3. Next.js Rules (module-specific)

1. **One page, RSC, thin orchestrator.** `app/(app)/products/product-offering/page.tsx` does exactly: `await requirePermission('products', 'READ')` → `await` the `searchParams` prop (a `Promise` in this Next.js version — this version's breaking change, not a synchronous page-prop shape, per AGENTS.md) → parse the resolved object with the `validation/product` list schema → call `services/product` → compose the four section components. No DB access, no business rules, no heavy markup (general §3.3).
2. **All list and selection state lives in URL searchParams** — `q` (name search), `status` (lifecycle filter), `sort`, `page`, `offering` (selected row). No client-side state store, no `useState` mirror of the URL, no cookies/localStorage for view state.
3. **searchParams are parsed, never trusted.** Invalid or unknown values fall back to schema defaults (page 1, default sort, RETIRED hidden) rather than erroring. A well-formed `?offering=` that matches no row renders the empty-detail state — not 404, not an error boundary.
4. **RETIRED is hidden server-side by default.** The default filter is applied in the service when `status` is absent; it is not a client-side row filter.
5. **Row selection is a `<Link>` that rewrites `?offering=`** (preserving the other params), so deep-linking and the back button work with zero client logic. No `onClick` + `router.push` + component state.
6. **`'use client'` only at interaction leaves** — search input, sort headers, pagination controls — and each one's sole job is writing searchParams to the URL. Section components (`OfferingDetail`, `SpecificationsPanel`, `PricesPanel`) stay server components.
7. **No Server Actions in v1.** Adding the first `actions/product/*` file is a CRUD-fast-follow change and must land with its EDIT/DELETE re-check per general §3.4 — never as a v1 "convenience".
8. **Nav renders regardless of permission; the guard enforces.** The "Products" section and "Product Offering" item appear for every authenticated user (platform convention); an ungranted user who clicks through gets the no-access state from the page guard.
9. **Page `metadata.title` is "Product Offering"**; the route segment ships `loading.tsx` and `error.tsx` per general §3.11.

---

## 4. Styling (module-specific)

1. **Shared indicator components** (general §4.8) — one visual treatment per domain value, created exactly with these names:
   - `LifecycleBadge` — `DRAFT | ACTIVE | RETIRED` (semantic tokens; no raw palette classes)
   - `PriceTypeBadge` — `recurring | usage | once`
2. **JSONB entries render as plain text, not dedicated widgets** (revised 2026-07-09 — density pass): spec characteristics (`SST_ID: 01`) and tiered-price bounds/rate render inline as `key: value` / `from–to: rate` text in the specifications and prices panels respectively; there is no `CharacteristicChip` or `TierTable` component. Open-ended top tier still reads "and above".
3. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for the offerings table — extend them if needed; never fork a parallel table implementation for this module.
4. **Four-section layout is a responsive grid:** table full-width on top, detail below it, specs and prices side-by-side (`lg:` and up) collapsing to a single stacked column on narrow viewports in the order table → detail → specs → prices (general §4.10).
5. **Money formatting goes through one `lib/` formatter** — `formatCurrency(amount, currency, locale)` — used by flat-price cards. No inline `toFixed`, no hand-built currency strings, no currency symbol hardcoding.
6. **Datetime display** (`last_modified`, `start_date_time`, derived end) uses the platform `formatDatetime(date, locale, timezone, …)` with the timezone threaded as a prop (general §2.13); `<time dateTime>` stays ISO-8601 UTC.
7. **Boolean flags** (`is_bundle`, `is_sellable`, billing-only) render through one shared yes/no indicator, not per-card ad-hoc icons or text.

---

## 5. API Routes (module-specific)

1. **This module adds no Route Handlers.** `app/api/**` gains nothing from Product Management in v1 (architecture §2: "No `actions/` or `app/api/` additions"). Reads flow RSC page → `services/product` → repositories only.
2. **The CRUD fast-follow uses Server Actions, not Route Handlers.** A product Route Handler would require a platform design review first (general §5.1 scope: auth provider, callbacks, M2M only).
3. **A PR adding any `app/api/product*` path in v1 is rejected at review.**

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `product` schema:** `product_offering`, `product_specifications`, `product_offering_price` — nothing else, and no identity/RBAC/session/config/audit tables (module inv. #9). Cross-schema references go by FK to `core` (`last_edited_by` → `core.APPUSER`).
2. **ID prefixes** (format per general §6.18): `PRDOFR` (offering), `PRDSMD` (specification), `PRDOFP` (price) — one sequence per table.
3. **The price table has no `end_date_time` and no `last_update` column** (module inv. #3). Effectivity end is derived at query time from the successor's `start_date_time` (window function in the repository query); it is never stored, cached, or backfilled.
4. **Overlap prevention is a DB constraint, not app logic** (module inv. #2): a UNIQUE constraint on (`product_offering_id`, `price_type`, `start_date_time`) — effectivity windows are derived from successor starts, so they never overlap by construction (supersession: a new price truncates its predecessor from its start instant); the constraint's job is keeping that derivation well-defined (revised 2026-07-04; the btree_gist exclusion constraint was removed because, with no stored end, a range-exclusion constraint cannot reference the successor row; backdating caveat in architecture Inv. #2). Violating seeds and inserts must fail at the database; the Zod layer is additional, not the enforcement.
5. **`amount` XOR tiers is a CHECK constraint** (module inv. #5): `pricing_model = 'flat'` ⇒ `amount NOT NULL`; `pricing_model = 'tiered'` ⇒ `amount IS NULL` (tiers live in `pricing_characteristics` JSONB). Zod mirrors it; the DB owns it.
6. **`created_at` vs `start_date_time` are distinct and both required on prices:** `created_at` = insert time, `start_date_time` = billing effectivity; they differ for future-dated prices. Neither substitutes for the other in queries.
7. **`version` is an in-place metadata counter** (module inv. #8): bumped on any offering change in the same transaction as that change (CRUD phase; seeds set it explicitly). No versioned offering rows, no version-aware queries, no optimistic-locking semantics attached to it in v1.
8. **JSONB writes are schema-guarded everywhere** (module inv. #4): every write of `pricing_characteristics` or `product_spec_characteristics` — including seeds — passes the Zod schema for its `pricing_model`/spec shape first. Tiered tiers must be contiguous and non-overlapping (`tier[n].to === tier[n+1].from`, strictly increasing).
9. **Only `lifecycle_status = 'ACTIVE'` offerings are billable** (module inv. #6): when later modules (Customer, Billing Service, Bill Run) add FKs to `product_offering`, their selection queries filter on ACTIVE; this module's repositories expose the status to make that filter trivial.
10. **Tier storage stays JSONB in v1.** Migrating tiers to a child table is a deferred decision owned by the future rating module — do not pre-build the child table.

---

## 7. File Organization (module-specific)

Placement per general §7; the module's concrete tree:

```
app/(app)/products/product-offering/
  page.tsx            # ProductOfferingPage — guard, parse params, fetch, compose
  loading.tsx
  error.tsx
components/products/
  offering-table.tsx        # OfferingTable
  offering-detail.tsx       # OfferingDetail
  specifications-panel.tsx  # SpecificationsPanel
  prices-panel.tsx          # PricesPanel
  lifecycle-badge.tsx       # LifecycleBadge
  price-type-badge.tsx      # PriceTypeBadge
services/product/
  list-offerings.ts         # listOfferings(params): search/filter/sort/pagination
  get-offering-detail.ts    # getOfferingDetail(id): offering + specs + prices (+ derived end)
db/schema/product.ts        # 3 tables, sequences, enums, constraints
db/repositories/
  product-offering.ts
  product-specification.ts
  product-offering-price.ts
db/migrations/…             # schema + `products` PERMISSIONS seed row
db/seeds/product.ts         # TOREMOVE-Template-* rows, validated via Zod
validation/product/
  offering-list.schema.ts           # searchParams: q/status/sort/page/offering
  pricing-characteristics.schema.ts # per-pricing_model discriminated schemas
tests/…                     # mirrors source; incl. authz-matrix entry for the page
```

1. **The nav refactor lives in `components/admin-nav.tsx`** — `NAV_ITEMS` → `NAV_SECTIONS` (caption + items). Do not create a second nav component or a product-specific nav file.
2. **No `actions/product/` and no `app/api/product*` folders exist in v1** (§1.1, §5). Their creation marks the start of the CRUD fast-follow.
3. **`services/product` stays framework-agnostic** — no `next/*` imports (general §3.14); list/detail functions accept parsed, typed params and return the §2.7 read models.
4. **The route-group rename** moves `app/(admin)/**` → `app/(app)/**` and updates every `@/app/(admin)/…` import in the same commit; nothing else changes in that commit.

---

## 8. Permission Names & Per-Page Permission Map

**v1 permission name** (general §8.1): `products` — single, page-level, code-seeded via migration. READ gates the entire page **including prices**; there is no pricing-visibility split in v1 (module inv. #10). EDIT and DELETE are seeded in the same migration but unused until the CRUD fast-follow. Reference via the typed constant in `auth/` (e.g. `PERMISSIONS.PRODUCTS = 'products'`, general §8.5).

Authoritative for v1; mirrors architecture §4. New pages are appended before they ship.

| Page | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| Product Offering — list + detail + specifications + prices | `/products/product-offering` | `ProductOfferingPage` → `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel` | `app/(app)/products/product-offering/` | `products` : **READ** |
| — create / edit offering, prices, specs, lifecycle transitions *(CRUD fast-follow, not v1)* | (actions under `/products/product-offering`) | *TBD with CRUD phase* | `actions/product/` *(does not exist in v1)* | `products` : **EDIT** (seeded, unused in v1) |
| — delete *(CRUD fast-follow, not v1)* | (action under `/products/product-offering`) | *TBD with CRUD phase* | `actions/product/` *(does not exist in v1)* | `products` : **DELETE** (seeded, unused in v1) |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable (general §9).
- A user without `products : READ` sees the nav item but is stopped by the page guard → no-access state; no partial rendering of specs or prices under a weaker check (module inv. #10).
- Deep links (`?offering=PRDOFR000001`) pass through the same guard — the searchParam grants nothing.

---

## 9. Module Guardrail Tests (CI gate §10.4)

The general test-suite gate includes this module's guardrail tests from *Success Criteria*, all of which must exist before ship:

1. **Authz matrix** — `/products/product-offering` × every role/level combination, including no-grant → no-access.
2. **Price immutability** — inserting a replacement price leaves the old row untouched and bumps the offering `version`; the repository module exports no update/delete for prices (asserted structurally).
3. **Overlap constraint** — seeding two same-`price_type` prices with the same `start_date_time` (overlapping effectivity, revised 2026-07-04) on one offering fails at the DB.
4. **Derived effectivity** — the price effective "now" is resolved from `start_date_time`; a future-dated successor does not displace the current price early; open-ended prices return `endDateTime: null`.
5. **JSONB validation** — tiered `pricing_characteristics` with a gap or overlap in tier bounds fails the Zod schema; `flat` + `amount NULL` and `tiered` + `amount NOT NULL` both fail.
6. **Deep link** — `?offering=PRDOFR000001` in a fresh session reproduces the selected view; an unknown offering ID renders the empty-detail state.
7. **Rename invariance** — every pre-existing Administration route passes its authz-matrix tests unchanged under `(app)` with identical URLs (module inv. #12).
