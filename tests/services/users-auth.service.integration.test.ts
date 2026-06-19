import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import type { handleSsoSignIn as HandleSsoSignIn } from "@/services/users/users-auth.service";

// um10-spec §10.10 integration coverage for `handleSsoSignIn` — unlike
// `setPasswordAction`'s integration suite, this function never touches
// Better-Auth itself (it's called from a `databaseHooks` hook, not the
// other way around), so no `@/auth` mock is needed here.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("handleSsoSignIn (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let handleSsoSignIn: typeof HandleSsoSignIn;

  async function insertSsoUser(params: {
    id: string;
    status: "PENDING" | "ACTIVE" | "DISABLED";
  }): Promise<void> {
    await db.insert(appuser).values({
      id: params.id,
      userName: "Test SSO User",
      userEmail: `${params.id}@example.com`,
      emailVerified: true,
      authMethod: "SSO",
      status: params.status,
    });
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl as string, { max: 1 });
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    db = drizzle(sql, { schema });
    await migrate(db, {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });

    ({ handleSsoSignIn } = await import("@/services/users/users-auth.service"));
  }, 30_000);

  afterAll(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.end();
  });

  it("activates a PENDING SSO user, sets last_login_datetime, and writes both audit events", async () => {
    const userId = randomUUID();
    await insertSsoUser({ id: userId, status: "PENDING" });

    const result = await handleSsoSignIn({ userId });
    expect(result).toEqual({ ok: true, wasFirstLogin: true });

    const [userRow] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.id, userId));
    expect(userRow?.status).toBe("ACTIVE");
    expect(userRow?.lastLoginDatetime).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId));
    expect(audits.map((a) => a.eventType).sort()).toEqual([
      "SSO_LOGIN",
      "USER_FIRST_LOGIN",
    ]);

    const firstLogin = audits.find((a) => a.eventType === "USER_FIRST_LOGIN");
    expect(firstLogin?.beforeData).toEqual({ status: "PENDING" });
    expect(firstLogin?.afterData).toEqual({ status: "ACTIVE" });
  });

  it("updates an already-ACTIVE SSO user's last_login_datetime without USER_FIRST_LOGIN", async () => {
    const userId = randomUUID();
    await insertSsoUser({ id: userId, status: "ACTIVE" });

    const result = await handleSsoSignIn({ userId });
    expect(result).toEqual({ ok: true, wasFirstLogin: false });

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("SSO_LOGIN");
  });

  it("rejects a DISABLED SSO user and writes nothing", async () => {
    const userId = randomUUID();
    await insertSsoUser({ id: userId, status: "DISABLED" });

    const result = await handleSsoSignIn({ userId });
    expect(result).toEqual({ ok: false, code: "USER_NOT_ELIGIBLE" });

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId));
    expect(audits).toHaveLength(0);
  });

  it("rejects a LOCAL user and writes nothing", async () => {
    const userId = randomUUID();
    await db.insert(appuser).values({
      id: userId,
      userName: "Local User",
      userEmail: `${userId}@example.com`,
      emailVerified: true,
      authMethod: "LOCAL",
      status: "ACTIVE",
    });

    const result = await handleSsoSignIn({ userId });
    expect(result).toEqual({ ok: false, code: "AUTH_METHOD_MISMATCH" });

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId));
    expect(audits).toHaveLength(0);
  });

  describe("transaction atomicity", () => {
    afterEach(async () => {
      await sql.unsafe(
        'ALTER TABLE IF EXISTS "core"."audit_log_disabled" RENAME TO "audit_log"',
      );
    });

    it("rolls back the activation and last-login update when the audit insert fails", async () => {
      const userId = randomUUID();
      await insertSsoUser({ id: userId, status: "PENDING" });

      await sql.unsafe(
        'ALTER TABLE "core"."audit_log" RENAME TO "audit_log_disabled"',
      );

      await expect(handleSsoSignIn({ userId })).rejects.toThrow();

      await sql.unsafe(
        'ALTER TABLE "core"."audit_log_disabled" RENAME TO "audit_log"',
      );

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(userRow?.status).toBe("PENDING");
      expect(userRow?.lastLoginDatetime).toBeNull();
    });
  });
});
