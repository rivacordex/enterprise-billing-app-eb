# Product Management — Project Overview

**Module:** Product Management (second module of the wholesale enterprise billing application)
**Users:** Billing Operations team
**Status:** Planned — decisions agreed 2026-07-03, see `_new-product-module-plan.md`
**Companion docs:** `architecture.md` (platform architecture this module inherits), `code-standards.md` (conventions)

## Overview

The Product Management module is a catalog viewer for the products the billing system charges enterprise customers against. It displays product offerings (e.g. "5G Nationwide Service Plan"), each offering's specifications (network-slice characteristics such as SST/SD identifiers held as JSONB), and each offering's prices (recurring, usage, and one-time charges, flat or tiered) on a single four-section page at `/products/product-offering`. Version 1 is strictly read-only — data enters through Drizzle seeds and SQL run by engineers — but the schema, services, and permission seeds are built CRUD-ready so the planned fast-follow adds editing without schema or service rework. The module reuses the shared platform core delivered by User Management: Better-Auth sessions, the code-seeded RBAC registry, the append-only audit log, and the `services/` → `db/repositories/` layering.

## Goals

1. Give Billing Operations one place to see every product offering, its specifications, and its prices without engineering assistance or direct SQL access.
2. Establish the three product tables (`product_offering`, `product_specifications`, `product_offering_price`) as the system of record that later modules (Customer, Billing Service, Bill Run) reference by FK.
3. Make price data billing-safe from day one: immutable price rows with `start_date_time` effectivity, so any historical bill-run basis remains reproducible after prices change.
4. Extend the left navigation with a "Products" section (peer of "Administration") and rename the route group `(admin)` → `(app)`, setting the folder pattern every future module follows.
5. Ship CRUD-ready foundations — `version` counter, `lifecycle_status` enum, `last_edited_by` FK, per-`pricing_model` Zod validation — so the editing fast-follow is additive only.

## Core User Flow

1. A Billing Operations user signs in; their role grants the `products` permission at READ level.
2. They click "Product Offering" under the new "Products" section in the left panel and land on `/products/product-offering`.
3. Section 1 (top) shows the offerings table: ID, name, lifecycle status, version, sellable flag, last modified. RETIRED offerings are hidden by default; the user can search by name, filter by `lifecycle_status`, sort columns, and page through results.
4. The user clicks a row. The selection is written to the URL (`?offering=PRDOFR000001`), making the view deep-linkable and back-button-safe.
5. Section 2 renders the selected offering's full detail: name, lifecycle badge, version, bundle/sellable/billing-only flags, last modified, last edited by.
6. Section 3 (bottom-left) lists the offering's specifications as cards: name, mandatory/default badges, and the `product_spec_characteristics` JSONB rendered as labeled chips (e.g. `SST_ID: 01`, `SD_ID: A0C4E2`).
7. Section 4 (bottom-right) lists the offering's prices as cards: name, price type badge (recurring / usage / once), amount and currency for flat prices or the tier table (bounds and rates from `pricing_characteristics` JSONB) for tiered prices, charge period, GL code, and effectivity (`start_date_time`).
8. The user copies the URL to share the exact view with a colleague, or selects another offering; there is nothing to save — the page is read-only.

## Features

### Catalog listing
- Server-side paginated, sortable offerings table driven entirely by URL searchParams (RSC pattern shared with the Administration pages).
- Name search (case-insensitive substring) and `lifecycle_status` filter; RETIRED hidden by default.
- Row selection synced to `?offering=` for deep-linking.

### Offering detail
- All `product_offering` columns displayed: flags, lifecycle badge, `version` (in-place metadata counter, bumped on any change), `last_modified`, `last_edited_by` resolved to a user display name via FK to APPUSER.

### Specifications panel
- Cards per `product_specifications` row scoped to the selected offering: mandatory/default indicators, `default_value`, and JSONB characteristics rendered as key–value chips.

### Prices panel
- Cards per `product_offering_price` row scoped to the selected offering.
- Flat prices show `amount` + `currency`; tiered prices render the tier array (`[{from, to, rate}, …]`) from `pricing_characteristics` JSONB as a mini table.
- Effectivity display: `start_date_time` per price; a price's end is derived from its successor's start (no stored `end_date_time`).

