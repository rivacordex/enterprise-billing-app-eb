-- bm50 (Invoice Template update, Part 4) — invoice template catalog: four
-- billing catalog tables (unpartitioned), the DB-enforced version rules, the
-- two customer_bill posting-stamp columns, the seed rows (INVOICE, layout
-- INVTPL-STD-A4 v1, default generated v1, CSV v1), and the invoice_settings
-- permission row. Schema + seed only — no consumer reads these until bm53.
-- Inv #41/#42/#44/#23; code-standards Part 2 data rules; G3/G6/G7/G10/G12.

CREATE TABLE "billing"."bill_format" (
  "bill_format_id" text PRIMARY KEY CHECK ("bill_format_id" IN ('INVOICE')),
  "name" text NOT NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_template_version_seq" START 1;
--> statement-breakpoint
CREATE TABLE "billing"."bill_template_version" (
  "bill_template_version_id" text PRIMARY KEY DEFAULT 'BTV' || lpad(nextval('billing.bill_template_version_seq')::text, 8, '0'),
  "ref_bill_format_id"   text NOT NULL REFERENCES "billing"."bill_format"("bill_format_id"),
  "kind"                 text NOT NULL CHECK ("kind" IN ('layout','generated','csv')),
  "version_no"           integer NOT NULL CHECK ("version_no" >= 1),
  "status"               text NOT NULL CHECK ("status" IN ('DRAFT','ACTIVE','RETIRED')),
  "is_default"           boolean NOT NULL DEFAULT false,
  "layout_code"          text,
  "ref_layout_version_id" text REFERENCES "billing"."bill_template_version"("bill_template_version_id"),
  "structure"            jsonb,
  "page_setup"           jsonb,
  "blob_ref"             text,
  "checksum"             text,
  "checksum_algorithm"   text CHECK ("checksum_algorithm" IN ('sha256')),
  "change_note"          text,
  "created_by"           text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL,
  "created_datetime"     timestamptz NOT NULL DEFAULT now(),
  "activated_by"         text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL,
  "activated_datetime"   timestamptz,
  "retired_datetime"     timestamptz,
  "last_modified_datetime" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "btv_version_uq" UNIQUE ("ref_bill_format_id", "kind", "version_no"),
  CONSTRAINT "btv_files_when_not_draft" CHECK ("status" = 'DRAFT' OR ("blob_ref" IS NOT NULL AND "checksum" IS NOT NULL AND "checksum_algorithm" IS NOT NULL AND "activated_datetime" IS NOT NULL)),
  CONSTRAINT "btv_draft_has_no_files" CHECK ("status" <> 'DRAFT' OR ("blob_ref" IS NULL AND "checksum" IS NULL)),
  CONSTRAINT "btv_change_note" CHECK ("status" = 'DRAFT' OR length(btrim(coalesce("change_note", ''))) > 0),
  CONSTRAINT "btv_generated_has_layout" CHECK ("kind" <> 'generated' OR ("ref_layout_version_id" IS NOT NULL AND "structure" IS NOT NULL)),
  CONSTRAINT "btv_layout_has_code" CHECK ("kind" <> 'layout' OR ("layout_code" IS NOT NULL AND "page_setup" IS NOT NULL)),
  CONSTRAINT "btv_draft_only_generated" CHECK ("status" <> 'DRAFT' OR "kind" = 'generated'),
  CONSTRAINT "btv_default_not_draft" CHECK (NOT "is_default" OR "status" = 'ACTIVE')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "btv_one_active_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "status" = 'ACTIVE' AND NOT "is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX "btv_one_default_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX "btv_one_draft_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "status" = 'DRAFT';
--> statement-breakpoint
CREATE INDEX "btv_layout_ref_idx" ON "billing"."bill_template_version" ("ref_layout_version_id");
--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_asset_seq" START 1;
--> statement-breakpoint
CREATE TABLE "billing"."bill_asset" (
  "bill_asset_id" text PRIMARY KEY DEFAULT 'INVAST' || lpad(nextval('billing.bill_asset_seq')::text, 8, '0'),
  "kind" text NOT NULL CHECK ("kind" IN ('logo')),
  "name" text NOT NULL,
  "created_by" text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_asset_version_seq" START 1;
--> statement-breakpoint
CREATE TABLE "billing"."bill_asset_version" (
  "bill_asset_version_id" text PRIMARY KEY DEFAULT 'INVASV' || lpad(nextval('billing.bill_asset_version_seq')::text, 8, '0'),
  "ref_bill_asset_id" text NOT NULL REFERENCES "billing"."bill_asset"("bill_asset_id"),
  "version_no" integer NOT NULL CHECK ("version_no" >= 1),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','RETIRED')),
  "mime" text NOT NULL CHECK ("mime" IN ('image/png','image/jpeg','image/svg+xml')),
  "width" integer NOT NULL CHECK ("width" > 0),
  "height" integer NOT NULL CHECK ("height" > 0),
  "byte_size" integer NOT NULL CHECK ("byte_size" BETWEEN 1 AND 512000),
  "blob_ref" text NOT NULL,
  "checksum" text NOT NULL,
  "checksum_algorithm" text NOT NULL CHECK ("checksum_algorithm" IN ('sha256')),
  "created_by" text REFERENCES "core"."appuser"("user_id") ON DELETE SET NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now(),
  "retired_datetime" timestamptz,
  CONSTRAINT "basv_version_uq" UNIQUE ("ref_bill_asset_id", "version_no")
);
--> statement-breakpoint
-- D2 — version-rules guards. Messages begin with the binding error code so the
-- app maps SQLSTATE 23001 + prefix to a typed AppError (DEFAULT_VERSION_IMMUTABLE,
-- VERSION_IMMUTABLE, VERSION_DELETE_FORBIDDEN).
CREATE FUNCTION "billing"."bill_template_version_guard"() RETURNS trigger
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
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_datetime IS DISTINCT FROM OLD.created_datetime THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: identity columns of % cannot change.', OLD.bill_template_version_id USING ERRCODE = '23001';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.layout_code IS DISTINCT FROM OLD.layout_code
       OR NEW.ref_layout_version_id IS DISTINCT FROM OLD.ref_layout_version_id
       OR NEW.page_setup IS DISTINCT FROM OLD.page_setup
       OR NEW.blob_ref IS DISTINCT FROM OLD.blob_ref
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm
       OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
       OR NEW.activated_datetime IS DISTINCT FROM OLD.activated_datetime
       OR NEW.retired_datetime IS DISTINCT FROM OLD.retired_datetime THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: a DRAFT may change only structure/change_note (%).', OLD.bill_template_version_id USING ERRCODE = '23001';
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
--> statement-breakpoint
CREATE FUNCTION "billing"."bill_asset_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERSION_DELETE_FORBIDDEN: bill_asset_version rows are never deleted (%).', OLD.bill_asset_version_id USING ERRCODE = '23001';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED'
     AND NEW.bill_asset_version_id IS NOT DISTINCT FROM OLD.bill_asset_version_id
     AND NEW.ref_bill_asset_id IS NOT DISTINCT FROM OLD.ref_bill_asset_id
     AND NEW.version_no IS NOT DISTINCT FROM OLD.version_no
     AND NEW.mime IS NOT DISTINCT FROM OLD.mime
     AND NEW.width IS NOT DISTINCT FROM OLD.width
     AND NEW.height IS NOT DISTINCT FROM OLD.height
     AND NEW.byte_size IS NOT DISTINCT FROM OLD.byte_size
     AND NEW.blob_ref IS NOT DISTINCT FROM OLD.blob_ref
     AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
     AND NEW.checksum_algorithm IS NOT DISTINCT FROM OLD.checksum_algorithm THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'VERSION_IMMUTABLE: bill_asset_version allows only ACTIVE -> RETIRED (%).', OLD.bill_asset_version_id USING ERRCODE = '23001';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "billing"."bill_catalog_forbid"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERSION_DELETE_FORBIDDEN: % rows are never deleted.', TG_TABLE_NAME USING ERRCODE = '23001';
  END IF;
  RAISE EXCEPTION 'VERSION_IMMUTABLE: % rows are immutable.', TG_TABLE_NAME USING ERRCODE = '23001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "bill_template_version_guard_trg" BEFORE UPDATE OR DELETE ON "billing"."bill_template_version"
  FOR EACH ROW EXECUTE FUNCTION "billing"."bill_template_version_guard"();
--> statement-breakpoint
CREATE TRIGGER "bill_asset_version_guard_trg" BEFORE UPDATE OR DELETE ON "billing"."bill_asset_version"
  FOR EACH ROW EXECUTE FUNCTION "billing"."bill_asset_version_guard"();
--> statement-breakpoint
CREATE TRIGGER "bill_asset_forbid_trg" BEFORE DELETE ON "billing"."bill_asset"
  FOR EACH ROW EXECUTE FUNCTION "billing"."bill_catalog_forbid"();
--> statement-breakpoint
CREATE TRIGGER "bill_format_forbid_trg" BEFORE UPDATE OR DELETE ON "billing"."bill_format"
  FOR EACH ROW EXECUTE FUNCTION "billing"."bill_catalog_forbid"();
--> statement-breakpoint
-- D6 — customer_bill posting-stamp columns (G12 interim). Nullable, no FK
-- (partitioned parent + the plain-key stamp rule, 0029 precedent). Written only
-- by stampPosted (bm54); NOT granted to billrun_runtime in any form.
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_invoice_profile_version" integer;
--> statement-breakpoint
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_csv_template_version_id" text;
--> statement-breakpoint
-- D4 — seed rows. Explicit IDs keep the seed deterministic; setval moves the
-- sequence past them. created_by/activated_by are NULL (system seed). Each
-- checksum is the SHA-256 of that version directory's checksums.json (D3),
-- recomputed by tests/db/invoice-template-seed-checksums.test.ts.
INSERT INTO "billing"."bill_format" ("bill_format_id", "name") VALUES ('INVOICE', 'Tax invoice');
--> statement-breakpoint
INSERT INTO "billing"."bill_template_version"
  ("bill_template_version_id", "ref_bill_format_id", "kind", "version_no", "status", "is_default",
   "layout_code", "page_setup", "blob_ref", "checksum", "checksum_algorithm", "change_note", "activated_datetime")
VALUES
  ('BTV00000001', 'INVOICE', 'layout', 1, 'ACTIVE', true,
   'INVTPL-STD-A4',
   '{"format":"A4","orientation":"portrait","margin":{"top":"13mm","bottom":"16mm","left":"14mm","right":"14mm"},"displayHeaderFooter":true,"printBackground":true}'::jsonb,
   'invoice-templates/layouts/INVTPL-STD-A4/v1/',
   '55cff2f3fcce23cd4815e09ecdf51c7c7a3c8189ece2c99f3c0a6a07b89a8220', 'sha256',
   'Seeded default layout INVTPL-STD-A4 v1 (bm50).', now());
--> statement-breakpoint
INSERT INTO "billing"."bill_template_version"
  ("bill_template_version_id", "ref_bill_format_id", "kind", "version_no", "status", "is_default",
   "ref_layout_version_id", "structure", "blob_ref", "checksum", "checksum_algorithm", "change_note", "activated_datetime")
VALUES
  ('BTV00000002', 'INVOICE', 'generated', 1, 'ACTIVE', true,
   'BTV00000001',
   '{"sections":{"billTo":true,"identification":true,"amountDue":true,"chargeSummary":true,"taxSummary":true,"payment":true,"chargeDetails":true,"usageAnnex":true,"notes":true},"columns":{"showServicePeriod":true,"showDiscountColumn":true,"showProductId":true,"showUdrCount":true}}'::jsonb,
   'invoice-templates/generated/INVOICE/v1/',
   '45be7ad972b7b6912fd2f4e2e443620afb245cf00ad40844330020ea2098506b', 'sha256',
   'Seeded default generated template v1 (bm50).', now());
--> statement-breakpoint
INSERT INTO "billing"."bill_template_version"
  ("bill_template_version_id", "ref_bill_format_id", "kind", "version_no", "status", "is_default",
   "blob_ref", "checksum", "checksum_algorithm", "change_note", "activated_datetime")
VALUES
  ('BTV00000003', 'INVOICE', 'csv', 1, 'ACTIVE', true,
   'invoice-templates/system/csv/v1/',
   'ef31c2f1b96d6f6278fe2a0e4f657755c8c75bf17eab105bd3da7d0c8e579c05', 'sha256',
   'Seeded CSV column map v1 (bm50).', now());
--> statement-breakpoint
SELECT setval('billing.bill_template_version_seq', 3);
--> statement-breakpoint
-- D7 — the invoice_settings permission row (role grants are applied by
-- db:seed-billing, the 0043 precedent). READ and EDIT only; no DELETE.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES
  ('invoice_settings', 'Controls access to Administration > Invoice Settings: view and edit the company profile and invoice template, upload the invoice logo, and activate versions (read and edit only - no delete).')
ON CONFLICT ("permission_name") DO NOTHING;
