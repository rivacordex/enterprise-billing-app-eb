# Product Management — Module Code Standards Addendum (Phase 2: CRUD Fast-Follow)

**Status:** PLANNED — decisions agreed 2026-07-20, pre-implementation. See `_change-product-crud-plan.md` for the full decision record, `prodmgmt-architecture-phase2.md` for the technical-design deltas this file builds on, and `prodmgmt-project-overview-phase2.md` for the user-facing spec.
**Base document:** `prodmgmt-code-standards.md` (v1, shipped, **unchanged by this addendum**). Read that document in full first — this file records **only what Phase 2 adds, amends, or supersedes**, using its section numbers. Anything not mentioned here is inherited from v1 unchanged.
**Precedence unchanged:** where this doc conflicts with `prodmgmt-architecture-phase2.md`'s Module Invariants (superseded/amended/new), the Invariants win and the conflict is a bug to fix here.

---

## Relative to §1 (General Rules)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 1.1 | "v1 is read-only. No production code path mutates `product.*` tables... No `actions/product/` folder... Mutation code arrives only with the CRUD fast-follow behind `products:EDIT`/`DELETE`." | **This is that fast-follow.** `actions/product/**` now exists; production code paths mutate `product.*` tables, exclusively through `actions/product/**` → `services/product/*-write.service.ts` → repositories, gated by `products:EDIT`/`DELETE` exactly as v1 anticipated. |
| 1.2 | "The only future write is `insertPrice`..." | No longer future — `insertPrice` exists. The rule itself is unchanged and permanent: the price repository exports no `update*`/`delete*`, ever. |
| 1.3 | "Reads are not audited. This module adds no `AUDIT_LOG` event types in v1." | Reads still are not audited — that half is permanent. Mutations now are: this phase adds `PRODUCT_OFFERING_CREATED`, `_UPDATED`, `_BRANCHED`, `_ACTIVATED`, `_SUPERSEDED`, `_RETIRED`, `_DISCARDED`, `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED`, `PRODUCT_PRICE_ADDED` to `AUDIT_LOG` — every one from a mutation-path file, never from `services/product/list-offerings.ts` or `get-offering-detail.ts`. |
| 1.5 | "CRUD-ready means additive-only... A v1 design that would force a breaking change in the fast-follow is a review-blocking defect." | Holds for specifications and prices without exception. For offerings, it holds with **one disclosed exception**: `family_offering_id` is a genuinely new column, not a reshaping of anything v1 shipped — see `prodmgmt-architecture-phase2.md` §3. This was reviewed and accepted, not discovered as a defect. |

**New rules this phase adds (no v1 equivalent):**

9. **`is_bundle` is never user-editable, in any form, ever.** Neither `create-offering.schema.ts` nor `update-offering.schema.ts` includes an `isBundle` field. `insertOffering` hardcodes `isBundle: false`. `branchOfferingAsDraft` copies whatever value the source row already has — the value survives cloning, but no code path lets a user set it.
10. **Editing an `ACTIVE` offering never mutates it in place.** Any write targeting an `ACTIVE` offering's own fields, its specifications, or its prices routes through `branchOfferingAsDraft` first (Inv. 14); there is no service function that `UPDATE`s an `ACTIVE` `product_offering` row's content columns.
11. **Discard and Retire are the same repository call with different audit events.** `retireOffering(tx, offeringId)` sets `lifecycle_status = RETIRED` regardless of the row's prior status; the calling service logs `PRODUCT_OFFERING_DISCARDED` when the source was `DRAFT` and `PRODUCT_OFFERING_RETIRED` when it was `ACTIVE`. Do not fork this into two repository methods — the DB-level operation is identical, only the audit semantics differ.
12. **Backdating tolerance is a service-layer check, not a DB constraint.** `insertPrice`'s caller rejects a `start_date_time` more than 3 days in the past (`BACKDATED_START_TOO_FAR`) and flags (non-blocking) anything backdated within that window. The DB has no way to enforce this — see Inv. 2 amendment.

## Relative to §2 (TypeScript Conventions)

- Domain unions (`LifecycleStatus`, `PriceType`, `PricingModel`) are unchanged.
- **New field on the `ProductOffering` read/insert types:** `familyOfferingId: string | null`, mirroring the new column (`prodmgmt-architecture-phase2.md` §3). No new branded ID type — a family id is just another `PRDOFR…` value.
- **New read model needed for the Manage Products list:** a family-grouped row shape (current `ACTIVE` version, or latest `DRAFT` if the family never went live, plus a count/summary of other versions in the family). Exact shape is a build-time decision (§7 file tree below names where it lives); do not invent it speculatively before Unit 8 of the implementation guide.
- Everything else in v1's §2 (JSONB typing, `PricingCharacteristics` discriminated union, money-as-string, `endDateTime` as computed-only, entity-ID regex validation) is unchanged.

