# Product Management — Update Overview (Manage Products Rebuild & Catalog Lifecycle)

**Module:** Product Management — second update phase (extends the Phase 1 catalog viewer, the Phase 2 Manage Products CRUD, and the Ordering & Inventory update)
**Users:** Revenue Operations team (permission `products`, levels EDIT and DELETE)
**Status:** DELIVERED (pm35–pm45, 2026-09-20) — decisions D1–D13 from `_updatemodule-product-manage-page-refactor-plan.md`; ship-gate-verified at pm45.
**Companion docs:** `prodmgmt-architecture.md` (Module Invariants — the five amendments are approved and landed, G1 design review by Khek 2026-09-19), `prodmgmt-code-standards.md`, `prodmgmt-ui-context.md`, `bm29-real-aggregation-recurring-price-resolver.md` (recurring price consumer), `rm08-rp-price-resolution-snapshot.md` (usage price consumer)

## Overview

This update rebuilds the Manage Products page and completes the catalog data it produces. Manage Products today is a family-grouped table with modal dialogs: a user cannot see what an offering charges without leaving for View Product, and the page loads every offering plus every offering's detail before rendering, then throws the price data away. The rebuild gives Manage Products the same four-section shape as View Product — a families list, a version switcher, a specifications panel and a pricing panel — with editing and versioning controls in the panels, and loads only the selected version's data. Alongside the page, three catalog gaps close: the lifecycle gains `TESTING` and `OBSOLETE` so a superseded version is no longer mislabelled "retired"; DRAFT versions become genuinely editable and deletable, which the current insert-only rule forbids even for content nobody has ordered; and the price form stops writing `NULL` into `recurring_charge_period_length`, `recurring_charge_period_type` and `unit_of_measure`, the fields the bill run's recurring resolver actually reads. Subscriptions remain pinned to the exact offering version they were sold on, so nothing in this update changes what an existing customer pays.

## Goals

1. Show an offering's prices and specifications on Manage Products itself, so Revenue Ops never needs View Product to answer "what does this charge?".
2. Cut the page's first load from roughly `2N/5 + 3N` queries (N = every offering in the catalog) to 2 queries, with a further 4 on selecting a family — by moving family grouping into a server-paged repository read model and fetching detail only for the selected version.
3. Replace `DRAFT → ACTIVE → RETIRED` with `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`, where OBSOLETE means "not orderable, still billed for existing subscriptions" and RETIRED means "no subscription depends on this version any more".
4. Make a DRAFT version fully editable — add, change and delete specifications and prices — while making everything from TESTING onward immutable, enforced by the repository and by a database trigger, not by UI discipline alone.
5. Make every price created through the app billable: a recurring price carries a charge period that maps onto a bill cycle; a usage price carries a unit of measure from a fixed list (`Mbps`, `GB`, `MB`, `EA`).
6. Replace the discard-sets-RETIRED behaviour with a real hard delete of never-released versions, so RETIRED carries exactly one meaning.
7. Enforce "one open version per family" and "one ACTIVE version per family" in the database, as unique indexes backing the existing in-transaction lock.
8. Keep grandfathering provably intact: activating a new version leaves an existing subscription's pinned version and resolved prices byte-identical.

## Core user flow

