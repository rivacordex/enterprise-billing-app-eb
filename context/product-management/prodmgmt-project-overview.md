# Product Management — Project Overview

**Module:** Product Management (second module of the wholesale enterprise billing application)
**Users:** Billing Operations (catalog — View Product & Manage Products) and Revenue Operations (Orders & Subscriptions; permissions `product_orders`, `product_inventory`)
**Status:** SHIPPED — the read-only catalog (units pm01–pm09), the Manage Products CRUD fast-follow (units pm10–pm24), the **Product Ordering & Inventory update** (units pm25–pm34), and the **Manage Products rebuild & catalog lifecycle update** (units pm35–pm45) are implemented and ship-gate-verified. See the "Completed Tracker" section at the end of `prodmgmt-progress-tracker.md` for the per-unit build record. The next planned update — pricing components (capacity commitment/motivation, the component envelope) — is specced in `prodmgmt-update-overview.md` and `_updatemodule-product-pricing-components-plan.md`.
**Companion docs:** `prodmgmt-architecture.md` (technical design, numbered **Module Invariants**), `prodmgmt-code-standards.md` (conventions)

## Overview

The Product Management module is where the business both **defines** the products the billing system charges enterprise customers against and **records the sale** of those products. It serves two audiences across four pages under a shared "Products" nav section.

**Catalog (Billing Operations):**

- **View Product** (`/products/product-offering`) — a read-only catalog viewer. Displays product offerings (e.g. "5G Nationwide Service Plan"), each offering's specifications (network-slice characteristics such as SST/SD identifiers held as JSONB), and each offering's prices (recurring, usage, and one-time charges, flat or tiered) on a single four-section page.
- **Manage Products** (`/products/manage-products`) — the CRUD page, rebuilt into the same four-section shape as View Product: a server-paged **families list**, a **version switcher**, a **specifications panel**, and a **pricing panel**, with editing and versioning controls in the panels. Billing Operations create an offering, edit its specifications and prices **inline while it is `DRAFT`**, and move it through a five-state lifecycle — `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED` — using a copy-on-write versioning model rather than in-place editing of live data. The page loads only the selected version's data (2 queries on first load; a further 4 on selecting a family), not the whole catalog.

**Ordering & Inventory (Revenue Operations):**

- **Orders** (`/products/orders`) — where a Revenue Operations user manually places an order of a billing-only offer (`billing_only = true`, `is_sellable = true`, `lifecycle_status = ACTIVE`) for a specific customer against a specific billing account (BAN), through a three-step form (customer → BAN → offer). A standard-price order validates, completes, and instantiates a subscription in one atomic transaction; an order carrying a negotiated price parks as `PENDING` until a manager (never the submitter) approves or rejects it.
- **Subscriptions** (`/products/subscriptions`) — the product inventory. Each completed order produces exactly one subscription, which pins the exact catalog offering version it was sold at (grandfathered pricing), records which BAN it bills to, and carries a suspend/resume/terminate lifecycle with an append-only status history. The subscription list is what the future bill run will rate; this module produces everything rating needs and nothing else.

Editing a live (`ACTIVE`) offering never modifies that row — it branches a new `DRAFT` copy of the whole version (offering fields, all specifications, all prices) instead, and only one version of a product can be `ACTIVE` at a time, so activating a new version automatically moves whichever version was active before it to `OBSOLETE` in the same transaction. A `DRAFT` version's specifications and prices are fully editable and deletable; from `TESTING` onward the version's content is immutable, enforced by the repository **and** a database trigger, not by UI discipline alone. A released version's prices never change, so any historical bill-run basis stays reproducible. Grandfathering is the ordering-side consequence of the same guarantee: a subscription FKs the exact offering version it was sold at, and an `OBSOLETE` version — not orderable, still billed for its existing subscriptions — keeps its prices byte-identical, so later catalog activations never change an existing subscriber's price. The module reuses the shared platform core delivered by User Management: Better-Auth sessions, the code-seeded RBAC registry, the append-only audit log, and the `services/` → `db/repositories/` layering.

## Goals

**Catalog:**

1. Give Billing Operations one place to see every product offering, its specifications, and its prices without engineering assistance or direct SQL access (View Product).
2. Let Billing Operations create, edit, release, and withdraw product offerings themselves, without engineering writing SQL or seed files (Manage Products).
3. Establish the three product tables (`product_offering`, `product_specifications`, `product_offering_price`) as the system of record that later modules (Customer, Billing Service, Bill Run) reference by FK.
4. Make price data billing-safe: a released version's prices are immutable with `start_date_time` effectivity, so any historical bill-run basis remains reproducible after prices change or an offering is superseded; `DRAFT` prices are freely editable and deletable, since no bill has ever been computed against a version that has never been released.
5. Guarantee that a live offering's terms never change silently: editing an `ACTIVE` offering's fields, specifications, or prices always branches a new `DRAFT` version, leaving the currently active version — and every historical bill computed against it — exactly as it was.
6. Guarantee that at most one version of a given product is billable at any moment: activating a new version automatically and atomically moves whichever version was previously active to `OBSOLETE` (still billed for existing subscriptions, no longer orderable).
7. Extend the left navigation with a "Products" section (peer of "Administration") and rename the route group `(admin)` → `(app)`, a pattern every subsequent module follows.
8. Keep the two product pages structurally independent — View Product stays a pure read path with zero write-code imports; Manage Products owns all mutation UI and imports View Product's read-only presentational components one-directionally.
9. Reuse the mutation pattern (UI → server action → write service → repository → Postgres) already established elsewhere in the app, adding one new shared primitive (branching a draft from an existing offering) rather than a second architecture.

