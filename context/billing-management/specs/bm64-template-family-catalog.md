# bm64 — Standard template family in the catalog

**Unit:** bm64 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** database (migration, Drizzle schema, seed, grants, read repository) and its ops runbook · **Depends on:** the fresh-DB round being confirmed (D3, D26)
**Authorizes:** D10, D24, D26, D44, D45 · Inv #44 (amended), #54 (the family half) · code-standards Phase 3 Data rules 1–3, 5, TS rule 3 · guardrail item 61 · workflow rules §1.3, §6.3

## Goal

Add a `billing.bill_template_family` table with one seeded family, **Standard**, and make every `generated` template version belong to a family. On a fresh database the catalog then shows Standard owning the seeded generated version, and the database refuses a family-less generated row or a second non-default ACTIVE or DRAFT inside one family.

## Design

**One family, no consumer yet.** Nothing reads the family in this unit except the catalog's own constraints, the seed, `insertDraft` (which must now set it), and one read repository used by bm65. Resolution (`resolve-template.ts`), posting and every page keep working unchanged. With one family, "per family" and "per format + kind" select the same rows.

**Fresh-DB only.** `0046_invoice_template_catalog.sql` is edited in place (D26). That is safe only because every environment is rebuilt from an empty database **and** an empty `invoice-templates` container (D3, D41), so the seeded rows get their family at INSERT. The guard trigger rejects any UPDATE of an `is_default` row, so there is no backfill and no trigger bypass. The `_journal.json` entry for `0046` is not touched. Migrations after `0026` are hand-written SQL with no drizzle-kit snapshot.

**Table `billing.bill_template_family`** (added to `0046` after `bill_format`, before `bill_template_version`). Timestamp names follow this catalog's existing `*_datetime` convention (see `bill_template_version`):

```sql
CREATE SEQUENCE "billing"."bill_template_family_seq" START 1;
CREATE TABLE "billing"."bill_template_family" (
  "bill_template_family_id" text PRIMARY KEY DEFAULT 'BTF' || lpad(nextval('billing.bill_template_family_seq')::text, 8, '0'),
  "code"              text NOT NULL,
  "name"              text NOT NULL,
  "kind"              text NOT NULL CHECK ("kind" = 'generated'),
  "is_default"        boolean NOT NULL DEFAULT false,
  "retired_datetime"  timestamptz,
  "created_by"        text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL,
  "created_datetime"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "btf_code_uq" UNIQUE ("code"),
  CONSTRAINT "btf_default_not_retired" CHECK (NOT ("is_default" AND "retired_datetime" IS NOT NULL))
);
CREATE UNIQUE INDEX "btf_one_default_uq" ON "billing"."bill_template_family" ("kind") WHERE "is_default";
```

- There is no `status` column (D44): a family is *usable* when `retired_datetime IS NULL` and it has an ACTIVE `generated` version.
- `code` stays unique across retired rows, because a family code is never reused (code-standards Data rule 2).
- `name`, `code` and `kind` are immutable. Add a `bill_template_family_guard` trigger reusing the 0046 pattern: refuse DELETE (`VERSION_DELETE_FORBIDDEN`); refuse any UPDATE of a default row (`DEFAULT_VERSION_IMMUTABLE`); otherwise allow only `retired_datetime` NULL → a value (`VERSION_IMMUTABLE` for anything else). Nothing in this phase retires a family; the trigger only makes the rule hold for later.

**Changes to `billing.bill_template_version`:**
- New column `"ref_bill_template_family_id" text REFERENCES "billing"."bill_template_family"("bill_template_family_id")`, placed after `ref_layout_version_id`.
- New CHECK: `CONSTRAINT "btv_generated_has_family" CHECK ("kind" <> 'generated' OR "ref_bill_template_family_id" IS NOT NULL)`. Layout and CSV rows have no family.
- **Indexes** (replace the three partial unique indexes):

```sql
CREATE UNIQUE INDEX "btv_one_active_family_uq" ON "billing"."bill_template_version" ("ref_bill_template_family_id")
  WHERE "kind" = 'generated' AND "status" = 'ACTIVE' AND NOT "is_default";
CREATE UNIQUE INDEX "btv_one_active_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "kind" <> 'generated' AND "status" = 'ACTIVE' AND NOT "is_default";
CREATE UNIQUE INDEX "btv_one_default_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "is_default";                                         -- unchanged
CREATE UNIQUE INDEX "btv_one_draft_uq" ON "billing"."bill_template_version" ("ref_bill_template_family_id")
  WHERE "status" = 'DRAFT';                                   -- DRAFT is generated-only (btv_draft_only_generated)
CREATE INDEX "btv_family_ref_idx" ON "billing"."bill_template_version" ("ref_bill_template_family_id");
```

  `btv_one_default_uq` stays (`format`, `kind`): the one default `generated` version exists only inside the default family (architecture P7).
