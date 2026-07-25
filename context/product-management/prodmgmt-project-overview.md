# Product Management — Project Overview

**Module:** Product Management (second module of the wholesale enterprise billing application)
**Users:** Billing Operations team
**Status:** SHIPPED — read-only catalog (units pm01–pm09) and the CRUD fast-follow (units pm10–pm24) are both implemented and ship-gate-verified. See `prodmgmt-progress-tracker.md` for build history and `_new-product-module-plan.md` / `_change-product-crud-plan.md` for the original decision records.
**Companion docs:** `prodmgmt-architecture.md` (technical design this module implements), `prodmgmt-code-standards.md` (conventions)

## Overview

The Product Management module is where Billing Operations views and maintains the products the billing system charges enterprise customers against. It has two pages under a shared "Products" nav section:

- **View Product** (`/products/product-offering`) — a read-only catalog viewer. Displays product offerings (e.g. "5G Nationwide Service Plan"), each offering's specifications (network-slice characteristics such as SST/SD identifiers held as JSONB), and each offering's prices (recurring, usage, and one-time charges, flat or tiered) on a single four-section page.
- **Manage Products** (`/products/manage-products`) — the CRUD page. Billing Operations can create an offering, attach and edit its specifications, add new prices, and move it through its lifecycle from draft to active to retired, using a copy-on-write versioning model rather than in-place editing of live data.

Editing a live (`ACTIVE`) offering never modifies that row — it creates a new draft version instead, and only one version of a given product can be `ACTIVE` at a time, so activating a new version automatically retires whichever version was active before it. Prices remain insert-only and immutable everywhere, across every version, so historical bill-run basis stays reproducible after prices change. The module reuses the shared platform core delivered by User Management: Better-Auth sessions, the code-seeded RBAC registry, the append-only audit log, and the `services/` → `db/repositories/` layering.

## Goals

1. Give Billing Operations one place to see every product offering, its specifications, and its prices without engineering assistance or direct SQL access (View Product).
2. Let Billing Operations create, edit, and retire product offerings themselves, without engineering writing SQL or seed files (Manage Products).
3. Establish the three product tables (`product_offering`, `product_specifications`, `product_offering_price`) as the system of record that later modules (Customer, Billing Service, Bill Run) reference by FK.
4. Make price data billing-safe: immutable, insert-only price rows with `start_date_time` effectivity, so any historical bill-run basis remains reproducible after prices change or an offering is edited.
5. Guarantee that a live offering's terms never change silently: editing an `ACTIVE` offering's fields, specifications, or prices always produces a new draft version, leaving the currently active version — and every historical bill computed against it — exactly as it was.
6. Guarantee that at most one version of a given product is billable at any moment: activating a new version automatically and atomically retires whichever version was previously active.
7. Extend the left navigation with a "Products" section (peer of "Administration") and rename the route group `(admin)` → `(app)`, a pattern every subsequent module follows.
8. Keep the two product pages structurally independent — View Product stays a pure read path with zero write-code imports, while Manage Products owns all mutation UI.
9. Reuse the mutation pattern (UI → server action → write service → repository → Postgres) already established elsewhere in the app, adding one new shared primitive (branching a draft from an existing offering) rather than a second architecture.

## Core User Flow

### Viewing the catalog (View Product)

1. A Billing Operations user signs in; their role grants the `products` permission at READ level.
2. They click "View Product" under the "Products" section in the left panel and land on `/products/product-offering`.
3. Section 1 (top) shows the offerings table: ID, name, lifecycle status, version, sellable flag, last modified. RETIRED offerings are hidden by default; the user can search by name, filter by `lifecycle_status`, sort columns, and page through results.
4. The user clicks a row. The selection is written to the URL (`?offering=PRDOFR000001`), making the view deep-linkable and back-button-safe.
5. Section 2 renders the selected offering's full detail: name, lifecycle badge, version, bundle/sellable/billing-only flags, last modified, last edited by.
6. Section 3 (bottom-left) lists the offering's specifications as cards: name, mandatory/default badges, and the `product_spec_characteristics` JSONB rendered as `key: value` text.
7. Section 4 (bottom-right) lists the offering's prices as cards: name, price type badge (recurring / usage / once), amount and currency for flat prices or the tier bounds/rates for tiered prices (plain inline text), charge period, GL code, and effectivity (`start_date_time`).
8. The user copies the URL to share the exact view with a colleague, or selects another offering. View Product itself has nothing to save — it is, and remains, read-only.

