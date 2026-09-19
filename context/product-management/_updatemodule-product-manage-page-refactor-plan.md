# Plan: Product module — Manage Products rebuild, lifecycle extension, price field completion

Status: Draft for review · Date: 2026-09-19
Module: Product Management (`prodmgmt-*`) · Users: Revenue Operations
Boundary: `product` schema + Manage Products page + the docs listed in §9. Ordering, Inventory, Billing and Rating code is **read-only context** for this plan; the hand-offs it creates are listed in §11.

> **What this is.** Manage Products today is a family-grouped table with dialogs. Two things are wrong with it. Pricing is invisible — a user has to leave for View Product to see what an offering charges — and the first load is slow because the page fetches every offering and then every offering's detail before it renders anything. The fix is to rebuild the page in View Product's shape (list on top, selection opening detail + specifications + pricing panels) with the editing and versioning controls the CRUD page owns, and to load only what the selected version needs.
>
> Along the way three things that were deferred or wrong get settled: the lifecycle gains **TESTING** and **OBSOLETE** so a replaced version stops being called "retired"; the price form stops writing `NULL` into the fields the bill run actually reads; and a DRAFT version becomes genuinely editable, which the current insert-only rule forbids even for content nobody has ever ordered.

---

## 1. What exists today (verified against the codebase)

| Fact | Where | Consequence |
|---|---|---|
| The page fetches **every** offering by looping `listOfferings` across all pages, twice (non-RETIRED + RETIRED), at the configured page size of **5** | `app/(app)/products/manage-products/page.tsx`, `core.system_config` `products.offering_list_page_size` | ~2N/5 list+count queries before grouping |
| It then calls `getOfferingDetail` for **every** row (offering + specs + prices = 3 queries each), keeps `specifications`, and **discards `prices`** | same file, `fetchSpecificationsByOfferingId` | ~3N further queries; the prices it throws away are the ones the user has to go to View Product to see |
| Grouping into families happens **in the page**, not the repository | `groupIntoFamilies`, code-standards §2.9 ("implement whichever is simpler") | The list cannot be paged or filtered server-side |
| Every mutation calls `router.refresh()` + `revalidatePath` | code-standards §3.2, §3.7 | The whole fan-out above reruns after each save |
| `MAX_COMBINED_ROWS = 1000` throws if the catalog outgrows it | page.tsx | A hard ceiling, not a paging strategy |
| Price rows are insert-only by construction — the repository exports only `insertPrice` | `db/repositories/product-offering-price.ts`, module Inv. #1 | A typo in a DRAFT price can never be corrected: the unique index on (offering, price_type, start_date_time) also blocks re-inserting at the same start |
| `insertPrice` hardcodes `recurringChargePeriodLength`, `recurringChargePeriodType`, `unitOfMeasure`, `policy` to `null` | same file | Every price created through the app is missing what bm29 reads (§7.1) |
| Discard sets a DRAFT to `RETIRED` ("offerings are never hard-deleted") | `services/product/retire-offering.ts` | Today's RETIRED rows mix three unrelated meanings: superseded, stopped, and discarded-never-live |
| The migrator applies **all pending migrations in one transaction** | `drizzle-orm@0.45.2` `pg-core/dialect.js` `migrate()` → `session.transaction(...)` | Splitting an enum change across two migration files does **not** help (§3.1) |

**Two database facts were tested, not assumed** (PostgreSQL 16.13 locally; prod is pinned to 17, same behaviour):

1. `ALTER TYPE … ADD VALUE` followed by a statement using the new value **in the same transaction** fails: `ERROR: unsafe use of new value "OBSOLETE" of enum type ls`. Given the single-transaction migrator above, the add-value form is unusable here.
2. A unique index on `COALESCE(family_offering_id, product_offering_id)` with a status predicate **does** enforce one-per-family, for a root row (`family_offering_id IS NULL`) and a branch alike. Both the "second open draft" and the "second ACTIVE" inserts were rejected. Module Inv. #13 and code-standards §6.11 state this is impossible; they are wrong.

---

## 2. Decisions

Locked with Khek, 2026-09-18/19.