**Manage Products rebuild & catalog lifecycle:**

10. Show an offering's prices and specifications on Manage Products itself, so Billing Operations never needs View Product to answer "what does this charge?".
11. Replace `DRAFT → ACTIVE → RETIRED` with `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`, where `OBSOLETE` means "not orderable, still billed for existing subscriptions" and `RETIRED` means "no subscription depends on this version any more".
12. Make a `DRAFT` version fully editable — add, change, and delete specifications and prices — while making everything from `TESTING` onward immutable, enforced by the repository and by a database trigger.
13. Make every price created through the app billable: a recurring price carries a charge period that maps onto a bill cycle; a usage price carries a unit of measure from a fixed list (`Mbps`, `GB`, `MB`, `EA`); a `once` price carries neither.
14. Replace the discard-sets-`RETIRED` behaviour with a real hard delete of never-released versions, so `RETIRED` carries exactly one meaning.
15. Enforce "one open version per family" and "one ACTIVE version per family" in the database, as unique indexes backing the in-transaction lock, and cut Manage Products' first load to 2 queries by moving family grouping into a server-paged repository read model.

**Ordering & Inventory:**

16. Record every sale as a TMF622-shaped order (`ordering.product_order` + `ordering.product_order_item`) with the full TMF622 status enum seeded and the module persisting `ACKNOWLEDGED / PENDING / COMPLETED / REJECTED`. `FAILED` remains seeded solely for enum completeness and is never written — a failed order rolls back fully rather than persisting a FAILED row.
17. Instantiate exactly one TMF637-shaped subscription (`inventory.product_inventory`) per completed order item, automatically, in the same transaction as order completion — no manual fulfilment step.
18. Guarantee grandfathered pricing: the order item and subscription FK the exact `product.product_offering` version row ordered; later catalog version activations never change an existing subscriber's price.
19. Make every customer price provable: either an immutable catalog price row or an insert-only, manager-approved override row in `ordering.order_item_price_override` — no third source, no editable price anywhere.
20. Give subscriptions a billing-safe lifecycle: suspend, resume, and terminate actions writing an append-only, gap-free `inventory.inventory_status_history`, so the bill run can prorate around suspension windows without interpretation.
21. Keep Revenue Operations' access separate from catalog administration: two new permissions (`product_orders`, `product_inventory`) with no grant overlap against the existing `products` permission.

## Core User Flows

### Viewing the catalog (View Product)

1. A Billing Operations user signs in; their role grants the `products` permission at READ level.
2. They click "View Product" under the "Products" section in the left panel and land on `/products/product-offering`.
3. Section 1 (top) shows the offerings table: ID, name, lifecycle status, version, sellable flag, last modified. `OBSOLETE` and `RETIRED` offerings are hidden by default; the user can search by name, filter by `lifecycle_status`, sort columns, and page through results.
4. The user clicks a row. The selection is written to the URL (`?offering=PRDOFR000001`), making the view deep-linkable and back-button-safe.
5. Section 2 renders the selected offering's full detail: name, lifecycle badge, version, bundle/sellable/billing-only flags, last modified, last edited by.
6. Section 3 (bottom-left) lists the offering's specifications as cards: name, mandatory/default badges, and the `product_spec_characteristics` JSONB rendered as `key: value` text.
7. Section 4 (bottom-right) lists the offering's prices as cards: name, price type badge (recurring / usage / once), amount and currency for flat prices or the tier bounds/rates for tiered prices, the recurring charge period or the usage unit of measure, GL code, and effectivity (`start_date_time`, derived end from the successor's start).
8. The user copies the URL to share the exact view with a colleague, or selects another offering. View Product itself has nothing to save — it is, and remains, read-only.

### Managing the catalog (Manage Products)