### Managing the catalog (Manage Products)

1. A Billing Operations user signs in; their role grants the `products` permission at EDIT (and, for retirement, DELETE) level.
2. They open the "Products" section in the left nav and click "Manage Products," landing on `/products/manage-products` — a sibling of "View Product" under the same nav section.
3. The page shows offerings grouped by product family — one row per family (its current `ACTIVE` version, or its latest `DRAFT` if the family has never gone live), with an option to expand and see every version in that family's history and each one's status.
4. The user clicks "New offering," fills in name and flags (sellable, billing-only — bundle is not user-settable) in a dialog, and saves. A brand-new offering is created as the root of a new family, in `DRAFT` status.
5. The user adds one or more specifications and at least one price to the `DRAFT`. Because it's still a draft, these edits apply directly to it — no versioning branch happens yet.
6. Once the draft has at least one price and its mandatory specifications are resolved, the user clicks "Activate." The draft becomes `ACTIVE` and billable. (If this family already had an active version, that version is retired automatically in the same action, labeled in the audit trail as superseded.)
7. Later, the user opens "View Product" and confirms the newly active version appears there exactly as any other `ACTIVE` offering — same detail, specs, and prices panels — and the previously active version (now `RETIRED`) is hidden by the default filter.
8. Months later, a rate change is needed. The user finds the family on "Manage Products" and clicks "Add price" on the `ACTIVE` row. Because the target is live, the system transparently clones it — offering, specifications, and prices — into a brand-new `DRAFT` version, and adds the new price to that clone. The originally active version, and everything a past bill was computed against, is untouched.
9. The user reviews the new draft, adjusts anything else needed (in place, since it's now a draft), and activates it once ready. The old active version is retired automatically; the new one takes over.
10. Separately, the user starts drafting a second product idea, decides against it before it ever goes live, and clicks "Discard" on that draft row. It moves to `RETIRED` directly — a soft delete, not a row deletion — and disappears from the default view.

## Features

### Catalog listing (View Product)
- Server-side paginated, sortable offerings table driven entirely by URL searchParams (RSC pattern shared with the Administration pages).
- Name search (case-insensitive substring) and `lifecycle_status` filter; RETIRED hidden by default.
- Row selection synced to `?offering=` for deep-linking.

### Offering detail (View Product)
- All `product_offering` columns displayed: flags, lifecycle badge, `version` (a row's sequence number within its version family — see *Versioning* below), `last_modified`, `last_edited_by` resolved to a user display name via FK to APPUSER.

### Specifications panel (View Product)
- Cards per `product_specifications` row scoped to the selected offering: mandatory/default indicators, `default_value`, and JSONB characteristics rendered as `key: value` plain text.

### Prices panel (View Product)
- Cards per `product_offering_price` row scoped to the selected offering.
- Flat prices show `amount` + `currency`; tiered prices render the tier array (`[{from, to, rate}, …]`) from `pricing_characteristics` JSONB as inline `from–to: rate` text.
- Effectivity display: `start_date_time` per price; a price's end is derived from its successor's start (no stored `end_date_time`).

### Offering management (Manage Products)
- Create dialog: name, `is_sellable`, `billing_only` — offering starts in `DRAFT` as the root of a new version family. `is_bundle` is never shown or settable in this UI; new offerings are always non-bundle.
- Edit dialog behavior depends on the target's status: a `DRAFT` can be saved in place or explicitly "saved as new" (a sibling draft version); an `ACTIVE` offering has no in-place option at all — any edit transparently produces a new draft version instead.
- No hard delete anywhere in the UI or the API surface. Removing an offering is always a lifecycle transition to `RETIRED` — "Discard" for a draft that never went live, "Retire" for a version that was active.

### Versioning and single-active-version guarantee (Manage Products)
- Every offering belongs to a version family, linked by `product_offering.family_offering_id` (nullable, self-referencing). The Manage Products table shows one row per family by default, expandable to the full version history.
- `version` is the row's sequence number within its family — the root is `1`, the first branch is `2`, and so on — assigned once at insert and never changed afterward, including for an in-place edit to an already-`DRAFT` row.
- At most one version per family can be `ACTIVE` at a time. Activating a draft automatically retires whichever other version in its family was active, in the same atomic action.
- Editing an `ACTIVE` version's own fields, specifications, or prices always clones it into a new `DRAFT` version first — the active row and everything attached to it are never modified in place.

### Specification management (Manage Products)
- Add and edit specifications on a `DRAFT`. On an `ACTIVE` offering, adding or editing a specification triggers the clone-to-new-draft behavior above, and the change lands on the new draft, not the live version.
- Hard delete is available for a specification, but only on a `DRAFT` row — and since specification writes against an `ACTIVE` offering always land on a freshly cloned draft first, this condition holds automatically rather than needing a separate check bolted on top.

### Price management (Manage Products)
- Add price: name, price type, pricing model (flat or tiered), currency, GL code, start date. On an `ACTIVE` offering, this triggers the clone-to-new-draft behavior; on a `DRAFT`, it applies directly.
- Prices remain insert-only everywhere. There is no edit or delete action for an existing price, on any offering, at any version.
- A new price's start date may be backdated up to 3 days; the form shows a non-blocking warning when it is. Earlier than that is rejected outright.

### Lifecycle transitions (Manage Products)
- `DRAFT → ACTIVE`: requires at least one price row and all mandatory specifications resolved. Available via "Activate" on a draft. Automatically retires the family's previous active version, if any, as part of the same action.
- `ACTIVE → RETIRED` ("Retire") and `DRAFT → RETIRED` ("Discard"): both a soft-delete transition to the same terminal status, with an optional free-text reason, labeled differently in the UI and the audit trail depending on which state the row was in.
- `RETIRED` is terminal — no path back to `DRAFT` or `ACTIVE`.

### Navigation & shell
- "Products" nav section with two items: "View Product" (lucide `Package`) and "Manage Products" (lucide `PackagePlus`), via the `NAV_ITEMS` → `NAV_SECTIONS` refactor of `admin-nav.tsx`; collapsed-rail behavior unchanged.
- Route group `(app)`; pages live at `app/(app)/products/product-offering/` and `app/(app)/products/manage-products/`.
- New "New offering" call-to-action button in the Manage Products page header — the page's one accent-filled primary action.

### Data integrity (enforced, not just displayed)
- Price rows are immutable and insert-only everywhere — the price repository exposes exactly one write method, `insertPrice`; a change inserts a new row, it never updates or deletes an existing one.
- Constraint: no two prices of the same `price_type` on one offering with the same `start_date_time` (DB UNIQUE constraint; derived windows never overlap by construction — a new price supersedes its predecessor from its start instant).
- Zod schema per `pricing_model` validates `pricing_characteristics` on every write (tiered requires contiguous, non-overlapping bounds).
- The single-active-version rule is enforced inside the same database transaction that performs an activation: any existing active sibling in the family is retired before, or as part of, the new version being marked active.
- Every mutation runs inside a database transaction paired with an audit-log write, so every create, branch, edit, activation, supersession, retirement, discard, specification change, and price addition is independently attributable and timestamped.
- "View Product" imports no write-path code — the read guarantees from the catalog viewer remain structurally enforced.

### Access control
- Single code-seeded `products` permission, page-level. READ gates View Product, including prices — no pricing-visibility split. EDIT gates offering/specification create-edit, branching, and price add on Manage Products; DELETE gates retirement and discard.
- Nav items render regardless of permission; each page guard (`requirePermission('products', 'READ' | 'EDIT')`) enforces access.

### Audit trail
- View Product reads are never audited.
- Manage Products writes: offering created, updated (in-place draft save), branched (new draft from an edit), activated, superseded (auto-retired by another version's activation), retired, discarded; specification created, updated, deleted; price added. The distinction between "retired" and "discarded," and between "retired" and "superseded," is preserved in the audit log even though some of these share the same underlying status transition.

## In Scope

- Three Drizzle-managed tables with migrations and seeds: `product_offering` (with a nullable, self-referencing `family_offering_id` + index linking version history), `product_specifications`, `product_offering_price` (`start_date_time` + `created_at`; `amount` nullable when `pricing_model = tiered`).
- IDs in seed format: prefix + zero-padded DB sequence (`PRDOFR`, `PRDSMD`, `PRDOFP`), one sequence per table.
- `lifecycle_status` enum `DRAFT / ACTIVE / RETIRED`; only ACTIVE is selectable for billing by later modules; at most one `ACTIVE` row per version family.
- Repositories and `services/product` for both reads (list/detail) and writes (create, update-in-place, branch-as-draft, specification CRUD, insert-price, activate, retire).
- The copy-on-write branch primitive: cloning an offering plus its specifications and prices into a new draft whenever an edit targets a live (`ACTIVE`) version.
- Zod validation schemas including per-`pricing_model` characteristics validation, and schemas for create/update-offering, create/update-specification, insert-price (with backdating check), and activate/retire.
- `products` permission seed (READ/EDIT/DELETE) and both page guards.
- View Product (four-section read-only page) and Manage Products (family-grouped offering list, row actions, create/edit/activate/retire/discard dialogs), the nav refactor, and the `(admin)` → `(app)` route-group rename.
- Optional reason/comment capture on activation and retirement/discard, stored in the audit log, not a new product-table column.
- Tests: repository/service unit tests, integration tests for every write path and versioning invariant, and authz-matrix entries for both pages.

## Out of Scope

- Hard delete of product offerings, specifications (once their offering has gone live), or prices — every removal path is a status transition, never a row deletion, except the DRAFT-only specification hard-delete.
- Editing or deleting an existing price row — prices are permanently insert-only, across every version.
- Any transition out of `RETIRED` — retirement and discard are both permanent.
- Any UI or code path that allows more than one version of a family to be `ACTIVE` at the same time.
- Making `is_bundle` user-editable — it stays a display-only, non-CRUD attribute; `is_bundle` is display-only, no `bundle_link` table, no child-offering view.
- Any database tables or columns beyond the three product tables plus the single `family_offering_id` lineage column — no changes to `product_specifications` or `product_offering_price`.
- API routes of any kind for product data — all writes go through Server Actions; reads flow through RSC pages calling `services/product` directly. `app/api/product*` never exists.
- CSV export, bulk edit, or bulk retirement of offerings.
- Bundle composition management.
- A separate pricing-visibility permission (`product_pricing`) — anyone who can see products sees prices.
- Rating/charging logic that consumes tiers — a later billing module concern; tier JSONB may migrate to a child table if that module needs SQL-queryable tiers.
- Semantics of the price `policy` column — carried as nullable text until a consumer defines it.
- Merging two version families together, or moving a version from one family to another.
- Changes to View Product's data, filters, or components beyond its nav label and page heading ("View Product").
- Replacement of the `TOREMOVE-Template-*` seed rows with the real catalog — a go-live data-migration task, not module code.

## Success Criteria

- A user whose role grants `products` READ can, from sign-in, reach `/products/product-offering`, find an offering by name search in a catalog of 100+ rows, and read its full detail, specifications, and prices — with zero engineering involvement.
- A user without the `products` permission is stopped by each page's guard (no-access state), and the authz test matrix covers both routes.
- The URL `?offering=PRDOFR000001` opened in a fresh session reproduces the exact same selected view on View Product (deep-link works).
- A user with `products` EDIT can, starting from sign-in, create a new offering, add a mandatory specification, add a flat price, and activate it — the offering reaches `ACTIVE` status and appears correctly on View Product with no engineering involvement.
- Activating a new version of a family that already has an active version automatically retires the previous one in the same action; at no point do both appear `ACTIVE` simultaneously, including under two near-simultaneous activation attempts.
- Editing any field, specification, or price on an `ACTIVE` offering leaves that exact row and its exact specification and price rows unchanged in the database, and produces exactly one new `DRAFT` row in the same family with the edit applied.
- A user with `products` DELETE can retire an `ACTIVE` version or discard a `DRAFT` that never went live; both disappear from View Product's default filter, and the audit log distinguishes "retired" from "discarded" from "superseded."
- Attempting to activate a `DRAFT` with no prices, or with unresolved mandatory specifications, is rejected with a specific error and the offering stays `DRAFT`.
- Attempting to backdate a new price's start date more than 3 days is rejected; backdating within 3 days succeeds with a visible warning.
- There is no UI control, server action, or repository method anywhere in the codebase that updates or deletes an existing price row, confirmed by a guardrail test that inspects the price repository's exported method names.
- Deleting a specification is only ever possible on a `DRAFT` row — confirmed both by the service logic and by a guardrail test asserting no code path calls it against an `ACTIVE` offering.
- View Product's source files import no write-path code, confirmed by a guardrail test.
- Every create, branch, edit, activation, supersession, retirement, discard, specification change, and price addition produces exactly one corresponding audit-log entry, with an optional reason captured when supplied.
- `db/schema/product.ts` shows exactly the three product tables plus `family_offering_id` and its index — `product_specifications` and `product_offering_price` are otherwise untouched from their original shape.
- `npm run typecheck`, `lint`, and the full test suite (including all guardrail and versioning-invariant tests) pass; existing Administration pages work unchanged under the `(app)` route group with zero URL changes.
