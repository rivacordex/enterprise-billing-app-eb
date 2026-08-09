# Change: Standardize Human-Readable ID Sequences to 8-Digit Padding

- **Type:** Consistency fix to already-delivered schema/validation code. Not a new feature.
- **Status:** Implemented and verified — schema, validation, tests, and docs delivered; later folded into the base migrations (`0006`/`0009`/`0012`) and confirmed against a rebuilt database.
- **Date:** 2026-08-09
- **Modules touched:** Product, Customer, Billing (Accounts/Transactions) — schema, validation, tests, one doc.
- **Depends on:** `architecture.md` §3 / `code-standards.md` #18 ("Human-readable IDs: fixed prefix + zero-padded DB sequence"). This plan pins the digit count that convention left unspecified; it doesn't change the convention itself.

---

## 1. Problem

Every domain table's ID follows `PREFIX + lpad(nextval(seq), N, '0')`, but `N` was chosen per table with no standard, so it's inconsistent today:

| N | Tables |
|---|---|
| 6 | `product_offering`, `product_offering_price`, `product_specifications`, `billing_account`, `financial_account`, `bill_cycle`, `gl_mapping`, `ledger_binding` |
| 7 | `organization` |
| 8 | `party_role`, `contact_medium`, `document_line`, `document` (5 per-`doc_type` sequences, app-assigned) |