1. A Revenue Operations user (`products : EDIT`) opens **Products → Manage Products**. The page renders a server-paged list of product **families**, one row each: name, the primary version's status badge, version count, sellable and billing-only chips, last modified. The primary version is the family's ACTIVE version, else its open (DRAFT or TESTING) version, else its highest version number.
2. The user searches or filters by status. Both run in SQL against the paged query; no client-side row filtering.
3. The user selects a family row. The URL becomes `?family=PRDOFR000004&version=PRDOFR000011`, and three panels load for that version: offering detail (name, flags, version, last edited by), specifications, and prices grouped by price type with each row's derived effectivity (current, future-dated, superseded).
4. The user switches to another version of the same family from the version bar (version number + status badge per entry). Only the three detail queries rerun.
5. The user edits a version whose status is **ACTIVE**. The first edit branches a new DRAFT copy of the whole version — offering fields, all specifications, all prices — assigns it the family's next version number, and redirects the user to it. The ACTIVE version is untouched. If the family already has an open version, the user is taken to that one instead; a second open version is refused.
6. On the **DRAFT** version, the user edits inline in the panels: renames the offering, edits or deletes a specification, edits a price's amount or tiers, deletes a price row, or adds a future-dated successor price of the same type (permitted only while DRAFT — this is how a contractual step-up is set up before the customer signs).
7. The user adds a **recurring** price: name, amount or tiers, currency, GL code, start date, and a charge period (length + type) that must map onto a supported bill cycle. A usage price additionally requires a unit of measure from the fixed list. A `once` price accepts neither. A tiered recurring price, or a tiered usage price, saves with a visible warning that no downstream component can bill it yet.
8. The user clicks **Submit for testing**. The service re-reads the version's status under lock and checks the release preconditions — at least one price row, at least one specification, and every mandatory specification resolved to a non-null default. The version becomes `TESTING` and its content becomes read-only.
9. The user clicks **Back to draft** if something needs changing. The version returns to `DRAFT` and becomes editable again.
10. The user clicks **Activate** (`products : EDIT`). In one transaction the version becomes `ACTIVE` and the family's previously ACTIVE version becomes `OBSOLETE`. New orders now pick the new version; every existing subscription keeps billing from its pinned version.
11. The user stops selling a product with no replacement (`products : DELETE`): the ACTIVE version becomes `OBSOLETE` directly.
12. The user retires an OBSOLETE version (`products : DELETE`). The service counts subscriptions pinned to that version where `status <> 'TERMINATED'` or `end_date IS NULL OR end_date >= current_date`. Zero → the version becomes `RETIRED`, terminal. Non-zero → refused, with the blocking subscription count shown.
13. The user discards an unreleased version (`products : DELETE`). A DRAFT or TESTING version that was never ACTIVE is hard-deleted with its specifications and prices in one transaction, with a `PRODUCT_OFFERING_DELETED` audit event recording the version id, name, version number and the counts removed.
14. Every mutation above writes exactly one audit event inside the same transaction as the data change, and refreshes the page via `revalidatePath`, which reruns the whole route (the selection budget again), not a partial panel refresh — Next has no panels-only revalidation.

## Features

### Catalog browsing and selection

- Server-paged families list: one row per family, page size from the existing `products.offering_list_page_size` config key.
- Server-side name search and lifecycle-status filter.
- Version bar for the selected family: every version with its status badge, one click to switch.
- URL-held selection (`?family=…&version=…`), so deep links and the browser back button work with no client state — the convention View Product already uses.
- Per-version panels: offering detail, specifications, prices with derived effectivity (`current` / `future` / `superseded`) computed from each successor's `start_date_time`.

### Editing

- Inline editing in the specifications and pricing panels for DRAFT versions; dialogs reserved for consequential confirmations (submit for testing, activate, stop selling, retire, discard).
- Add, edit and delete specifications on a DRAFT version.
- Add, edit and delete price rows on a DRAFT version — new capability; today's price repository is insert-only in every phase.
- Several dated prices of one price type per version, permitted only while DRAFT.
- Branch-on-edit for ACTIVE versions, with the existing "this creates a new draft" warning.
- Backdating warning on a price start date within the 3-day tolerance; a validation error beyond it (unchanged).

### Price fields

- `recurring_charge_period_length` + `_type`: required for `recurring`, forbidden for `usage` and `once`. Accepted combinations are validated against the bill run's cycle mapping (1 month = monthly, 3 months = quarterly, 12 months = annually — confirmed against bm29's resolver; open item O1 is closed, shipped as the `product_offering_price_period_value_check` CHECK: `months` only, length ∈ (1, 3, 12)).
- `unit_of_measure`: required for `usage`, forbidden for `recurring` and `once`, restricted to `Mbps`, `GB`, `MB`, `EA` by a database CHECK and a TypeScript union. Case-sensitive and matched exactly; `Mbps` keeps that casing deliberately, since `MBPS` reads as ambiguous between megabit and megabyte per second. `EA` means "each" — a countable unit.
- `policy` stays in the table, stays `NULL`, stays out of the form; its semantics are still undefined.
- A quiet warning on price shapes nothing downstream can bill yet: tiered recurring (bm29 fails the account with `RECURRING_PRICE_UNSUPPORTED`) and tiered usage (rating v1 is `FLAT`-only).