- **D1 — Versioning stays offering-level.** A subscription is a contract; it stays pinned to the version it was ordered on, and a later version never changes what an existing subscriber pays. This is already how `ordering.product_order_item` and `inventory.product_inventory` work (the immutable version FK *is* the price snapshot) — no change.
- **D2 — Several dated prices of one type may exist only while the version is DRAFT.** Once a version leaves DRAFT its price schedule is fixed. Contractual step-ups are therefore set up before the version goes live, and the customer agrees to them at order time.
- **D3 — A DRAFT version is freely editable**: specs and prices can be added, changed and deleted. Everything from TESTING onward is immutable content.
- **D4 — The list shows one row per family**, its primary version (ACTIVE, else the latest open version, else the latest), with details loaded only for the selected version.
- **D5 — Lifecycle becomes DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED.** Activating a version moves the family's previous ACTIVE version to OBSOLETE (not orderable, still billed). RETIRED means no subscription depends on it any more. TESTING is a placeholder status this phase creates but does not flesh out.
- **D6 — Discarding an unreleased version hard-deletes it** (DRAFT or TESTING, never ACTIVE), cascading to its specs and prices, with an audit event. The DRAFT → RETIRED discard path is removed.
- **D7 — Recurring period and unit of measure become required**, per price type, in Zod and in the database.
- **D8 — No maker-checker.** `products : EDIT` / `DELETE` as today.
- **D9 — One open version (DRAFT or TESTING) per family**, enforced by a unique index plus the existing in-transaction lock.
- **D10 — Invariants are amended, not excepted.** Platform Inv. #18 and module Inv. #1 become "immutable once the version leaves DRAFT", as a documented design review (§9).
- **D11 — Fresh-install assumption for this round.** Treat the product migrations as not yet applied: `0006_product.sql` is edited in place rather than corrected forward. Every environment rebuilds its database. No relabelling migration, no backfill, no data-fix script exists anywhere in the result.
- **D12 — Unit of measure is a short fixed list in code + a database CHECK**: `Mbps`, `GB`, `MB`, `EA`. Case-sensitive, matched exactly. `Mbps` keeps that exact casing deliberately — `MBPS` is ambiguous between megabit and megabyte per second. `EA` means "each": a countable unit (one event, one SMS, one session).
- **D13 — The price form stays permissive about shapes nothing can bill yet** (tiered recurring, tiered usage), with a quiet warning rather than a hard block. Per-unit rating is a separate rating-module phase.

---

## 3. Data model

### 3.1 Lifecycle status — edit `0006_product.sql` in place (D11)

`product.lifecycle_status` is declared as `ENUM('DRAFT','ACTIVE','RETIRED')` in `0006`. Under D11 that `CREATE TYPE` is edited to:

```sql
CREATE TYPE "product"."lifecycle_status" AS ENUM
  ('DRAFT','TESTING','ACTIVE','OBSOLETE','RETIRED');
```

**Why not a forward migration.** The migrator runs every pending migration inside one transaction, and Postgres refuses to *use* an enum value added in the transaction that added it (§1, tested). A forward change would therefore need the create-new-type-and-swap-the-column dance (`CREATE TYPE … ; ALTER TABLE … ALTER COLUMN … TYPE … USING s::text::new; DROP TYPE; ALTER TYPE … RENAME`), which is correct but pointless when no installation exists. Should the fresh-install assumption ever be withdrawn, the swap form is the fallback — it was tested and works in a single transaction.

**Consequences of editing an applied migration** (all of them, so nobody is surprised):

- Every local database is rebuilt from scratch. Role passwords and the step-6 grant patch live in the Docker volume and do not survive; the README's install steps are the recovery path.
- `db/schema/product.ts` is kept in sync **by hand**; **no `drizzle-kit generate` (`db:generate`) is run** (pm35 D2). Snapshots stop at `0026` in this repo — every migration from `0027` on is hand-written SQL with a hand-appended `meta/_journal.json` entry, and `generate` is retired because it would emit one giant broken diff (`db/migrations/README.md`, `drizzle.config.ts`). The apply path never reads snapshots, so `meta/0006_snapshot.json` is left untouched and stale like every snapshot after `0026`, and `meta/_journal.json` stays byte-identical (the file is edited, not added).
- Guardrail 13 (schema-diff: `product_offering_price` byte-identical to its original shape) is re-baselined against the new shape, not deleted.
- The repo rule that applied migrations are never edited (`prodmgmt-ai-workflow-rules` §5.3, `db/migrations/README.md` §4) is suspended **for this round only**, recorded here and in the module docs.

