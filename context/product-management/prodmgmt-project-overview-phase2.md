# Product Management — Project Overview (Phase 2: CRUD Fast-Follow)

**Module:** Product Management — Phase 2 (fast-follow to the Phase 1 read-only catalog)
**Users:** Billing Operations team (same audience as Phase 1, now with create/edit/retire capability)
**Status:** Planned — see `_change-product-crud-plan.md` for decisions and `_change-product-crud-implementation-guide.md` for the unit-by-unit build order
**Companion docs:** `prodmgmt-project-overview.md` (Phase 1, shipped, unchanged), `prodmgmt-architecture.md` / `prodmgmt-code-standards.md` (platform rules this phase inherits), `product_module_manage_products_mockup.html` (UI mockup)

## Overview

Phase 2 turns the Product Management module from a read-only catalog into one Billing Operations can maintain themselves, using a copy-on-write versioning model rather than simple in-place editing. It adds a new "Manage Products" page, sitting alongside the existing read-only page (relabeled "View Product" but otherwise untouched), where users with the right permissions can create a product offering, attach and edit its specifications, add new prices, and move it through its lifecycle from draft to active to retired. Editing a live (`ACTIVE`) offering never modifies that row — it creates a new draft version instead, and only one version of a given product can be `ACTIVE` at a time, so activating a new version automatically retires whichever version was active before it. This phase requires one small, explicit schema addition — a column linking an offering's version history together — the only exception to Phase 1's "CRUD-ready, no schema changes needed" design.

## Goals

1. Let Billing Operations create, edit, and retire product offerings themselves, without engineering writing SQL or seed files.
2. Guarantee that a live offering's terms never change silently: editing an `ACTIVE` offering's fields, specifications, or prices always produces a new draft version, leaving the currently active version — and every historical bill computed against it — exactly as it was.
3. Guarantee that at most one version of a given product is billable at any moment: activating a new version automatically and atomically retires whichever version was previously active.
4. Preserve price history exactly as Phase 1 guaranteed it: prices remain insert-only and immutable — a price change always adds a new row, never touches an old one, even across versions.
5. Keep the two product pages structurally independent — "View Product" stays a pure read path with zero write-code imports, while "Manage Products" owns all mutation UI.
6. Reuse the mutation pattern (UI → server action → write service → repository → Postgres) already established elsewhere in the app, adding one new shared primitive (branching a draft from an existing offering) rather than a second architecture.

## Core User Flow