### Data integrity (enforced, not visible)
- Price rows are immutable — a change inserts a new row and bumps the offering `version`; `created_at` records insert time and can differ from `start_date_time` for future-dated prices.
- Constraint: no two prices of the same `price_type` on one offering with the same `start_date_time` (UNIQUE constraint; derived windows never overlap by construction — a new price supersedes its predecessor from its start instant; revised 2026-07-04, backdating caveat in architecture Inv. #2).
- Zod schema per `pricing_model` validates `pricing_characteristics` on every write (tiered requires contiguous, non-overlapping bounds).

### Access control
- Single code-seeded `products` permission, page-level, following the platform convention. READ gates the entire page including prices. EDIT/DELETE are seeded now but unused until the CRUD fast-follow.
- Nav items render regardless of permission; the page guard (`requirePermission('products', 'READ')`) enforces access.

### Navigation & shell
- New "Products" nav section with one item, "Product Offering" (lucide `Package` icon), via refactor of `NAV_ITEMS` → `NAV_SECTIONS` in `admin-nav.tsx`; collapsed-rail behavior unchanged.
- Route group renamed `(admin)` → `(app)`; page lives at `app/(app)/products/product-offering/`.

## In Scope

- Three Drizzle-managed tables with migrations and seeds: `product_offering`, `product_specifications`, `product_offering_price` (price gains `start_date_time` + `created_at`; `amount` nullable when `pricing_model = tiered`).
- IDs in seed format: prefix + zero-padded DB sequence (`PRDOFR`, `PRDSMD`, `PRDOFP`), one sequence per table.
- `lifecycle_status` enum `DRAFT / ACTIVE / RETIRED`; only ACTIVE is selectable for billing by later modules.
- Repositories and `services/product` for list (search / filter / sort / pagination) and detail (offering + specs + prices) reads.
- Zod validation schemas including per-`pricing_model` characteristics validation.
- `products` permission seed and page guard wiring.
- The four-section read-only page, nav refactor, and `(admin)` → `(app)` route-group rename (including the one-line folder-ownership updates already made to `usrmgmt-architecture.md` §2 and `usrmgmt-code-standards.md`).
- Tests: repository/service unit tests plus an authz-matrix entry for the new page.

## Out of Scope

- Create, update, delete, or lifecycle-transition UI — the CRUD fast-follow, not v1.
- CSV export of offerings or prices.
- Bundle composition: `is_bundle` is display-only; no `bundle_link` table, no child-offering view.
- New audit events — reads are not audited; CRUD events arrive with the CRUD phase.
- Pricing-visibility split (`product_pricing` permission) — anyone who can see products sees prices.
- Rating/charging logic that consumes tiers — a later billing module concern; tier JSONB may migrate to a child table if that module needs SQL-queryable tiers.
- Semantics of the price `policy` column — carried as nullable text until a consumer defines it.
- Replacement of the `TOREMOVE-Template-*` seed rows with the real catalog — a go-live data-migration task, not module code.

## Success Criteria

- A user whose role grants `products` READ can, from sign-in, reach `/products/product-offering`, find an offering by name search in a catalog of 100+ rows, and read its full detail, specifications, and prices — with zero engineering involvement.
- A user without the `products` permission is stopped by the page guard (no-access state), and the authz test matrix covers the new route.
- The URL `?offering=PRDOFR000001` opened in a fresh session reproduces the exact same selected view (deep-link works).
- Both seeded offerings render correctly, including the tiered Data Overage price displaying its tier bounds and rates from JSONB — no "(tiered)" placeholder text anywhere.
- Inserting a replacement price row (via SQL, simulating the future CRUD path) leaves the old row untouched, bumps the offering `version`, and the page shows the price effective now based on `start_date_time`.
- Attempting to seed two same-type prices with the same `start_date_time` on one offering fails the constraint (overlapping effectivity, revised 2026-07-04).
- `npm run typecheck`, `lint`, and the full test suite pass; existing Administration pages work unchanged under the renamed `(app)` route group with zero URL changes.
