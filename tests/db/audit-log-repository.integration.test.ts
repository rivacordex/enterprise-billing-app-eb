import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "auditLogRepository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorAId: string;
    let actorBId: string;
    let tombstonedActorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [actorA] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Actor A",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorAId = actorA!.id;

      const [actorB] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Actor B",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorBId = actorB!.id;

      const [tombstoned] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Tombstoned Actor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DELETED",
        })
        .returning({ id: appuser.id });
      tombstonedActorId = tombstoned!.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("findFiltered", () => {
      it("returns [] / total 0 with no events inserted yet", async () => {
        const result = await auditLogRepository.findFiltered(
          db,
          { eventType: null, actorUserId: null, dateFrom: null, dateTo: null },
          1,
          50,
        );
        expect(result).toEqual({ rows: [], total: 0 });
      });

      it("returns all rows ordered newest-first, with no filters", async () => {
        await insertAuditEvent(db, {
          eventType: "USER_CREATED",
          actorUserId: actorAId,
          targetEntity: "APPUSER",
          targetId: "target-1",
          beforeData: null,
          afterData: { userName: "First" },
        });
        await insertAuditEvent(db, {
          eventType: "USER_UPDATED",
          actorUserId: actorAId,
          targetEntity: "APPUSER",
          targetId: "target-2",
          beforeData: { userName: "Old" },
          afterData: { userName: "New" },
        });

        const result = await auditLogRepository.findFiltered(
          db,
          { eventType: null, actorUserId: null, dateFrom: null, dateTo: null },
          1,
          50,
        );

        expect(result.total).toBeGreaterThanOrEqual(2);
        expect(
          result.rows[0]!.createdDatetime.getTime(),
        ).toBeGreaterThanOrEqual(result.rows[1]!.createdDatetime.getTime());
      });

      it("filters by eventType", async () => {
        await insertAuditEvent(db, {
          eventType: "ROLE_CREATED",
          actorUserId: actorBId,
          targetEntity: "ROLES",
          targetId: "role-1",
          beforeData: null,
          afterData: { roleName: "MANAGER" },
        });

        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: "ROLE_CREATED",
            actorUserId: null,
            dateFrom: null,
            dateTo: null,
          },
          1,
          50,
        );

        expect(result.rows.length).toBeGreaterThan(0);
        for (const row of result.rows) {
          expect(row.eventType).toBe("ROLE_CREATED");
        }
      });

      it("filters by actorUserId", async () => {
        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: null,
            actorUserId: actorBId,
            dateFrom: null,
            dateTo: null,
          },
          1,
          50,
        );

        expect(result.rows.length).toBeGreaterThan(0);
        for (const row of result.rows) {
          expect(row.actorUserId).toBe(actorBId);
        }
      });

      it("filters by dateFrom/dateTo window", async () => {
        const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: null,
            actorUserId: null,
            dateFrom: future,
            dateTo: null,
          },
          1,
          50,
        );

        expect(result.rows).toEqual([]);
        expect(result.total).toBe(0);
      });

      it("combines all four filters with AND logic", async () => {
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: "ROLE_CREATED",
            actorUserId: actorBId,
            dateFrom: past,
            dateTo: future,
          },
          1,
          50,
        );

        expect(result.rows.length).toBeGreaterThan(0);
        for (const row of result.rows) {
          expect(row.eventType).toBe("ROLE_CREATED");
          expect(row.actorUserId).toBe(actorBId);
        }
      });

      it("applies offset pagination (page 2 with a small pageSize)", async () => {
        const allRows = await auditLogRepository.findFiltered(
          db,
          { eventType: null, actorUserId: null, dateFrom: null, dateTo: null },
          1,
          1,
        );
        const page2 = await auditLogRepository.findFiltered(
          db,
          { eventType: null, actorUserId: null, dateFrom: null, dateTo: null },
          2,
          1,
        );

        expect(page2.total).toBe(allRows.total);
        if (allRows.total > 1) {
          expect(page2.rows[0]?.auditId).not.toBe(allRows.rows[0]?.auditId);
        }
      });

      it("maps a tombstoned actor to actorUserName from the row and actorDeleted=true", async () => {
        await insertAuditEvent(db, {
          eventType: "USER_LOCKED",
          actorUserId: tombstonedActorId,
          targetEntity: "APPUSER",
          targetId: "target-3",
          beforeData: null,
          afterData: null,
        });

        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: "USER_LOCKED",
            actorUserId: null,
            dateFrom: null,
            dateTo: null,
          },
          1,
          50,
        );

        const row = result.rows[0];
        expect(row?.actorUserName).toBe("Tombstoned Actor");
        expect(row?.actorDeleted).toBe(true);
      });

      it("maps category from AUDIT_EVENT_CATEGORY_MAP for each row", async () => {
        const result = await auditLogRepository.findFiltered(
          db,
          {
            eventType: "USER_CREATED",
            actorUserId: null,
            dateFrom: null,
            dateTo: null,
          },
          1,
          50,
        );

        expect(result.rows.length).toBeGreaterThan(0);
        for (const row of result.rows) {
          expect(row.category).toBe("Additive");
        }
      });
    });

    describe("findActors", () => {
      it("returns one entry per distinct actor, ordered by userName ascending with tombstoned actors last", async () => {
        const actors = await auditLogRepository.findActors(db);

        const ids = actors.map((a) => a.userId);
        expect(ids).toContain(actorAId);
        expect(ids).toContain(actorBId);
        expect(ids).toContain(tombstonedActorId);

        const tombstoned = actors.find((a) => a.userId === tombstonedActorId);
        expect(tombstoned?.isDeleted).toBe(true);
        expect(tombstoned?.userName).toBe("Tombstoned Actor");

        const namedActors = actors.filter((a) => a.userName !== null);
        const names = namedActors.map((a) => a.userName);
        expect(names).toEqual([...names].sort());
      });
    });
  },
);
