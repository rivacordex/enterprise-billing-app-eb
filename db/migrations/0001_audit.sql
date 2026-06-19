CREATE TABLE "core"."audit_log" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" text,
	"target_entity" text,
	"target_id" text,
	"before_data" jsonb,
	"after_data" jsonb,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_actor_user_id_appuser_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_idx" ON "core"."audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_type_idx" ON "core"."audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_log_created_datetime_idx" ON "core"."audit_log" USING btree ("created_datetime");