CREATE SCHEMA "product";
--> statement-breakpoint
CREATE TYPE "product"."lifecycle_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE SEQUENCE "product"."product_offering_price_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "product"."product_offering_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "product"."product_specifications_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "product"."product_offering" (
	"product_offering_id" text PRIMARY KEY DEFAULT 'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 6, '0') NOT NULL,
	"name" text NOT NULL,
	"is_bundle" boolean NOT NULL,
	"is_sellable" boolean NOT NULL,
	"billing_only" boolean NOT NULL,
	"lifecycle_status" "product"."lifecycle_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text
);
--> statement-breakpoint
CREATE TABLE "product"."product_offering_price" (
	"product_offering_price_id" text PRIMARY KEY DEFAULT 'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 6, '0') NOT NULL,
	"product_offering_id" text NOT NULL,
	"name" text NOT NULL,
	"price_type" text NOT NULL,
	"recurring_charge_period_length" integer,
	"recurring_charge_period_type" text,
	"unit_of_measure" text,
	"amount" numeric,
	"currency" text NOT NULL,
	"gl_code" text,
	"pricing_model" text NOT NULL,
	"policy" text,
	"pricing_characteristics" jsonb,
	"start_date_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_offering_price_type_check" CHECK (price_type IN ('recurring','usage','once')),
	CONSTRAINT "product_offering_price_pricing_model_check" CHECK (pricing_model IN ('flat','tiered')),
	CONSTRAINT "product_offering_price_currency_check" CHECK (char_length(currency) = 3),
	CONSTRAINT "product_offering_price_amount_xor_tiers_check" CHECK ((pricing_model = 'flat' AND amount IS NOT NULL AND pricing_characteristics IS NULL) OR (pricing_model = 'tiered' AND amount IS NULL AND pricing_characteristics IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "product"."product_specifications" (
	"product_spec_id" text PRIMARY KEY DEFAULT 'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 6, '0') NOT NULL,
	"ref_product_offering_id" text NOT NULL,
	"name" text NOT NULL,
	"is_mandatory" boolean NOT NULL,
	"is_default" boolean NOT NULL,
	"default_value" text,
	"product_spec_characteristics" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product"."product_offering" ADD CONSTRAINT "product_offering_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_specifications" ADD CONSTRAINT "product_specifications_ref_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("ref_product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_price_type_start_unique" ON "product"."product_offering_price" USING btree ("product_offering_id","price_type","start_date_time");--> statement-breakpoint
CREATE INDEX "product_offering_price_offering_idx" ON "product"."product_offering_price" USING btree ("product_offering_id");--> statement-breakpoint
CREATE INDEX "product_specifications_offering_idx" ON "product"."product_specifications" USING btree ("ref_product_offering_id");--> statement-breakpoint
INSERT INTO "core"."permissions" ("permission_name", "permission_info") VALUES ('products', 'Controls access to the Product Offering catalog page.');