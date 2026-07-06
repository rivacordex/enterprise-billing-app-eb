import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

// Reads `DATABASE_URL` directly (not via lib/config): the loader throws at
// import time when the var is absent, which would prevent the loud-skip
// below from ever running. CI provides Postgres as a service and exports
// the var; locally it comes from the developer's shell/.env.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "migration integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      // "product" holds FKs into "core" (last_edited_by -> core.appuser), so
      // it must drop first (pm02-spec §3.8).
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    test("the core schema exists and nothing application-related lands in public", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name IN ('core', 'drizzle')
      `;
      expect(schemas.map((r) => r.schema_name).sort()).toEqual([
        "core",
        "drizzle",
      ]);

      const publicTables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `;
      expect(publicTables).toEqual([]);
    });

    test("the four identity tables, audit_log, the four RBAC tables, and system_config exist in core", async () => {
      // um27 made audit_log a partitioned parent, so its partition children
      // (e.g. audit_log_default) also surface in information_schema.tables.
      // Query pg_class and exclude partition children — assert only the logical
      // tables: relkind 'r' (ordinary) + 'p' (partitioned parent).
      const tables = await sql<{ table_name: string }[]>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition
      `;
      expect(tables.map((r) => r.table_name).sort()).toEqual(
        [
          "account",
          "appuser",
          "audit_log",
          "session",
          "verification",
          "roles",
          "permissions",
          "role_permission_assign",
          "role_assign",
          "system_config",
        ].sort(),
      );
    });

    test("system_config has the seeded app_name row and its unique/check constraints", async () => {
      const rows = await sql<
        {
          config_group: string;
          config_version: number;
          config_key: string;
          config_value: string;
          description: string | null;
          is_secret: boolean;
          status: string;
          modified_by: string | null;
        }[]
      >`SELECT config_group, config_version, config_key, config_value, description, is_secret, status, modified_by
        FROM core.system_config WHERE config_key = 'app_name'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        config_group: "app",
        config_version: 1,
        config_key: "app_name",
        config_value: "Enterprise Billing System",
        // um28: the pre-existing app_name row was given its description by 0005.
        description: "Application display name.",
        is_secret: false,
        status: "ACTIVE",
        modified_by: null,
      });

      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'core' AND tablename = 'system_config'
          AND indexname = 'system_config_group_version_key_unique'
      `;
      expect(indexes).toHaveLength(1);

      const checks = await sql<{ conname: string; def: string }[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_namespace ns ON con.connamespace = ns.oid
        WHERE ns.nspname = 'core' AND con.contype = 'c'
          AND con.conname = 'system_config_status_check'
      `;
      expect(checks).toHaveLength(1);
      expect(checks[0]?.def).toContain("DRAFT");
      expect(checks[0]?.def).toContain("ACTIVE");
      expect(checks[0]?.def).toContain("RETIRED");
    });

    test("system_config has the nullable description column (um28 / 0005)", async () => {
      const columns = await sql<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'system_config'
          AND column_name = 'description'
      `;
      expect(columns).toHaveLength(1);
      expect(columns[0]?.is_nullable).toBe("YES");
    });

    test("0005 seeds the six new config rows with correct group/secret/status and non-null descriptions", async () => {
      const rows = await sql<
        {
          config_group: string;
          config_key: string;
          config_value: string;
          description: string | null;
          is_secret: boolean;
          status: string;
          modified_by: string | null;
        }[]
      >`SELECT config_group, config_key, config_value, description, is_secret, status, modified_by
        FROM core.system_config
        WHERE config_key IN (
          'app_logo_path', 'locale', 'default_currency',
          'company_name', 'company_address', 'company_billing_pic'
        )
        ORDER BY config_key`;

      expect(rows).toHaveLength(6);
      const byKey = new Map(rows.map((r) => [r.config_key, r]));

      // Every seeded row is non-secret, ACTIVE, NULL modifier, non-null doc.
      for (const r of rows) {
        expect(r.is_secret).toBe(false);
        expect(r.status).toBe("ACTIVE");
        expect(r.modified_by).toBeNull();
        expect(r.description).not.toBeNull();
      }

      // locale/default_currency live in `app`; the three company rows in
      // the new `company` group, seeded blank.
      expect(byKey.get("locale")).toMatchObject({
        config_group: "app",
        config_value: "en-MY",
      });
      expect(byKey.get("default_currency")).toMatchObject({
        config_group: "app",
        config_value: "MYR",
      });
      expect(byKey.get("app_logo_path")?.config_group).toBe("app");
      expect(byKey.get("app_logo_path")?.config_value).toBe("");
      for (const key of [
        "company_name",
        "company_address",
        "company_billing_pic",
      ]) {
        expect(byKey.get(key)?.config_group).toBe("company");
        expect(byKey.get(key)?.config_value).toBe("");
      }
    });

    test("appuser columns match the spec, including email_verified, excluding image", async () => {
      const columns = await sql<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'appuser'
      `;
      const byName = new Map(columns.map((c) => [c.column_name, c]));
      expect(byName.has("email_verified")).toBe(true);
      expect(byName.get("email_verified")?.is_nullable).toBe("NO");
      expect(byName.has("image")).toBe(false);
      expect(byName.get("user_id")?.is_nullable).toBe("NO");
      expect(byName.get("user_phonenum")?.is_nullable).toBe("YES");
    });

    test("the appuser partial unique index excludes DELETED rows", async () => {
      const indexes = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'core' AND tablename = 'appuser' AND indexname = 'appuser_email_unique'
      `;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.indexdef).toContain("UNIQUE");
      expect(indexes[0]?.indexdef).toContain("WHERE (status <> 'DELETED'");
    });

    test("account, session, audit_log, role_assign, and system_config have FKs to core.appuser with the expected delete rules", async () => {
      // um27 made audit_log partitioned; the FK declared on the parent
      // propagates to every partition child, which inflated the old
      // information_schema query. Read pg_constraint directly and exclude
      // partition children (relispartition) so only the logical parent-table
      // FKs to appuser are counted.
      const fks = await sql<
        {
          table_name: string;
          column_name: string;
          delete_rule: string;
        }[]
      >`
        SELECT
          c.relname AS table_name,
          att.attname AS column_name,
          CASE con.confdeltype
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'd' THEN 'SET DEFAULT'
          END AS delete_rule
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
        WHERE n.nspname = 'core'
          AND con.contype = 'f'
          AND con.confrelid = 'core.appuser'::regclass
          AND NOT c.relispartition
      `;
      const byColumn = new Map(
        fks.map((fk) => [`${fk.table_name}.${fk.column_name}`, fk.delete_rule]),
      );
      expect(byColumn.get("account.user_id")).toBe("CASCADE");
      expect(byColumn.get("session.user_id")).toBe("CASCADE");
      expect(byColumn.get("audit_log.actor_user_id")).toBe("SET NULL");
      expect(byColumn.get("role_assign.ref_user_id")).toBe("RESTRICT");
      expect(byColumn.get("role_assign.assigned_by")).toBe("SET NULL");
      expect(byColumn.get("system_config.modified_by")).toBe("SET NULL");
      expect(fks).toHaveLength(6);
    });

    test("role_permission_assign and role_assign have FKs to core.roles/core.permissions with ON DELETE RESTRICT", async () => {
      const fks = await sql<
        { table_name: string; column_name: string; delete_rule: string }[]
      >`
        SELECT
          tc.table_name,
          kcu.column_name,
          rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
        WHERE tc.table_schema = 'core' AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name IN ('roles', 'permissions')
      `;
      const byColumn = new Map(
        fks.map((fk) => [`${fk.table_name}.${fk.column_name}`, fk.delete_rule]),
      );
      expect(byColumn.get("role_permission_assign.ref_role_id")).toBe(
        "RESTRICT",
      );
      expect(byColumn.get("role_permission_assign.ref_permission_id")).toBe(
        "RESTRICT",
      );
      expect(byColumn.get("role_assign.ref_role_id")).toBe("RESTRICT");
      expect(fks).toHaveLength(3);
    });

    test("named unique constraints exist on roles, permissions, role_permission_assign, role_assign", async () => {
      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'core' AND indexname IN (
          'roles_role_name_unique',
          'permissions_permission_name_unique',
          'role_permission_assign_role_permission_unique',
          'role_assign_user_role_unique'
        )
      `;
      expect(indexes.map((i) => i.indexname).sort()).toEqual(
        [
          "roles_role_name_unique",
          "permissions_permission_name_unique",
          "role_permission_assign_role_permission_unique",
          "role_assign_user_role_unique",
        ].sort(),
      );
    });

    test("role_permission_assign has the permission_type CHECK constraint", async () => {
      const checks = await sql<{ conname: string; def: string }[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_namespace ns ON con.connamespace = ns.oid
        WHERE ns.nspname = 'core' AND con.contype = 'c'
          AND con.conname = 'role_permission_assign_type_check'
      `;
      expect(checks).toHaveLength(1);
      expect(checks[0]?.def).toContain("READ");
      expect(checks[0]?.def).toContain("EDIT");
      expect(checks[0]?.def).toContain("DELETE");
    });

    test("permissions has no timestamp columns; role_assign has no last_modified_datetime", async () => {
      const permissionsColumns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'permissions'
      `;
      expect(permissionsColumns.map((c) => c.column_name)).not.toContain(
        "created_datetime",
      );

      const roleAssignColumns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'role_assign'
      `;
      expect(roleAssignColumns.map((c) => c.column_name)).not.toContain(
        "last_modified_datetime",
      );
    });

    test("session_token is unique", async () => {
      const constraints = await sql<{ constraint_type: string }[]>`
        SELECT tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = 'core' AND tc.table_name = 'session'
          AND ccu.column_name = 'session_token' AND tc.constraint_type = 'UNIQUE'
      `;
      expect(constraints).toHaveLength(1);
    });

    test("the three CHECK constraints exist with the expected predicates", async () => {
      const checks = await sql<{ conname: string; def: string }[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_namespace ns ON con.connamespace = ns.oid
        WHERE ns.nspname = 'core' AND con.contype = 'c'
      `;
      const byName = new Map(checks.map((c) => [c.conname, c.def]));

      expect(byName.get("appuser_auth_method_check")).toContain("SSO");
      expect(byName.get("appuser_auth_method_check")).toContain("LOCAL");

      expect(byName.get("appuser_status_check")).toContain("PENDING");
      expect(byName.get("appuser_status_check")).toContain("DELETED");

      expect(byName.get("account_provider_id_check")).toContain("credential");
      expect(byName.get("account_provider_id_check")).toContain("microsoft");
    });

    test("a second migration run is idempotent", async () => {
      await expect(
        migrate(drizzle(sql), {
          migrationsFolder: "./db/migrations",
          migrationsSchema: "drizzle",
        }),
      ).resolves.not.toThrow();
    });
  },
);
