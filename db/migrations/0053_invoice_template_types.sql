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
