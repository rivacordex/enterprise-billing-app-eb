DROP INDEX "core"."roles_role_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "roles_role_name_unique" ON "core"."roles" USING btree (lower("role_name"));