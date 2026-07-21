# Product Management — Architecture Addendum (Phase 2: CRUD Fast-Follow)

**Status:** PLANNED — decisions agreed 2026-07-20, pre-implementation. See `_change-product-crud-plan.md` for the full decision record and `prodmgmt-project-overview-phase2.md` for the user-facing spec.
**Base document:** `prodmgmt-architecture.md` (v1, shipped, **unchanged by this addendum**). Read that document in full first — this file records **only what Phase 2 adds, amends, or supersedes**, section by section, using its section numbers. Anything not mentioned here is inherited from v1 unchanged.
**Why a separate file instead of editing v1 in place:** the base document is the historical record of what actually shipped and was reviewed on 2026-07-03; Phase 2 hasn't shipped yet. Keeping deltas in their own file (same pattern as `prodmgmt-project-overview-phase2.md`) means a reader can always tell what was true at v1 ship time versus what Phase 2 changes, without diffing git history.

**Headline:** Phase 2 is not purely additive. It requires one schema change and directly **supersedes** v1's Module Invariant 8. Both are called out explicitly below, not folded in quietly — per the base document's own rule that "changes to Module Invariants require a documented design review," this addendum is that review.

---

## Relative to §1 (Technology Stack)

| Layer | v1 said | Phase 2 changes it to |
|---|---|---|
| APIs & Backend | "No new API surface in v1... Server Actions arrive with the CRUD fast-follow." | That fast-follow is now: `actions/product/**` exists, one file per mutation, following the platform's standard Server-Action shape (`requirePermission` → `safeParse` → delegate to `services/product` → `revalidatePath`). **Still no `app/api/product*` route, ever** — that half of the v1 statement holds permanently and stays guardrail-enforced. |

Everything else in §1 (frontend URL-state pattern, database being Postgres/Drizzle in the `product` schema, the one `products` permission, per-`pricing_model` Zod validation) is unchanged.

## Relative to §2 (Folder Ownership Deltas)

