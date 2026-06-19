import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import * as schema from "@/db/schema";
import { account, appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import type { setPasswordAction as SetPasswordAction } from "@/actions/auth/set-password.action";
import type * as AuthModule from "@/auth";

// Exercises the real `setPasswordAction` (guard + validation + service)
// against a live Postgres database. `@/auth`'s `api.getSession` is
// overridden with a controllable mock (mirroring
// tests/actions/create-user.action.integration.test.ts) while the rest of
// the real module — including `api.signInEmail`, needed to verify the old
// temp password is rejected post-activation — passes through untouched.
const databaseUrl = process.env.DATABASE_URL;

const getSessionMock = vi.fn();
vi.mock("@/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return {
    auth: {
      ...actual.auth,
      api: { ...actual.auth.api, getSession: getSessionMock },
    },
  };
});
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

function redirectTarget(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    typeof (error as { digest?: unknown }).digest !== "string"
  ) {
    return null;
  }
  const parts = (error as Error & { digest: string }).digest.split(";");
  if (parts[0] !== "NEXT_REDIRECT") return null;
  return parts.slice(2, -2).join(";");
}

describe.skipIf(!databaseUrl)(
  "setPasswordAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let setPasswordAction: typeof SetPasswordAction;
    let auth: typeof AuthModule.auth;

    const OLD_TEMP_PASSWORD = "old-temp-password-123";
    const NEW_PASSWORD = "BrandNewPassword123";

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    async function insertLocalUser(params: {
      id: string;
      status: "PENDING" | "ACTIVE";
      forcePasswordChange: boolean;
    }): Promise<void> {
      const hashedPassword = await hashPassword(OLD_TEMP_PASSWORD);
      await db.insert(appuser).values({
        id: params.id,
        userName: "Test User",
        userEmail: `${params.id}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: params.status,
        forcePasswordChange: params.forcePasswordChange,
      });
      await db.insert(account).values({
        id: randomUUID(),
        userId: params.id,
        providerId: "credential",
        providerAccountId: params.id,
        password: hashedPassword,
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

      ({ setPasswordAction } =
        await import("@/actions/auth/set-password.action"));
      ({ auth } = await import("@/auth"));
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(() => {
      getSessionMock.mockReset();
    });

    it("activates a PENDING user, hashes the new password, and writes both audit events", async () => {
      const userId = randomUUID();
      await insertLocalUser({
        id: userId,
        status: "PENDING",
        forcePasswordChange: true,
      });
      mockSession(userId);

      await expect(
        setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/");

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(userRow?.status).toBe("ACTIVE");
      expect(userRow?.forcePasswordChange).toBe(false);

      const [accountRow] = await db
        .select()
        .from(account)
        .where(eq(account.userId, userId));
      expect(accountRow?.password).not.toBeNull();

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      expect(audits.map((a) => a.eventType).sort()).toEqual([
        "USER_FIRST_LOGIN",
        "USER_PASSWORD_CHANGED",
      ]);

      const passwordChanged = audits.find(
        (a) => a.eventType === "USER_PASSWORD_CHANGED",
      );
      expect(passwordChanged?.actorUserId).toBe(userId);
      expect(passwordChanged?.beforeData).toBeNull();
      expect(passwordChanged?.afterData).toEqual({
        forcePasswordChange: false,
      });

      const firstLogin = audits.find((a) => a.eventType === "USER_FIRST_LOGIN");
      expect(firstLogin?.beforeData).toEqual({ status: "PENDING" });
      expect(firstLogin?.afterData).toEqual({ status: "ACTIVE" });
    });

    it("updates an already-ACTIVE user's password (admin reset) without USER_FIRST_LOGIN", async () => {
      const userId = randomUUID();
      await insertLocalUser({
        id: userId,
        status: "ACTIVE",
        forcePasswordChange: true,
      });
      mockSession(userId);

      await expect(
        setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/");

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(userRow?.status).toBe("ACTIVE");
      expect(userRow?.forcePasswordChange).toBe(false);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, userId));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.eventType).toBe("USER_PASSWORD_CHANGED");
    });

    it("rejects the old temp password and accepts the new one after activation", async () => {
      const userId = randomUUID();
      const email = `${userId}@example.com`;
      await insertLocalUser({
        id: userId,
        status: "PENDING",
        forcePasswordChange: true,
      });
      mockSession(userId);

      await expect(
        setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/");

      await expect(
        auth.api.signInEmail({
          body: { email, password: OLD_TEMP_PASSWORD },
        }),
      ).rejects.toThrow();

      const result = await auth.api.signInEmail({
        body: { email, password: NEW_PASSWORD },
      });
      expect(result.token).toBeTruthy();
    });

    it("redirects to /set-password unauthorized when force_password_change is already false", async () => {
      const userId = randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "Already Active",
        userEmail: `${userId}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
        forcePasswordChange: false,
      });
      mockSession(userId);

      await expect(
        setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/");
    });

    it("fails loudly, not silently, for an SSO user with no credential account (um08 invariant violated)", async () => {
      // um08 never sets `force_password_change = TRUE` for an SSO user
      // (db/repositories/appuser.repository.ts's `insertAppUser`), so this
      // fixture deliberately violates that invariant to exercise
      // `updateAccountPassword`'s "throw if no row is updated" guarantee
      // (um09-spec §9.3.1) — the typed result is `SERVER_ERROR`, not a
      // silent no-op, and no row is updated.
      const userId = randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "SSO User",
        userEmail: `${userId}@example.com`,
        emailVerified: false,
        authMethod: "SSO",
        status: "PENDING",
        forcePasswordChange: true,
      });
      mockSession(userId);

      const result = await setPasswordAction({
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });

      expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, userId));
      expect(userRow?.status).toBe("PENDING");
      expect(userRow?.forcePasswordChange).toBe(true);
    });

    it("redirects to /login when there is no session", async () => {
      mockSession(null);

      await expect(
        setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");
    });

    describe("transaction atomicity", () => {
      afterEach(async () => {
        await sql.unsafe(
          'ALTER TABLE IF EXISTS "core"."audit_log_disabled" RENAME TO "audit_log"',
        );
      });

      it("rolls back the password/status change when the audit insert fails", async () => {
        const userId = randomUUID();
        await insertLocalUser({
          id: userId,
          status: "PENDING",
          forcePasswordChange: true,
        });
        mockSession(userId);

        await sql.unsafe(
          'ALTER TABLE "core"."audit_log" RENAME TO "audit_log_disabled"',
        );

        const result = await setPasswordAction({
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        });
        expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });

        await sql.unsafe(
          'ALTER TABLE "core"."audit_log_disabled" RENAME TO "audit_log"',
        );

        const [userRow] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(userRow?.status).toBe("PENDING");
        expect(userRow?.forcePasswordChange).toBe(true);

        // The account password was rolled back along with everything else —
        // the old temp password still verifies. Checked directly via
        // `verifyPassword` (not a real sign-in) since the user is still
        // PENDING, which `auth/index.ts`'s status-check hook would reject
        // regardless of which password was supplied.
        const [accountRow] = await db
          .select()
          .from(account)
          .where(eq(account.userId, userId));
        await expect(
          verifyPassword({
            hash: accountRow?.password ?? "",
            password: OLD_TEMP_PASSWORD,
          }),
        ).resolves.toBe(true);

        const audits = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, userId));
        expect(audits).toHaveLength(0);
      });
    });
  },
);
