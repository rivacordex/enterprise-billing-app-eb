# rm16 — `rating_runtime` grant extension — Spec

- **Unit:** rm16 of Phase G (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/bootstrap/rating-db-roles.sql` + `tests/rating/grants.integration.test.ts`
- **Authorizes from:** `ratemgmt-architecture.md` §4 (the grant table, updated); `ratemgmt-code-standards.md` §0, §9; `_change-rating-configuration-plan.md` (A1 resolver reads `customer.party_role`; PRP reads the ratecard + specs).

## Goal

Extend `rating_runtime`'s read surface with exactly the four tables the PER_UNIT resolver (rm20) and PRP validations (rm21) read — `customer.party_role`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` — enumerated per table (never `ON ALL TABLES`), plus the **`customer` schema `USAGE`** grant that does not yet exist.

## Design

- **Follows the existing enumerated-grant precedent** (rm03): every read is a named `GRANT SELECT ON TABLE`, never `ON ALL TABLES IN SCHEMA` (which widens silently whenever another module ships a table). The read set is asserted per table.
- **`customer` schema needs `USAGE`.** `rating-db-roles.sql` currently grants `USAGE` on `rating/product/ordering/inventory/billing/core` (0034-roles Step 3) but **not `customer`** — the resolver's read of `customer.party_role` is refused without it. `product` schema `USAGE` already exists.
- **Read-only; the boundary is untouched.** No write grant anywhere new; the `billing.*` `REVOKE`, the `SECURITY DEFINER` `EXECUTE` revoke, and "no `DELETE`" are unchanged. This unit only adds `SELECT`.
- **Bootstrap, not a migration** (`§2.1`/rm03): grants live in `db/bootstrap/rating-db-roles.sql`, run by the bootstrap runner, not the Drizzle migration history.
- **No `ALTER DEFAULT PRIVILEGES` change** — these are existing tables in other modules' schemas, not future `rating` tables, so each gets an explicit grant now.

## Implementation

### 1. Schema `USAGE` (`rating-db-roles.sql`, Step 3 block ~line 68–78)
Add alongside the existing schema `USAGE` grants:
```sql
GRANT USAGE ON SCHEMA "customer" TO rating_runtime;   -- Phase G: resolver reads party_role_specification
--> statement-breakpoint
```
(`product` `USAGE` already present — do not duplicate.)

### 2. Per-table `SELECT` grants (alongside the existing seven enumerated tables)
```sql
GRANT SELECT ON TABLE "customer"."party_role"                TO rating_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE "product"."product_specifications"     TO rating_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE "product"."ratecard_ran_usage_lkp"     TO rating_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE "product"."ratecard_version"           TO rating_runtime;
--> statement-breakpoint
```
The existing seven (`product.product_offering`, `product.product_offering_price`, `ordering.product_order_item`, `ordering.order_item_price_override`, `inventory.product_inventory`, `billing.billing_account`, `billing.bill_cycle`) stay; the read set becomes **eleven** tables. No `INSERT`/`UPDATE`/`DELETE` on any of them.

### 3. Grant-assertion test (`tests/rating/grants.integration.test.ts`)
Extend the existing per-table assertions: for each of the four new tables, `rating_runtime` **can** `SELECT` and **is refused** `INSERT`/`UPDATE`/`DELETE`. Add `customer.party_role` to the "reads succeed" set and confirm the `customer` schema is reachable.

## Dependencies

**None.** SQL-only change to an existing bootstrap script plus a test extension.

## Verification checklist

- [ ] `rating_runtime` `SELECT`s each of `customer.party_role`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` successfully.
- [ ] `rating_runtime` is **refused** `INSERT`/`UPDATE`/`DELETE` on each of the four (permission error).
- [ ] `customer` schema `USAGE` is granted; **no `ON ALL TABLES IN SCHEMA`** appears anywhere in the file.
- [ ] No new write grant; the `billing.*` write `REVOKE`, the four-function `SECURITY DEFINER` `EXECUTE` revoke, and "no `DELETE` on any `rating` table" assertions still pass.
- [ ] The bootstrap script re-runs idempotently (re-granting an existing grant is a no-op); `grants.integration.test.ts` is green against a live DB.
- [ ] Diff is app-repo `db/bootstrap` + test only.