### 3.2 `product.product_offering`

No new columns. Two new indexes, replacing the "impossible" note in code-standards §6.11:

```sql
CREATE UNIQUE INDEX product_offering_one_open_per_family
  ON product.product_offering ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status IN ('DRAFT','TESTING');

CREATE UNIQUE INDEX product_offering_one_active_per_family
  ON product.product_offering ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status = 'ACTIVE';
```

The existing advisory lock + in-transaction re-check in `activateOffering` stays exactly as it is. The indexes are a backstop against a bug or a direct SQL write, not a replacement for the lock — with them, the failure mode becomes a rejected write instead of two live versions.

### 3.3 `product.product_offering_price`

| Change | Rule |
|---|---|
| `recurring_charge_period_length` / `_type` | Required when `price_type = 'recurring'`, forbidden otherwise. CHECK + Zod. Allowed combinations in §7.1. |
| `unit_of_measure` | Required when `price_type = 'usage'`, forbidden otherwise. `CHECK (unit_of_measure IN ('Mbps','GB','MB','EA'))`. |
| `policy` | Stays in the table, stays `NULL`, stays out of the form — semantics are still undefined. |
| Update / delete | Now permitted, **only** while the parent offering is DRAFT (§3.5). |
| Unique (offering, price_type, start_date_time) | Unchanged. |
| `amount` XOR tiers, `amount >= 0`, 3-char currency | Unchanged. |

### 3.4 Cascade for hard delete (D6)

`product_specifications.ref_product_offering_id` and `product_offering_price.product_offering_id` move from `ON DELETE restrict` to `ON DELETE cascade`. The self-referencing `family_offering_id` stays `restrict`: a branch only ever comes from an ACTIVE version, and an ACTIVE version is never deletable, so the restrict can never block a legitimate discard.

The service deletes the offering row inside one transaction after re-reading its status under `FOR UPDATE`, and writes one `PRODUCT_OFFERING_DELETED` audit event carrying the deleted version's id, name, version number and the count of specs and prices removed.

### 3.5 Database-level DRAFT guard

The application guard (repository refuses unless DRAFT) is backed by a trigger on both child tables, following the platform's own pattern for restricting transitions in the database rather than in application code (`architecture.md` §4, "a trigger enforces it"):

```
BEFORE INSERT OR UPDATE OR DELETE ON product.product_specifications
BEFORE INSERT OR UPDATE OR DELETE ON product.product_offering_price
  → reject unless the parent offering's lifecycle_status = 'DRAFT'
```

The trigger is what makes D3 safe to state as an invariant amendment rather than a code convention. The delete branch must allow the cascade from §3.4 (the parent row is being deleted while DRAFT or TESTING) — implemented by exempting `TG_OP = 'DELETE'` when the parent row is itself being deleted. Parent-first cascade is the **only** supported hard-delete path: deleting children explicitly before the parent is not viable for a `TESTING` parent, because the trigger rejects a child delete whenever the parent is not `DRAFT`. **Build-time verification item V6 (§10).**

---

## 4. Lifecycle

```
            (create)                 submit            activate
              ──────► DRAFT ─────────────────► TESTING ─────────► ACTIVE
                        ▲                         │                 │
                        └───── back to draft ─────┘                 │
                        │                                           │ superseded by a
     hard delete ◄──────┴──────────────► hard delete                │ new version, or
       (D6)                                (D6)                     │ stopped manually
                                                                    ▼
                                                  RETIRED ◄──── OBSOLETE
                                                          no live
                                                       subscriptions
```