### Lifecycle and versioning

- Five statuses: `DRAFT`, `TESTING`, `ACTIVE`, `OBSOLETE`, `RETIRED`.
- `TESTING` in this phase: read-only, not orderable, not billable, counts as the family's open version, reversible to DRAFT. What testing does beyond that is a later phase.
- Release preconditions move from activation to the DRAFT → TESTING step.
- Activation supersedes the family's previous ACTIVE version to OBSOLETE in the same transaction.
- Retirement gated on live subscriptions, checked on click under a lock — no background job.
- Hard delete for never-released versions, cascading to specifications and prices.
- New audit events: `PRODUCT_OFFERING_SUBMITTED_FOR_TESTING`, `PRODUCT_OFFERING_RETURNED_TO_DRAFT`, `PRODUCT_OFFERING_OBSOLETED`, `PRODUCT_OFFERING_DELETED`, `PRODUCT_PRICE_UPDATED`, `PRODUCT_PRICE_DELETED`. `PRODUCT_OFFERING_DISCARDED` is removed; `PRODUCT_OFFERING_SUPERSEDED` keeps its name with `afterData.lifecycleStatus = 'OBSOLETE'`.

### Data integrity

- Unique index `product_offering_one_open_per_family` on `COALESCE(family_offering_id, product_offering_id)` where status is `DRAFT` or `TESTING`.
- Unique index `product_offering_one_active_per_family` on the same expression where status is `ACTIVE`. Both back the existing advisory lock and in-transaction re-check rather than replacing them.
- A trigger on `product_specifications` and `product_offering_price` rejecting any insert, update or delete unless the parent offering is `DRAFT` — the database-level counterpart to the amended immutability invariant.
- `ON DELETE cascade` from both child tables to `product_offering`; the self-referencing `family_offering_id` stays `restrict`.

### Access

- Unchanged permission `products`; page guard stays `products : EDIT`.
- `EDIT`: create and edit drafts, spec and price writes, submit for testing, back to draft, activate.
- `DELETE`: discard (hard delete), stop selling (→ OBSOLETE), retire (→ RETIRED).
- Every action re-checks its level server-side and re-reads the target's status under `FOR UPDATE` inside its own transaction.

## In scope

- Rebuild of `app/(app)/products/manage-products/` as a list + version bar + three panels, with URL-held selection and inline editing.
- A repository-level family read model (`findFamilyPage`) replacing the page-local grouping, the multi-page fetch loop and the `MAX_COMBINED_ROWS` ceiling.
- Removal of the per-row `getOfferingDetail` fan-out.
- `product.lifecycle_status` extended to five values by editing `0006_product.sql` in place, under the agreed fresh-install assumption (D11): no installation exists yet, so every environment rebuilds its database and no relabelling migration or backfill script is written.
- CHECK constraints and Zod schemas for the per-price-type required fields and the unit list.
- DRAFT-only `updatePrice` / `deletePrice` on the price repository, plus the enforcing trigger.
- The two family unique indexes; cascade FKs; the new and renamed audit events.
- New transition services: submit for testing, back to draft, obsolete, retire (with the live-subscription gate), hard delete.
- Manage Products importing View Product's read-only presentational components (one-directional; the reverse stays forbidden and guardrail 11 still asserts it).
- Badge treatments for `TESTING` (info tint, flask icon) and `OBSOLETE` (muted row, history icon, Retire as the only action).
- Amendments to `architecture.md` Inv. #18 and `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17, plus the code-standards, ui-context and workflow-rules edits listed in the plan's §9.
- Re-baselined guardrails: price immutability re-scoped to non-DRAFT, single-active now index-backed, schema-diff against the new price-table shape, grandfathering asserting OBSOLETE.
- Updated demo and sample seeds carrying the new required price fields.
- A codebase sweep of every `'RETIRED'` comparison outside the product module, including the flow SQL under `workflow-management/**`.

## Out of scope

