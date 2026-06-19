CREATE TABLE "core"."roles" (
	"role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_name" text NOT NULL,
	"role_descr" text,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."permissions" (
	"permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission_name" text NOT NULL,
	"permission_info" text
);
--> statement-breakpoint
CREATE TABLE "core"."role_permission_assign" (
	"role_permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_role_id" uuid NOT NULL,
	"ref_permission_id" uuid NOT NULL,
	"permission_type" text NOT NULL,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_assign_type_check" CHECK (permission_type IN ('READ','EDIT','DELETE'))
);
--> statement-breakpoint
CREATE TABLE "core"."role_assign" (
	"role_assign_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_user_id" text NOT NULL,
	"ref_role_id" uuid NOT NULL,
	"assigned_by" text,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."role_permission_assign" ADD CONSTRAINT "role_permission_assign_ref_role_id_roles_role_id_fk" FOREIGN KEY ("ref_role_id") REFERENCES "core"."roles"("role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permission_assign" ADD CONSTRAINT "role_permission_assign_ref_permission_id_permissions_permission_id_fk" FOREIGN KEY ("ref_permission_id") REFERENCES "core"."permissions"("permission_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assign" ADD CONSTRAINT "role_assign_ref_user_id_appuser_user_id_fk" FOREIGN KEY ("ref_user_id") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assign" ADD CONSTRAINT "role_assign_ref_role_id_roles_role_id_fk" FOREIGN KEY ("ref_role_id") REFERENCES "core"."roles"("role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assign" ADD CONSTRAINT "role_assign_assigned_by_appuser_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_role_name_unique" ON "core"."roles" USING btree ("role_name");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_permission_name_unique" ON "core"."permissions" USING btree ("permission_name");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permission_assign_role_permission_unique" ON "core"."role_permission_assign" USING btree ("ref_role_id","ref_permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assign_user_role_unique" ON "core"."role_assign" USING btree ("ref_user_id","ref_role_id");