import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { auditLog } from "@/db/schema/audit";
import {
  insertAuditEvent,
  insertAuditEvents,
} from "@/db/repositories/audit.repository";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "audit.repository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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

    // bm83 — the retire switch's multi-row insert (one statement per chunk).
    it("insertAuditEvents writes every event in one call, and nothing for an empty list", async () => {
      const before = (await db.select().from(auditLog)).length;
      await insertAuditEvents(db, []);
      expect(await db.select().from(auditLog)).toHaveLength(before);
      await insertAuditEvents(
        db,
        ["BAN00000001", "BAN00000002"].map((targetId) => ({
          eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED" as const,
          actorUserId: null,
          targetEntity: "BILLING_ACCOUNT",
          targetId,
          beforeData: { refBillTemplateFamilyId: "BTF00000002" },
          afterData: { refBillTemplateFamilyId: null },
        })),
      );
      const rows = await db.select().from(auditLog);
      expect(rows).toHaveLength(before + 2);
      expect(
        rows
          .filter((r) => r.eventType === "BILLING_ACCOUNT_TEMPLATE_CHANGED")
          .map((r) => r.targetId)
          .sort(),
      ).toEqual(["BAN00000001", "BAN00000002"]);
    });

    // bm85 gate finding (review fix) — the rule, not a name list: the audit
    // log is append-only, so the module exports inserts and nothing else.
    it("exposes no update or delete methods on the repository module", async () => {
      const repo: Record<string, unknown> =
        await import("@/db/repositories/audit.repository");
      const names = Object.keys(repo);
      expect(names).toContain("insertAuditEvent");
      expect(names).toContain("insertAuditEvents");
      expect(names.filter((n) => !/^insert[A-Z]/.test(n))).toEqual([]);
      expect(
        names.filter((n) => /update|delete|upsert|remove|truncate/i.test(n)),
      ).toEqual([]);
    });
  },
);