1. A Billing Operations user signs in; their role grants the `products` permission at EDIT (and, for withdrawal, DELETE) level.
2. They open the "Products" section and click "Manage Products," landing on `/products/manage-products`. The page renders a server-paged list of product **families**, one row each: name, the primary version's status badge, version count, sellable and billing-only chips, last modified. (Primary version = the family's `ACTIVE` version, else its open `DRAFT`/`TESTING` version, else its highest version number.)
3. The user searches or filters by status — both run in SQL against the paged query, no client-side row filtering — then selects a family row. The URL becomes `?family=PRDOFR000004&version=PRDOFR000011`, and three panels load for that version: offering detail, specifications, and prices grouped by price type with each row's derived effectivity (current / future / superseded).
4. The user switches to another version of the same family from the version bar (version number + status badge per entry); only the three detail queries rerun.
5. The user edits a version whose status is `ACTIVE`. The first edit branches a new `DRAFT` copy of the whole version — offering fields, all specifications, all prices — assigns the family's next version number, and redirects to it. The `ACTIVE` version is untouched. If the family already has an open version, the user is taken to that one; a second open version is refused.
6. On the `DRAFT` version, the user edits inline: renames the offering, edits or deletes a specification, edits a price's amount or tiers, deletes a price row, or adds a future-dated successor price of the same type (permitted only while `DRAFT` — how a contractual step-up is set up before the customer signs).
7. The user adds a **recurring** price (name, amount or tiers, currency, GL code, start date, and a charge period that maps onto a supported bill cycle), a **usage** price (additionally a unit of measure from `Mbps` / `GB` / `MB` / `EA`), or a **once** price (neither). A tiered recurring or tiered usage price saves with a visible warning that no downstream component can bill it yet.
8. The user clicks **Submit for testing**. The service re-reads status under lock and checks the release preconditions — at least one price row, at least one specification, and every mandatory specification resolved to a non-null default. The version becomes `TESTING` and its content becomes read-only. **Back to draft** returns it to `DRAFT` and editable.
9. The user clicks **Activate**. In one transaction the version becomes `ACTIVE` and the family's previously `ACTIVE` version becomes `OBSOLETE`. New orders pick the new version; every existing subscription keeps billing from its pinned version.
10. To stop selling a product with no replacement (`products : DELETE`), the user moves the `ACTIVE` version directly to `OBSOLETE`.
11. To retire an `OBSOLETE` version (`products : DELETE`), the service counts subscriptions pinned to it that are not terminated (or terminated with an `end_date` today or later). Zero → the version becomes `RETIRED`, terminal. Non-zero → refused, with the blocking subscription count shown.
12. To discard an unreleased version (`products : DELETE`), a `DRAFT` or `TESTING` version that was never `ACTIVE` is **hard-deleted** with its specifications and prices in one transaction, writing a `PRODUCT_OFFERING_DELETED` audit event with the version id, name, version number, and removed counts.

### Placing an order (Orders)