- **Guard trigger:** add `OR NEW.ref_bill_template_family_id IS DISTINCT FROM OLD.ref_bill_template_family_id` to the identity check in `bill_template_version_guard`. A version never changes family.

**Seed (in `0046`):**
- `INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind, is_default) VALUES ('BTF00000001', 'STANDARD', 'Standard', 'generated', true);` then `SELECT setval('billing.bill_template_family_seq', 1);`.
- The `BTV00000002` (generated, default) INSERT gains `ref_bill_template_family_id = 'BTF00000001'`. `BTV00000001` (layout) and `BTV00000003` (csv) stay family-less.
- The seed row's checksums are unchanged. No seeded file content changes in this unit.

**Grants** (in `db/bootstrap/bootstrap-db-roles.sql`, next to the bm50 block): `bill_template_family` is created by `app_migrate`, so the default-privilege path hands `app_runtime` full DML. Revoke to SELECT only:

```sql
REVOKE INSERT, UPDATE, DELETE ON TABLE "billing"."bill_template_family" FROM app_runtime;
```

  Grant `USAGE` on `bill_template_family_seq` only if a later phase adds a create-family screen; not now. `billrun_runtime` gets nothing (`billrun-db-roles.sql` unchanged).

**Application code touched (keeps the tree green):**
- `billTemplateVersionRepository.insertDraft` must now set `refBillTemplateFamilyId`, or Save draft breaks on `btv_generated_has_family`. The service passes the family of the version invoices currently use. Since the working draft is built from that version (bm57), use its `ref_bill_template_family_id`. Resolution queries (`findActive`, `findDefault`, `findDraft`, `lockKind`) stay keyed by format and kind: with one family the result is identical, and family-aware selection arrives with capture in bm65.
- New read repository `db/repositories/billing/bill-template-family.ts`: `findDefault(tx)` (the `is_default` row) and `findById(tx, id)`. Used by bm65.

**Deliberately not done:** no family create/retire UI or action (D45); no change to `billing_account` or `0050` (D46); no resolver change; no family shown on any page (bm72 adds the "Standard (default)" heading).

**Visible result:** on a fresh database, `SELECT * FROM billing.bill_template_family` returns one row, Standard (default). The seeded generated version references it. The database refuses a family-less generated row, a second non-default ACTIVE or DRAFT in Standard, any UPDATE of Standard, and a DELETE. Invoice Settings › Invoice template › Version history is unchanged, and Save draft and Activate still work.

## Implementation

### 1. Migration `0046` (edit in place)

File: `db/migrations/0046_invoice_template_catalog.sql`.
1. Insert the sequence, table, `btf_one_default_uq` and the family guard function and trigger after the `bill_format` block.
2. Add the column and `btv_generated_has_family` to `bill_template_version`.
3. Replace the three partial unique indexes with the four above, and add `btv_family_ref_idx`.
4. Add the identity line to `bill_template_version_guard`.
5. Insert `BTF00000001` before the version seed rows, and give the `BTV00000002` INSERT its family.
6. Update the header comment to cite bm64 / D26.

Do **not** touch `db/migrations/meta/_journal.json`.

### 2. Drizzle schema

- New `db/schema/billing/bill-template-family.ts`: `billTemplateFamilySeq` and `billTemplateFamily` (columns as above; the header comment says the migration is the DDL of record, the bm50 convention). Export it from `db/schema/billing/index.ts`.
- `db/schema/billing/bill-template-version.ts`: add `refBillTemplateFamilyId: text("ref_bill_template_family_id")`. Keep it plain text with no Drizzle FK, like `ref_layout_version_id`.

### 3. Types and validation

- `types/billing.ts`: `export type BillTemplateFamily = typeof billTemplateFamily.$inferSelect;` (general §2.7).
- New `validation/billing/template-family-id.schema.ts`: `export const templateFamilyIdSchema = z.string().regex(/^BTF\d+$/);` (general §6.18; mirrors `template-version-id.schema.ts`).

### 4. Repositories

- New `db/repositories/billing/bill-template-family.ts` with `billTemplateFamilyRepository.findDefault(tx)` and `findById(tx, id)`, both returning `BillTemplateFamily | null`.
- `db/repositories/billing/bill-template-version.ts` `insertDraft`: add the `refBillTemplateFamilyId: string` input and value.
- `services/billing/invoice-template/save-template-draft.ts` (the `insertDraft` call, ~l.140): pass the family of the base version it already loads.

### 5. Grants

`db/bootstrap/bootstrap-db-roles.sql`: the REVOKE above, with a comment citing bm64 / Inv #23.

### 6. Fresh-environment runbook (T11)

