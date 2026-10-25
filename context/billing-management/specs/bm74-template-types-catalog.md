# bm74 — Type-scoped template catalog in the database

**Unit:** bm74 (Invoice Template Types · Part 6, unit 1 of 12). **Boundary:** DB: one migration, two Drizzle mirrors, and the tests they break. **Specs from:** `billmgmt-update-overview.md` › Features › Data model; `billmgmt-architecture.md` Inv #44 (amended), #62, #65 and the _Invoice Template Types — architecture deltas_ (Storage model, platform deltas); `billmgmt-code-standards.md` › Invoice Template Types, Data rules 1–2, guardrail item 75; `bm00-build-plan.md` Part 6, unit 74. **Model file:** `db/migrations/0046_invoice_template_catalog.sql` (the DDL this migration amends).

> **Framing.** Today the catalog is shaped for **one** layout and **one** type. `btv_version_uq` and `btv_one_active_uq` are global per (format, kind), only `generated` rows carry a type (`btv_generated_has_family`), and only `generated` rows may be DRAFT. Every later unit of this update needs the catalog **type-scoped**:
> - each type has its own `layout_code`, its own layout version line and its own one-ACTIVE / one-DRAFT slots
> - a settings version may only point at a layout of its own type
> - a layout DRAFT carries files and may be overwritten in place, but nothing else about it may change
> - a never-activated DRAFT may be discarded
>
> bm74 builds exactly that, **additively**, on a database that already holds Standard's rows, posted bills and runs. It adds **no** repository function, grant, service or UI. Those arrive just in time in bm77 (create type, grant) and bm78 (`lockTemplateType`, the layout-DRAFT writer). Today's app code keeps working unchanged, because Standard is still the only type.

## Goal

Ship migration `0053_invoice_template_types.sql`, which makes the invoice template catalog type-scoped. It adds `layout_code` and name rules to `bill_template_family`, and per-type uniqueness, composite same-type FKs, layout drafts with files, discard, and `last_modified_by` to `bill_template_version`. It applies cleanly to a populated database, with Standard backfilled and every guard still enforced.

## Design

**Structural decisions**