| Transition | Who | Preconditions | Notes |
|---|---|---|---|
| create → DRAFT | `products:EDIT` | family has no other open version (D9) | Editing an ACTIVE version branches a new DRAFT (unchanged behaviour); if the family already has an open version, the user is sent to it instead of creating a second |
| DRAFT → TESTING | EDIT | ≥ 1 price row; ≥ 1 specification and every mandatory one resolved | These are today's *activation* checks, moved one step earlier |
| TESTING → DRAFT | EDIT | — | "Back to draft"; content becomes editable again |
| TESTING → ACTIVE | EDIT | re-checked under lock | Previous ACTIVE in the family → OBSOLETE in the same transaction |
| ACTIVE → OBSOLETE | DELETE | — | Stop selling with no replacement (today's "retire") |
| OBSOLETE → RETIRED | DELETE | no live subscription (§4.1) | Terminal |
| DRAFT/TESTING → deleted | DELETE | never was ACTIVE | Hard delete, cascade (§3.4) |

TESTING in this phase: **read-only, not orderable, not billable**, counts as the family's open version. What testing actually *does* (a sandbox order path, a dry-run bill) is deliberately left to a later phase.

### 4.1 "No live subscription"

RETIRED is refused while any `inventory.product_inventory` row pinned to that version satisfies:

```
status <> 'TERMINATED'  OR  (end_date IS NULL OR end_date >= current_date)
```

A TERMINATED subscription with a future `end_date` is still billed to that date (`billmgmt` inclusive-billed convention), so it counts as live. The check runs when the user acts, under a lock; there is no background job (module §5 stands: no jobs in this module).

Retiring is a **labelling** action: nothing is deleted, so a rerun of an old bill period still resolves its prices. Bill-run reruns additionally read the stored `customer_bill_line` price snapshot rather than re-resolving (bm29 D19), so they are unaffected either way.

### 4.2 Audit events

Existing: `PRODUCT_OFFERING_CREATED / _UPDATED / _BRANCHED / _ACTIVATED / _SUPERSEDED / _RETIRED`, `PRODUCT_SPECIFICATION_*`, `PRODUCT_PRICE_ADDED`.

Added: `PRODUCT_OFFERING_SUBMITTED_FOR_TESTING`, `PRODUCT_OFFERING_RETURNED_TO_DRAFT`, `PRODUCT_OFFERING_OBSOLETED`, `PRODUCT_OFFERING_DELETED`, `PRODUCT_PRICE_UPDATED`, `PRODUCT_PRICE_DELETED`.

Removed: `PRODUCT_OFFERING_DISCARDED` (discard is now a delete). `PRODUCT_OFFERING_SUPERSEDED` keeps its name but its `afterData.lifecycleStatus` becomes `OBSOLETE`.

---

## 5. The page

Route unchanged: `/products/manage-products`, guard `products : EDIT`.

### 5.1 Layout

Mirrors View Product's four sections, with editing:

1. **Families table** — one row per family: name, primary version's status badge, version count, sellable / billing-only chips, last modified. Server-paged, server-filtered (`q`, `status`), sorted by name. No tree, no client-side grouping.
2. **Version bar** — the selected family's versions as a compact switcher (version number + status badge), so moving between v3 DRAFT and v2 ACTIVE is one click and one fetch.
3. **Specifications panel** — the selected version's specs, editable in place when the version is DRAFT.
4. **Pricing panel** — the selected version's prices, grouped by price type, with each row's derived effectivity (current / future / superseded), editable in place when DRAFT.

Selection lives in the URL — `?family=PRDOFR…&version=PRDOFR…` — matching View Product's `?offering=` convention, so deep links and the back button work with no client state.

### 5.2 Loading

| Interaction | Queries |
|---|---|
| First load | 2 (one page of families + count) |
| Select a family | 1 (its versions) + 1 (detail) + 1 (specs) + 1 (prices) |
| Switch version | the selection budget again (see note) |
| After a save | `revalidatePath` reruns the whole route: the selection budget again, **not** a partial panel refresh |

**`revalidatePath` / `router.refresh()` invalidate the _route_, not a fragment.** There is no "panels only" refresh: a mutation (or a `?version=`/`?family=` navigation) re-renders the whole page and re-issues its queries. So the numbers above are *targets contingent on caching*: the families list (2 queries) is re-issued on every selection and version switch unless `listFamilies` is held in the Next Data Cache keyed by `q`/`status`/`page`. Decide that caching approach when pm40 is built, then assert the exact resulting counts in the query-budget guardrail (pm45) — first-load and per-selection budgets are the real win; the post-mutation path is not cheaper than a fresh selection.

Family grouping moves from `manage-products/page.tsx` into a repository read model (`findFamilyPage`), reversing code-standards §2.9. `MAX_COMBINED_ROWS` and the multi-page loop are deleted. The page size reuses the existing `products.offering_list_page_size` config key.

### 5.3 Editing style

Inline within the panels for content (spec fields, price fields, add/remove rows). Dialogs are kept only for the confirmations that carry consequence: submit for testing, activate, stop selling, retire, discard. The "this creates a new draft" warning stays on the first edit of an ACTIVE version. The backdating warning stays on the price start date.

### 5.4 Components

Manage may import View's read-only components (`LifecycleBadge`, `PriceTypeBadge`, and the presentational parts of `SpecificationsPanel` / `PricesPanel`). The reverse stays forbidden and guardrail 11 continues to assert it. `prodmgmt-architecture.md` §2's "and vice versa" is corrected to one-directional.

### 5.5 Badges

`TESTING` — info tint, flask icon. `OBSOLETE` — muted row, history icon, actions limited to Retire. `RETIRED` — today's archive treatment, no actions. Tokens per `ui-context.md`; no new colour families (the AI/Iris exclusion still holds).

---

## 6. Access model

Unchanged permission (`products`), unchanged page guard (`EDIT`). Level split:

| Action | Level |
|---|---|
| Create / edit a DRAFT, add-edit-delete specs and prices, submit for testing, back to draft, activate | `products : EDIT` |
| Discard (hard delete), stop selling (→ OBSOLETE), retire (→ RETIRED) | `products : DELETE` |

Every action re-checks the level server-side and re-reads the target's status under `FOR UPDATE` inside its transaction (code-standards §1 rule 13, unchanged).

---

## 7. Cross-module impact

### 7.1 Bill run — recurring prices (bm29)

bm29's recurring resolver maps `recurring_charge_period_length` / `_type` onto the account's bill cycle (monthly / quarterly / annually) and multiplies by subscription quantity. Because the app writes `NULL` today, **any recurring price created through the UI is currently unresolvable** — D7 is what makes UI-created recurring prices billable at all.

Allowed combinations (O1 CLOSED — confirmed against bm29's shipped resolver, see §Open items):

| length | type | Bill cycle |
|---|---|---|
| 1 | `months` | monthly |
| 3 | `months` | quarterly |
| 12 | `months` | annually |

A value the mapping doesn't cover is rejected at save time, so the failure surfaces in the product form rather than as a `RECURRING_PRICE_NOT_FOUND` hard failure during a bill run.

bm29 also fails an account outright on a **tiered recurring** price (`RECURRING_PRICE_UNSUPPORTED`). Per D13 the form allows it with a warning.

**Resolver reads no lifecycle status (standing invariant).** bm29 resolves `product_offering_price` for the subscription's pinned offering under `billrun_runtime` with **no `lifecycle_status` filter** (and no lifecycle-aware WHERE in the `lead(start_date_time)` window). This is correct only because inventory can pin **only an ACTIVE-descended version**: an order re-checks `ACTIVE` at approval (`order-preconditions.ts`), so a subscription never points at a DRAFT/TESTING version, and OBSOLETE/RETIRED are reached only from ACTIVE. Recorded here as a bm29 precondition; **no new bm29 test** (accepted 2026-09-19) — there is no code path by which a non-ACTIVE version becomes subscribable, so the invariant holds by construction.

### 7.2 Rating — usage prices

Rating v1 resolves `FLAT` only; quantity is stored but ignored, and `PER_UNIT` is an explicit stub (rm08). A tiered usage price therefore does not rate. Per D13: allowed, warned, not blocked.

Unit of measure has **no shared catalog anywhere** — `product_offering_price.unit_of_measure`, `rating.udr_rated.udr_usage_unit` and `billing.customer_bill_line.unit` are three independent free-text columns, and the unit a customer sees on a bill line comes from the rating feed (`min(udr_usage_unit)`, bm28), never from the price. D12 fixes the product side only; the mismatch risk becomes real when per-unit rating lands (**hand-off H1**).

### 7.3 Ordering and inventory

- The offer picker filters `lifecycle_status = 'ACTIVE'` — unchanged, and OBSOLETE is correctly excluded.
- A PENDING order against a version that goes OBSOLETE mid-review still fails at approval, because approval re-checks ACTIVE. This is today's behaviour with RETIRED, not a new failure mode, but the reviewer-facing message should name it.
- Module Inv. #17 (a pinned version is a rating source regardless of status) is unchanged in substance; its wording moves from RETIRED to "OBSOLETE or RETIRED".

### 7.4 Status literals elsewhere

Every comparison against `'RETIRED'` outside the product module must be reviewed, because the value's meaning changes. `services/**`, `db/repositories/**` and `components/**` are in this plan's sweep; the flow SQL under `workflow-management/**` is **not readable from this plan's tooling** and needs its own grep before the build spec (**verification item V5**).

### 7.5 View Product default filter (shipped surface, same module)

pm37 adds `OBSOLETE` to View Product's default status exclusion (`buildWhereClause` currently hides only `RETIRED`). Consequence: a version superseded by an activation (pm42) **silently disappears from the default View Product list**, reachable only through the explicit status filter. This is a deliberate "what can be sold" default, but it is a user-visible change to an already-shipped page (pm05–08), not only a Manage Products change — flag it in release notes, and audit existing View Product tests for any default-list count assertion, which will break in pm37 rather than in a Manage Products unit.

---

## 8. Out of scope

Maker-checker / approval routing for catalog changes (explicitly dropped). What TESTING *does*. Per-unit or tiered rating. Tiered recurring support in bm29. `policy` semantics. Bundles and `is_bundle` editability. A TMF620 external API. Any change to Orders, Subscriptions, or the billing and rating pipelines beyond the hand-offs in §11.

---

## 9. Document amendments

| Doc | Change | Needs review? |
|---|---|---|
| `architecture.md` §7 Inv. #18 | "Financially significant rows are immutable" → immutable **once the version leaves DRAFT**; DRAFT content is not yet a billing basis | **Yes — documented design review** (D10) |
| `prodmgmt-architecture.md` Inv. #1 | Same amendment at module level; the price repository gains DRAFT-only `update` / `delete` | Yes (same review) |
| `prodmgmt-architecture.md` Inv. #6 | Activation moves the previous ACTIVE to **OBSOLETE**; only ACTIVE is orderable; ACTIVE **and OBSOLETE** are billable | Yes |
| `prodmgmt-architecture.md` Inv. #13 | Corrected: the expression unique index **does** work; the lock stays as defence in depth | Yes |
| `prodmgmt-architecture.md` Inv. #17 | Wording: RETIRED → "OBSOLETE or RETIRED" | No |
| `prodmgmt-architecture.md` §2, §3, §4 | Component import direction (§5.4), lifecycle values, cascade FKs, new indexes, the trigger, the permission table | No |
| `prodmgmt-code-standards.md` §1.2, §1.11, §2.1, §2.9, §3.2, §4.13, §6.11 | Price mutability, discard-is-delete, the `LifecycleStatus` union, grouping moves to the repository, the new page's URL state, the family list, the index correction | No |
| `prodmgmt-code-standards.md` guardrails 2, 8, 13, 16 | Price immutability re-scoped to non-DRAFT; single-active now index-backed; schema-diff re-baselined; grandfathering test asserts OBSOLETE | No |
| `prodmgmt-ui-context.md` §1, §7 | TESTING and OBSOLETE badges; row actions per status; panel editing replaces the family-expand tree | No |
| `prodmgmt-ai-workflow-rules.md` §5.3 + `db/migrations/README.md` §4 | Record the one-round suspension of "never edit an applied migration" (D11) | No |
| `README.md` | Note that this round requires a local database rebuild | No |

---

## 10. Verification

Tests that change or land with the work:

- **V1 — Lifecycle transitions.** Every legal transition in §4 succeeds; every illegal one is refused with a typed code. Activation moves the sibling ACTIVE to OBSOLETE in the same transaction.
- **V2 — DRAFT-only writes.** A price update or delete against a TESTING, ACTIVE, OBSOLETE or RETIRED version is refused by the repository **and** by the trigger on a direct SQL write.
- **V3 — One open version per family.** Two concurrent branch attempts on one family leave exactly one open version; a direct SQL insert of a second is rejected by the index. Same for two concurrent activations.
- **V4 — Hard delete.** Discarding a DRAFT removes its specs and prices, leaves every other family member untouched, and writes one audit event. An ACTIVE, OBSOLETE or RETIRED version cannot be deleted by any path.
- **V5 — Status literal sweep.** No code path outside the product module treats OBSOLETE as unbillable. Includes a grep of `workflow-management/**` flow SQL (§7.4) — **do this before the build spec, not during it**.
- **V6 — Cascade vs trigger.** The §3.5 trigger does not block the §3.4 cascade. Prove it with a delete that removes a `DRAFT` **and** a `TESTING` version, each carrying both specs and prices — the `TESTING` case is the one a child-first delete cannot handle (the trigger rejects the child delete while the parent is not `DRAFT`), so it is the load-bearing case.
- **V7 — Required price fields.** A recurring price with no period, a usage price with no unit, a `once` price carrying either, and a unit outside the list each fail in Zod and at the database.
- **V8 — Grandfathering (guardrail 16, updated).** Activating a new version leaves an existing subscription's pinned version and resolved prices byte-identical, with the old version now OBSOLETE.
- **V9 — Page query budget.** The first load issues the §5.2 query count and no per-row detail fetch. Worth asserting, since this is the whole point of the rebuild.
- **V10 — Authz matrix.** `/products/manage-products` × every role/level, including the EDIT-vs-DELETE split across the new transitions.

---

## 11. Open items and hand-offs

**O1 — CLOSED (2026-09-19).** bm29's shipped resolver (`bill_run_processing.yml`) maps the charge period onto `billing.bill_cycle.frequency`; pm35 stores the safe subset `months` only, length ∈ (1, 3, 12) (1 → monthly, 3 → quarterly, 12 → annually), enforced by `product_offering_price_period_value_check` (D4). `'years'` is deliberately not stored (§3.2).

**O2 — `EA` in the unit list.** Included on the argument that adding a value later needs a migration. Drop it if counted usage is not coming.

**O3 — `MB` and `GB` together.** Same measure, different scale. If a feed reports MB and a price is set per GB, per-unit rating is out by 1,000 unless someone normalises. Either the price unit must match the feed exactly, or pre-rating normalises to one volume unit. A rating-phase decision, recorded here because the list is being fixed now.

**H1 — Unit spelling, to the rating phase.** rm07's feed profile writes the literal `'MBPS'`, and `db/seeds/sample/udr-rated-sample.ts` writes `'EA'`. If the product catalog is canonical (D12), the rating profile and that seed should emit `Mbps`. Case-only divergence between a price's unit and its rated usage is exactly the kind of mismatch that is invisible until it bills wrongly.

**H2 — Rate-based units need a basis.** `Mbps` is a rate, not a quantity consumed over a period. A per-Mbps price has to state per what (per month, per peak sample). If the upcoming use case needs it, the price form may need a period alongside the unit for rate-based units — not built in this phase.

**H3 — Per-unit rating.** `PER_UNIT` stays a stub in rm08; planned as its own rating-module change (D13).

---

## 12. Suggested delivery order

1. **U1 — Schema.** Edit `0006` (enum, price CHECKs, cascade FKs), add the two unique indexes and the DRAFT-guard trigger; keep `db/schema/product.ts` in sync by hand (no `drizzle-kit generate` — snapshots stop at `0026`, pm35 D2); re-baseline guardrail 13.
2. **U2 — Repository + services.** Family page read model; DRAFT-only `updatePrice` / `deletePrice`; the new transitions; hard delete; new audit events.
3. **U3 — Validation.** Required period and unit per price type; the unit list; the bm29 mapping check.
4. **U4 — Page rebuild.** List + version bar + panels, URL selection, inline editing, confirmation dialogs.
5. **U5 — Sweep + docs.** §7.4 literal sweep, §9 amendments, seeds updated for the new required fields, V1–V10 green.

U1 blocks everything. U3 can land with U2. U5's design-review amendments (§9 rows marked "Yes") should be agreed **before** U1, since they are what authorise it.
