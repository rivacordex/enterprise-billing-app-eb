import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";
import { hashPassword } from "better-auth/crypto";

import { appuser, account, session } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import type { auth as Auth } from "@/auth";

// Exercises the real `auth/index.ts` config (field mapping, status-check
// hook, audit hook) against a live Postgres database — `@/auth` is imported
// dynamically inside `beforeAll`, after confirming `DATABASE_URL` is set, so
// the eager `@/lib/config` validation in its import graph never runs when
// this suite is skipped (um03-spec §5 "Sign-in flow").
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("sign-in flow (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle>;
  let auth: typeof Auth;

  const ADMIN_EMAIL = "active-admin@example.com";
  const ADMIN_PASSWORD = "correct-password-123";
  const DISABLED_EMAIL = "disabled-user@example.com";
  const PENDING_EMAIL = "pending-user@example.com";

  let activeUserId: string;
  let disabledUserId: string;
  let pendingUserId: string;

  beforeAll(async () => {
    sql = postgres(databaseUrl as string, { max: 1 });
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    db = drizzle(sql);
    await migrate(db, {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });

    ({ auth } = await import("@/auth"));

    const hashedPassword = await hashPassword(ADMIN_PASSWORD);

    activeUserId = randomUUID();
    await db.insert(appuser).values({
      id: activeUserId,
      userName: "Active Admin",
      userEmail: ADMIN_EMAIL,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
      failedLoginCount: 0,
    });
    await db.insert(account).values({
      id: randomUUID(),
      userId: activeUserId,
      providerId: "credential",
      providerAccountId: activeUserId,
      password: hashedPassword,
    });

    disabledUserId = randomUUID();
    await db.insert(appuser).values({
      id: disabledUserId,
      userName: "Disabled User",
      userEmail: DISABLED_EMAIL,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "DISABLED",
      forcePasswordChange: false,
      failedLoginCount: 0,
    });
    await db.insert(account).values({
      id: randomUUID(),
      userId: disabledUserId,
      providerId: "credential",
      providerAccountId: disabledUserId,
      password: hashedPassword,
    });

    // PENDING (um08): a newly created LOCAL user signs in with this status
    // before completing the forced first-login `/set-password` flow (um09) —
    // unlike DISABLED/DELETED, PENDING must be allowed past this hook.
    pendingUserId = randomUUID();
    await db.insert(appuser).values({
      id: pendingUserId,
      userName: "Pending User",
      userEmail: PENDING_EMAIL,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "PENDING",
      forcePasswordChange: true,
      failedLoginCount: 0,
    });
    await db.insert(account).values({
      id: randomUUID(),
      userId: pendingUserId,
      providerId: "credential",
      providerAccountId: pendingUserId,
      password: hashedPassword,
    });
  }, 30_000);

  afterAll(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.end();
  });

  it("rejects an incorrect password without creating a session or audit row", async () => {
    await expect(
      auth.api.signInEmail({
        body: { email: ADMIN_EMAIL, password: "wrong-password" },
      }),
    ).rejects.toThrow();

    const sessions = await db
      .select()
      .from(session)
      .where(eq(session.userId, activeUserId));
    expect(sessions).toHaveLength(0);

    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it("rejects a non-existent email without revealing whether the account exists", async () => {
    await expect(
      auth.api.signInEmail({
        body: { email: "nobody@example.com", password: "whatever123" },
      }),
    ).rejects.toThrow();

    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it("rejects sign-in for a DISABLED user", async () => {
    await expect(
      auth.api.signInEmail({
        body: { email: DISABLED_EMAIL, password: ADMIN_PASSWORD },
      }),
    ).rejects.toThrow();

    const sessions = await db
      .select()
      .from(session)
      .where(eq(session.userId, disabledUserId));
    expect(sessions).toHaveLength(0);
  });

  it("allows sign-in for a PENDING user (um09: forced first-login flow)", async () => {
    const result = await auth.api.signInEmail({
      body: { email: PENDING_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(result.token).toBeTruthy();

    const sessions = await db
      .select()
      .from(session)
      .where(eq(session.userId, pendingUserId));
    expect(sessions).toHaveLength(1);
  });

  it("creates a session and a LOCAL_LOGIN audit row, and updates last_login_datetime, on success", async () => {
    const result = await auth.api.signInEmail({
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(result.token).toBeTruthy();
    expect(result.user).not.toHaveProperty("status");

    const sessions = await db
      .select()
      .from(session)
      .where(eq(session.userId, activeUserId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, activeUserId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("LOCAL_LOGIN");
    expect(audits[0]?.targetEntity).toBe("appuser");

    const [user] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.id, activeUserId));
    expect(user?.lastLoginDatetime).not.toBeNull();
    expect(user?.lastLoginDatetime?.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it("rejects sign-up attempts (disableSignUp)", async () => {
    await expect(
      auth.api.signUpEmail({
        body: {
          email: "new-self-registered@example.com",
          password: "whatever123",
          name: "Self Registered",
        },
      }),
    ).rejects.toThrow();

    const [row] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.userEmail, "new-self-registered@example.com"));
    expect(row).toBeUndefined();
  });

  it("rolls back last_login_datetime when the audit insert fails, without affecting the session", async () => {
    const [beforeUser] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.id, activeUserId));
    const lastLoginBefore = beforeUser?.lastLoginDatetime ?? null;

    await sql.unsafe(
      'ALTER TABLE "core"."audit_log" RENAME TO "audit_log_disabled"',
    );
    try {
      const result = await auth.api.signInEmail({
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });

      // The session itself is unaffected by the audit-write failure.
      expect(result.token).toBeTruthy();

      const [afterUser] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, activeUserId));
      expect(afterUser?.lastLoginDatetime?.getTime()).toBe(
        lastLoginBefore?.getTime(),
      );
    } finally {
      await sql.unsafe(
        'ALTER TABLE "core"."audit_log_disabled" RENAME TO "audit_log"',
      );
    }
  });
});