New and changed rows (v1's table stands; this is what's added on top):

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/products/product-offering/` | Unchanged data/logic. | **Cosmetic change only:** nav label and page `H1` relabeled "View Product." Route path, components, and data logic untouched — see §3 for why the label changed. |
| `components/admin-nav.tsx` | v1: "Products" section, one item, "Product Offering." | Phase 2: "Products" section now has two items — "View Product" (relabeled) and "Manage Products" (new), both under the same section heading. |
| `services/product/**` | v1: read-only, list + detail. | Phase 2 adds `*-write.service.ts` files (create/update/activate/retire offering, spec CRUD, `insertPrice`) plus the shared `branchOfferingAsDraft` primitive. Still no `next/*` imports. |
| `db/**` (product scope) | v1: 3 tables, no writes beyond seeds. | Phase 2 adds **one migration**: `product_offering.family_offering_id` (nullable, self-referencing FK) + its index — see §3. Repositories gain write methods; the price repository gains exactly one, `insertPrice` — never `update*`/`delete*` (unchanged invariant, see §6 Inv. 1). |
| `validation/product/**` | v1: list params + `pricing_characteristics`. | Adds create/update-offering, create/update-specification, insert-price (with backdating check), and activate/retire (optional `reason`) schemas. |
| `tests/**` | v1: repo/service unit tests + one authz-matrix entry. | Adds an authz-matrix entry for `/products/manage-products`, plus the versioning-invariant tests in §6 (new Inv. 13–14). |
| `actions/product/**` *(new)* | One Server Action file per mutation. | No DB access in this layer — same convention as `actions/roles/**`. |
| `app/(app)/products/manage-products/` *(new)* | The CRUD page: family-grouped offering list, row actions, create/edit/activate/retire/discard dialogs. Declares `products : EDIT` guard (retire/discard actions additionally re-check `DELETE`). | Structurally independent of `product-offering/` — imports no components from it, and vice versa. |
| `components/products/manage/**` *(new)* | Write-capable UI: offering/spec/price forms, activate/retire/discard dialogs. | Kept in its own subfolder, deliberately separate from the read-only `components/products/*` used by View Product. A guardrail test asserts the read-only components import nothing from here. |

v1's closing line, "No `actions/` or `app/api/` additions in v1 (read-only)" — the `app/api/` half is now the permanent rule (see §1 table above); the `actions/` half was specifically scoped to v1 and this is exactly the phase that adds it.

## Relative to §3 (Storage Model)

This is where v1 text gets **superseded**, not just extended.

**v1 said** (Offerings row): *"One row per offering; `version` is an in-place metadata counter bumped on any change — no versioned offering rows."*

**Phase 2 supersedes this.** Multiple rows per product are now expected — one per version. Specifically:

- A new nullable, self-referencing column, `product_offering.family_offering_id`, links versions of the same product together. `NULL` means the row **is** the family's root. A non-null value points directly at the root's id — always one hop, even for a branch-of-a-branch, so "all versions of this product" is always a single indexed lookup: `WHERE product_offering_id = :rootId OR family_offering_id = :rootId`.
- `version` no longer means "bumped in place on any change." It now means **the row's sequence number within its family** — the root is `1`, the first branch is `2`, and so on — computed as `MAX(version)` across the resolved family + 1, assigned once at insert, and never changed afterward (including for an in-place edit to an already-`DRAFT` row, which updates content and `last_modified` but not `version`).
- `lifecycle_status` semantics gain a cross-row constraint: **at most one row per family may be `ACTIVE` at a time** (see §6 Inv. 6, 13).
- `is_bundle` stays exactly as v1 described it — display-only, no `bundle_link` table — and Phase 2 keeps it that way in the CRUD UI too: it is never user-settable, only copied through unchanged when a row is cloned (branched).

**Why not just match on `name` for version linkage:** names change, and two unrelated offerings can legitimately share one. A flat, one-hop self-reference costs one column and one index and stays correct regardless of renames — this was the explicit trade-off made for this phase (the alternative, no schema change at all, was considered and rejected for that fragility).

**Prices row nuance** (v1: *"a change inserts a new row and bumps the offering `version`"*): this still describes what happens for an in-place edit to a `DRAFT`. It does **not** describe what happens when the target offering is `ACTIVE` — in that case, the new price is inserted against a brand-new, branched `DRAFT` row with its own freshly assigned `version`; the original `ACTIVE` row's `version` is untouched, because the original row itself is untouched (see §6 new Inv. 14). Backdating: v1 flagged this as an open caveat requiring "the CRUD fast-follow must restrict backdated starts as a service rule" — Phase 2 resolves it: a price's `start_date_time` may be up to 3 days in the past (non-blocking warning shown), rejected beyond that (see §6 Inv. 2).

**New row, not in v1's table:** `family_offering_id` (nullable, self-FK, indexed) is the **only** schema addition this phase makes — to `product_offering` alone. `product_specifications` and `product_offering_price` are untouched; specification and price writes against an `ACTIVE` offering are redirected by the *service layer* (branch-first) onto a freshly cloned `DRAFT` row's children, not by any change to those two tables' shape.

Everything else in §3 (IDs, price-history-as-forensics-source, tier storage deferral) is unchanged.

## Relative to §4 (Authentication & Access Model)

v1's permission matrix listed EDIT/DELETE as *"seeded, unused in v1."* Phase 2 is exactly where they stop being unused:

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/products/product-offering` (View Product — relabeled, otherwise unchanged) | Authenticated | `products` : **READ** (unchanged) |
| `/products/manage-products` (Manage Products — new: create/edit/branch/activate) | Authenticated | `products` : **EDIT** |
| `/products/manage-products` — retire / discard | Authenticated | `products` : **DELETE** |

No new permission rows were needed — `products:EDIT` and `products:DELETE` were seeded in v1 for exactly this. Everything else in §4 (single page-level `products` permission, no pricing-visibility split, nav-renders-regardless-of-permission convention) is unchanged.

## Relative to §5 (Background Tasks & AI)

v1: *"No new audit events — reads are not audited; CRUD-phase mutations will add create/update/lifecycle events."* Phase 2 is that CRUD phase. New audit event types: `PRODUCT_OFFERING_CREATED`, `PRODUCT_OFFERING_UPDATED`, `PRODUCT_OFFERING_BRANCHED`, `PRODUCT_OFFERING_ACTIVATED`, `PRODUCT_OFFERING_SUPERSEDED`, `PRODUCT_OFFERING_RETIRED`, `PRODUCT_OFFERING_DISCARDED`, `PRODUCT_SPECIFICATION_CREATED`, `PRODUCT_SPECIFICATION_UPDATED`, `PRODUCT_SPECIFICATION_DELETED`, `PRODUCT_PRICE_ADDED`. Still no AI/ML components and no scheduled jobs — price effectivity is still resolved at query time, unchanged.

## Relative to §6 (Module Invariants)

**Superseded outright:**

- **v1 Inv. 8** — *"`version` is a metadata counter only. It bumps in place on any offering change; no versioned offering rows, no version-aware queries."* **This is false under Phase 2 and is retired, not amended.** Replacement: *"`version` is a row's sequence number within its version family, assigned once at insert and never changed afterward. Versioned offering rows are the norm, not an exception — `family_offering_id` (§3) makes every query that needs 'all versions of this product' or 'the current active version' explicitly version-aware."*

**Amended (the rule's intent survives, the wording is updated):**

- **Inv. 2** (no overlapping effectivity): the backdating caveat — *"the CRUD fast-follow must restrict backdated starts as a service rule"* — is now resolved, not open. The rule: a new price's `start_date_time` may be up to 3 days in the past (accepted with a non-blocking UI warning); beyond that, the write is rejected (`BACKDATED_START_TOO_FAR`).
- **Inv. 6** (only ACTIVE offerings are billable): gains a cross-row clause — **and at most one row per version family may be `ACTIVE` at any time.** Activating a version automatically retires whichever other version in its family was previously active, in the same transaction.
- **Inv. 11** (*"No production code path mutates product tables until the CRUD fast-follow ships behind `products:EDIT`/`DELETE`"*): Phase 2 is that shipment. Restated as a present-tense fact: production code paths now mutate product tables, exclusively through `actions/product/**` → `services/product/*-write.service.ts` → repositories, gated by `products:EDIT`/`DELETE` exactly as v1 anticipated.

**New (Phase 2 introduces rules v1 had no need for):**

- **Inv. 13 — Single-active-per-family is enforced transactionally, not by a single DB constraint.** A plain unique index on `family_offering_id` can't cleanly cover "the root itself is `ACTIVE`, one of its branches also tries to activate," because the root's `family_offering_id` is `NULL` and NULLs don't collide in a unique index. `activateOffering` re-reads and re-checks "is there currently another `ACTIVE` row in this family?" **inside** the transaction before flipping status — the same defense-in-depth pattern `roles-write.service.ts`'s `deleteRole` already uses to close a race window. This is a deliberate, documented trade-off, not an oversight.
- **Inv. 14 — Editing an `ACTIVE` offering never mutates it in place.** There is no in-place write path for an `ACTIVE` offering's own fields, its specifications, or its prices. Any such edit first clones the offering plus all of its specifications and all of its prices into a new `DRAFT` row (`branchOfferingAsDraft`), then applies the edit to that clone. The original `ACTIVE` row and everything attached to it are provably untouched — the same "immutable, insert instead of update" discipline v1 established for prices alone (Inv. 1), now extended to the offering and its specifications whenever the source is live.

**Unchanged:** Inv. 1 (price rows immutable), 3 (`end_date_time` never stored), 4 (JSONB schema-guarded), 5 (amount/tiers mutually exclusive), 7 (audit log never a rating source), 9 (product tables stay in the `product` schema, no new user/role/permission/session/config/audit tables — the one new column doesn't violate this, it's still the same 3 tables), 10 (READ gates the View Product page), 12 (route-group rename history, irrelevant to Phase 2).

---

## Summary for implementers

Read `prodmgmt-architecture.md` in full, then this addendum. Where they conflict, this addendum wins — it's dated later and specifically documents the supersession. The one thing to internalize before writing any code: **`version` no longer means what v1's Inv. 8 said it meant**, and that single fact ripples through the repository layer (`branchOfferingAsDraft` vs. in-place `UPDATE`), the service layer (branch-first routing for `ACTIVE` targets), and the guardrail tests (single-active-per-family, ACTIVE-row-untouched-on-edit) — see `_change-product-crud-plan.md` and `_change-product-crud-implementation-guide.md` for the concrete build order.
