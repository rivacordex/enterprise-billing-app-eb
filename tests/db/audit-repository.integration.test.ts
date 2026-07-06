import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { auditLog } from "@/db/schema/audit";
import { insertAuditEvent } from "@/db/repositories/audit.repository";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "audit.repository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
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

    it("inserts a row that appears in the database", async () => {
      await insertAuditEvent(db, {
        eventType: "LOCAL_LOGIN",
        actorUserId: null,
        targetEntity: "appuser",
        targetId: "some-user-id",
        beforeData: null,
        afterData: { last_login_datetime: new Date().toISOString() },
      });

      const rows = await db.select().from(auditLog);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventType).toBe("LOCAL_LOGIN");
      expect(rows[0]?.targetId).toBe("some-user-id");
    });

    it("exposes no update or delete methods on the repository module", async () => {
      const repo: Record<string, unknown> =
        await import("@/db/repositories/audit.repository");
      expect(Object.keys(repo).sort()).toEqual(["insertAuditEvent"]);
    });
  },
);
