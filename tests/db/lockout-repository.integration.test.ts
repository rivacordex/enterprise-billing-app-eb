import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import {
  adminClearLockout,
  clearLockout,
  getLockoutState,
  recordFailedAttempt,
} from "@/db/repositories/lockout.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "lockout.repository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let userId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      userId = randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "Lockout Test User",
        userEmail: `${userId}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
        forcePasswordChange: false,
        failedLoginCount: 0,
      });
    });

    it("getLockoutState returns zero/null for a fresh user", async () => {
      const state = await getLockoutState(db, userId);
      expect(state).toEqual({ failedLoginCount: 0, lockedUntil: null });
    });

    it("getLockoutState returns the correct lockedUntil for a locked user", async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      await db
        .update(appuser)
        .set({ failedLoginCount: 5, lockedUntil })
        .where(eq(appuser.id, userId));

      const state = await getLockoutState(db, userId);
      expect(state.failedLoginCount).toBe(5);
      expect(state.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    });

    it("increments failed_login_count from 0 to 1 without setting locked_until", async () => {
      await recordFailedAttempt(db, userId);
      const state = await getLockoutState(db, userId);
      expect(state).toEqual({ failedLoginCount: 1, lockedUntil: null });
    });

    it("increments failed_login_count from 1 to 4 without setting locked_until", async () => {
      for (let i = 0; i < 4; i++) {
        await recordFailedAttempt(db, userId);
      }
      const state = await getLockoutState(db, userId);
      expect(state.failedLoginCount).toBe(4);
      expect(state.lockedUntil).toBeNull();
    });

    it("locks the account and writes one USER_LOCKED audit row on the 5th failure", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailedAttempt(db, userId);
      }

      const state = await getLockoutState(db, userId);
      expect(state.failedLoginCount).toBe(5);
      expect(state.lockedUntil).not.toBeNull();
      const expectedLockMs = Date.now() + 15 * 60 * 1000;
      expect(state.lockedUntil?.getTime()).toBeGreaterThan(
        expectedLockMs - 2000,
      );
      expect(state.lockedUntil?.getTime()).toBeLessThan(expectedLockMs + 2000);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.eventType).toBe("USER_LOCKED");
      expect(audits[0]?.actorUserId).toBeNull();
      expect(audits[0]?.targetEntity).toBe("appuser");
      expect(audits[0]?.beforeData).toEqual({
        failed_login_count: 4,
        locked_until: null,
      });
      expect(audits[0]?.afterData).toMatchObject({ failed_login_count: 5 });
    });

    it("re-locks and writes another USER_LOCKED entry on a 6th failure after an expired lock", async () => {
      const expired = new Date(Date.now() - 1000);
      await db
        .update(appuser)
        .set({ failedLoginCount: 5, lockedUntil: expired })
        .where(eq(appuser.id, userId));

      await recordFailedAttempt(db, userId);

      const state = await getLockoutState(db, userId);
      expect(state.failedLoginCount).toBe(6);
      expect(state.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.eventType).toBe("USER_LOCKED");
    });

    it("clearLockout resets failed_login_count and locked_until", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailedAttempt(db, userId);
      }

      await clearLockout(db, userId);

      const state = await getLockoutState(db, userId);
      expect(state).toEqual({ failedLoginCount: 0, lockedUntil: null });
    });

    it("adminClearLockout resets failed_login_count and locked_until for a locked user", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailedAttempt(db, userId);
      }

      await db.transaction(async (tx) => {
        await adminClearLockout(tx, userId);
      });

      const state = await getLockoutState(db, userId);
      expect(state).toEqual({ failedLoginCount: 0, lockedUntil: null });
    });

    it("adminClearLockout updates last_modified_datetime", async () => {
      const [before] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, userId));

      await db.transaction(async (tx) => {
        await adminClearLockout(tx, userId);
      });

      const [after] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(after!.lastModifiedDatetime.getTime()).toBeGreaterThanOrEqual(
        before!.lastModifiedDatetime.getTime(),
      );
    });

    it("adminClearLockout does not affect any other column on APPUSER", async () => {
      const [before] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));

      await db.transaction(async (tx) => {
        await adminClearLockout(tx, userId);
      });

      const [after] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(after?.userName).toBe(before?.userName);
      expect(after?.userEmail).toBe(before?.userEmail);
      expect(after?.status).toBe(before?.status);
      expect(after?.authMethod).toBe(before?.authMethod);
    });

    it("adminClearLockout is idempotent on an already-unlocked user", async () => {
      await db.transaction(async (tx) => {
        await adminClearLockout(tx, userId);
      });

      await expect(
        db.transaction(async (tx) => {
          await adminClearLockout(tx, userId);
        }),
      ).resolves.not.toThrow();

      const state = await getLockoutState(db, userId);
      expect(state).toEqual({ failedLoginCount: 0, lockedUntil: null });
    });

    it("adminClearLockout does not write an audit row", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailedAttempt(db, userId);
      }

      await db.transaction(async (tx) => {
        await adminClearLockout(tx, userId);
      });

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      // The 5th `recordFailedAttempt` writes its own `USER_LOCKED` row;
      // `adminClearLockout` itself must not add a second row.
      expect(audits).toHaveLength(1);
      expect(audits[0]?.eventType).toBe("USER_LOCKED");
    });

    it("rolls back both the column change and the audit row when the transaction fails", async () => {
      for (let i = 0; i < 4; i++) {
        await recordFailedAttempt(db, userId);
      }

      await sql.unsafe(
        'ALTER TABLE "core"."audit_log" RENAME TO "audit_log_disabled"',
      );
      try {
        await expect(recordFailedAttempt(db, userId)).rejects.toThrow();
      } finally {
        await sql.unsafe(
          'ALTER TABLE "core"."audit_log_disabled" RENAME TO "audit_log"',
        );
      }

      const state = await getLockoutState(db, userId);
      expect(state.failedLoginCount).toBe(4);
      expect(state.lockedUntil).toBeNull();

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      expect(audits).toHaveLength(0);
    });
  },
);