1. A Billing Operations user signs in; their role grants the `products` permission at EDIT (and, for retirement, DELETE) level.
2. They open the "Products" section in the left nav and click "Manage Products," landing on `/products/manage-products` — a sibling of "View Product" under the same nav section.
3. The page shows offerings grouped by product family — one row per family (its current `ACTIVE` version, or its latest `DRAFT` if the family has never gone live), with an option to expand and see every version in that family's history and each one's status.
4. The user clicks "New offering," fills in name and flags (sellable, billing-only — bundle is not user-settable) in a dialog, and saves. A brand-new offering is created as the root of a new family, in `DRAFT` status.
5. The user adds one or more specifications and at least one price to the `DRAFT`. Because it's still a draft, these edits apply directly to it — no versioning branch happens yet.
6. Once the draft has at least one price and its mandatory specifications are resolved, the user clicks "Activate." The draft becomes `ACTIVE` and billable. (If this family already had an active version, that version is retired automatically in the same action, labeled in the audit trail as superseded.)
7. Later, the user opens "View Product" and confirms the newly active version appears there exactly as any other `ACTIVE` offering — same detail, specs, and prices panels Phase 1 already shipped, and the previously active version (now `RETIRED`) is hidden by the default filter.
8. Months later, a rate change is needed. The user finds the family on "Manage Products" and clicks "Add price" on the `ACTIVE` row. Because the target is live, the system transparently clones it — offering, specifications, and prices — into a brand-new `DRAFT` version, and adds the new price to that clone. The originally active version, and everything a past bill was computed against, is untouched.
9. The user reviews the new draft, adjusts anything else needed (in place, since it's now a draft), and activates it once ready. The old active version is retired automatically; the new one takes over.
10. Separately, the user starts drafting a second product idea, decides against it before it ever goes live, and clicks "Discard" on that draft row. It moves to `RETIRED` directly — a soft delete, not a row deletion — and disappears from the default view.

## Features

### Offering management
- Create dialog: name, `is_sellable`, `billing_only` — offering starts in `DRAFT` as the root of a new version family. `is_bundle` is never shown or settable in this UI; new offerings are always non-bundle.
- Edit dialog behavior depends on the target's status: a `DRAFT` can be saved in place or explicitly "saved as new" (a sibling draft version); an `ACTIVE` offering has no in-place option at all — any edit transparently produces a new draft version instead.
- No hard delete anywhere in the UI or the API surface. Removing an offering is always a lifecycle transition to `RETIRED` — "Discard" for a draft that never went live, "Retire" for a version that was active.

### Version history and single-active-version guarantee
- Every offering belongs to a version family, linked by a new lineage column. The Manage Products table shows one row per family by default, expandable to the full version history.
- At most one version per family can be `ACTIVE` at a time. Activating a draft automatically retires whichever other version in its family was active, in the same atomic action.
- Editing an `ACTIVE` version's own fields, specifications, or prices always clones it into a new `DRAFT` version first — the active row and everything attached to it are never modified in place.

### Specification management
- Add and edit specifications on a `DRAFT`. On an `ACTIVE` offering, adding or editing a specification triggers the clone-to-new-draft behavior above, and the change lands on the new draft, not the live version.
- Hard delete is available for a specification, but only on a `DRAFT` row — and since specification writes against an `ACTIVE` offering always land on a freshly cloned draft first, this condition holds automatically rather than needing a separate check bolted on top.

### Price management
- Add price: name, price type, pricing model (flat or tiered), currency, GL code, start date. On an `ACTIVE` offering, this triggers the clone-to-new-draft behavior; on a `DRAFT`, it applies directly.
- Prices remain insert-only everywhere. There is no edit or delete action for an existing price, on any offering, at any version.
- A new price's start date may be backdated up to 3 days; the form shows a non-blocking warning when it is. Earlier than that is rejected outright.

### Lifecycle transitions
- `DRAFT → ACTIVE`: requires at least one price row and all mandatory specifications resolved. Available via "Activate" on a draft. Automatically retires the family's previous active version, if any, as part of the same action.
- `ACTIVE → RETIRED` ("Retire") and `DRAFT → RETIRED` ("Discard"): both a soft-delete transition to the same terminal status, with an optional free-text reason, labeled differently in the UI and the audit trail depending on which state the row was in.
- `RETIRED` is terminal — no path back to `DRAFT` or `ACTIVE`.

### Navigation & shell
- The existing "Product Offering" page is relabeled "View Product" in the left nav and its page heading — same route, same components, same data logic, text-only change.
- New "Manage Products" nav item added as a sibling of "View Product," both nested under the existing "Products" section.
- New "New offering" call-to-action button in the Manage Products page header.

### Data integrity (enforced, not just displayed)
- Price immutability is enforced at the repository layer: the price repository exposes exactly one write method, `insertPrice` — cloning a price onto a new draft version is implemented as more inserts, never an update.
- The single-active-version rule is enforced inside the same database transaction that performs an activation: any existing active sibling in the family is retired before, or as part of, the new version being marked active.
- Every mutation runs inside a database transaction paired with an audit-log write, so every create, branch, edit, activation, supersession, retirement, discard, specification change, and price addition is independently attributable and timestamped.
- "View Product" imports no write-path code — the read guarantees from Phase 1 remain structurally enforced.

### Access control
- Reuses the single `products` permission already seeded in Phase 1: EDIT gates offering/specification create-edit, branching, and price add; DELETE gates retirement and discard.
- Nav items render regardless of permission; the page guard is what actually enforces access.

### Audit trail
- New audit event types covering the full lifecycle: offering created, updated (in-place draft save), branched (new draft from an edit), activated, superseded (auto-retired by another version's activation), retired, discarded; specification created, updated, deleted; price added. The distinction between "retired" and "discarded," and between "retired" and "superseded," is preserved in the audit log even though some of these share the same underlying status transition.

## In Scope

- One schema addition: a nullable, self-referencing lineage column on `product_offering` (plus its index) linking versions of the same product together — the single exception to "no schema changes" in this phase.
- Create, edit (in place or as a new draft version), and retire/discard flows for product offerings.
- The copy-on-write branch primitive: cloning an offering plus its specifications and prices into a new draft whenever an edit targets a live (`ACTIVE`) version.
- The single-active-version-per-family rule, enforced transactionally at activation time.
- Create, edit, and (draft-only) delete flows for product specifications.
- Add-price flow for product prices (insert-only, no edit or delete, with bounded backdating tolerance).
- The `DRAFT → ACTIVE → RETIRED` lifecycle state machine, with activation preconditions and terminal retirement enforced in the service layer.
- Optional reason/comment capture on activation and retirement/discard, stored in the audit log, not a new product-table column.
- The new "Manage Products" page, including a family-grouped, expandable version-history view.
- The "Product Offering" → "View Product" label rename (nav item and page heading only).
- New Zod validation schemas, repository methods, write services, server actions, and audit event types needed to support the above.
- Updated and new guardrail tests covering the new write paths, price immutability, the single-active-version invariant, and the "View Product stays read-only" boundary.
- Permission wiring for the already-seeded `products` EDIT and DELETE levels.

## Out of Scope

- Hard delete of product offerings, specifications (once their offering has gone live), or prices — every removal path is a status transition, never a row deletion, except the DRAFT-only specification hard-delete described above.
- Editing or deleting an existing price row — prices are permanently insert-only, across every version.
- Any transition out of `RETIRED` — retirement and discard are both permanent.
- Any UI or code path that allows more than one version of a family to be `ACTIVE` at the same time.
- Making `is_bundle` user-editable — it stays a display-only, non-CRUD attribute.
- Any new database tables or columns beyond the single lineage column on `product_offering` — no changes to `product_specifications` or `product_offering_price`.
- API routes of any kind for product mutations — all writes go through Server Actions.
- Bundle composition management.
- CSV export, bulk edit, or bulk retirement of offerings.
- A separate pricing-visibility permission.
- Changes to the "View Product" page's data, filters, or components beyond the label rename.
- Merging two version families together, or moving a version from one family to another.

## Success Criteria

- A user with `products` EDIT can, starting from sign-in, create a new offering, add a mandatory specification, add a flat price, and activate it — the offering reaches `ACTIVE` status and appears correctly on "View Product" with no engineering involvement.
- Activating a new version of a family that already has an active version automatically retires the previous one in the same action; at no point do both appear `ACTIVE` simultaneously, including under two near-simultaneous activation attempts.
- Editing any field, specification, or price on an `ACTIVE` offering leaves that exact row and its exact specification and price rows unchanged in the database, and produces exactly one new `DRAFT` row in the same family with the edit applied.
- A user with `products` DELETE can retire an `ACTIVE` version or discard a `DRAFT` that never went live; both disappear from "View Product"'s default filter, and the audit log distinguishes "retired" from "discarded" from "superseded."
- Attempting to activate a `DRAFT` with no prices, or with unresolved mandatory specifications, is rejected with a specific error and the offering stays `DRAFT`.
- Attempting to backdate a new price's start date more than 3 days is rejected; backdating within 3 days succeeds with a visible warning.
- There is no UI control, server action, or repository method anywhere in the codebase that updates or deletes an existing price row, confirmed by the guardrail test that inspects the price repository's exported method names.
- Deleting a specification is only ever possible on a `DRAFT` row — confirmed both by the service logic and by a guardrail test asserting no code path calls it against an `ACTIVE` offering.
- "View Product" renders identically to its Phase 1 behavior apart from its relabeled nav item and heading; a guardrail test confirms its source files import no write-path code.
- Every create, branch, edit, activation, supersession, retirement, discard, specification change, and price addition produces exactly one corresponding audit-log entry, with an optional reason captured when supplied.
- `db/schema/product.ts` shows a diff limited to the single new lineage column and its index; `product_specifications` and `product_offering_price` are untouched.
- `npm run typecheck`, `lint`, and the full test suite (including the updated and new guardrail and versioning-invariant tests) pass.
