CREATE SCHEMA "customer";
--> statement-breakpoint
CREATE SEQUENCE "customer"."organization_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "customer"."party_role_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "customer"."contact_medium_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "customer"."organization" (
	"organization_id" text PRIMARY KEY DEFAULT 'ORG' || lpad(nextval('customer.organization_seq')::text, 7, '0') NOT NULL,
	"name" text NOT NULL,
	"trading_name" text,
	"organization_type" text NOT NULL,
	"registration_number" text,
	"tax_id" text,
	"industry" text,
	"status" text DEFAULT 'REGISTERED' NOT NULL,
	"status_reason" text,
	"last_modified_by" text NOT NULL,
	"created_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_registration_number_unique" UNIQUE("registration_number"),
	CONSTRAINT "organization_organization_type_check" CHECK (organization_type IN ('COMPANY','GOVERNMENT')),
	CONSTRAINT "organization_status_check" CHECK (status IN ('REGISTERED','ACTIVE','INACTIVE','SUSPENDED','DISSOLVED','MERGED'))
);
--> statement-breakpoint
CREATE TABLE "customer"."party_role" (
	"party_role_id" text PRIMARY KEY DEFAULT 'PTRL' || lpad(nextval('customer.party_role_seq')::text, 8, '0') NOT NULL,
	"engaged_party" text NOT NULL,
	"status" text DEFAULT 'INITIALIZED' NOT NULL,
	"status_reason" text,
	"party_role_specification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account" text,
	"contact_medium" text,
	"last_modified_by" text NOT NULL,
	"created_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_role_status_check" CHECK (status IN ('INITIALIZED','VALIDATED','ACTIVE','SUSPENDED','CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "customer"."contact_medium" (
	"contact_medium_id" text PRIMARY KEY DEFAULT 'CTMD' || lpad(nextval('customer.contact_medium_seq')::text, 8, '0') NOT NULL,
	"ref_party_role" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_role" text,
	"phone_number" text,
	"email_address" text,
	"ga_address_line1" text,
	"ga_address_line2" text,
	"ga_city" text,
	"ga_state_province" text,
	"ga_postal_code" text,
	"ga_country" text,
	"preferred_contact_method" text,
	"last_modified_by" text NOT NULL,
	"created_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_medium_id_ref_party_role_unique" UNIQUE("contact_medium_id","ref_party_role"),
	CONSTRAINT "contact_medium_preferred_contact_method_check" CHECK (preferred_contact_method IN ('PHONE','EMAIL','ADDRESS'))
);
--> statement-breakpoint
ALTER TABLE "customer"."organization" ADD CONSTRAINT "organization_last_modified_by_appuser_user_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer"."party_role" ADD CONSTRAINT "party_role_engaged_party_organization_organization_id_fk" FOREIGN KEY ("engaged_party") REFERENCES "customer"."organization"("organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer"."party_role" ADD CONSTRAINT "party_role_last_modified_by_appuser_user_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer"."contact_medium" ADD CONSTRAINT "contact_medium_ref_party_role_party_role_party_role_id_fk" FOREIGN KEY ("ref_party_role") REFERENCES "customer"."party_role"("party_role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer"."contact_medium" ADD CONSTRAINT "contact_medium_last_modified_by_appuser_user_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_role_engaged_party_idx" ON "customer"."party_role" USING btree ("engaged_party");--> statement-breakpoint
CREATE UNIQUE INDEX "party_role_engaged_party_unique_open" ON "customer"."party_role" USING btree ("engaged_party") WHERE status != 'CLOSED';--> statement-breakpoint
CREATE INDEX "contact_medium_ref_party_role_idx" ON "customer"."contact_medium" USING btree ("ref_party_role");--> statement-breakpoint
-- Hand-authored, not drizzle-kit-generated (cm01-spec §2.2, §3.3): the
-- composite deferrable FK that makes a party_role.contact_medium pointer
-- into another customer's contact a DB-level impossibility. Added last,
-- after contact_medium exists. DEFERRABLE INITIALLY DEFERRED lets
-- later mutation units (cm11, cm14) insert the contact_medium row and point
-- party_role.contact_medium at it in either statement order within one
-- transaction, checking only at COMMIT.
ALTER TABLE "customer"."party_role" ADD CONSTRAINT "party_role_contact_medium_fk" FOREIGN KEY ("contact_medium","party_role_id") REFERENCES "customer"."contact_medium"("contact_medium_id","ref_party_role") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES ('customers', 'Controls access to the View Customer and Manage Customer pages.');
