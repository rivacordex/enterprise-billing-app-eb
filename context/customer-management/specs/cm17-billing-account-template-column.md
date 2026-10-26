# CM17 — Billing Account Template Reference Column

- **Unit:** 17 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** DB.
- **Dependencies:** delivered Accounts module (`billing.billing_account`, migration `0012`, ac02); delivered Billing template catalog (`billing.bill_template_version`, migration `0046`, bm50).
- **Authorizing sections:** `_updatemodule-customer-accounts-invoice-template-binding-plan.md` §4, D9, D10; the binding update overview (folded into `custmgmt-project-overview.md`) *Features → Data model*; `custmgmt-architecture.md` §7.3 and Inv. #18; `custmgmt-ai-workflow-rules.md` §9.2 (cm17), §9.4 item 2.
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10 (latest applied migration `0049_product_price_lane_key`).

> **Framing.** `billing.billing_account` is an **Accounts-module** table; Customer Management adds one column to it because the customer screens are where the binding is captured and shown. The column is pure plumbing: in v1 only `NULL` is ever written (cm18, cm21) and posting never reads it (Inv. #18). This unit lands the column alone, verified, before any service reads or writes it (`custmgmt-ai-workflow-rules.md` §9.4).

---

## 1. Goal

Add a nullable `ref_bill_template_version_id` column, with a foreign key to `billing.bill_template_version`, to `billing.billing_account` in one forward migration, and mirror it in the Drizzle schema. Every existing BAN reads back `NULL`.

## 2. Design

**Structural decisions**

- **Nullable, no default, no backfill (D9).** `NULL` means "follow the current ACTIVE template, else the default". Existing rows stay `NULL`; the migration writes no data.
- **Real FK in the same migration (D9).** The target table exists since `0046`, so there is no deferred FK and no follow-up migration (plan O5 closed). Referential action: `ON DELETE NO ACTION` (the default). Template versions are never deleted — `bill_template_version_guard` refuses every `DELETE` (bm50) — so a cascade or set-null path would be dead code.
- **Explicit constraint name (`context/code-standards.md` §6.19).** `billing_account_ref_bill_template_version_id_fk` is 47 bytes, under the 63-byte cap. The same name appears in the SQL and the Drizzle `foreignKey({ name })`.
- **Meaning is "follow the line", kind `generated` only (D10).** The column type is the version id for referential integrity; v1 never stores a value, and Phase 3 resolves a stored id to its line's ACTIVE version. No `CHECK` on `kind` is added: v1 writes `NULL` only, and the kind rule lives in `assertBindableTemplate` (cm18). Record this in the column comment.
- **No index.** Nothing filters or joins on the column in v1 (the label resolver in cm20 reads it per BAN by primary key). Add an index in Phase 3 if posting starts joining on it.
- **No grant change.** `app_runtime` already holds table-level `SELECT, INSERT, UPDATE, DELETE` on `billing.billing_account` and `SELECT` on `billing.bill_template_version` (`db/bootstrap/bootstrap-db-roles.sql`). `billrun_runtime` and `rating_runtime` hold table-level `SELECT` on `billing_account` and gain read access to the column automatically; neither reads it (Inv. #18).
- **Customer schema untouched.** No change to `customer.*`.

## 3. Implementation

### 3.1 Migration — `db/migrations/0050_billing_account_template_ref.sql` (new)

Use the next free number at build time (`0050` today). Hand-written per `db/migrations/README.md`; statements separated by `--> statement-breakpoint`.

```sql
-- cm17 (Customer Management — Invoice Template Binding update). Adds the
-- per-BAN invoice template reference. NULL = follow the current ACTIVE
-- template, else the default (binding plan D9). Semantics are "follow the
-- template line", kind `generated` only (D10); v1 writes NULL only (D13) and
-- posting never reads this column (custmgmt Inv. #18). No backfill, no index,
-- no grant change (app_runtime already has table-level DML on billing_account).
ALTER TABLE "billing"."billing_account"
  ADD COLUMN IF NOT EXISTS "ref_bill_template_version_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account"
  ADD CONSTRAINT "billing_account_ref_bill_template_version_id_fk"
  FOREIGN KEY ("ref_bill_template_version_id")
  REFERENCES "billing"."bill_template_version"("bill_template_version_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
COMMENT ON COLUMN "billing"."billing_account"."ref_bill_template_version_id" IS
  'Invoice template for this BAN. NULL = follow the current ACTIVE template, else the default. Follow-the-line semantics, kind generated only. v1 accepts NULL only; posting does not read it (cm17).';
```

### 3.2 Journal — `db/migrations/meta/_journal.json` (append)

Append one entry after `0049_product_price_lane_key`: `"idx": 50`, `"version": "7"`, `"tag": "0050_billing_account_template_ref"`, `"breakpoints": true`, and a `"when"` value greater than the `0049` entry's `1791108000000` (follow the existing step, e.g. `1791194400000`). The migrator applies an entry only when its `when` is newer than the last applied one (README §"Adding a migration" item 4).

### 3.3 Drizzle schema — `db/schema/billing/accounts.ts` (extend)

- Import `billTemplateVersion` from `@/db/schema/billing/bill-template-version`.
- Add to the `billingAccount` column map, after `defaultPaymentMethodRef`:

```ts
    // cm17 — per-BAN invoice template reference (binding plan D9/D10).
    // NULL = follow the current ACTIVE template, else the default. v1 writes
    // NULL only (cm18/cm21, D13); posting never reads it (custmgmt Inv. #18).
    // DDL of record: db/migrations/0050_billing_account_template_ref.sql.
    refBillTemplateVersionId: text("ref_bill_template_version_id"),
```

- Add to the table's extras array, next to the existing `foreignKey` for `ref_financial_account_id`:

```ts
    foreignKey({
      columns: [t.refBillTemplateVersionId],
      foreignColumns: [billTemplateVersion.billTemplateVersionId],
      name: "billing_account_ref_bill_template_version_id_fk",
    }),
```

Verify no circular import: `bill-template-version.ts` imports `bill-format`, `identity`, `pg-schema`, `types/billing` and a validation schema, none of which import `accounts.ts`.

`BillingAccount` / `BillingAccountInsert` pick the field up through inference; `refBillTemplateVersionId` is optional on insert, so `onboardCustomerAccounts` keeps compiling unchanged until cm18 sets it.

### 3.4 Tests

**`tests/db/billing-schema.test.ts` (extend — regression).** The `billing.billing_account` "exposes the exact snake_case column set" case lists every column; add `"ref_bill_template_version_id"` to the expected array, or the test fails. Add one case: the column is nullable (`getTableColumns(billingAccount).refBillTemplateVersionId.notNull === false`) and the table config carries a foreign key named `billing_account_ref_bill_template_version_id_fk`.

**`tests/db/billing-account-template-column.integration.test.ts` (new, DB-gated).** Same fresh-migrate setup as `tests/db/billing-schema.integration.test.ts` (`assertTestDatabaseUrl`, drop schemas, `migrate`, raw-SQL fixtures). Cases:

1. `information_schema.columns` shows `billing.billing_account.ref_bill_template_version_id`, `data_type = 'text'`, `is_nullable = 'YES'`, `column_default IS NULL`.
2. `pg_constraint` has `billing_account_ref_bill_template_version_id_fk` (`contype = 'f'`) referencing `billing.bill_template_version(bill_template_version_id)`, and `length(conname) <= 63`.
3. A BAN inserted by raw SQL without the column reads back `NULL`.
4. A BAN with `ref_bill_template_version_id = 'BTV99999999'` (no such row) is rejected with SQLSTATE `23503`.
5. A BAN with `ref_bill_template_version_id = 'BTV00000002'` (the seeded default generated version from `0046`) is accepted — proves the FK target and type line up; the test then deletes nothing (the guard trigger refuses version deletes).

Run only on a throwaway Postgres marked disposable (`custmgmt-ai-workflow-rules.md` §9.1 item 4).

### 3.5 Explicitly NOT in this unit

- Any service, action, validator or UI that reads or writes the column (cm18–cm21).
- Any change to posting, rendering or `resolve-template.ts` (Inv. #18).
- Any index, grant or backfill.

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] `0050_billing_account_template_ref.sql` (or the next free number) applies cleanly on a fresh database and on a database already at `0049`.
- [ ] `_journal.json` entry appended with a `when` newer than `0049`; no existing migration edited.
- [ ] Column is `text`, nullable, no default; every pre-existing BAN reads `NULL`.
- [ ] FK `billing_account_ref_bill_template_version_id_fk` exists, ≤ 63 bytes, same name in SQL and Drizzle.
- [ ] Non-existent template id → `23503`; seeded `BTV00000002` accepted.
- [ ] `tests/db/billing-schema.test.ts` column-set case updated and green; new nullable/FK case green.
- [ ] `tests/db/billing-account-template-column.integration.test.ts` green on a disposable Postgres.
- [ ] `npm run typecheck`, `npm run lint`, Prettier clean; existing onboarding tests (`tests/services/onboard-customer-accounts.service.test.ts`, V7) still green with no code change.
- [ ] No file under `services/billing/**`, `workflow-management/**` or `db/bootstrap/**` changed.
- [ ] `custmgmt-progress-tracker.md` updated; `custmgmt-architecture.md` §7.3 still accurate (no doc drift).
