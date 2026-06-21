CREATE TABLE "core"."system_config" (
	"config_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_group" text NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"config_key" text NOT NULL,
	"config_value" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"modified_by" text,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_config_status_check" CHECK (status IN ('DRAFT','ACTIVE','RETIRED'))
);
--> statement-breakpoint
ALTER TABLE "core"."system_config" ADD CONSTRAINT "system_config_modified_by_appuser_user_id_fk" FOREIGN KEY ("modified_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "system_config_group_version_key_unique" ON "core"."system_config" USING btree ("config_group","config_version","config_key");--> statement-breakpoint
INSERT INTO "core"."system_config" ("config_group", "config_version", "config_key", "config_value", "is_secret", "status", "modified_by") VALUES ('app', 1, 'app_name', 'Enterprise Billing System', false, 'ACTIVE', NULL);