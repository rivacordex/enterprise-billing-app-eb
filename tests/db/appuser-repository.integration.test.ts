import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { account, appuser } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { roleAssign } from "@/db/schema/role-assign";
import {
  countRemainingAdmins,
  deleteAllUserAccounts,
  findAllWithRoles,
  findByIdWithRoles,
  getUserRoleNames,
  removeUserRoleAssignments,
  setForcePasswordChange,
  setUserStatus,
  userHasAdminRole,
} from "@/db/repositories/appuser.repository";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "appuser.repository read queries (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    let adminUserId: string;
    let noRolesUserId: string;
    let adminRoleId: string;
    let managerRoleId: string;

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      adminUserId = randomUUID();
      noRolesUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: adminUserId,
          userName: "Admin User",
          userEmail: `${adminUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        },
        {
          id: noRolesUserId,
          userName: "No Roles User",
          userEmail: `${noRolesUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        },
      ]);

      const [adminRole] = await db
        .insert(roles)
        .values({ roleName: "ADMIN", roleDescr: "Admin" })
        .returning({ roleId: roles.roleId });
      const [managerRole] = await db
        .insert(roles)
        .values({ roleName: "MANAGER", roleDescr: "Manager" })
        .returning({ roleId: roles.roleId });
      adminRoleId = adminRole!.roleId;
      managerRoleId = managerRole!.roleId;

      await db.insert(roleAssign).values([
        { refUserId: adminUserId, refRoleId: adminRoleId, assignedBy: null },
        {
          refUserId: adminUserId,
          refRoleId: managerRoleId,
          assignedBy: null,
        },
      ]);
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("findAllWithRoles", () => {
      it("returns each user exactly once even with multiple role assignments", async () => {
        const rows = await findAllWithRoles(db);

        const adminRow = rows.find((r) => r.userId === adminUserId);
        expect(adminRow).toBeDefined();
        expect(adminRow?.roles).toHaveLength(2);
        expect(adminRow?.roles.map((r) => r.roleName).sort()).toEqual([
          "ADMIN",
          "MANAGER",
        ]);
      });

      it("returns roles: [] (empty array, not null) for a user with no assignments", async () => {
        const rows = await findAllWithRoles(db);

        const row = rows.find((r) => r.userId === noRolesUserId);
        expect(row).toBeDefined();
        expect(row?.roles).toEqual([]);
      });

      it("returns at least the two seeded users", async () => {
        const rows = await findAllWithRoles(db);
        expect(rows.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("findByIdWithRoles", () => {
      it("returns the user with roles", async () => {
        const row = await findByIdWithRoles(db, adminUserId);
        expect(row).not.toBeNull();
        expect(row?.userId).toBe(adminUserId);
        expect(row?.roles).toHaveLength(2);
      });

      it("returns null for a non-existent UUID", async () => {
        const row = await findByIdWithRoles(
          db,
          "00000000-0000-0000-0000-000000000000",
        );
        expect(row).toBeNull();
      });
    });

    describe("setUserStatus", () => {
      it("sets status and bumps last_modified_datetime", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "Status User",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        });
        const [before] = await db
          .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
          .from(appuser)
          .where(eq(appuser.id, userId));

        await setUserStatus(db, userId, "DISABLED");

        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(row?.status).toBe("DISABLED");
        expect(row?.lastModifiedDatetime.getTime()).toBeGreaterThan(
          before!.lastModifiedDatetime.getTime(),
        );
      });
    });

    describe("setForcePasswordChange", () => {
      it("sets the flag and bumps last_modified_datetime", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "Reset User",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          forcePasswordChange: false,
        });
        const [before] = await db
          .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
          .from(appuser)
          .where(eq(appuser.id, userId));

        await setForcePasswordChange(db, userId);

        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(row?.forcePasswordChange).toBe(true);
        expect(row?.lastModifiedDatetime.getTime()).toBeGreaterThan(
          before!.lastModifiedDatetime.getTime(),
        );
      });

      it("does not affect any other column", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "Reset User 2",
          userEmail: `${userId}@example.com`,
          userPhonenum: "+1 555 0100",
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          forcePasswordChange: false,
        });

        await setForcePasswordChange(db, userId);

        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(row?.userName).toBe("Reset User 2");
        expect(row?.userPhonenum).toBe("+1 555 0100");
        expect(row?.status).toBe("ACTIVE");
      });

      it("is idempotent when the flag is already TRUE", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "Reset User 3",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          forcePasswordChange: true,
        });

        await expect(setForcePasswordChange(db, userId)).resolves.not.toThrow();

        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(row?.forcePasswordChange).toBe(true);
      });
    });

    describe("userHasAdminRole / countRemainingAdmins", () => {
      it("userHasAdminRole returns true for a user with ADMIN, false otherwise", async () => {
        expect(await userHasAdminRole(db, adminUserId)).toBe(true);
        expect(await userHasAdminRole(db, noRolesUserId)).toBe(false);
      });

      it("countRemainingAdmins excludes the target user and DISABLED/DELETED admins", async () => {
        const secondAdminId = randomUUID();
        const disabledAdminId = randomUUID();
        await db.insert(appuser).values([
          {
            id: secondAdminId,
            userName: "Second Admin",
            userEmail: `${secondAdminId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "PENDING",
          },
          {
            id: disabledAdminId,
            userName: "Disabled Admin",
            userEmail: `${disabledAdminId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "DISABLED",
          },
        ]);
        await db.insert(roleAssign).values([
          {
            refUserId: secondAdminId,
            refRoleId: adminRoleId,
            assignedBy: null,
          },
          {
            refUserId: disabledAdminId,
            refRoleId: adminRoleId,
            assignedBy: null,
          },
        ]);

        // adminUserId + secondAdminId (PENDING) are sign-in-capable ADMINs;
        // disabledAdminId is excluded. Excluding adminUserId itself (the
        // target being disabled) leaves exactly secondAdminId.
        expect(await countRemainingAdmins(db, adminUserId)).toBe(1);
        // Excluding secondAdminId itself leaves exactly adminUserId.
        expect(await countRemainingAdmins(db, secondAdminId)).toBe(1);
      });
    });

    describe("setUserStatus → DELETED", () => {
      it("sets status to DELETED and bumps last_modified_datetime", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "Tombstone User",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
        });
        const [before] = await db
          .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
          .from(appuser)
          .where(eq(appuser.id, userId));

        await setUserStatus(db, userId, "DELETED");

        const [row] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, userId));
        expect(row?.status).toBe("DELETED");
        expect(row?.lastModifiedDatetime.getTime()).toBeGreaterThan(
          before!.lastModifiedDatetime.getTime(),
        );
      });
    });

    describe("removeUserRoleAssignments", () => {
      it("deletes the target user's assignments, leaves others, and returns the count", async () => {
        const targetId = randomUUID();
        const otherId = randomUUID();
        await db.insert(appuser).values([
          {
            id: targetId,
            userName: "Roles Target",
            userEmail: `${targetId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "DISABLED",
          },
          {
            id: otherId,
            userName: "Roles Other",
            userEmail: `${otherId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "ACTIVE",
          },
        ]);
        await db.insert(roleAssign).values([
          { refUserId: targetId, refRoleId: adminRoleId, assignedBy: null },
          { refUserId: targetId, refRoleId: managerRoleId, assignedBy: null },
          { refUserId: otherId, refRoleId: managerRoleId, assignedBy: null },
        ]);

        const removed = await removeUserRoleAssignments(db, targetId);
        expect(removed).toBe(2);

        const targetRows = await db
          .select()
          .from(roleAssign)
          .where(eq(roleAssign.refUserId, targetId));
        expect(targetRows).toHaveLength(0);

        const otherRows = await db
          .select()
          .from(roleAssign)
          .where(eq(roleAssign.refUserId, otherId));
        expect(otherRows).toHaveLength(1);
      });

      it("returns 0 and does not throw when the user has no assignments", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "No Roles Tombstone",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
        });

        const removed = await removeUserRoleAssignments(db, userId);
        expect(removed).toBe(0);
      });
    });

    describe("deleteAllUserAccounts", () => {
      it("deletes both credential and microsoft rows for the user, leaving others", async () => {
        const targetId = randomUUID();
        const otherId = randomUUID();
        await db.insert(appuser).values([
          {
            id: targetId,
            userName: "Accounts Target",
            userEmail: `${targetId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "DISABLED",
          },
          {
            id: otherId,
            userName: "Accounts Other",
            userEmail: `${otherId}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "ACTIVE",
          },
        ]);
        await db.insert(account).values([
          {
            id: randomUUID(),
            userId: targetId,
            providerId: "credential",
            providerAccountId: targetId,
            password: "hash",
          },
          {
            id: randomUUID(),
            userId: targetId,
            providerId: "microsoft",
            providerAccountId: `entra-${targetId}`,
          },
          {
            id: randomUUID(),
            userId: otherId,
            providerId: "credential",
            providerAccountId: otherId,
            password: "hash",
          },
        ]);

        await deleteAllUserAccounts(db, targetId);

        const targetRows = await db
          .select()
          .from(account)
          .where(eq(account.userId, targetId));
        expect(targetRows).toHaveLength(0);

        const otherRows = await db
          .select()
          .from(account)
          .where(eq(account.userId, otherId));
        expect(otherRows).toHaveLength(1);
      });

      it("does not throw when the user has no account rows", async () => {
        const userId = randomUUID();
        await db.insert(appuser).values({
          id: userId,
          userName: "No Accounts",
          userEmail: `${userId}@example.com`,
          emailVerified: false,
          authMethod: "SSO",
          status: "DISABLED",
        });

        await expect(deleteAllUserAccounts(db, userId)).resolves.not.toThrow();
      });
    });

    describe("getUserRoleNames", () => {
      it("returns the role names for an assigned user", async () => {
        const names = await getUserRoleNames(db, adminUserId);
        expect(names.sort()).toEqual(["ADMIN", "MANAGER"]);
      });

      it("returns [] for a user with no assignments", async () => {
        const names = await getUserRoleNames(db, noRolesUserId);
        expect(names).toEqual([]);
      });
    });
  },
);
