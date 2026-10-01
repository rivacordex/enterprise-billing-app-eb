-- pm57a — Card schema, current design. This migration (0041) was rewritten in
-- place to the current design; no deployment based on its earlier shape has
-- taken place, so every environment rebuilds from empty — the module's
-- fresh-install regime, the same one under which 0006_product.sql is edited in
-- place. 0006_product.sql is not reopened.
--
-- RATECARD_RAN_USAGE_LKP: the row key is
-- (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)
-- (D-A9 — polygon_start_date is NOT a key component). polygon_start_date,
-- polygon_end_date, state and district are descriptive; service_code and
-- rate_per_unit are plain (no CHECK); there is no as-of index and no
-- carry-forward columns (no retired_at, no carried_row_count — D-A7).
-- lkp_subscriber_ref_id carries a product_inventory_id VALUE with no FK (D-A1).
-- The ratecard PERMISSIONS row and the types/rbac.ts member stay gated on
-- G-RC3 and are not created here (the pm57 I6 split).

CREATE SEQUENCE "product"."ratecard_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "product"."ratecard_version" (
	"ratecard_version_id" text PRIMARY KEY DEFAULT 'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0') NOT NULL,
	"card_name" text NOT NULL,
	"version_num" integer NOT NULL,
	"status" text NOT NULL,
	-- Upload date in the app timezone, set by the upload service (D-A8). Not
	-- read from the file; never used for matching.
	"snapshot_date" date NOT NULL,
	"source_file" text NOT NULL,
	"file_checksum" text,
	"row_count" integer NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"superseded_by_version_id" text,
	-- status = 'REJECTED' and reject_summary have NO writer in this delivery; a
	-- failed upload writes nothing. Reserved for a future asynchronous ingest.
	"reject_summary" jsonb,
	CONSTRAINT "ratecard_version_card_name_version_num_unique" UNIQUE("card_name","version_num"),
	CONSTRAINT "ratecard_version_status_check" CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED')),
	CONSTRAINT "ratecard_version_uploaded_by_appuser_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "ratecard_version_activated_by_appuser_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
-- At most one live version per card (RV1) — enforced by the index, not app code.
CREATE UNIQUE INDEX "ratecard_version_one_active_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'ACTIVE';
--> statement-breakpoint
-- At most one open DRAFT per card (C8, option A). A wrong draft is replaced by
-- the next upload (D-A11, pm61 D12) — it does not block the card.
CREATE UNIQUE INDEX "ratecard_version_one_draft_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'DRAFT';
--> statement-breakpoint
CREATE TABLE "product"."ratecard_ran_usage_lkp" (
	-- ULID default, not a padded sequence — a high-volume child table whose id
	-- is never displayed (matches rating.udr_rated).
	"ratecard_ran_usage_lkp_id" uuid DEFAULT core.generate_ulid() PRIMARY KEY NOT NULL,
	"ratecard_version_id" text NOT NULL,
	-- key components
	"mno_public_key" text NOT NULL,
	"commercial_unit_public_key" text NOT NULL,
	"polygon_id" text NOT NULL,
	-- descriptive validity-window dates (D-A9) — NOT part of the row key.
	-- polygon_end_date NULL = open-ended / still active.
	"polygon_start_date" date NOT NULL,
	"polygon_end_date" date,
	-- descriptive labels (D-A10) — candidate future key components, plain here.
	"state" text,
	"district" text,
	-- a product_inventory.product_inventory_id VALUE, not a reference. No FK
	-- (D-A1, Inv #57) — validated structurally only; a superseded version must
	-- survive a subscription's removal.
	"lkp_subscriber_ref_id" text NOT NULL,
	-- plain columns — no CHECK, no meaning here (§5, D-A2).
	"service_code" text,
	"rate_per_unit" numeric(18, 6),
	-- RV2 (D-A9): row identity within a version is
	-- (mno_public_key, commercial_unit_public_key, polygon_id) — polygon_start_date
	-- is out of the key. This version-scoped uniqueness index is the only lookup
	-- index; there is no separate as-of index.
	CONSTRAINT "ratecard_ran_usage_lkp_row_key_unique" UNIQUE("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id"),
	CONSTRAINT "ratecard_ran_usage_lkp_ratecard_version_id_fk" FOREIGN KEY ("ratecard_version_id") REFERENCES "product"."ratecard_version"("ratecard_version_id") ON DELETE cascade ON UPDATE no action
);