- `infra/docs/environment-operations.md`: a new section "Fresh rebuild — Invoice Template Phase 3", next to the existing `invoice-templates` seed notes (~l.583, ~l.798). It sets out the steps, in this order:
  1. drop and recreate the database;
  2. delete and recreate the `invoice-templates` container, or every blob under `layouts/INVTPL-STD-A4/v1/` and `generated/INVOICE/v1/`;
  3. `npm run db:bootstrap-roles` (and the other role bootstraps);
  4. `npm run db:setup`.

  It also explains why: the store is write-once, and the seed refuses a differing blob with `SEED_BLOB_CONFLICT`.
- `README.md`, the local Azurite steps (~l.154): the same reset for Docker (`docker compose down -v` for the Azurite volume, or deleting the container in Azure Storage Explorer).

### 7. Tests

- `tests/db/invoice-template-catalog.integration.test.ts`:
  - **Seed:** one family, and `BTV00000002` references it.
  - **Rejected writes:**
    - a `generated` INSERT without a family → 23514 (`btv_generated_has_family`);
    - a second non-default ACTIVE in the family → 23505 (`btv_one_active_family_uq`);
    - a second DRAFT → 23505 (`btv_one_draft_uq`);
    - an UPDATE of a version's family → `VERSION_IMMUTABLE`;
    - a second default family → 23505 (`btf_one_default_uq`);
    - UPDATE or DELETE of Standard → refused.
  - **Allowed:** layout and CSV inserts without a family.
- Update the raw `INSERT INTO billing.bill_template_version` fixtures for `generated` rows to set `ref_bill_template_family_id = 'BTF00000001'`:
  - `tests/db/helpers/invoice-render-fixtures.ts` (~l.119)
  - `tests/db/activate-template.integration.test.ts` (~l.533, ~l.547)
  - `tests/db/invoice-csv.integration.test.ts` (~l.162)
  - `tests/db/invoice-template-catalog.integration.test.ts` (~l.60, ~l.166–184)
  - `tests/db/save-template-draft.integration.test.ts` (~l.347)
- `tests/db/save-template-draft.integration.test.ts`: the first save writes the base version's family.
- `tests/guardrails/invoice-settings-grants.integration.test.ts`: over `information_schema`, `app_runtime` has only SELECT on `bill_template_family`, and `billrun_runtime` has none.
- `tests/db/billing-schema.test.ts`: the new table and column are present.

## Dependencies

- **Packages:** none. Drizzle, `postgres`, Zod and vitest are already installed; this unit is SQL, schema and tests.
- **Units:** none (first unit of Phase 3).
- **Environment:** an operator confirms the fresh-DB round: an empty database **and** an empty `invoice-templates` container for every environment that runs this unit (workflow rules §1.3). At the start of the unit, run the general §5 "stop, explain, confirm" step for editing an applied migration, citing D26.

## Verification checklist

- [ ] The diff touches `0046_invoice_template_catalog.sql` and no other existing migration; `_journal.json` is unchanged (general §8.8 exception, workflow rules §8.6).
- [ ] On an empty database, `npm run db:setup` succeeds; a second run is a no-op (the seed is idempotent).
- [ ] `SELECT bill_template_family_id, code, is_default FROM billing.bill_template_family` → `BTF00000001 | STANDARD | true`.
- [ ] `SELECT bill_template_version_id, ref_bill_template_family_id FROM billing.bill_template_version ORDER BY 1` → `BTV00000001 | NULL`, `BTV00000002 | BTF00000001`, `BTV00000003 | NULL`.
- [ ] Guardrail item 61: the catalog integration tests above pass.
- [ ] Invoice Settings › Invoice template: Save draft and Activate still succeed, and the new draft and version carry `BTF00000001`.
- [ ] Grants: `app_runtime` has SELECT only on `bill_template_family`; `billrun_runtime` has nothing.
- [ ] `npm run typecheck`, `npm run lint`, the unit suite and the integration suite are green. Guardrails 43–56 still pass, especially 45 (default resolution) and 46 (pinning).
- [ ] No file under `services/accounts/**`, `components/customers/**` or `app/(app)/customers/**` changed, and `0050` is unchanged.
- [ ] Docs:
  - architecture Inv #44 note and the Phase 3 storage row say "built (bm64)";
  - code-standards guardrail item 61 says "built (bm64)";
  - progress tracker entry added;
  - the corrections below applied.

## Open questions

1. **Doc corrections (no decision needed; apply with this unit).**
   - code-standards Phase 3 Data rule 2 names the column `retired_at timestamptz(3)`; this catalog's convention is `retired_datetime timestamptz` (no precision), and the spec follows the code. Same for architecture's storage row and D44.
   - code-standards Data rule 5 and workflow rules §6.8 put the grant in `db/bootstrap/billrun-db-roles.sql`; the catalog tables' `app_runtime` grants live in `db/bootstrap/bootstrap-db-roles.sql`.
2. **Family `code` value.** The spec uses `STANDARD`. If the business wants a different code (e.g. `INVTPL-STD`), say so before the build; it is immutable once seeded.
