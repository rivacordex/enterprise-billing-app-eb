CREATE SCHEMA "ordering";
--> statement-breakpoint
CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TYPE "ordering"."order_status" AS ENUM('ACKNOWLEDGED', 'REJECTED', 'PENDING', 'HELD', 'IN_PROGRESS', 'CANCELLED', 'COMPLETED', 'FAILED', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "inventory"."product_status" AS ENUM('CREATED', 'PENDING_ACTIVE', 'ACTIVE', 'SUSPENDED', 'PENDING_TERMINATE', 'TERMINATED', 'CANCELLED', 'ABORTED');--> statement-breakpoint
CREATE SEQUENCE "ordering"."order_item_price_override_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "ordering"."product_order_item_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "ordering"."product_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "inventory"."inventory_status_history_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "inventory"."product_inventory_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "ordering"."order_item_price_override" (
	"order_item_price_override_id" text PRIMARY KEY DEFAULT 'PRDOPO' || lpad(nextval('ordering.order_item_price_override_seq')::text, 8, '0') NOT NULL,
	"product_order_item_id" text NOT NULL,
	"price_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_price_override_item_type_unique" UNIQUE("product_order_item_id","price_type"),
	CONSTRAINT "order_item_price_override_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "ordering"."product_order" (
	"product_order_id" text PRIMARY KEY DEFAULT 'PRDORD' || lpad(nextval('ordering.product_order_seq')::text, 8, '0') NOT NULL,
	"customer_party_role_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"status" "ordering"."order_status" NOT NULL,
	"failure_reason" text,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_reviewer_check" CHECK (reviewed_by IS NULL OR reviewed_by <> submitted_by)
);
--> statement-breakpoint
CREATE TABLE "ordering"."product_order_item" (
	"product_order_item_id" text PRIMARY KEY DEFAULT 'PRDORI' || lpad(nextval('ordering.product_order_item_seq')::text, 8, '0') NOT NULL,
	"product_order_id" text NOT NULL,
	"product_offering_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"start_date" date NOT NULL,
	"ordered_characteristics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_item_quantity_check" CHECK (quantity >= 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."inventory_status_history" (
	"inventory_status_history_id" text PRIMARY KEY DEFAULT 'PRDIVE' || lpad(nextval('inventory.inventory_status_history_seq')::text, 8, '0') NOT NULL,
	"product_inventory_id" text NOT NULL,
	"from_status" "inventory"."product_status",
	"to_status" "inventory"."product_status" NOT NULL,
	"effective_date" date NOT NULL,
	"reason" text,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."product_inventory" (
	"product_inventory_id" text PRIMARY KEY DEFAULT 'PRDINV' || lpad(nextval('inventory.product_inventory_seq')::text, 8, '0') NOT NULL,
	"product_order_item_id" text NOT NULL,
	"customer_party_role_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"product_offering_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"instance_characteristics" jsonb,
	"status" "inventory"."product_status" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_inventory_product_order_item_id_unique" UNIQUE("product_order_item_id"),
	CONSTRAINT "product_inventory_quantity_check" CHECK (quantity >= 1),
	CONSTRAINT "product_inventory_end_after_start_check" CHECK (end_date IS NULL OR end_date >= start_date)
);
--> statement-breakpoint
ALTER TABLE "ordering"."order_item_price_override" ADD CONSTRAINT "order_item_price_override_product_order_item_id_product_order_item_product_order_item_id_fk" FOREIGN KEY ("product_order_item_id") REFERENCES "ordering"."product_order_item"("product_order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order" ADD CONSTRAINT "product_order_customer_party_role_id_party_role_party_role_id_fk" FOREIGN KEY ("customer_party_role_id") REFERENCES "customer"."party_role"("party_role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order" ADD CONSTRAINT "product_order_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order" ADD CONSTRAINT "product_order_submitted_by_appuser_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order" ADD CONSTRAINT "product_order_reviewed_by_appuser_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order_item" ADD CONSTRAINT "product_order_item_product_order_id_product_order_product_order_id_fk" FOREIGN KEY ("product_order_id") REFERENCES "ordering"."product_order"("product_order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."product_order_item" ADD CONSTRAINT "product_order_item_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."inventory_status_history" ADD CONSTRAINT "inventory_status_history_product_inventory_id_product_inventory_product_inventory_id_fk" FOREIGN KEY ("product_inventory_id") REFERENCES "inventory"."product_inventory"("product_inventory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."inventory_status_history" ADD CONSTRAINT "inventory_status_history_changed_by_appuser_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."product_inventory" ADD CONSTRAINT "product_inventory_product_order_item_id_product_order_item_product_order_item_id_fk" FOREIGN KEY ("product_order_item_id") REFERENCES "ordering"."product_order_item"("product_order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."product_inventory" ADD CONSTRAINT "product_inventory_customer_party_role_id_party_role_party_role_id_fk" FOREIGN KEY ("customer_party_role_id") REFERENCES "customer"."party_role"("party_role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."product_inventory" ADD CONSTRAINT "product_inventory_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."product_inventory" ADD CONSTRAINT "product_inventory_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_price_override_item_idx" ON "ordering"."order_item_price_override" USING btree ("product_order_item_id");--> statement-breakpoint
CREATE INDEX "product_order_customer_idx" ON "ordering"."product_order" USING btree ("customer_party_role_id");--> statement-breakpoint
CREATE INDEX "product_order_billing_account_idx" ON "ordering"."product_order" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "product_order_status_idx" ON "ordering"."product_order" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_order_item_order_idx" ON "ordering"."product_order_item" USING btree ("product_order_id");--> statement-breakpoint
CREATE INDEX "product_order_item_offering_idx" ON "ordering"."product_order_item" USING btree ("product_offering_id");--> statement-breakpoint
CREATE INDEX "inventory_status_history_inventory_idx" ON "inventory"."inventory_status_history" USING btree ("product_inventory_id");--> statement-breakpoint
CREATE INDEX "product_inventory_customer_idx" ON "inventory"."product_inventory" USING btree ("customer_party_role_id");--> statement-breakpoint
CREATE INDEX "product_inventory_billing_account_idx" ON "inventory"."product_inventory" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "product_inventory_offering_idx" ON "inventory"."product_inventory" USING btree ("product_offering_id");--> statement-breakpoint
CREATE INDEX "product_inventory_status_idx" ON "inventory"."product_inventory" USING btree ("status");