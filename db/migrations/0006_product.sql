CREATE SCHEMA "product";
--> statement-breakpoint
CREATE TYPE "product"."lifecycle_status" AS ENUM('DRAFT', 'TESTING', 'ACTIVE', 'OBSOLETE', 'RETIRED');--> statement-breakpoint
CREATE SEQUENCE "product"."product_offering_price_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "product"."product_offering_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "product"."product_specifications_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE FUNCTION product.pricing_steps_ok(steps jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  -- Every `::numeric` cast below is CASE-guarded by its own
  -- `jsonb_typeof(...) = 'number'` test. CASE is the only construct PostgreSQL
  -- guarantees evaluates its WHEN branches in order, so a non-numeric
  -- `aboveQuantity` reaching this function (a raw-SQL write bypassing Zod, the
  -- backstop's whole point) fails these predicates cleanly instead of raising
  -- `invalid input syntax for type numeric` from an eagerly-evaluated cast in a
  -- sibling AND/OR operand — an evaluation order Postgres does not promise
  -- (hardened post-pm46, 2026-09-22; Zod still rejects it first on every real
  -- write path).
  SELECT steps IS NOT NULL
     AND jsonb_typeof(steps) = 'array'
     AND jsonb_array_length(steps) > 0
     AND NOT EXISTS (
           SELECT 1
           FROM   jsonb_array_elements(steps) AS s(v)
           WHERE  COALESCE(jsonb_typeof(s.v -> 'aboveQuantity'), 'missing') <> 'number'
              OR  CASE WHEN jsonb_typeof(s.v -> 'aboveQuantity') = 'number'
                       THEN (s.v ->> 'aboveQuantity')::numeric <= 0
                       ELSE false
                  END
              OR  COALESCE(jsonb_typeof(s.v -> 'ratePerUnit'), 'missing') <> 'string'
              OR  COALESCE(s.v ->> 'ratePerUnit', '') !~ '^[0-9]+(\.[0-9]+)?$'
         )
     AND (
           SELECT COALESCE(bool_and(prev IS NULL OR cur > prev), true)
           FROM (
             SELECT cur, lag(cur) OVER (ORDER BY ord) AS prev
             FROM (
               SELECT s.ord,
                      CASE WHEN jsonb_typeof(s.v -> 'aboveQuantity') = 'number'
                           THEN (s.v ->> 'aboveQuantity')::numeric
                      END AS cur
               FROM   jsonb_array_elements(steps) WITH ORDINALITY AS s(v, ord)
             ) g
           ) t
         );
$fn$;
--> statement-breakpoint
CREATE TABLE "product"."product_offering" (
	"product_offering_id" text PRIMARY KEY DEFAULT 'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 8, '0') NOT NULL,
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
	"product_offering_price_id" text PRIMARY KEY DEFAULT 'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 8, '0') NOT NULL,
	"product_offering_id" text NOT NULL,
	"name" text NOT NULL,
	"component_type" text NOT NULL,
	"price_component" jsonb NOT NULL,
	"recurring_charge_period_length" integer,
	"recurring_charge_period_type" text,
	"unit_of_measure" text,
	"currency" text NOT NULL,
	"gl_code" text,
	"policy" text,
	"start_date_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_offering_price_currency_check" CHECK (char_length(currency) = 3),
	CONSTRAINT "product_offering_price_period_value_check" CHECK (
	  recurring_charge_period_type IS NULL
	  OR (recurring_charge_period_type = 'months'
	      AND recurring_charge_period_length IN (1, 3, 12))
	),
	CONSTRAINT "product_offering_price_unit_value_check" CHECK (
	  unit_of_measure IS NULL
	  OR unit_of_measure IN ('Mbps', 'GB', 'MB', 'EA')
	),
	CONSTRAINT "product_offering_price_component_type_check" CHECK (
	  component_type IN ('usage_rate','flat_fee','capacity_commitment','capacity_motivation')
	),
	CONSTRAINT "product_offering_price_envelope_type_check" CHECK (
	  component_type = price_component ->> '@type'
	),
	CONSTRAINT "product_offering_price_usage_rate_check" CHECK (
	  component_type <> 'usage_rate' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND COALESCE(jsonb_typeof(price_component #> '{params,ratePerUnit}'), 'missing') = 'string'
	    AND price_component #>> '{params,ratePerUnit}' ~ '^[0-9]+(\.[0-9]+)?$'
	  )
	),
	CONSTRAINT "product_offering_price_flat_fee_check" CHECK (
	  component_type <> 'flat_fee' OR (
	    unit_of_measure IS NULL
	    AND COALESCE(jsonb_typeof(price_component #> '{params,amount}'), 'missing') = 'string'
	    AND price_component #>> '{params,amount}' ~ '^[0-9]+(\.[0-9]+)?$'
	    AND COALESCE(price_component ->> 'priceType', '') IN ('recurring', 'oneTime')
	    AND (
	      (price_component ->> 'priceType' = 'recurring'
	         AND recurring_charge_period_length IS NOT NULL
	         AND recurring_charge_period_type IS NOT NULL)
	      OR
	      (price_component ->> 'priceType' = 'oneTime'
	         AND recurring_charge_period_length IS NULL
	         AND recurring_charge_period_type IS NULL)
	    )
	  )
	),
	CONSTRAINT "product_offering_price_capacity_commitment_check" CHECK (
	  component_type <> 'capacity_commitment' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND CASE WHEN jsonb_typeof(price_component #> '{params,committedQuantity}') = 'number'
	             THEN (price_component #>> '{params,committedQuantity}')::numeric > 0
	             ELSE false
	        END
	  )
	),
	CONSTRAINT "product_offering_price_capacity_motivation_check" CHECK (
	  component_type <> 'capacity_motivation' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND product.pricing_steps_ok(price_component #> '{params,steps}')
	  )
	)
);
--> statement-breakpoint
CREATE TABLE "product"."product_specifications" (
	"product_spec_id" text PRIMARY KEY DEFAULT 'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 8, '0') NOT NULL,
	"ref_product_offering_id" text NOT NULL,
	"name" text NOT NULL,
	"is_mandatory" boolean NOT NULL,
	"is_default" boolean NOT NULL,
	"default_value" text,
	"product_spec_characteristics" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product"."product_offering" ADD CONSTRAINT "product_offering_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_specifications" ADD CONSTRAINT "product_specifications_ref_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("ref_product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_component_start_unique" UNIQUE NULLS NOT DISTINCT ("product_offering_id", "component_type", "unit_of_measure", "start_date_time");--> statement-breakpoint
CREATE INDEX "product_offering_price_offering_idx" ON "product"."product_offering_price" USING btree ("product_offering_id");--> statement-breakpoint
CREATE INDEX "product_offering_price_component_type_idx" ON "product"."product_offering_price" USING btree ("component_type");--> statement-breakpoint
CREATE INDEX "product_specifications_offering_idx" ON "product"."product_specifications" USING btree ("ref_product_offering_id");--> statement-breakpoint
INSERT INTO "core"."permissions" ("permission_name", "permission_info") VALUES ('products', 'Controls access to the Product Offering catalog page.');