## Relative to §3 (Next.js Rules)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 3.7 | "No Server Actions in v1. Adding the first `actions/product/*` file is a CRUD-fast-follow change..." | This is that change. `actions/product/**` now exists, one file per mutation, each doing exactly: `requirePermission` → `isRedirectError` catch → `schema.safeParse` → delegate to the write service only → `revalidatePath` both product pages → typed `{ok, code}` result — same shape as `actions/roles/*.action.ts`. |
| 3.9 | "Page `metadata.title` is 'Product Offering'..." | **Superseded.** The existing page's `metadata.title` and `H1` become **"View Product"** — text-only, no route or component change. The new page at `/products/manage-products` ships its own `metadata.title`, **"Manage Products"**, plus its own `loading.tsx`/`error.tsx` per general §3.11. |

**New rule:** the Manage Products page follows the same "thin RSC orchestrator" discipline as View Product (v1 §3.1) — guard, parse, fetch, compose — with dialogs and forms as the `'use client'` interaction leaves (v1 §3.6's rule extends unchanged to the new page).

Everything else in §3 (URL-state pattern for View Product, searchParams parsing/fallback, RETIRED hidden by default, nav renders regardless of permission) is unchanged for the View Product page specifically.

## Relative to §4 (Styling)

- **New binding component names** this phase introduces (same "create exactly these names" convention as v1 §4.1): `ManageOfferingTable`, `OfferingForm`, `SpecificationForm`, `SpecificationsDialog` (pm21 — plural, one per offering, list-first; renders both the specifications list and the add/edit form as two content swaps inside one Radix `Dialog`, plus a nested `AlertDialog` for delete), `PriceForm`, `RetireOfferingDialog` (its copy/title switches between "Retire" and "Discard draft" based on the target's status — one component, not two), `CreateOfferingDialog`, `AddPriceDialog`.
- The reserved `--action-cta-bg` token (v1 §5 of `prodmgmt-ui-context.md`) is now used — see `prodmgmt-ui-context-phase2.md`.
- New visual patterns (warning banners for branch-on-edit and backdating, version-history expansion) are specified in `prodmgmt-ui-context-phase2.md`, not here — this file owns component *names* and *conventions*, ui-context owns tokens/colors.
- Everything else in §4 (shared badge components, Administration table-primitive reuse, four-section responsive grid, `formatCurrency`, `formatDatetime`, boolean-flag indicator) is unchanged for View Product.

## Relative to §5 (API Routes)

Unchanged, permanently: this module adds no Route Handlers, in v1 or in Phase 2 or ever. A PR adding any `app/api/product*` path is rejected at review regardless of phase — Phase 2's mutations go through `actions/product/**` exclusively.

## Relative to §6 (Data and Storage Rules)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 6.1 | "All module tables live in the `product` schema: `product_offering`, `product_specifications`, `product_offering_price` — nothing else..." | Still exactly these 3 tables — Phase 2 adds a **column** (`family_offering_id` on `product_offering`), not a table. The "nothing else" guarantee (no identity/RBAC/session/config/audit tables) is unaffected. |
| 6.7 | "`version` is an in-place metadata counter (module inv. #8): bumped on any offering change... No versioned offering rows, no version-aware queries." | **Superseded, not amended** — see `prodmgmt-architecture-phase2.md` Inv. 8. `version` is now a row's sequence number within its version family (root = 1, each branch = family max + 1), assigned once at insert, never changed after. Versioned offering rows are the norm; version-aware queries (`findActiveInFamily`) are a repository primitive, not an anti-pattern to avoid. |

**New rules this phase adds:**

11. **Single-active-per-family is enforced transactionally, not by a DB constraint** (Inv. 13). `activateOffering` re-checks for a sibling `ACTIVE` row inside the transaction before flipping status — the same in-transaction re-check pattern `deleteRole` uses for its assignment-count race. Do not attempt to express this as a single unique index; the nullable-root design (`family_offering_id IS NULL` for roots) makes a clean partial-unique-index equivalent impossible, and this was a deliberate, reviewed trade-off, not an oversight to "fix" later.
12. **A price or specification write against an `ACTIVE` offering always lands on a freshly branched `DRAFT`, never on the `ACTIVE` row** (Inv. 14). This is why `deleteSpecification`'s "only on a `DRAFT`" rule (v1, unchanged) holds by construction in Phase 2 — by the time any spec-write function is called, its target offering is guaranteed `DRAFT`.
13. **Reason/comment on activation and retirement/discard is captured in the audit event payload, not a new column.** `insertAuditEvent`'s `afterData` carries `{ ...fields, transitionReason: reason ?? null }`. No `product_offering` schema impact.
14. **The backdating tolerance (3 days) is enforced in `insert-price.ts` (the write service), checked against the transaction's `now()`**, not in the Zod schema alone (Zod can check "is this a valid date," not "is this within tolerance of the current instant at write time" — that's a service concern).

Everything else in §6 (ID prefixes, no stored `end_date_time`, overlap-prevention constraint, amount/tiers CHECK, `created_at` vs `start_date_time`, JSONB schema-guarding, ACTIVE-only billable, tiers staying JSONB) is unchanged.

## Relative to §7 (File Organization)

Extend v1's concrete tree with:

```
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
components/products/manage/
  manage-offering-table.tsx        # ManageOfferingTable
  create-offering-dialog.tsx       # CreateOfferingDialog
  offering-form.tsx                # OfferingForm
  add-price-dialog.tsx             # AddPriceDialog
  price-form.tsx                   # PriceForm
  specification-form.tsx           # SpecificationForm
  specifications-dialog.tsx        # SpecificationsDialog
  retire-offering-dialog.tsx       # RetireOfferingDialog
services/product/
  create-offering.ts
  update-offering.ts
  add-specification.ts
  update-specification.ts
  delete-specification.ts
  insert-price.ts
  activate-offering.ts
  retire-offering.ts
db/repositories/
  product-offering.ts        # + insertOffering, updateOfferingDraftInPlace,
                              #   branchOfferingAsDraft, activateOffering,
                              #   retireOffering, findActiveInFamily
  product-specification.ts   # + insertSpecification, updateSpecification, deleteSpecification
  product-offering-price.ts  # + insertPrice (only)
db/migrations/…              # one new migration: family_offering_id + index
validation/product/
  create-offering.schema.ts
  update-offering.schema.ts
  create-specification.schema.ts
  update-specification.schema.ts
  insert-price.schema.ts
  activate-offering.schema.ts
  retire-offering.schema.ts
tests/…                      # + authz-matrix entry for manage-products,
                              #   versioning-invariant tests, guardrail rewrites
```

**§7.2 superseded:** v1 said "No `actions/product/` and no `app/api/product*` folders exist in v1. Their creation marks the start of the CRUD fast-follow." `actions/product/` now exists — this is that start. `app/api/product*` remains permanently absent (§5).

Everything else in §7 (nav refactor lives in `admin-nav.tsx`, `services/product` stays framework-agnostic, the route-group rename is historical/done) is unchanged.

## Relative to §8 (Permission Names & Per-Page Permission Map)

The permission-map rows v1 marked `*TBD with CRUD phase*` now have real answers:

| Page | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| View Product — list + detail + specs + prices (relabeled, otherwise unchanged) | `/products/product-offering` | `ProductOfferingPage` → `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel` | `app/(app)/products/product-offering/` | `products` : **READ** |
| Manage Products — create / edit / branch / activate | `/products/manage-products` | `ManageProductsPage` → `ManageOfferingTable`, `OfferingForm`, `PriceForm`, `SpecificationForm` | `app/(app)/products/manage-products/`, `actions/product/` | `products` : **EDIT** |
| Manage Products — retire / discard | `/products/manage-products` | `RetireOfferingDialog` | `actions/product/retire-offering.action.ts` | `products` : **DELETE** |

No new permission rows needed — `products:EDIT`/`DELETE` were seeded in v1's migration for exactly this. Everything else in §8 (single page-level permission name, no pricing-visibility split, component-names-are-binding convention, deep links pass through the guard) is unchanged.

## Relative to §9 (Module Guardrail Tests)

All seven v1 guardrail tests still apply to View Product unchanged. Phase 2 adds:

8. **Single-active-per-family** — activating a version retires any sibling `ACTIVE` version in the same transaction; under two near-simultaneous activation attempts on siblings, exactly one family member ends up `ACTIVE`, never zero or two.
9. **Branch-not-mutate** — editing any field, specification, or price on an `ACTIVE` offering leaves that row and its exact children byte-for-byte unchanged in the database and produces exactly one new sibling `DRAFT`.
10. **Spec-delete unreachable on `ACTIVE`** — no code path calls `deleteSpecification` against an offering whose current status is `ACTIVE` (asserted directly, not just trusted from construction).
11. **View stays read-only** — `app/(app)/products/product-offering/**` and `components/products/*.tsx` (excluding `components/products/manage/`) import nothing from `actions/product/`, `components/products/manage/`, or any `*-write.service.ts`.
12. **Route manifest extended** — `/products/manage-products` appears exactly once alongside the existing `/products/product-offering` entry.
13. **Schema-diff check** — the only diff in `db/schema/product.ts` versus its Phase 1 state is `family_offering_id` + its index; `product_specifications` and `product_offering_price` are byte-identical to Phase 1.
14. **Price immutability, now behaviorally testable** — inserting a successor price leaves the old row untouched and (when the target was already `DRAFT`) the offering's `version` is whatever it already was; pm09's structural-only version of this guardrail gets its behavioral companion now that `insertPrice` actually exists.