- Maker-checker or any approval routing for catalog changes — explicitly dropped; `products : EDIT` / `DELETE` remain the only gates.
- What `TESTING` actually does: no sandbox order path, no dry-run bill, no test-data isolation. The status is a placeholder this phase creates and a later phase defines.
- `PER_UNIT`, tiered or block rating. Rating v1 stays `FLAT`-only; per-unit is its own rating-module phase.
- Tiered recurring support in bm29.
- Normalising units between the catalog and the rating feed — including making rm07's feed profile emit `Mbps` instead of `MBPS`, and deciding whether `MB` and `GB` coexist or pre-rating normalises to one volume unit. Recorded as hand-offs, not built here.
- A billing basis for rate-based units (per Mbps per month, per peak sample).
- `policy` semantics.
- Bundles, `bundle_link`, and making `is_bundle` user-settable — still display-only, still never editable.
- A TMF620 external API or any `app/api/product*` route, which remains permanently forbidden.
- Any change to Orders, Subscriptions, Customer, Accounts or the bill-run and rating pipelines beyond the status-literal sweep.
- Tier storage migrating from JSONB to a child table.

## Success criteria

1. Manage Products' first load issues exactly 2 database queries (families page + count). Because a `?family=`/`?version=` change re-renders the whole route and the module runs no cache layer (pm40 D5), `listFamilies` is deliberately **not** cached: the families page + count (2) are re-issued on every selection. Uncached, selecting a family issues **6** (families 2 + version list 1 + offering detail 1 + specifications 1 + prices 1) and switching version also issues **6**; the exact counts are pinned and asserted at pm40/pm45 build. No code path fetches detail for an unselected row.
2. The pricing panel on Manage Products shows every price row of the selected version — amount or tiers, currency, GL code, charge period or unit, start date, derived end, effectivity state — with no navigation to View Product.
3. `MAX_COMBINED_ROWS`, `fetchAllForStatus`, `fetchAllOfferingRows` and `fetchSpecificationsByOfferingId` no longer exist; family grouping lives in the repository.
4. Every transition in the lifecycle table succeeds and every illegal transition is refused with a typed result code, proven by integration tests.
5. A price update or delete against a `TESTING`, `ACTIVE`, `OBSOLETE` or `RETIRED` version is refused by the repository **and** by the database trigger on a direct SQL write.
6. A direct SQL insert of a second open version, or a second ACTIVE version, in one family is rejected by a unique index — for a family root (`family_offering_id IS NULL`) and for a branch alike.
7. Two concurrent activation attempts on sibling versions leave exactly one ACTIVE version in the family, never zero or two.
8. Discarding a DRAFT removes its specifications and prices, leaves every other family member untouched, and writes one audit event. No path deletes an ACTIVE, OBSOLETE or RETIRED version.
9. A recurring price with no charge period, a usage price with no unit, a `once` price carrying either, a unit outside `Mbps` / `GB` / `MB` / `EA`, and a charge period the bill-run mapping does not cover each fail in Zod and at the database.
10. Activating a new version of an ordered offering leaves the existing subscription's pinned `product_offering_id` unchanged and its price reads byte-identical, with the superseded version now `OBSOLETE` (guardrail 16, updated).
11. Retiring is refused while any subscription pinned to the version is not terminated, or is terminated with an `end_date` today or later; the refusal names the blocking count.
12. No code path outside the product module treats `OBSOLETE` as unbillable, including the flow SQL under `workflow-management/**`.
13. The authz matrix passes for `/products/manage-products` across every role and level, including a principal with EDIT but not DELETE being unable to discard, obsolete or retire.
14. `npm run db:migrate` on an empty database produces the five-value enum, both unique indexes, the trigger, the cascade FKs and the new CHECK constraints; the seeds load with the new required price fields; the schema-diff guardrail passes against the re-baselined shape.

## Success-criteria evidence (pm45 I5)

The artefact a reviewer reads instead of re-deriving coverage: each of the fourteen criteria above mapped to the committed test that proves it. Most were landed by the unit that changed the behaviour (pm35–pm44); pm45 adds only the module-spanning guardrails (23, 29-extended, 30) and references the rest rather than duplicating them (pm45 D1). Paths are under `tests/`.