1. A Revenue Operations user (role grants `product_orders` EDIT) opens **Products → Orders** and clicks **New order**.
2. **Step 1 — Customer:** the user searches and selects a customer party role. Only `ACTIVE` parties can proceed; a `VALIDATED`, `SUSPENDED`, or `CLOSED` party blocks with the reason shown.
3. **Step 2 — Billing account:** the customer's non-closed BANs are listed with their bill cycle and payment terms shown read-only (cycle lives on the BAN). Exactly one open BAN is auto-preselected. The user selects the BAN the subscription will bill to.
4. **Step 3 — Offer:** the picker lists offerings where `lifecycle_status = ACTIVE AND billing_only = true AND is_sellable = true`, with current effective prices shown read-only from the immutable price rows. The user sets quantity (integer ≥ 1, default 1), start date (default today; future allowed; ≤ 3-day backdating with warning), fills instance characteristics (key/value rows prefilled from the version's spec characteristics), and optionally enters a negotiated price per flat-model price type. Entering any override shows "this order will require manager approval."
5. **Submit:** the server re-runs all validation inside one transaction with row locks — party `ACTIVE`, BAN non-closed, offering still `ACTIVE`, at least one price row, overrides target existing flat price types. No override: the same transaction creates the subscription (`ACTIVE`, characteristics copied, first status-history row) and completes the order. Override present: the order commits as `PENDING` with no inventory.

### Reviewing an override order (Orders → Review)

6. A MANAGER-role user with `product_orders` EDIT who is **not** the submitter opens the pending order, sees list vs negotiated price side by side, and either approves (full validation re-runs under locks at approval time, then instantiation runs and the order completes, stamped `reviewed_by`/`reviewed_at`) or rejects with a reason (`REJECTED`, terminal, no inventory). The submitter can never approve their own order; corrections are reject + re-order (no edit/amend path).

### Managing subscriptions (Subscriptions)

7. The user opens **Products → Subscriptions** (`product_inventory` READ) and confirms the new subscription row: customer, BAN, pinned offer version, quantity, start date, status `ACTIVE`.
8. Later, a user with `product_inventory` EDIT suspends the subscription (effective date + reason), resumes it (effective date), or terminates it (end date + reason, terminal). Each action row-locks the instance, validates the transition (`ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE|SUSPENDED→TERMINATED`), appends a status-history row, and updates the status column in one transaction. Effective dates obey the 3-day backdating tolerance and the inclusive-billed-day convention. Editing a subscription's instance characteristics updates `instance_characteristics` only (with an audit event) — never a rating input.

## Features

### Catalog listing (View Product)

- Server-side paginated, sortable offerings table driven entirely by URL searchParams (RSC pattern shared with the Administration pages).
- Name search (case-insensitive substring) and `lifecycle_status` filter; `OBSOLETE` and `RETIRED` hidden by default.
- Row selection synced to `?offering=` for deep-linking.

### Offering detail (View Product)

- All `product_offering` columns displayed: flags, lifecycle badge, `version` (a row's sequence number within its version family — see _Versioning_ below), `last_modified`, `last_edited_by` resolved to a user display name via FK to APPUSER.

### Specifications panel (View Product)

- Cards per `product_specifications` row scoped to the selected offering: mandatory/default indicators, `default_value`, and JSONB characteristics rendered as `key: value` plain text.

### Prices panel (View Product)

- Cards per `product_offering_price` row scoped to the selected offering.
- Flat prices show `amount` + `currency`; tiered prices render the tier array (`[{from, to, rate}, …]`) from `pricing_characteristics` JSONB as inline `from–to: rate` text.
- A recurring price shows its charge period (length + type); a usage price shows its unit of measure (`Mbps` / `GB` / `MB` / `EA`); a `once` price shows neither.
- Effectivity display: `start_date_time` per price; a price's end is derived from its successor's start (no stored `end_date_time`).

### Catalog browsing and selection (Manage Products)

- Server-paged families list: one row per family, page size from the `products.offering_list_page_size` config key; server-side name search and lifecycle-status filter.
- Version bar for the selected family: every version with its status badge, one click to switch.
- URL-held selection (`?family=…&version=…`), so deep links and the browser back button work with no client state.
- Per-version panels: offering detail, specifications, and prices with derived effectivity (`current` / `future` / `superseded`) computed from each successor's `start_date_time`. Manage Products imports View Product's read-only presentational components (one-directional; the reverse stays forbidden).

### Offering and specification management (Manage Products)

- Create dialog: name, `is_sellable`, `billing_only` — offering starts in `DRAFT` as the root of a new version family. `is_bundle` is never shown or settable; new offerings are always non-bundle.
- Inline editing in the specifications and pricing panels for `DRAFT` versions; dialogs reserved for consequential confirmations (submit for testing, activate, stop selling, retire, discard).
- Add, edit, and delete specifications on a `DRAFT` version. On an `ACTIVE` version, any spec edit first branches a new `DRAFT` and lands there.
- Branch-on-edit for `ACTIVE` versions, with the "this creates a new draft" warning; a second open version in a family is refused.

### Versioning and single-active-version guarantee (Manage Products)

- Every offering belongs to a version family, linked by `product_offering.family_offering_id` (nullable, self-referencing). The families list shows one row per family; the version bar shows the full history.
- `version` is the row's sequence number within its family — the root is `1`, the first branch is `2`, and so on — assigned once at insert and never changed afterward.
- At most one version per family can be `ACTIVE`, and at most one can be *open* (`DRAFT` or `TESTING`), at a time — both enforced by expression unique indexes on `COALESCE(family_offering_id, product_offering_id)` backing the in-transaction advisory lock and re-check.
- Editing an `ACTIVE` version's own fields, specifications, or prices always branches a new `DRAFT` version first — the active row and everything attached to it are never modified in place.

### Price management (Manage Products)

- Add price: name, price type, pricing model (flat or tiered), currency, GL code, start date, and the per-type required fields — a **charge period** (length ∈ {1,3,12} months + type) for `recurring`, a **unit of measure** (`Mbps` / `GB` / `MB` / `EA`) for `usage`, neither for `once`.
- Edit and delete a price row — new capability, permitted only while the version is `DRAFT`. Several dated prices of one price type per version are permitted only while `DRAFT` (how a contractual step-up is staged).
- A released version's prices are immutable: from `TESTING` onward, a price update or delete is refused by the repository **and** by a database trigger.
- A new price's start date may be backdated up to 3 days with a non-blocking warning; earlier than that is rejected outright.
- A quiet warning on price shapes nothing downstream can bill yet: tiered recurring (bm29 fails with `RECURRING_PRICE_UNSUPPORTED`) and tiered usage (rating v1 is FLAT-only).

### Lifecycle transitions (Manage Products)

- Five statuses: `DRAFT`, `TESTING`, `ACTIVE`, `OBSOLETE`, `RETIRED`.
- `DRAFT → TESTING` ("Submit for testing"): requires at least one price row, at least one specification, and every mandatory specification resolved. `TESTING` is read-only, not orderable, not billable, counts as the family's open version, and is reversible to `DRAFT` ("Back to draft").
- `TESTING → ACTIVE` ("Activate"): moves the family's previous `ACTIVE` version to `OBSOLETE` in the same transaction.
- `ACTIVE → OBSOLETE` ("Stop selling"): withdraw a live product with no replacement (`products : DELETE`).
- `OBSOLETE → RETIRED` ("Retire", `products : DELETE`): gated on live subscriptions — refused while any subscription pinned to the version is not terminated (or terminated with an `end_date` today or later), with the blocking count shown.
- Discard (`products : DELETE`): a `DRAFT` or `TESTING` version that was never `ACTIVE` is hard-deleted with its specifications and prices. `RETIRED` is terminal.

### Order capture (Orders)

- Three-step order form: customer search → BAN selection → offer/quantity/dates/characteristics/price. One order item per order in the UI (schema supports multiple; UI creates one).
- Party gate: `ACTIVE` only. BAN gate: any non-closed state. Offer gate: `ACTIVE ∧ billing_only ∧ is_sellable`.
- Quantity column (integer ≥ 1, default 1) on order item and subscription; one subscription row regardless of quantity — rating multiplies.
- Start date: user-chosen, default today, future-dating allowed, backdating limited to 3 days with a non-blocking warning.
- Instance characteristics: key/value editor prefilled from the pinned version's spec characteristics; stored write-once on the order item (`ordered_characteristics`), copied to the subscription as living values (`instance_characteristics`).

### Pricing and approval (Orders)

- No price snapshot columns anywhere: the pinned version FK is the snapshot, because activated versions' specs and prices are frozen by the catalog's copy-on-write invariants and stay frozen through `OBSOLETE`.
- Optional negotiated price per flat-model price type, stored in insert-only `ordering.order_item_price_override` (UNIQUE per item + price type; currency must match the BAN; tiered price types not overridable).
- Manager approval workflow for override orders: `PENDING` state, approve/reject by a MANAGER ≠ submitter, full re-validation at approval time, `reviewed_by`/`reviewed_at` stamped on either outcome.
- Stated rating contract for the future bill run: per price type, use the override row if present, else the catalog price row effective on the rating date.

### Subscription lifecycle (Subscriptions)

- Subscription born `ACTIVE` at order completion; TMF637 status enum fully seeded, phase uses `ACTIVE / SUSPENDED / TERMINATED`.
- Suspend pauses charges from its effective date; resume restarts them; terminate sets `end_date` and is terminal.
- Append-only, gap-free `inventory_status_history` — every transition recorded with effective date, reason, and actor; suspension windows derived from consecutive rows; repository permanently exports no update/delete for this table.
- Edit-characteristics action on subscriptions: updates `instance_characteristics` only, with audit event — never a rating input.

### Order and subscription lists (Orders, Subscriptions)

- Orders list columns: order id, customer, BAN, offer + version, quantity, start date, negotiated-price indicator, status, submitted by/at, reviewed by/at; `PENDING` rows badged with a Review action.
- Subscriptions list columns: subscription id, customer, BAN, pinned offer version, quantity, start/end dates, status, expandable status history; row actions gated by the current status.

### Navigation & shell

- "Products" nav section with four items: "View Product" (lucide `Package`), "Manage Products" (lucide `PackagePlus`), "Orders", and "Subscriptions", via the `NAV_ITEMS` → `NAV_SECTIONS` refactor of `admin-nav.tsx`; collapsed-rail behavior unchanged.
- Route group `(app)`; pages live at `app/(app)/products/{product-offering,manage-products,orders,subscriptions}/`.
- Accent-filled primary actions: "New offering" on Manage Products, "New order" on Orders.
- Badge treatments: `TESTING` (info tint, flask icon) and `OBSOLETE` (muted row, history icon, Retire as the only action).

### Data integrity (enforced, not just displayed)

- A released version's prices are immutable: price update/delete is permitted only while the parent offering is `DRAFT`, refused by the repository **and** by a `BEFORE INSERT OR UPDATE OR DELETE` trigger on `product_specifications` and `product_offering_price` rejecting any parent whose status is not `DRAFT`. The `order_item_price_override` and `inventory_status_history` repositories remain permanently insert-only (finders only).
- Per-price-type completeness: a `recurring` price carries a charge period and no unit; a `usage` price carries a unit from `Mbps`/`GB`/`MB`/`EA` and no period; a `once` price carries neither — enforced by DB CHECKs and by discriminated Zod schemas.
- Constraint: no two prices of the same `price_type` on one offering with the same `start_date_time` (DB UNIQUE; derived windows never overlap by construction).
- Two expression unique indexes on `COALESCE(family_offering_id, product_offering_id)`: `product_offering_one_active_per_family` (where status `ACTIVE`) and `product_offering_one_open_per_family` (where status `DRAFT` or `TESTING`), backing the in-transaction lock for a family root and a branch alike.
- `ON DELETE cascade` from `product_specifications` and `product_offering_price` to `product_offering` (the self-referencing `family_offering_id` stays `restrict`), so a discard hard-deletes children in one transaction.
- Order approval always re-runs the full submission validation set under locks at approval time, and never accepts reviewer = submitter — enforced in the service and backstopped by the `product_order_reviewer_check` DB CHECK.
- All mutations follow the house TOCTOU rule: precondition reads are re-checked on the transaction with `FOR UPDATE` before writing.
- Every mutation runs inside a database transaction paired with an audit-log write, so every create, branch, edit, submit-for-testing, return-to-draft, activation, supersession-to-obsolete, retirement, discard (hard delete), specification change, price add/update/delete, order event, and subscription-lifecycle transition is independently attributable and timestamped.
- "View Product" imports no write-path code — the read guarantees remain structurally enforced.

### Access control

- Catalog: single code-seeded `products` permission, page-level. READ gates View Product, including prices — no pricing-visibility split. EDIT gates offering/specification/price create-edit, branching, submit-for-testing, back-to-draft, and activate on Manage Products; DELETE gates discard (hard delete), stop selling (→ `OBSOLETE`), and retire (→ `RETIRED`).
- Ordering & Inventory: two code-seeded permissions with no grant overlap against `products`. `product_orders` (READ sees the Orders list; EDIT places and reviews orders — approval additionally requires the MANAGER role, checked live). `product_inventory` (READ sees the Subscriptions list; EDIT drives suspend/resume/terminate and characteristics edits).
- Nav items render regardless of permission; each page guard (`requirePermission(<name>, 'READ' | 'EDIT')`) enforces access, and each action re-checks its level server-side under `FOR UPDATE`.

### Audit trail

- View Product and Subscriptions/Orders list reads are never audited.
- Catalog writes: offering created, updated (in-place draft save), branched (new draft from an edit), `PRODUCT_OFFERING_SUBMITTED_FOR_TESTING`, `PRODUCT_OFFERING_RETURNED_TO_DRAFT`, activated, `PRODUCT_OFFERING_SUPERSEDED` (auto-moved to `OBSOLETE` by another version's activation, `afterData.lifecycleStatus = 'OBSOLETE'`), `PRODUCT_OFFERING_OBSOLETED` (stop selling), retired, `PRODUCT_OFFERING_DELETED` (discard hard delete); specification created, updated, deleted; `PRODUCT_PRICE` added, `PRODUCT_PRICE_UPDATED`, `PRODUCT_PRICE_DELETED`. `PRODUCT_OFFERING_DISCARDED` is removed.
- Ordering/Inventory writes: `PRODUCT_ORDER_CREATED / _PENDING_APPROVAL / _APPROVED / _REJECTED / _COMPLETED / _FAILED` and `PRODUCT_INVENTORY_CREATED / _CHARACTERISTICS_UPDATED / _SUSPENDED / _RESUMED / _TERMINATED`.
- `PRODUCT_ORDER_FAILED` is seeded but unused — orders roll back fully rather than persisting a FAILED row.

## In Scope

**Catalog:**

- Three Drizzle-managed tables with migrations and seeds: `product_offering` (with a nullable, self-referencing `family_offering_id` + index linking version history), `product_specifications`, `product_offering_price` (`start_date_time` + `created_at`; `amount` nullable when `pricing_model = tiered`; per-price-type charge-period/unit fields populated, never `NULL` where required).
- IDs in seed format: prefix + zero-padded DB sequence (`PRDOFR`, `PRDSMD`, `PRDOFP`), one sequence per table.
- `lifecycle_status` enum `DRAFT / TESTING / ACTIVE / OBSOLETE / RETIRED`; only `ACTIVE` is orderable; `ACTIVE` and `OBSOLETE` are billable; at most one `ACTIVE` and one open version per family, index-backed.
- Repositories and `services/product` for reads (families-page read model `findFamilyPage`, version list, detail) and writes (create, update-in-place, branch-as-draft, specification CRUD, insert/update/delete-price DRAFT-only, submit-for-testing, return-to-draft, activate, obsolete, retire, discard hard delete).
- The copy-on-write branch primitive: cloning an offering plus its specifications and prices into a new draft whenever an edit targets a live (`ACTIVE`) version.
- Zod validation including per-`pricing_model` characteristics validation and the discriminated per-price-type input schema (period on `recurring`, unit on `usage`, neither on `once`), plus schemas for create/update-offering, create/update/delete-specification, insert/update/delete-price (with backdating check), and the transition services.
- CHECK constraints for the per-price-type required fields and the unit list; the two family unique indexes; the DRAFT-guard trigger; cascade FKs.
- `products` permission seed (READ/EDIT/DELETE) and both catalog page guards.
- View Product (four-section read-only page) and Manage Products (families list + version bar + three panels, inline DRAFT editing, transition dialogs), the nav refactor, and the `(admin)` → `(app)` route-group rename.
- Optional reason/comment capture on transitions, stored in the audit log, not a new product-table column.

**Ordering & Inventory:**

- Manual order creation (three-step form) for billing-only offers, single order item per order (schema supports multiple items; UI creates one).
- Automatic subscription instantiation in the order-completion transaction.
- Negotiated price overrides on flat price types, with the manager approval workflow (`PENDING → COMPLETED / REJECTED`).
- Orders list and Subscriptions list pages with the columns and actions above; two new nav entries.
- Suspend / resume / terminate with append-only status history and guarded transitions; editable instance characteristics on subscriptions, with audit.
- Permissions `product_orders` and `product_inventory` (code-seeded), authz-matrix entries for both pages.
- Full TMF622 and TMF637 status enum seeding, used subset as stated.
- Five new tables across schemas `ordering` and `inventory` (`product_order`, `product_order_item`, `order_item_price_override`, `product_inventory`, `inventory_status_history`), text PKs from prefixed sequences (`PRDORD`, `PRDORI`, `PRDOPO`, `PRDINV`, `PRDIVE`), with migrations, seeds, repositories, services, Zod validation, and unit/integration tests per platform standards.

**Cross-cutting:**

- Tests: repository/service unit tests, integration tests for every write path and versioning/lifecycle invariant, concurrency tests for the single-active/single-open and approval/lifecycle races, and authz-matrix entries for all four pages.

## Out of Scope

**Catalog:**

- Hard delete of an `ACTIVE`, `OBSOLETE`, or `RETIRED` offering — only a never-released `DRAFT`/`TESTING` version is hard-deleted (discard); every other removal is a status transition. Specifications and prices are hard-deletable only on a `DRAFT`.
- Editing or deleting a price row on any released version (`TESTING` onward) — released prices are immutable; `DRAFT` prices are editable.
- Any transition out of `RETIRED` — retirement is permanent and terminal.
- What `TESTING` actually does beyond being read-only, not orderable, not billable, and reversible to `DRAFT`: no sandbox order path, no dry-run bill, no test-data isolation. A later phase defines it.
- Any UI or code path that allows more than one `ACTIVE`, or more than one open, version of a family at the same time.
- Making `is_bundle` user-editable — it stays a display-only, non-CRUD attribute; no `bundle_link` table, no child-offering view.
- CSV export, bulk edit, or bulk withdrawal of offerings; bundle composition management.
- A separate pricing-visibility permission (`product_pricing`) — anyone who can see products sees prices.
- Semantics of the price `policy` column — carried as nullable text until a consumer defines it.
- `PER_UNIT`, tiered, or block rating; tiered recurring support in bm29 — rating-side work, hand-offs.
- Normalising units between the catalog and the rating feed (e.g. `Mbps` vs `MBPS`, `MB`/`GB` coexistence) — recorded as hand-offs, not built here.
- Merging two version families, moving a version between families, or migrating tier JSONB to a child table.
- Replacement of the `Demo — *` seed rows (opt-in `db:seed-demo`) with the real catalog — a go-live data-migration task, not module code.
- A relabelling migration or backfill: under the fresh-install assumption (D11), every environment rebuilds its database, so `0006_product.sql` is edited in place.

**Ordering & Inventory:**

- Rating and the bill run itself — this module produces rating inputs only.
- The bill cycle catalog and BAN cycle assignment — owned by the accounts module (`billing.bill_cycle`); this module only displays the selected BAN's cycle.
- Multi-line orders in the UI, order edit/cancel/amend (a `PENDING` order can only be approved or rejected; corrections are reject + re-order), async or queued fulfilment.
- Non-billing-only offers and any external provisioning integration.
- Repricing or migrating an existing subscription to a newer catalog version (a grandfathering consequence — future migration flow).
- Per-seat inventory fan-out and partial-quantity lifecycle (e.g., suspend 2 of 5 seats).
- Tiered-price overrides; approval tolerance bands (±N% auto-approve); changing an approved override (terminate + re-order).
- The resume-day proration rule — the effective date is captured; the charge-or-not decision belongs to the bill-run phase.
- Moving a subscription to a different BAN or customer; notifications; bulk import.

**Cross-cutting:**

- API routes of any kind for product, ordering, or inventory data — all writes go through Server Actions; reads flow through RSC pages calling `services/*` directly. `app/api/product*`, `app/api/ordering*`, `app/api/inventory*`, and any TMF620 external API never exist.
- Maker-checker or approval routing for catalog changes — `products : EDIT` / `DELETE` remain the only gates.
- Snapshot-copying catalog spec/price rows into orders or inventory — rejected by design; the pinned version FK is the snapshot.
- Any database tables or columns beyond the three product tables (plus the `family_offering_id` lineage column) and the five ordering/inventory tables.

## Success Criteria

**Catalog:**

- A user whose role grants `products` READ can, from sign-in, reach `/products/product-offering`, find an offering by name search in a catalog of 100+ rows, and read its full detail, specifications, and prices — with zero engineering involvement.
- A user without the `products` permission is stopped by each page's guard (no-access state), and the authz test matrix covers both catalog routes.
- The URL `?offering=PRDOFR000001` opened in a fresh session reproduces the exact same selected view on View Product; on Manage Products, `?family=…&version=…` reproduces the selected version.
- Manage Products' first load issues exactly 2 database queries (families page + count); selecting a family adds the version list + detail + specifications + prices; switching version reruns only the version list + detail. No code path fetches detail for an unselected row.
- A user with `products` EDIT can, from sign-in, create a new offering, add a mandatory specification, add a monthly recurring price and a `GB` usage price, submit for testing, and activate it — the version reaches `ACTIVE` and appears on View Product with no engineering involvement.
- Every transition in the lifecycle (`DRAFT→TESTING`, `TESTING→DRAFT`, `TESTING→ACTIVE`, `ACTIVE→OBSOLETE`, `OBSOLETE→RETIRED`, discard) succeeds, and every illegal transition is refused with a typed result code, proven by integration tests.
- Activating a new version automatically moves the family's previous `ACTIVE` version to `OBSOLETE` in the same action; both never appear `ACTIVE` simultaneously, including under two near-simultaneous activation attempts (exactly one `ACTIVE`, never zero or two).
- A direct SQL insert of a second `ACTIVE`, or a second open, version in one family is rejected by a unique index — for a family root and for a branch alike.
- A price update or delete against a `TESTING`, `ACTIVE`, `OBSOLETE`, or `RETIRED` version is refused by the repository **and** by the database trigger on a direct SQL write; on a `DRAFT` version, editing and deleting a price works.
- Editing any field, specification, or price on an `ACTIVE` offering leaves that exact row and its exact specification and price rows unchanged, and produces exactly one new `DRAFT` row in the same family with the edit applied.
- Discarding a `DRAFT` or `TESTING` version that was never `ACTIVE` removes its specifications and prices, leaves every other family member untouched, and writes one `PRODUCT_OFFERING_DELETED` audit event; no path deletes an `ACTIVE`, `OBSOLETE`, or `RETIRED` version.
- Retiring is refused while any subscription pinned to the version is not terminated (or terminated with an `end_date` today or later); the refusal names the blocking count. Activating a new version of an ordered offer leaves the existing subscription's pinned `product_offering_id` and its price reads byte-identical, with the superseded version now `OBSOLETE`.
- Submitting for testing with no prices, no specifications, or an unresolved mandatory specification is rejected with a specific error and the version stays `DRAFT`.
- A recurring price with no charge period, a usage price with no unit, a `once` price carrying either, a unit outside `Mbps`/`GB`/`MB`/`EA`, and a charge period the bill-run mapping does not cover each fail in Zod and at the database.
- Backdating a new price's start date more than 3 days is rejected; within 3 days succeeds with a visible warning.
- No code path outside the product module treats `OBSOLETE` as unbillable, including the flow SQL under `workflow-management/**`.
- `db/schema/product.ts` shows exactly the three product tables plus `family_offering_id`, its index, the two family unique indexes, the DRAFT-guard trigger, the cascade FKs, and the per-price-type CHECKs.

**Ordering & Inventory** (each verifiable by test or by a live walkthrough):

- A RevOps user can complete the full flow — search a customer, select a BAN, order 5 × an active billing-only offer within the 3-day backdating tolerance — and one `COMPLETED` order plus one `ACTIVE` subscription with matching characteristics exist afterward, created in a single transaction (verified by integration test asserting no intermediate committed state).
- Submitting for a `VALIDATED` party, a closed BAN, or a non-sellable/non-`ACTIVE` offering is rejected server-side with a specific error code, even when the UI is bypassed (service-level tests).
- An order with a negotiated price commits as `PENDING` with zero inventory rows; the submitter cannot approve it; a manager's approval re-validates and then creates the subscription; rejection leaves `REJECTED` and zero inventory rows (tests for all three paths plus the approve-vs-reject race under concurrency).
- After a new catalog version of the ordered offer activates, the existing subscription's pinned `product_offering_id` and its rateable prices are unchanged (grandfathering test), and the now-`OBSOLETE` version's rows remain readable through the subscription's read path.
- Suspending and later resuming a subscription produces the expected additional history rows whose derived suspension window matches those dates; illegal transitions are rejected; two concurrent lifecycle actions on the same subscription serialize with one winner (concurrency test).
- Effective dates more than 3 days in the past are rejected on every lifecycle action and on order start date; dates within tolerance succeed with the warning shown.
- Every mutation writes its audit event; `inventory_status_history` and `order_item_price_override` have no update/delete repository method (guardrail test asserting the exported surface).
- The authz matrix covers both new pages: no `product_orders` grant → `/products/orders` redirects to `/no-access`; no `product_inventory` grant → `/products/subscriptions` redirects; catalog `products` grants confer no access to either, both directions. A principal with EDIT but not DELETE cannot discard, obsolete, or retire.

**Cross-cutting:**

- `npm run typecheck`, `lint`, and the full test suite (including all guardrail, versioning-invariant, lifecycle, and concurrency tests) pass; existing Administration pages work unchanged under the `(app)` route group with zero URL changes; all four product routes appear in the frozen route manifest; `next build` clean.
