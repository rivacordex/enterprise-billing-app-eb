# Product Management — Update Overview (Product Ordering & Inventory)

**Module:** Product Management — update phase (extends the shipped Phase 1 catalog viewer and Phase 2 Manage Products CRUD)
**Users:** Revenue Operations team (permissions `product_orders`, `product_inventory`)
**Status:** Planned — all decisions locked (Q1–Q20) in `_updatemodule-product-ordering-inventory-plan.md`; UI mockup in `mockup-product-ordering.html`
**Companion docs:** `_newmodule-account-plan.md` (FA/BAN, bill cycle catalog — hard dependency), `_newmodule-billing-billrun-plan.md` (bill-run pre-decisions consuming this phase's outputs)

## Overview

This update adds product ordering and product inventory (subscriptions) to the Product Management module. Revenue Operations users manually place an order of a billing-only product offer (`billing_only = true`, `is_sellable = true`, `lifecycle_status = ACTIVE`) for a specific customer against a specific billing account (BAN), through a three-step form: select customer, select BAN, select offer with quantity, start date, instance characteristics, and an optional negotiated price. A standard-price order validates, completes, and instantiates a subscription in one atomic transaction; an order with a negotiated price parks as `PENDING` until a manager (never the submitter) approves or rejects it. Each completed order produces exactly one product inventory instance — the subscription — which pins the exact catalog offering version it was sold at (grandfathered pricing), records which BAN it bills to, and carries a suspend/resume/terminate lifecycle with an append-only status history. The subscription list is what the future bill run will rate; this phase produces everything rating needs and nothing else.

## Goals

1. Record every sale as a TMF622-shaped order (`ordering.product_order` + `ordering.product_order_item`) with the full TMF622 status enum seeded and the phase using `ACKNOWLEDGED / PENDING / COMPLETED / REJECTED / FAILED`.
2. Instantiate exactly one TMF637-shaped subscription (`inventory.product_inventory`) per completed order item, automatically, in the same transaction as order completion — no manual fulfilment step.
3. Guarantee grandfathered pricing: the order item and subscription FK the exact `product.product_offering` version row ordered; later catalog version activations never change an existing subscriber's price.
4. Make every customer price provable: either an immutable catalog price row or an insert-only, manager-approved override row in `ordering.order_item_price_override` — no third source, no editable price anywhere.
5. Give subscriptions a billing-safe lifecycle: suspend, resume, and terminate actions writing an append-only, gap-free `inventory.inventory_status_history`, so the bill run can prorate around suspension windows without interpretation.
6. Keep Revenue Operations' access separate from catalog administration: two new permissions (`product_orders`, `product_inventory`) with no grant overlap against the existing `products` permission.

## Core user flow

1. A Revenue Operations user (role grants `product_orders` EDIT) opens **Products → Orders** and clicks **New order**.
2. **Step 1 — Customer:** the user searches and selects a customer party role. Only `ACTIVE` parties can proceed (Q14); a `VALIDATED`, `SUSPENDED`, or `CLOSED` party blocks with the reason shown.
3. **Step 2 — Billing account:** the customer's non-closed BANs are listed with their bill cycle and payment terms shown read-only (cycle lives on the BAN — Q6). Exactly one open BAN is auto-preselected. The user selects the BAN the subscription will bill to.
4. **Step 3 — Offer:** the picker lists offerings where `lifecycle_status = ACTIVE AND billing_only = true AND is_sellable = true`, with current effective prices shown read-only from the immutable price rows. The user sets quantity (integer ≥ 1, default 1), start date (default today; future allowed; ≤ 3-day backdating with warning), fills instance characteristics (key/value rows prefilled from the version's spec characteristics), and optionally enters a negotiated price per flat-model price type. Entering any override shows "this order will require manager approval."
5. **Submit:** the server re-runs all validation inside one transaction with row locks — party `ACTIVE`, BAN non-closed, offering still `ACTIVE`, at least one price row, overrides target existing flat price types. No override: the same transaction creates the subscription (`ACTIVE`, characteristics copied, first status-history row) and completes the order. Override present: the order commits as `PENDING` with no inventory.
6. **Review (override orders only):** a MANAGER-role user with `product_orders` EDIT who is not the submitter opens the pending order, sees list vs negotiated price side by side, and approves (full validation re-runs under locks at approval time, then instantiation runs and the order completes, stamped `reviewed_by`/`reviewed_at`) or rejects with a reason (`REJECTED`, terminal, no inventory).
7. The user opens **Products → Subscriptions** (`product_inventory` READ) and confirms the new subscription row: customer, BAN, pinned offer version, quantity, start date, status `ACTIVE`.
8. Later, a user with `product_inventory` EDIT suspends the subscription (effective date + reason), resumes it (effective date), or terminates it (end date + reason, terminal). Each action row-locks the instance, validates the transition (`ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE|SUSPENDED→TERMINATED`), appends a status-history row, and updates the status column in one transaction. Effective dates obey the 3-day backdating tolerance (Q19) and the inclusive-billed day convention (Q20).

## Features

### Order capture
- Three-step order form: customer search → BAN selection → offer/quantity/dates/characteristics/price.
- Party gate: `ACTIVE` only (Q14). BAN gate: any non-closed state (Q15). Offer gate: `ACTIVE ∧ billing_only ∧ is_sellable` (Q16).
- Quantity column (integer ≥ 1, default 1) on order item and subscription; one subscription row regardless of quantity — rating multiplies (Q10).
- Start date: user-chosen, default today, future-dating allowed, backdating limited to 3 days with a non-blocking warning (Q7).
- Instance characteristics: key/value editor prefilled from the pinned version's spec characteristics; stored write-once on the order item (`ordered_characteristics`), copied to the subscription as living values (`instance_characteristics`) (Q12).

### Pricing and approval
- No price snapshot columns anywhere: the pinned version FK is the snapshot, because activated versions' specs and prices are frozen by the catalog's copy-on-write invariants.
- Optional negotiated price per flat-model price type, stored in insert-only `ordering.order_item_price_override` (UNIQUE per item + price type; currency must match the BAN; tiered price types not overridable) (Q12/Q13).
- Manager approval workflow for override orders: `PENDING` state, approve/reject by a MANAGER ≠ submitter, full re-validation at approval time, `reviewed_by`/`reviewed_at` stamped on either outcome (Q13/Q18).
- Stated rating contract for the future bill run: per price type, use the override row if present, else the catalog price row effective on the rating date.

### Subscription lifecycle
- Subscription born `ACTIVE` at order completion; TMF637 status enum fully seeded, phase uses `ACTIVE / SUSPENDED / TERMINATED` (Q8).
- Suspend pauses charges from its effective date; resume restarts them; terminate sets `end_date` and is terminal (Q9).
- Append-only, gap-free `inventory_status_history` — every transition recorded with effective date, reason, and actor; suspension windows derived from consecutive rows; repository permanently exports no update/delete for this table.
- Edit-characteristics action on subscriptions: updates `instance_characteristics` only, with audit event — never a rating input.

### Lists and navigation
- Orders list: order id, customer, BAN, offer + version, quantity, start date, negotiated-price indicator, status, submitted by/at, reviewed by/at; `PENDING` rows badged with a Review action.
- Subscriptions list: subscription id, customer, BAN, pinned offer version, quantity, start/end dates, status, expandable status history; row actions gated by current status.
- Two new nav entries, "Orders" and "Subscriptions", under the existing "Products" section.

### Data and audit
- Two new pg schemas: `ordering` (`product_order`, `product_order_item`, `order_item_price_override`) and `inventory` (`product_inventory`, `inventory_status_history`), text PKs from prefixed sequences (`PRDORD`, `PRDORI`, `PRDOPO`, `PRDINV`, `PRDIVE`).
- New audit event types: `PRODUCT_ORDER_CREATED / _PENDING_APPROVAL / _APPROVED / _REJECTED / _COMPLETED / _FAILED`, `PRODUCT_INVENTORY_CREATED / _CHARACTERISTICS_UPDATED / _SUSPENDED / _RESUMED / _TERMINATED`.
- All mutations follow the house TOCTOU rule: precondition reads re-checked on the transaction with `FOR UPDATE` before writing.

## In scope

- Manual order creation (three-step form) for billing-only offers, single order item per order (schema supports multiple items; UI creates one).
- Automatic subscription instantiation in the order-completion transaction.
- Negotiated price overrides on flat price types, with the manager approval workflow (`PENDING → COMPLETED / REJECTED`).
- Orders list and Subscriptions list pages with the columns and actions listed above.
- Suspend / resume / terminate with append-only status history and guarded transitions.
- Editable instance characteristics on subscriptions, with audit.
- Permissions `product_orders` and `product_inventory` (code-seeded), two nav entries, authz-matrix entries for both pages.
- Full TMF622 and TMF637 status enum seeding, used subset as stated.
- Five new tables across schemas `ordering` and `inventory`, with migrations, seeds, repositories, services, Zod validation, and unit/integration tests per platform standards.

## Out of scope

- Rating and the bill run itself — this phase produces rating inputs only. (Pre-decisions for that phase: `_newmodule-billing-billrun-plan.md`.)
- The bill cycle catalog and BAN cycle assignment — owned by the accounts module (`billing.bill_cycle`, account-plan Q13); this phase only displays the selected BAN's cycle.
- Multi-line orders in the UI, order edit/cancel/amend (a `PENDING` order can only be approved or rejected; corrections are reject + re-order), async or queued fulfilment.
- Non-billing-only offers and any external provisioning integration.
- Repricing or migrating an existing subscription to a newer catalog version (grandfathering consequence — future migration flow).
- Per-seat inventory fan-out and partial-quantity lifecycle (e.g., suspend 2 of 5 seats).
- Tiered-price overrides; approval tolerance bands (±N% auto-approve); changing an approved override (terminate + re-order).
- The resume-day proration rule — the effective date is captured (Q17); the charge-or-not decision belongs to the bill-run phase.
- Moving a subscription to a different BAN or customer; notifications; bulk import; any API surface beyond the app's own Server Actions.
- Snapshot-copying catalog spec/price rows into orders or inventory — rejected by design (Q12), not deferred.

## Success criteria

Done means all of the following hold, each verifiable by test or by a live walkthrough:

1. A RevOps user can complete the full flow — search Sample Telecom, select BAN000001, order 5 × Enterprise SIP Trunk v2 starting 2026-07-21 (the verification clock is pinned to 2026-07-21, keeping the start date within the 3-day backdating tolerance) — and one `COMPLETED` order plus one `ACTIVE` subscription with matching characteristics exist afterward, created in a single transaction (verified by integration test asserting no intermediate committed state).
2. Submitting for a `VALIDATED` party, a closed BAN, or a non-sellable/retired/draft offering is rejected server-side with a specific error code, even when the UI is bypassed (service-level tests, not just form validation).
3. An order with a negotiated 420.00 recurring price commits as `PENDING` with zero inventory rows; the submitter cannot approve it; a manager's approval re-validates and then creates the subscription; rejection leaves `REJECTED` and zero inventory rows (tests for all three paths plus the approve-vs-reject race under concurrency).
4. After a new catalog version of the ordered offer activates, the existing subscription's pinned `product_offering_id` and its rateable prices are unchanged (grandfathering test), and the retired version's rows remain readable through the subscription's read path.
5. Suspending 2026-08-10 and resuming 2026-08-20 produces two additional history rows (three total, counting the creation row) whose derived suspension window matches those dates; illegal transitions (resume an `ACTIVE`, suspend a `TERMINATED`) are rejected; two concurrent lifecycle actions on the same subscription serialize with one winner (concurrency test, pm16 pattern).
6. Effective dates more than 3 days in the past are rejected on every lifecycle action and on order start date; dates within tolerance succeed with the warning shown.
7. Every mutation writes its audit event; `inventory_status_history` has no update/delete repository method (guardrail test asserting the repository's exported surface, catalog Inv. #1 pattern).
8. The authz matrix covers both new pages: no `product_orders` grant → `/products/orders` redirects to `/no-access`; no `product_inventory` grant → `/products/subscriptions` redirects; catalog `products` grants confer no access to either.
9. Full existing test suite stays green; `tsc`, `eslint`, `prettier`, and `next build` clean; both new pages appear in the frozen route manifest test.