- **Additive only.** One new migration, `0053`. `0046` and every other applied migration stay untouched (architecture platform deltas, §4).
- **Reuse index names whose meaning carries over.** `save-template-draft.ts:36` maps the 23505 race to `btv_one_draft_uq` / `btv_version_uq`, and the repository and tests cite `btv_one_active_family_uq` / `btv_one_active_uq`. bm74 **drops and recreates those four under the same names** with type-scoped columns. The service mapping and existing assertions therefore keep working. Only `btv_version_csv_uq` is a new name.
- **Unique indexes, not constraints, for partial uniqueness.** `btv_version_uq` was a table `UNIQUE` constraint. It becomes a **partial unique index** (layout and generated only). A violation still reports `constraint_name = 'btv_version_uq'`.
- **Standard is backfilled without a trigger backdoor:**
  - `bill_template_family.layout_code` is added `NOT NULL DEFAULT 'INVTPL-STD-A4'`, then the default is dropped. `ADD COLUMN` fires no UPDATE trigger.
  - The one guarded-row change (Standard's default layout v1 joining the Standard type) runs in a single `DO` block that disables `bill_template_version_guard_trg`, updates exactly one row, `RAISE`s unless one row changed, and re-enables the trigger. A `DO` block is one statement, so a failure rolls the trigger state back with it. No session flag is added to the trigger.
- **Preconditions fail loudly.** The migration aborts unless the database holds exactly one type (default Standard `BTF00000001`) and exactly one layout row, Standard's default layout `BTV00000001`. Both are true on every environment today, because layouts were only ever seeded.
- **Discard is legal in the schema.** A discarded DRAFT is `RETIRED` with `activated_datetime IS NULL`. Today `btv_files_when_not_draft` (files + `activated_datetime` on every non-DRAFT row) and `btv_change_note` would reject it, so both are relaxed for exactly that case. Nothing else about them changes.
- **CSV stays global and never a DRAFT.** `btv_draft_only_generated` is replaced by `btv_draft_not_csv`, which keeps CSV out of DRAFT while letting layout drafts exist. A new `btv_csv_has_no_family` keeps CSV rows type-free.
- **Code and layout-code shapes are DB-enforced.** The format CHECKs on `code` and `layout_code` match today's Standard values (`STANDARD`, `INVTPL-STD-A4`) and the derived values bm77 writes (`WHOLESALE`, `INVTPL-WHOLESALE`). The catalog is billing evidence, so rules are enforced in the DB wherever they can be expressed.
- **Guard changes are minimal and explicit:**
  - **The type guard:** `layout_code` joins the frozen identity, and retirement is still the only allowed update.
  - **The version guard gains:**
    - **DRAFT → DRAFT:** a `layout` DRAFT may change `blob_ref`, `checksum`, `checksum_algorithm`, `page_setup` and `change_note`; a `generated` DRAFT may change `structure`, `change_note` and `ref_layout_version_id`.
    - **DRAFT → RETIRED (discard):** only `status` and a non-NULL `retired_datetime` change.
    - **DRAFT → ACTIVE:** a layout's files are frozen.
  - `last_modified_by` and `last_modified_datetime` are draft-editable (not listed as frozen).

## Implementation

### 1. Migration `db/migrations/0053_invoice_template_types.sql`

Hand-written SQL in the house style (`--> statement-breakpoint` between statements). Order matters: the backfill (step 4) must run before the CHECK and FKs that require it (step 6).

```sql
-- bm74 — Invoice Template Types: the catalog becomes type-scoped. ADDITIVE; runs on a
-- populated database (architecture › Invoice Template Types, platform deltas).

-- 1. Preconditions: exactly one type (Standard) and one layout row (Standard's default v1).
DO $$
BEGIN
  IF (SELECT count(*) FROM "billing"."bill_template_family") <> 1
     OR NOT EXISTS (SELECT 1 FROM "billing"."bill_template_family"
                    WHERE "bill_template_family_id" = 'BTF00000001' AND "is_default") THEN
    RAISE EXCEPTION 'MIGRATION_PRECONDITION: 0053 expects exactly one template type, the default Standard (BTF00000001).';
  END IF;
  IF (SELECT count(*) FROM "billing"."bill_template_version" WHERE "kind" = 'layout') <> 1
     OR NOT EXISTS (SELECT 1 FROM "billing"."bill_template_version"
                    WHERE "kind" = 'layout' AND "is_default" AND "layout_code" = 'INVTPL-STD-A4') THEN
    RAISE EXCEPTION 'MIGRATION_PRECONDITION: 0053 expects exactly one layout version, the default INVTPL-STD-A4 v1.';
  END IF;
END $$;
--> statement-breakpoint

-- 2. bill_template_family: layout_code and name/code rules. ADD COLUMN … DEFAULT fills
--    Standard without firing bill_template_family_guard (no UPDATE happens).
ALTER TABLE "billing"."bill_template_family" ADD COLUMN "layout_code" text NOT NULL DEFAULT 'INVTPL-STD-A4';
--> statement-breakpoint
ALTER TABLE "billing"."bill_template_family" ALTER COLUMN "layout_code" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "billing"."bill_template_family"
  ADD CONSTRAINT "btf_layout_code_uq" UNIQUE ("layout_code"),
  ADD CONSTRAINT "btf_id_layout_code_uq" UNIQUE ("bill_template_family_id", "layout_code"),
  ADD CONSTRAINT "btf_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  ADD CONSTRAINT "btf_layout_code_format" CHECK ("layout_code" ~ '^INVTPL-[A-Z0-9][A-Z0-9_-]{0,63}$'),
  ADD CONSTRAINT "btf_name_format" CHECK ("name" ~ '^[A-Za-z0-9 &()-]{3,60}$'),
  ADD CONSTRAINT "btf_name_spacing" CHECK ("name" = btrim("name") AND "name" !~ '\s{2}');
--> statement-breakpoint
-- Case- and space-insensitive, covering retired rows: a retired name stays reserved.
CREATE UNIQUE INDEX "btf_name_ci_uq" ON "billing"."bill_template_family" (lower(btrim("name")));
--> statement-breakpoint

-- 3. bill_template_version: who last wrote a DRAFT (draft-editable; set by every DRAFT write
--    from bm77 on). Adding a nullable column fires no trigger.
ALTER TABLE "billing"."bill_template_version"
  ADD COLUMN "last_modified_by" text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL;
--> statement-breakpoint

-- 4. The one guarded-row backfill: Standard's default layout v1 joins the Standard type.
--    The guard rejects ANY update of a default row, so it is disabled for this one statement
--    only, asserted, and re-enabled. One DO block = one statement = one rollback unit.
DO $$
DECLARE n integer;
BEGIN
  ALTER TABLE "billing"."bill_template_version" DISABLE TRIGGER "bill_template_version_guard_trg";
  UPDATE "billing"."bill_template_version"
     SET "ref_bill_template_family_id" = 'BTF00000001'
   WHERE "is_default" AND "kind" = 'layout' AND "ref_bill_template_family_id" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'MIGRATION_PRECONDITION: expected to backfill 1 default layout row, changed %.', n;
  END IF;
  ALTER TABLE "billing"."bill_template_version" ENABLE TRIGGER "bill_template_version_guard_trg";
END $$;
--> statement-breakpoint

-- 5. Drop the format-scoped rules (recreated type-scoped below; four keep their names).
ALTER TABLE "billing"."bill_template_version"
  DROP CONSTRAINT "btv_version_uq",
  DROP CONSTRAINT "btv_draft_only_generated",
  DROP CONSTRAINT "btv_draft_has_no_files",
  DROP CONSTRAINT "btv_files_when_not_draft",
  DROP CONSTRAINT "btv_change_note",
  DROP CONSTRAINT "btv_generated_has_family";
--> statement-breakpoint
DROP INDEX "billing"."btv_one_active_uq";
--> statement-breakpoint
DROP INDEX "billing"."btv_one_active_family_uq";
--> statement-breakpoint
DROP INDEX "billing"."btv_one_draft_uq";
--> statement-breakpoint

-- 6. Type-scoped CHECKs. A "discarded" DRAFT is RETIRED with activated_datetime IS NULL.
ALTER TABLE "billing"."bill_template_version"
  ADD CONSTRAINT "btv_type_scoped_has_family" CHECK ("kind" = 'csv' OR "ref_bill_template_family_id" IS NOT NULL),
  ADD CONSTRAINT "btv_csv_has_no_family" CHECK ("kind" <> 'csv' OR "ref_bill_template_family_id" IS NULL),
  ADD CONSTRAINT "btv_draft_not_csv" CHECK ("status" <> 'DRAFT' OR "kind" <> 'csv'),
  ADD CONSTRAINT "btv_draft_has_no_files" CHECK ("status" <> 'DRAFT' OR "kind" = 'layout' OR ("blob_ref" IS NULL AND "checksum" IS NULL)),
  ADD CONSTRAINT "btv_layout_draft_has_files" CHECK (NOT ("kind" = 'layout' AND "status" = 'DRAFT')
    OR ("blob_ref" IS NOT NULL AND "checksum" IS NOT NULL AND "checksum_algorithm" IS NOT NULL)),
  ADD CONSTRAINT "btv_files_when_not_draft" CHECK ("status" = 'DRAFT'
    OR ("status" = 'RETIRED' AND "activated_datetime" IS NULL)
    OR ("blob_ref" IS NOT NULL AND "checksum" IS NOT NULL AND "checksum_algorithm" IS NOT NULL AND "activated_datetime" IS NOT NULL)),
  ADD CONSTRAINT "btv_change_note" CHECK ("status" = 'DRAFT'
    OR ("status" = 'RETIRED' AND "activated_datetime" IS NULL)
    OR length(btrim(coalesce("change_note", ''))) > 0);
--> statement-breakpoint

-- 7. Same-type pair and one-layout-per-type, enforced by FKs. The referenced UNIQUE
--    constraints land first (separate statements).
ALTER TABLE "billing"."bill_template_version"
  ADD CONSTRAINT "btv_id_type_uq" UNIQUE ("bill_template_version_id", "ref_bill_template_family_id");
--> statement-breakpoint
-- A settings (generated) row's layout must belong to the same type. MATCH SIMPLE: rows with
-- a NULL ref_layout_version_id (layout, csv) are not checked.
ALTER TABLE "billing"."bill_template_version"
  ADD CONSTRAINT "btv_pair_same_type_fk" FOREIGN KEY ("ref_layout_version_id", "ref_bill_template_family_id")
  REFERENCES "billing"."bill_template_version" ("bill_template_version_id", "ref_bill_template_family_id");
--> statement-breakpoint
-- A layout row carries its type's layout_code. Generated rows (layout_code NULL) are not checked.
ALTER TABLE "billing"."bill_template_version"
  ADD CONSTRAINT "btv_layout_code_of_type_fk" FOREIGN KEY ("ref_bill_template_family_id", "layout_code")
  REFERENCES "billing"."bill_template_family" ("bill_template_family_id", "layout_code");
--> statement-breakpoint

-- 8. Type-scoped uniqueness (four names reused; save-template-draft.ts maps the first and last).
CREATE UNIQUE INDEX "btv_version_uq" ON "billing"."bill_template_version"
  ("ref_bill_template_family_id", "kind", "version_no") WHERE "kind" IN ('layout', 'generated');
--> statement-breakpoint
CREATE UNIQUE INDEX "btv_version_csv_uq" ON "billing"."bill_template_version"
  ("ref_bill_format_id", "kind", "version_no") WHERE "kind" = 'csv';
--> statement-breakpoint
-- One non-default ACTIVE per (type, kind); the default rows (Standard's v1) sit beside them.
CREATE UNIQUE INDEX "btv_one_active_family_uq" ON "billing"."bill_template_version"
  ("ref_bill_template_family_id", "kind")
  WHERE "kind" IN ('layout', 'generated') AND "status" = 'ACTIVE' AND NOT "is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX "btv_one_active_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "kind" = 'csv' AND "status" = 'ACTIVE' AND NOT "is_default";
--> statement-breakpoint
-- At most one layout DRAFT and one settings DRAFT per type (a pair can exist).
CREATE UNIQUE INDEX "btv_one_draft_uq" ON "billing"."bill_template_version"
  ("ref_bill_template_family_id", "kind") WHERE "status" = 'DRAFT';
--> statement-breakpoint
```

Then the two guard functions, replaced with `CREATE OR REPLACE FUNCTION` (the triggers are unchanged):

```sql
-- 9. Type guard: layout_code joins the frozen identity; retirement stays the only update.
CREATE OR REPLACE FUNCTION "billing"."bill_template_family_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERSION_DELETE_FORBIDDEN: bill_template_family rows are never deleted (%).', OLD.bill_template_family_id USING ERRCODE = '23001';
  END IF;
  IF OLD.is_default THEN
    RAISE EXCEPTION 'DEFAULT_VERSION_IMMUTABLE: the default family % cannot be modified.', OLD.bill_template_family_id USING ERRCODE = '23001';
  END IF;
  IF OLD.retired_datetime IS NULL AND NEW.retired_datetime IS NOT NULL
     AND NEW.bill_template_family_id IS NOT DISTINCT FROM OLD.bill_template_family_id
     AND NEW.code IS NOT DISTINCT FROM OLD.code
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.layout_code IS NOT DISTINCT FROM OLD.layout_code
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND NEW.is_default IS NOT DISTINCT FROM OLD.is_default
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_datetime IS NOT DISTINCT FROM OLD.created_datetime THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'VERSION_IMMUTABLE: bill_template_family allows only retirement (retired_datetime NULL -> a value); name, code and layout_code never change (%).', OLD.bill_template_family_id USING ERRCODE = '23001';
END;
$$;
--> statement-breakpoint

-- 10. Version guard: layout DRAFT overwrite, settings DRAFT re-point, discard, frozen layout
--     files at activation. Identity list and ACTIVE -> RETIRED unchanged.
CREATE OR REPLACE FUNCTION "billing"."bill_template_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERSION_DELETE_FORBIDDEN: bill_template_version rows are never deleted (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
  END IF;
  IF OLD.is_default THEN
    RAISE EXCEPTION 'DEFAULT_VERSION_IMMUTABLE: the default version % cannot be modified.', OLD.bill_template_version_id USING ERRCODE = '23001';
  END IF;
  IF NEW.bill_template_version_id IS DISTINCT FROM OLD.bill_template_version_id
     OR NEW.ref_bill_format_id IS DISTINCT FROM OLD.ref_bill_format_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.is_default IS DISTINCT FROM OLD.is_default
     OR NEW.ref_bill_template_family_id IS DISTINCT FROM OLD.ref_bill_template_family_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_datetime IS DISTINCT FROM OLD.created_datetime THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: identity columns of % cannot change.', OLD.bill_template_version_id USING ERRCODE = '23001';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.layout_code IS DISTINCT FROM OLD.layout_code
       OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
       OR NEW.activated_datetime IS DISTINCT FROM OLD.activated_datetime
       OR NEW.retired_datetime IS DISTINCT FROM OLD.retired_datetime THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: a DRAFT may not change its layout code or activation/retirement stamps (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    IF OLD.kind = 'layout'
       AND (NEW.structure IS DISTINCT FROM OLD.structure
            OR NEW.ref_layout_version_id IS DISTINCT FROM OLD.ref_layout_version_id) THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: a layout DRAFT may change only its files, page_setup and change_note (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    IF OLD.kind = 'generated'
       AND (NEW.page_setup IS DISTINCT FROM OLD.page_setup
            OR NEW.blob_ref IS DISTINCT FROM OLD.blob_ref
            OR NEW.checksum IS DISTINCT FROM OLD.checksum
            OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm) THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: a settings DRAFT may change only structure, change_note and ref_layout_version_id (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;

  -- Discard: a never-activated DRAFT becomes RETIRED; nothing else changes.
  IF OLD.status = 'DRAFT' AND NEW.status = 'RETIRED' THEN
    IF NEW.retired_datetime IS NULL
       OR NEW.layout_code IS DISTINCT FROM OLD.layout_code
       OR NEW.ref_layout_version_id IS DISTINCT FROM OLD.ref_layout_version_id
       OR NEW.structure IS DISTINCT FROM OLD.structure
       OR NEW.page_setup IS DISTINCT FROM OLD.page_setup
       OR NEW.blob_ref IS DISTINCT FROM OLD.blob_ref
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm
       OR NEW.change_note IS DISTINCT FROM OLD.change_note
       OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
       OR NEW.activated_datetime IS DISTINCT FROM OLD.activated_datetime THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: discarding a DRAFT may change only status and retired_datetime (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
    IF NEW.structure IS DISTINCT FROM OLD.structure
       OR NEW.layout_code IS DISTINCT FROM OLD.layout_code
       OR NEW.ref_layout_version_id IS DISTINCT FROM OLD.ref_layout_version_id
       OR NEW.page_setup IS DISTINCT FROM OLD.page_setup
       OR NEW.retired_datetime IS DISTINCT FROM OLD.retired_datetime THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: activation may not change structure/layout (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    -- What was previewed is what goes live: a layout's files are frozen at activation.
    IF OLD.kind = 'layout'
       AND (NEW.blob_ref IS DISTINCT FROM OLD.blob_ref
            OR NEW.checksum IS DISTINCT FROM OLD.checksum
            OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm) THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: activating a layout may not change its files (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' THEN
    IF NEW.layout_code IS DISTINCT FROM OLD.layout_code
       OR NEW.ref_layout_version_id IS DISTINCT FROM OLD.ref_layout_version_id
       OR NEW.structure IS DISTINCT FROM OLD.structure
       OR NEW.page_setup IS DISTINCT FROM OLD.page_setup
       OR NEW.blob_ref IS DISTINCT FROM OLD.blob_ref
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm
       OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
       OR NEW.activated_datetime IS DISTINCT FROM OLD.activated_datetime THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: retirement may change only status/retired_datetime (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'VERSION_IMMUTABLE: illegal status transition % -> % (%).', OLD.status, NEW.status, OLD.bill_template_version_id USING ERRCODE = '23001';
END;
$$;
```

Unchanged on purpose: `btv_one_default_uq` (format, kind, `WHERE is_default`), `btv_layout_has_code`, `btv_generated_has_layout`, `btv_default_not_draft`, `btf_one_default_uq`, `btf_default_not_retired`, `btv_layout_ref_idx`, `btv_family_ref_idx`, both triggers, and every seeded row's content.

### 2. Journal entry `db/migrations/meta/_journal.json`

Append, by hand, following the one-day spacing of `0050`–`0052`:

```json
{
  "idx": 53,
  "version": "7",
  "when": 1791453600000,
  "tag": "0053_invoice_template_types",
  "breakpoints": true
}
```

### 3. Drizzle mirrors (typing only; the SQL is the DDL of record)

- **`db/schema/billing/bill-template-family.ts`:**
  - add `layoutCode: text("layout_code").notNull(),` after `name`
  - update the header comment: `layout_code` (unique, frozen with `name` and `code`), the CHECKs and `btf_name_ci_uq` live in `0053`; one row per type; Standard's layout code is `INVTPL-STD-A4`
- **`db/schema/billing/bill-template-version.ts`:**
  - add `lastModifiedBy: text("last_modified_by").references(() => appuser.id, { onDelete: "set null" }),` next to `lastModifiedDatetime`
  - update the comment on `refBillTemplateFamilyId`: "the type of a `layout` or `generated` version (`btv_type_scoped_has_family`); NULL only for CSV (`btv_csv_has_no_family`)"
  - add a header note that layout DRAFTs exist from `0053`, and that discard is DRAFT → RETIRED with `activated_datetime` NULL

### 4. Code comments that name changed rules (comment-only edits)

No behaviour change. These comments would otherwise be wrong:
- **`db/repositories/billing/bill-template-version.ts`:**
  - line ~58: `btv_one_active_family_uq` is now per (type, kind)
  - line ~154: `btv_version_uq` is now per (type, kind)
  - line ~197–200: `btv_draft_has_no_files` applies to settings DRAFTs only, and `btv_type_scoped_has_family` replaces `btv_generated_has_family`
- **`services/billing/invoice-template/activate-template.ts:300`:** the index is now per (type, kind).

`nextVersionNo({ kind })` keeps returning the global max + 1 per kind. That is still unique per type while Standard is the only type. bm77 and bm78 make it type-scoped when a second type can exist.

### 5. Tests

**New: `tests/db/invoice-template-types-catalog.integration.test.ts`** (DB-gated: `describe.skipIf(!databaseUrl)`, `assertTestDatabaseUrl`, schemas dropped before and after, the `invoice-template-catalog.integration.test.ts` harness). Guardrail item **75**.

- **Populated-database apply.**
  - Copy `db/migrations/` to a temp dir, with `_journal.json` trimmed to `idx ≤ 52`, then `migrate()` it.
  - Insert the fixtures 0053 must survive: a non-default Standard `generated` v2 `ACTIVE` (with blob, checksum and change note) pointing at `BTV00000001`, and a Standard `generated` v3 `DRAFT`.
  - Then `migrate()` the real folder. Assert only `0053` was applied (`drizzle.__drizzle_migrations` count grows by 1).
- **After apply:**
  - `layout_code = 'INVTPL-STD-A4'` on `BTF00000001`
  - `BTV00000001.ref_bill_template_family_id = 'BTF00000001'`
  - the v2/v3 fixtures are unchanged
  - `pg_trigger.tgenabled = 'O'` for `bill_template_version_guard_trg` and `bill_template_family_guard_trg`
  - the `drizzle-orm` `last_modified_by` column exists and is nullable
- **Preconditions abort.** On a scratch database migrated to 0052 with a second family row inserted (guard disabled for the fixture), `0053` raises `MIGRATION_PRECONDITION` and leaves no `layout_code` column (whole-migration rollback).
- **Each case below is refused**, asserting `constraint_name` or the `VERSION_IMMUTABLE` prefix:

  | Case | Expected |
  |---|---|
  | Insert a second type with `name` = `"standard"`, `" Standard"` or `"STANDARD"` | `btf_name_ci_uq` / `btf_name_spacing` |
  | Insert a type named `"Whole  sale"` (two spaces), `"ab"` (too short), `"Café"` (bad char) | `btf_name_spacing` / `btf_name_format` |
  | Insert a type with code `"wholesale"` or layout code `"WHOLESALE"` | `btf_code_format` / `btf_layout_code_format` |
  | Insert a second type reusing `layout_code` `INVTPL-STD-A4` | `btf_layout_code_uq` |
  | UPDATE a non-default type's `name`, `code` or `layout_code` | `VERSION_IMMUTABLE` |
  | Retire a non-default type (only `retired_datetime`) | **allowed** |
  | Insert a layout row with no type | `btv_type_scoped_has_family` |
  | Insert a CSV row with a type; insert a CSV `DRAFT` | `btv_csv_has_no_family` / `btv_draft_not_csv` |
  | Insert a `generated` row of type B pointing at type A's layout | `btv_pair_same_type_fk` |
  | Insert a layout row of type B with `layout_code` of type A | `btv_layout_code_of_type_fk` |
  | Two layout v1 rows for the same type | `btv_version_uq` |
  | Layout v1 for type A **and** layout v1 for type B | **allowed** |
  | A second non-default ACTIVE layout for one type | `btv_one_active_family_uq` |
  | A second layout DRAFT for one type; a layout DRAFT **and** a settings DRAFT for one type | refused `btv_one_draft_uq` / **allowed** |
  | A layout DRAFT without files | `btv_layout_draft_has_files` |
  | A settings DRAFT with a `blob_ref` | `btv_draft_has_no_files` |
  | A layout DRAFT: UPDATE `blob_ref`, `checksum`, `page_setup` | **allowed** |
  | A layout DRAFT: UPDATE `structure`, `ref_layout_version_id` or `layout_code` | `VERSION_IMMUTABLE` |
  | A settings DRAFT: UPDATE `ref_layout_version_id` to another same-type layout | **allowed** |
  | A settings DRAFT: UPDATE `blob_ref` | `VERSION_IMMUTABLE` |
  | Discard a layout DRAFT and a settings DRAFT (status `RETIRED`, `retired_datetime = now()`, no change note) | **allowed** |
  | Discard with `retired_datetime` NULL, or while changing `blob_ref` | `VERSION_IMMUTABLE` |
  | Activate a layout DRAFT while changing its `checksum` | `VERSION_IMMUTABLE` |
  | Activate a layout DRAFT unchanged (with change note) | **allowed** |
  | Any UPDATE of `BTV00000001` or `BTF00000001` after the migration | `DEFAULT_VERSION_IMMUTABLE` |
  | `last_modified_by` change on a settings DRAFT | **allowed** |

**Changed (regressions this migration would otherwise break):**
- **`tests/db/invoice-template-catalog.integration.test.ts`:**
  - the seeded-rows test (~line 99–135): the layout row now carries `ref_bill_template_family_id = 'BTF00000001'`
  - "layout and CSV versions are inserted without a family" (~line 263): layout rows **require** a type, and CSV rows **must not** have one
  - the `btv_draft_only_generated` case (~line 357) becomes `btv_draft_not_csv`, plus a layout DRAFT **with** files now being accepted
  - the `btv_generated_has_family` case (~line 225) asserts `btv_type_scoped_has_family`
- **`tests/db/billing-schema.test.ts`:** the exact column sets gain `layout_code` (`billTemplateFamily`) and `last_modified_by` (`billTemplateVersion`). The "carries `ref_bill_template_family_id`, nullable" test's wording becomes "NULL only for CSV".
- **`tests/db/activate-template.integration.test.ts:590`:** the `BTV00000090` layout v2 fixture inserts `ref_bill_template_family_id = 'BTF00000001'`.
- **`tests/helpers/seeded-invoice-template.ts`:** `SEEDED_LAYOUT_ROW.refBillTemplateFamilyId = "BTF00000001"`, and `lastModifiedBy: null` on `SEEDED_LAYOUT_ROW` and `SEEDED_GENERATED_ROW`. The spreading fixtures (`build-invoice-html.test.ts`, `invoice-csv.test.ts`, `load.test.ts`) inherit it. `resolve-ban-template-label.test.ts` casts, so `tsc` stays green.
- **Re-run unchanged and green:** `invoice-template-seed-checksums.test.ts`, `invoice-template-seed-upload.integration.test.ts`, `save-template-draft.integration.test.ts` (its race still maps `btv_one_draft_uq` / `btv_version_uq`), `activate-template.integration.test.ts`, `run-template-capture.integration.test.ts`, and `migration.integration.test.ts`.

## Dependencies

- **Packages:** none.
- **Units:** delivered bm64–bm73 (`0046`, `0051`, `0052` applied). Independent of bm75.
- **Environment:** a disposable Postgres for the DB-gated suites (`assertTestDatabaseUrl`). Never the shared dev stack.

## Verification checklist

- [ ] `0053_invoice_template_types.sql` exists, with its journal entry `idx 53`. No other migration file is modified (`git diff --stat db/migrations` shows only `0053` and `_journal.json`).
- [ ] On a database migrated to `0052` with Standard v2/v3 fixtures, `npm run db:migrate` applies only `0053`. Standard's `layout_code` and layout type id are backfilled, the fixtures are unchanged, and both guard triggers are enabled.
- [ ] A second pre-existing type makes `0053` abort with `MIGRATION_PRECONDITION` and change nothing.
- [ ] Every row of the §5 table behaves as stated (`tests/db/invoice-template-types-catalog.integration.test.ts`, guardrail 75).
- [ ] `btv_version_uq`, `btv_one_draft_uq`, `btv_one_active_family_uq` and `btv_one_active_uq` exist under those names (`pg_indexes`), and `save-template-draft.ts` needs no change.
- [ ] The Drizzle mirrors carry `layoutCode` (NOT NULL) and `lastModifiedBy`. `tsc --noEmit`, ESLint and Prettier pass.
- [ ] The updated catalog, schema, activate and helper tests pass. Save-draft, activate, capture, seed-checksum and seed-upload suites pass unchanged.
- [ ] No repository function, service, action, grant or UI is added (`git diff --stat` touches only `db/migrations/**`, `db/schema/billing/bill-template-{family,version}.ts`, the comment-only lines in §4, and the tests in §5).
- [ ] `billmgmt-architecture.md` Inv #65 note: the DDL half is "built (bm74)", naming the test file. `billmgmt-progress-tracker.md` records bm74.