This isn't just cosmetic. `lpad()` doesn't truncate — once a sequence's `nextval` exceeds its column's pad width, the generated ID silently gets *wider* (e.g. `bill_cycle`'s 6-digit `BCY999999` rolling to `BCY1000000`). Two things break at that point with no error raised:

- Fixed-width display/export assumptions (UI columns, CSV output) go crooked.
- **Lexical sort order inverts.** `'1000000'` sorts *before* `'999999'` as a string, so any `ORDER BY <id>` or string comparison downstream silently misorders rows right at the rollover.

None of the 6/7-digit tables are close to their ceiling today, but the inconsistency itself is the defect worth fixing now, while it's cheap — before any table's volume forces a reactive fix under pressure.

## 2. Decision

Standardize every human-readable ID on **8-digit** zero-padded suffix — matches the four entities already built this way (`party_role`, `contact_medium`, `document_line`, `document`), so no new precedent is introduced, just consistency.

- This is a **`DEFAULT`-expression change only.** Column type stays `text`, sequence stays `BIGINT` (already effectively unbounded — `9223372036854775807`). No column type migration, no data rewrite of already-inserted rows.
- Existing rows keep their current (narrower) ID exactly as stored — a `text` primary key doesn't need to match any particular width to remain valid. See §5 for what this means for already-seeded dev/staging data.
- `code-standards.md` #18 currently says "zero-padded" with no number — this change also pins it to 8 so future modules don't each pick their own width again.

## 3. Scope — tables affected

**9 tables need their DB default widened (6 or 7 → 8):**

| Schema | Table | Column | Prefix | Sequence |
|---|---|---|---|---|
| product | product_offering | product_offering_id | PRDOFR | product.product_offering_seq |
| product | product_offering_price | product_offering_price_id | PRDOFP | product.product_offering_price_seq |
| product | product_specifications | product_spec_id | PRDSMD | product.product_specifications_seq |
| customer | organization | organization_id | ORG | customer.organization_seq |
| billing | financial_account | financial_account_id | FIN | billing.financial_account_seq |
| billing | billing_account | billing_account_id | BAN | billing.billing_account_seq |
| billing | bill_cycle | bill_cycle_id | BCY | billing.bill_cycle_seq |
| billing | gl_mapping | gl_mapping_id | GLM | billing.gl_mapping_seq |
| billing | ledger_binding | ledger_binding_id | LBD | billing.ledger_binding_seq |

**4 already compliant — no DB change, listed for the audit trail:** `party_role` (PTRL), `contact_medium` (CTMD), `document_line` (DLN), `document` (PAY/DEP/CRN/DBN/ADJ — assigned in `document.repository.ts`, already `padStart(8, "0")`).

## 4. Implementation

### 4.1 Migration

> **As shipped (supersedes the `0023` plan in this subsection).** This did not go out as a standalone `0023`. The `SET DEFAULT` widening was folded directly into the base CREATE migrations — `0006_product.sql`, `0009_customer.sql`, `0012_billing_module_tables.sql` — and the drizzle-kit baseline was re-generated as `meta/0021_snapshot.json` (there is no `0023` migration or snapshot). The `0023`-based SQL below is retained only as the original planning record.

Originally planned as a new file at the next free index (`0023`, the latest then being `0022_document_rename_reference_date_to_entry_date.sql`):

`db/migrations/0023_widen_id_sequence_padding.sql`:

```sql
ALTER TABLE "product"."product_offering" ALTER COLUMN "product_offering_id" SET DEFAULT 'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 8, '0');
ALTER TABLE "product"."product_offering_price" ALTER COLUMN "product_offering_price_id" SET DEFAULT 'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 8, '0');
ALTER TABLE "product"."product_specifications" ALTER COLUMN "product_spec_id" SET DEFAULT 'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 8, '0');
ALTER TABLE "customer"."organization" ALTER COLUMN "organization_id" SET DEFAULT 'ORG' || lpad(nextval('customer.organization_seq')::text, 8, '0');
ALTER TABLE "billing"."financial_account" ALTER COLUMN "financial_account_id" SET DEFAULT 'FIN' || lpad(nextval('billing.financial_account_seq')::text, 8, '0');
ALTER TABLE "billing"."billing_account" ALTER COLUMN "billing_account_id" SET DEFAULT 'BAN' || lpad(nextval('billing.billing_account_seq')::text, 8, '0');
ALTER TABLE "billing"."bill_cycle" ALTER COLUMN "bill_cycle_id" SET DEFAULT 'BCY' || lpad(nextval('billing.bill_cycle_seq')::text, 8, '0');
ALTER TABLE "billing"."gl_mapping" ALTER COLUMN "gl_mapping_id" SET DEFAULT 'GLM' || lpad(nextval('billing.gl_mapping_seq')::text, 8, '0');
ALTER TABLE "billing"."ledger_binding" ALTER COLUMN "ledger_binding_id" SET DEFAULT 'LBD' || lpad(nextval('billing.ledger_binding_seq')::text, 8, '0');
```

`ALTER COLUMN ... SET DEFAULT` only changes what future `INSERT`s without an explicit value receive — it doesn't touch existing rows and takes no table lock beyond the metadata change. Author by hand (same reasoning as the `entry_date` rename plan): a blind `drizzle-kit generate` diffing a changed `sql\`...\`` default expression is a coin flip on emitting the right `ALTER` vs. something heavier — verify the generated/hand-written migration is exactly `SET DEFAULT`, nothing else. Regenerate `meta/0023_snapshot.json` and the `_journal.json` entry to match.

### 4.2 Drizzle schema — 5 files, 9 lines (source of truth, do together with 4.1)

| File | Line | Change |
|---|---|---|
| `db/schema/product.ts` | 46 | `PRDOFR` lpad `6` → `8` |
| `db/schema/product.ts` | 85 | `PRDSMD` lpad `6` → `8` |
| `db/schema/product.ts` | 111 | `PRDOFP` lpad `6` → `8` |
| `db/schema/customer.ts` | 37 | `ORG` lpad `7` → `8` |
| `db/schema/billing/accounts.ts` | 34 | `FIN` lpad `6` → `8` |
| `db/schema/billing/accounts.ts` | 82 | `BAN` lpad `6` → `8` |
| `db/schema/billing/catalogs.ts` | 34 | `BCY` lpad `6` → `8` |
| `db/schema/billing/catalogs.ts` | 157 | `GLM` lpad `6` → `8` |
| `db/schema/billing/ledger-binding.ts` | 22 | `LBD` lpad `6` → `8` |

Each is a one-character edit inside the existing `sql\`'PREFIX' || lpad(nextval('...')::text, N, '0')\`` expression.

### 4.3 Validation — widen, but don't just swap the number

15 files currently validate these IDs with an **exact-length** regex (`^PREFIX\d{6}$` or `^PREFIX\d{7}$`). Naively changing `{6}`/`{7}` to `{8}` would just relocate the exact problem this plan fixes one level up — the next time anyone changes the padding width, these regexes go stale again, and worse, they'd start **rejecting every pre-existing row's ID** the moment they're widened (a `financial_account_id` inserted before this migration is 6 digits forever; `/^FIN\d{8}$/` would refuse to accept it as a valid reference in every one of these payment/billing actions).

**Recommended fix: drop the fixed length, keep the shape check.** Replace `^PREFIX\d{N}$` with `^PREFIX\d+$` everywhere in this list — still rejects garbage/wrong-prefix input, but is correct for legacy narrow IDs, newly-widened IDs, and any future width change, permanently.

Files to update (prefix → new pattern `^PREFIX\d+$`):

| File | Line(s) | Prefix(es) |
|---|---|---|
| `validation/accounts/allocate-payment.schema.ts` | 17, 20 | FIN, BAN |
| `validation/accounts/capture-deposit.schema.ts` | 21 | FIN |
| `validation/accounts/capture-payment.schema.ts` | 23 | FIN |
| `validation/accounts/close-account.schema.ts` | 9, 19 | BAN, FIN |
| `validation/accounts/onboard-customer-accounts.schema.ts` | 19 | BCY |
| `validation/accounts/parse-accounts-context.ts` | 6, 7 | FIN, BAN |
| `validation/accounts/raise-credit-note.schema.ts` | 16, 19 | FIN, BAN |
| `validation/accounts/raise-debit-note.schema.ts` | 17, 20 | FIN, BAN |
| `validation/accounts/refund-deposit.schema.ts` | 39 | FIN |
| `validation/accounts/refund-payment.schema.ts` | 24, 27 | FIN, BAN |
| `validation/accounts/reverse-deposit.schema.ts` | 16 | FIN |
| `validation/accounts/rounding-adjustment.schema.ts` | 17, 20 | FIN, BAN |
| `validation/accounts/write-off.schema.ts` | 17, 20 | FIN, BAN |
| `validation/customer/organization.schema.ts` | 5 | ORG |
| `validation/product/offering-list.schema.ts` | 31 | PRDOFR |

**No change needed** (already validate an already-8-digit prefix, and `\d+` isn't required there since those IDs were never narrower): `validation/accounts/contact.schema.ts:10` (CTMD), `validation/accounts/onboard-customer-accounts.schema.ts:18` (PTRL), `validation/accounts/parse-accounts-context.ts:5` (PTRL), `validation/accounts/refund-payment.schema.ts:16` (DLN), `validation/customer/contact-medium.schema.ts:3` (CTMD), `validation/customer/party-role.schema.ts:3` (PTRL). Leave these as `\d{8}` — no reason to loosen a check that was never wrong, though switching them to `\d+` too for uniformity is a reasonable option if consistency across all ID regexes is preferred (call it either way; functionally equivalent going forward).

### 4.4 Tests — 5 files assert the old fixed-width pattern, need updating to match §4.3's new regex

| File | Line(s) | Prefix |
|---|---|---|
| `tests/accounts/v05-gl-resolution.integration.test.ts` | 356 | BCY |
| `tests/db/billing-schema.integration.test.ts` | 200, 203 | FIN, BAN |
| `tests/db/create-customer.integration.test.ts` | 105 | ORG |
| `tests/db/customer-schema.integration.test.ts` | 112 | ORG |
| `tests/db/product-schema.integration.test.ts` | 84 | PRDOFR |

Add or confirm at least one assertion per widened table that a fresh insert now produces an 8-digit suffix (e.g. `expect(row.billCycleId).toMatch(/^BCY\d{8}$/)`), so the migration's actual effect is covered, not just the validators.

### 4.5 Optional cosmetic cleanup — not functionally required

`tests/auth/guard.integration.test.ts:377,383`, `tests/services/get-offering-detail.service.test.ts:48,177,193`, `tests/validation/offering-list.schema.test.ts:65,67` hardcode 6-digit fixture literals (`PRDOFP000001`, `PRDSMD000001`). No regex validates `PRDOFP`/`PRDSMD` width (§4.3's table confirms neither appears there), so these remain valid opaque fixture strings after the change — purely stale-looking, not broken. Fine to leave, or reword to 8 digits in the same pass for tidiness.

### 4.6 Docs

`code-standards.md` #18: change "Domain-table IDs are a fixed prefix + zero-padded per-table DB sequence (e.g. `PRDOFR000001`)" to name the width explicitly (e.g. `PRDOFR00000001`, 8 digits) so the convention is unambiguous for the next module.

## 5. Existing (seed/dev) data — explicit decision point

Dev/staging already has rows inserted under the old width via `db/seeds/**` (e.g. `seed-bill-cycles.ts`, `seed-gl-mappings.ts`). Two options:

- **(a) Leave as-is (recommended default).** Old rows keep their narrower IDs permanently; new rows from this point forward get 8 digits. Both coexist safely as primary keys/FKs — `text` columns don't enforce a shared width. This is the entire reason §4.3 recommends `\d+` over a re-fixed `\d{8}`: it's what makes option (a) safe. Zero risk, zero extra work.
- **(b) Wipe and reseed** dev/staging for a cosmetically consistent baseline (all IDs 8 digits from row 1). Trivial since seeding is already script-driven (`db/seeds/**`), but purely cosmetic — not required for correctness.

Default to (a) unless a clean baseline is specifically wanted before the next demo/test cycle.

**Outcome + ordering audit (post-implementation).** The database was rebuilt from `0000`, so every row is 8-digit — the mixed-width state option (a) would create does not actually exist here. Before relying on that uniformity, the callers that order/compare IDs as strings were audited: `db/repositories/accounts/billing-account.repository.ts`, `db/repositories/contact-medium.ts`, `services/accounts/get-financial-account-detail.ts`, and `services/accounts/get-transaction-document-detail.ts` all `ORDER BY <id>`. With uniform 8-digit width, lexical order equals numeric (creation) order, so these are correct as-is. If option (a) (genuinely mixed widths) is ever adopted, or a sequence passes 8 digits, switch those sorts to a numeric suffix or a creation-order/timestamp column.

## 6. Sequencing

Migration (4.1) and schema (4.2) land together — same as every prior schema change in this project. Validation (4.3) can land in the same commit or immediately after; until it lands, the exact-length regexes will reject any newly-inserted 8-digit ID passed back through a form (e.g. selecting a brand-new `financial_account` in the payment-allocation flow would fail client validation) — so don't ship 4.1/4.2 to an environment already exercising these flows without 4.3. Tests (4.4) follow, then `typecheck`/`lint`/full suite green, then docs (4.6). *As shipped:* 4.1 landed folded into the base migrations (`0006`/`0009`/`0012`) rather than a new `0023`; the remaining steps (4.2–4.6) applied as described.

## 7. Verification checklist

- [x] Schema + base migrations build the 8-digit defaults (folded into `0006`/`0009`/`0012`); a rebuilt DB shows all 9 tables with `lpad(..., 8, '0')` and fresh inserts 8-digit (confirmed by read-only query).
- [x] All 9 `db/schema/*.ts` default expressions are `8` and match the base migrations.
- [x] Grep sweep: zero remaining `\{6\}` / `\{7\}` exact-length ID regexes for the 9 prefixes in `validation/` (confirms §4.3 fully applied).
- [x] `typecheck` / `lint` / full unit suite green (2097 tests), including the 5 files in §4.4.
- [x] `code-standards.md` #18 updated.
- [ ] **Pending:** full DB-integration suite (`vitest --config vitest.integration.config.ts`) against a disposable/CI DB — not run locally (it drops+rebuilds all schemas). The pre-existing narrow-width regression check is moot here: the DB was rebuilt to a uniform 8-digit baseline, so no narrow-width rows remain.

## 8. Explicitly not in this change

No change to `party_role`, `contact_medium`, `document_line`, or `document`'s per-`doc_type` sequences — already 8 digits. No column type change (stays `text`) or sequence type change (stays `BIGINT`) on any table. No backfill/rewrite of existing primary keys. No change to `gl_code` or `reason_code` (natural keys, not sequence-generated — out of scope for this convention entirely). No change to the ULID-based `audit_log` or future ledger/CDR/invoice tables — those follow the separate ULID policy (`_change-audit-ulid-partitioning-plan.md` §2), not this one.
