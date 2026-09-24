-- pm57-spec — Rate Card Lookup, schema only. Forward-only; 0006_product.sql
-- is not reopened (RC12, code-standards §6.14/§6.25 — that gate is scoped to
-- pm46 and does not extend here). This is the module's fourth and fifth
-- tables (code-standards §6.23, superseding "no fourth table" — Appendix A
-- row A11).
--
-- G-RC3 (the `ratecard` permission name, OR3) is OPEN at authoring time and
-- no decision was found recorded anywhere in the tree. Per pm57-spec I6,
-- this migration lands ONLY the two tables and their indexes; the
-- `PERMISSIONS` seed row and the `types/rbac.ts` member are deliberately
-- deferred to a follow-up migration (0042, or the next free number when it
-- lands) the instant G-RC3 clears, and before pm67. Do not add the row here
-- on this unit's own initiative — that would be guessing a security
-- decision the workflow rules reserve for the user (ai-workflow-rules §5.1).
CREATE SEQUENCE "product"."ratecard_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "product"."ratecard_version" (
	"ratecard_version_id" text PRIMARY KEY DEFAULT 'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0') NOT NULL,
	"card_name" text NOT NULL,
	"version_num" integer NOT NULL,
	"status" text NOT NULL,
	-- The file's Date column, hoisted to the header (RC3, architecture §3.2).
	-- Constant across every row of the upload; NEVER stored per row and NEVER
	-- participates in matching. It is also the sole source of `retired_at`
	-- below (RC17, Inv. #49) — always `snapshot_date`, never a clock.
	"snapshot_date" date NOT NULL,
	"source_file" text NOT NULL,
	"file_checksum" text,
	"row_count" integer NOT NULL,
	"carried_row_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"superseded_by_version_id" text,
	-- `status = 'REJECTED'` and this column have NO writer in this delivery
	-- (code-standards §1.42). A failed upload writes nothing, including no
	-- version row. Both exist for a future asynchronous ingest — do not
	-- invent a writer to make the column look used (architecture §3.5).
	"reject_summary" jsonb,
	CONSTRAINT "ratecard_version_card_name_version_num_unique" UNIQUE("card_name","version_num"),
	CONSTRAINT "ratecard_version_status_check" CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED')),
	CONSTRAINT "ratecard_version_uploaded_by_appuser_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "ratecard_version_activated_by_appuser_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
-- At most one live version per card, enforced by the index and not by
-- application code (RV1, Inv. #45) — the direct analogue of
-- product_offering_one_active_per_family (code-standards §6.7/§6.27).
CREATE UNIQUE INDEX "ratecard_version_one_active_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'ACTIVE';
--> statement-breakpoint
-- C8, decided (pm57-spec D5, option A): at most one open DRAFT per card,
-- mirroring product_offering's one-open-version index exactly. The cost —
-- an abandoned draft blocks the next upload until it is activated, because
-- Phase A has no discard and no `ratecard : DELETE` (code-standards §8) — is
-- accepted and recorded in the hand-off register, not hidden.
CREATE UNIQUE INDEX "ratecard_version_one_draft_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'DRAFT';
--> statement-breakpoint
CREATE TABLE "product"."ratecard_ran_usage_lkp" (
	-- ULID default (core.generate_ulid()), not a padded sequence — a table
	-- taking ~5,500 rows per upload has no use for a human-readable id, the id
	-- is never displayed, and a shared sequence would be the upload's
	-- bottleneck (code-standards §6.24). Matches rating.udr_rated's own
	-- ULID-on-uuid convention.
	"ratecard_ran_usage_lkp_id" uuid DEFAULT core.generate_ulid() PRIMARY KEY NOT NULL,
	"ratecard_version_id" text NOT NULL,
	"mno_public_key" text NOT NULL,
	"commercial_unit_public_key" text NOT NULL,
	"polygon_id" text NOT NULL,
	"polygon_start_date" date NOT NULL,
	-- A product_inventory.product_inventory_id VALUE, not a reference. No FK
	-- (RC14, Inv. #57) — validated structurally only, at upload. A superseded
	-- version must survive a subscription's removal, which a FK would
	-- prevent or make actively dangerous. Same no-FK stance as
	-- rating.udr_rated (Inv. #17).
	"lkp_subscriber_ref_id" text NOT NULL,
	-- A plain column with no meaning — not a key, not a partition, selects no
	-- price and no cross-row rule reads it. Stored as uploaded (D3).
	"service_code" text,
	-- A plain nullable column (D4, §6.32/§6.28) — no CHECK, no reserved rule.
	-- Stored as uploaded when present, NULL when the cell is empty. Nothing
	-- in this module reads it for rating and nothing formats it
	-- (code-standards §1.45/§3.2).
	"rate_per_unit" numeric(18, 6),
	"retired_at" date,
	CONSTRAINT "ratecard_ran_usage_lkp_row_key_unique" UNIQUE("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id","polygon_start_date"),
	CONSTRAINT "ratecard_ran_usage_lkp_ratecard_version_id_ratecard_version_ratecard_version_id_fk" FOREIGN KEY ("ratecard_version_id") REFERENCES "product"."ratecard_version"("ratecard_version_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- The rating consumer's as-of join key (code-standards §6.28) — created now
-- though nothing consumes it in this delivery (§6.31). Nearly free, keeps a
-- later consumer's plan stable, and creating it later on a populated table
-- is a different operation.
CREATE INDEX "ratecard_ran_usage_lkp_as_of_idx"
  ON "product"."ratecard_ran_usage_lkp" ("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id","polygon_start_date" DESC);