| #   | Criterion (short)                                                                                                      | Proven by                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | First load = 2 queries; selection/switch budget; no unselected fan-out                                                 | `app/manage-products-query-budget.integration.test.ts` (no selection = 2; selection/switch = 6; unknown family = 3) — **and** guardrail 29 there. **Note:** criterion 1's "only if `listFamilies` is cached" premise was superseded by pm40 D5 — the module has no cache layer (architecture §1), so the uncached budget **2 / 6 / 6** is what is pinned; the families 2 are re-paid per selection. |
| 2   | Pricing panel shows every price row on Manage Products, no View-Product hop                                            | `components/manage-prices-panel.test.tsx` (pm41) + `components/prices-panel.test.tsx` (the shared read-only rows)                                                                                                                                                                                                                                                                                   |
| 3   | `MAX_COMBINED_ROWS`/`fetchAllForStatus`/… gone; grouping in the repository                                             | `guardrails/product-module-boundaries.test.ts` — "manage-products/page.tsx contains none of pm39's nine deleted identifiers"                                                                                                                                                                                                                                                                        |
| 4   | Every transition succeeds; every illegal ordered pair refused with a typed code                                        | `db/product-release-path.integration.test.ts` + `db/product-withdrawal-path.integration.test.ts` + `db/product-delete-offering.integration.test.ts` (per-pair typed codes); guardrail 23 `guardrails/product-lifecycle-transitions.test.ts` (the set is structurally complete, no `setLifecycleStatus`)                                                                                             |
| 5   | Price update/delete on a non-DRAFT version refused by repo **and** trigger                                             | `db/product-price-writes.integration.test.ts` (repository refusal per released status + direct-SQL trigger refusal)                                                                                                                                                                                                                                                                                 |
| 6   | Direct-SQL second-open / second-ACTIVE rejected by the unique index (root + branch)                                    | `db/product-family-guards.integration.test.ts`                                                                                                                                                                                                                                                                                                                                                      |
| 7   | Two concurrent activations leave exactly one ACTIVE                                                                    | `db/product-release-path.integration.test.ts` (the concurrency case: loser returns `OFFERING_NOT_TESTING`)                                                                                                                                                                                                                                                                                          |
| 8   | Discard removes children, leaves siblings, writes one `PRODUCT_OFFERING_DELETED`; no delete of ACTIVE/OBSOLETE/RETIRED | `db/product-delete-offering.integration.test.ts`; guardrail 23 asserts delete is offered only for DRAFT/TESTING                                                                                                                                                                                                                                                                                     |
| 9   | Completeness failures fail in Zod **and** at the DB                                                                    | `validation/price-input.test.ts` (Zod) + `db/product-price-constraints.integration.test.ts` and `db/product-price-writes.integration.test.ts` (DB CHECKs)                                                                                                                                                                                                                                           |
| 10  | Activation leaves the pinned id + resolved price byte-identical; superseded = OBSOLETE                                 | `db/ship-gate-guardrails.integration.test.ts` (guardrail 16, updated)                                                                                                                                                                                                                                                                                                                               |
| 11  | Retire refused while a subscription is live; refusal names the count; succeeds at zero                                 | `db/product-withdrawal-path.integration.test.ts` (blocked by ACTIVE/SUSPENDED/TERMINATED-today/-future; `liveCount` reported; succeeds at zero)                                                                                                                                                                                                                                                     |
| 12  | Nothing outside the module treats OBSOLETE as unbillable, `workflow-management/**` included                            | guardrail 30 `guardrails/status-literal-sweep.test.ts` (allow-list + `workflow-management/**` warning scan) — proves _absence_ of an out-of-home literal; the positive "OBSOLETE still bills" proof is criterion 10's guardrail 16 + `db/product-withdrawal-path.integration.test.ts` price-stability cases (bill run resolves by pinned id, Inv. #17)                                              |
| 13  | Authz matrix across levels; EDIT-not-DELETE cannot discard/obsolete/retire; deep links grant nothing                   | `auth/guard.integration.test.ts` (EDIT reaches every content write incl. update/delete-price; the three withdrawal actions reject an EDIT-only principal) + guardrail 23's "Manage Products guards products:EDIT before it reads searchParams" (deep-link clause)                                                                                                                                   |
| 14  | `db:migrate` from empty yields the enum/indexes/trigger/cascade/CHECKs; seeds load; schema-diff passes                 | `db/migration.integration.test.ts` (drop-all → migrate-from-empty → idempotent re-run) + `guardrails/product-module-boundaries.test.ts` (enum + four CHECKs + cascade FKs freeze; 0040 indexes + DRAFT-guard trigger freeze)                                                                                                                                                                        |
