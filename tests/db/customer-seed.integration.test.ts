import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// Runs the real `db:seed-customer` script as a child process (never
// imported directly — db/seeds/customer.ts is a standalone script, matching
// the "never imported by application code" rule shared by every seed
// script in this codebase). Inherits `process.env`, which already carries
// `DATABASE_URL` (this describe block is skipped without it) and the
// `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` test fixtures injected by
// vitest.integration.config.ts. `NODE_OPTIONS=--conditions=react-server` is
// required on top of that — `lib/config.ts` imports `server-only`, which
// throws under a bare `node` outside the react-server condition (the same
// fix docker-compose's one-shot migrate/setup jobs apply; vitest itself
// dodges this via a `server-only` resolve alias, which a spawned child
// process doesn't inherit).
function runSeedCustomer(): void {
  execFileSync(process.execPath, ["--import", "tsx", "db/seeds/customer.ts"], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
    stdio: "pipe",
  });
}

describe.skipIf(!databaseUrl)(
  "customer seed integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // MANAGER/USER role rows — the customer seed's precondition (cm01-spec
      // §3.6.2), normally provided by `db:seed-rbac`. Inserted directly here
      // rather than running the real seed-rbac script, matching the
      // `appuser-repository.integration.test.ts` precedent.
      await sql`INSERT INTO core.roles (role_name, role_descr) VALUES ('MANAGER', 'Manager')`;
      await sql`INSERT INTO core.roles (role_name, role_descr) VALUES ('USER', 'User')`;

      runSeedCustomer();
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    test("seeds exactly one CUSTOMER_SEARCH_RESULT_LIMIT = '5' row in the customer config group", async () => {
      const rows = await sql<
        {
          config_value: string | null;
          config_version: number;
          status: string;
        }[]
      >`
        SELECT config_value, config_version, status FROM core.system_config
        WHERE config_group = 'customer' AND config_key = 'CUSTOMER_SEARCH_RESULT_LIMIT'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        config_value: "5",
        config_version: 1,
        status: "ACTIVE",
      });
    });

    test("grants exactly MANAGER -> customers:EDIT and USER -> customers:READ, no DELETE row for any role", async () => {
      const rows = await sql<{ role_name: string; permission_type: string }[]>`
        SELECT r.role_name, rpa.permission_type
        FROM core.role_permission_assign rpa
        JOIN core.roles r ON r.role_id = rpa.ref_role_id
        JOIN core.permissions p ON p.permission_id = rpa.ref_permission_id
        WHERE p.permission_name = 'customers'
      `;
      expect(rows).toHaveLength(2);
      const byRole = new Map(rows.map((r) => [r.role_name, r.permission_type]));
      expect(byRole.get("MANAGER")).toBe("EDIT");
      expect(byRole.get("USER")).toBe("READ");
      expect(rows.some((r) => r.permission_type === "DELETE")).toBe(false);
    });

    test("re-running the seed script is a no-op (idempotent)", async () => {
      runSeedCustomer();

      const configRows = await sql<{ id: string }[]>`
        SELECT config_id AS id FROM core.system_config
        WHERE config_group = 'customer' AND config_key = 'CUSTOMER_SEARCH_RESULT_LIMIT'
      `;
      expect(configRows).toHaveLength(1);

      const grantRows = await sql<{ id: string }[]>`
        SELECT rpa.role_permission_id AS id
        FROM core.role_permission_assign rpa
        JOIN core.permissions p ON p.permission_id = rpa.ref_permission_id
        WHERE p.permission_name = 'customers'
      `;
      expect(grantRows).toHaveLength(2);
    }, 30_000);
  },
);
