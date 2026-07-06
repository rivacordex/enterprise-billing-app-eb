import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { account, appuser } from "@/db/schema/identity";
import type { createUser as CreateUser } from "@/services/users/users-write.service";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// Exercises the real `createUser` service (its own internal `@/db/client`
// pool, not the local `db` connection below) against a live Postgres
// database — `@/services/users/users-write.service` is imported dynamically
// inside `beforeAll`, after confirming `DATABASE_URL` is set, mirroring
// tests/auth/sign-in.integration.test.ts so the eager `@/lib/config`
// validation in its import graph never runs when this suite is skipped.
describe.skipIf(!databaseUrl)(
  "users-write.service createUser email uniqueness (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createUser: typeof CreateUser;
    let actorUserId: string;

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

      ({ createUser } = await import("@/services/users/users-write.service"));

      // `audit_log.actor_user_id` FKs to `appuser` — the actor must be a
      // real row, not an arbitrary UUID.
      actorUserId = randomUUID();
      await db.insert(appuser).values({
        id: actorUserId,
        userName: "Acting Admin",
        userEmail: `${actorUserId}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("returns EMAIL_CONFLICT and writes no row for an existing ACTIVE user's email", async () => {
      const email = "active-conflict@example.com";
      await db.insert(appuser).values({
        id: randomUUID(),
        userName: "Existing Active",
        userEmail: email,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });

      const result = await createUser(
        {
          userName: "New User",
          userEmail: email,
          userPhonenum: null,
          authMethod: "LOCAL",
          roleIds: [],
        },
        actorUserId,
      );

      expect(result).toEqual({ ok: false, code: "EMAIL_CONFLICT" });
    });

    it("succeeds when the existing user with that email is DELETED", async () => {
      const email = "deleted-reuse@example.com";
      await db.insert(appuser).values({
        id: randomUUID(),
        userName: "Previously Deleted",
        userEmail: email,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "DELETED",
      });

      const result = await createUser(
        {
          userName: "New User",
          userEmail: email,
          userPhonenum: null,
          authMethod: "SSO",
          roleIds: [],
        },
        actorUserId,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, result.userId));
        expect(row?.userEmail).toBe(email);
        expect(row?.status).toBe("PENDING");

        const accountRows = await db
          .select()
          .from(account)
          .where(eq(account.userId, result.userId));
        expect(accountRows).toHaveLength(0);
      }
    });
  },
);
