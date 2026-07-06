import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";
import { hashPassword } from "better-auth/crypto";

import { appuser, account } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import type { auth as Auth } from "@/auth";
import { csrfSignInOptions } from "../helpers/csrf-request";

// Exercises the real `auth/index.ts` config (lock check + failure/success
// hooks) against a live Postgres database — `@/auth` is imported dynamically
// inside `beforeAll`, after confirming `DATABASE_URL` is set, mirroring
// tests/auth/sign-in.integration.test.ts (um03-spec §5). Each test seeds its
// own LOCAL user in `beforeEach` so lockout state never leaks across tests.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("sign-in lockout (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle>;
  let auth: typeof Auth;

  const PASSWORD = "correct-password-123";
  let email: string;
  let userId: string;

  async function getRow(id: string) {
    const [row] = await db.select().from(appuser).where(eq(appuser.id, id));
    return row;
  }

  async function signInWrongPassword(targetEmail: string) {
    await expect(
      auth.api.signInEmail({
        body: { email: targetEmail, password: "wrong-password" },
        ...csrfSignInOptions(),
      }),
    ).rejects.toThrow();
  }

  async function lockedAuditCount(targetId: string) {
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, targetId));
    return audits.filter((a) => a.eventType === "USER_LOCKED").length;
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl as string, { max: 1 });
    await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    db = drizzle(sql);
    await migrate(db, {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });

    ({ auth } = await import("@/auth"));
  }, 30_000);

  afterAll(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.end();
  });

  beforeEach(async () => {
    userId = randomUUID();
    email = `${userId}@example.com`;
    const hashedPassword = await hashPassword(PASSWORD);
    await db.insert(appuser).values({
      id: userId,
      userName: "Lockout Local User",
      userEmail: email,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
      failedLoginCount: 0,
    });
    await db.insert(account).values({
      id: randomUUID(),
      userId,
      providerId: "credential",
      providerAccountId: userId,
      password: hashedPassword,
    });
  });

  it("increments failed_login_count on 1-4 wrong passwords without locking", async () => {
    for (let i = 1; i <= 4; i++) {
      await signInWrongPassword(email);
      const row = await getRow(userId);
      expect(row?.failedLoginCount).toBe(i);
      expect(row?.lockedUntil).toBeNull();
    }

    expect(await lockedAuditCount(userId)).toBe(0);
  });

  it("locks the account and writes one USER_LOCKED audit row on the 5th wrong password", async () => {
    for (let i = 0; i < 5; i++) {
      await signInWrongPassword(email);
    }

    const row = await getRow(userId);
    expect(row?.failedLoginCount).toBe(5);
    expect(row?.lockedUntil).not.toBeNull();
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(await lockedAuditCount(userId)).toBe(1);
  });

  it("rejects further attempts while locked without changing failed_login_count or locked_until, even with the correct password", async () => {
    for (let i = 0; i < 5; i++) {
      await signInWrongPassword(email);
    }
    const before = await getRow(userId);

    await expect(
      auth.api.signInEmail({
        body: { email, password: PASSWORD },
        ...csrfSignInOptions(),
      }),
    ).rejects.toThrow();

    const after = await getRow(userId);
    expect(after?.failedLoginCount).toBe(before?.failedLoginCount);
    expect(after?.lockedUntil?.getTime()).toBe(before?.lockedUntil?.getTime());
    expect(await lockedAuditCount(userId)).toBe(1);
  });

  it("re-locks immediately on a wrong password after the lock has expired", async () => {
    for (let i = 0; i < 5; i++) {
      await signInWrongPassword(email);
    }
    await db
      .update(appuser)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(appuser.id, userId));

    await signInWrongPassword(email);

    const row = await getRow(userId);
    expect(row?.failedLoginCount).toBe(6);
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(await lockedAuditCount(userId)).toBe(2);
  });

  it("clears lockout state on a correct password after a past-expired lock", async () => {
    for (let i = 0; i < 5; i++) {
      await signInWrongPassword(email);
    }
    await db
      .update(appuser)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(appuser.id, userId));

    const result = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      ...csrfSignInOptions(),
    });
    expect(result.token).toBeTruthy();

    const row = await getRow(userId);
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it("resets the counter on a correct password before the 5th failure", async () => {
    await signInWrongPassword(email);
    await signInWrongPassword(email);
    await signInWrongPassword(email);

    const midway = await getRow(userId);
    expect(midway?.failedLoginCount).toBe(3);

    const result = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      ...csrfSignInOptions(),
    });
    expect(result.token).toBeTruthy();

    const row = await getRow(userId);
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId));
    expect(audits.some((a) => a.eventType === "LOCAL_LOGIN")).toBe(true);
  });

  it("does not touch lockout columns for an SSO user attempting local sign-in", async () => {
    const ssoUserId = randomUUID();
    const ssoEmail = `${ssoUserId}@example.com`;
    await db.insert(appuser).values({
      id: ssoUserId,
      userName: "Lockout SSO User",
      userEmail: ssoEmail,
      emailVerified: false,
      authMethod: "SSO",
      status: "ACTIVE",
      forcePasswordChange: false,
      failedLoginCount: 0,
    });

    await expect(
      auth.api.signInEmail({
        body: { email: ssoEmail, password: "whatever123" },
        ...csrfSignInOptions(),
      }),
    ).rejects.toThrow();

    const row = await getRow(ssoUserId);
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });
});
