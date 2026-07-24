import { randomUUID } from "node:crypto";

import {
  afterAll,
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

import { appuser, session as sessionTable } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import type {
  requirePermission as RequirePermission,
  requireAuthenticated as RequireAuthenticated,
  resolveForcePasswordChangeSession as ResolveForcePasswordChangeSession,
} from "@/auth/guard";
import type { PermissionName, PermissionType } from "@/types/rbac";

// Exercises the real `auth/guard.ts` against a live Postgres database.
// `@/auth` is replaced with a fake exposing only `api.getSession` — the one
// member `auth/guard.ts` calls — so the guard's own session-aware logic
// runs for real while the controlled session comes from the test. `@/auth`
// and `@/auth/guard` are imported dynamically inside `beforeAll`, after
// confirming `DATABASE_URL` is set, mirroring
// tests/auth/signin-lockout.integration.test.ts (um06-spec §6.10).
const databaseUrl = process.env.DATABASE_URL;

const getSessionMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// Next's `redirect()` throws an `Error` whose `digest` encodes
// `NEXT_REDIRECT;<type>;<url>;<statusCode>;` — the same mechanism
// `getURLFromRedirectError` reads internally (not exported from the public
// `next/navigation` entry point), parsed here directly.
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
  "requirePermission / requireAuthenticated (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle>;
    let requirePermission: typeof RequirePermission;
    let requireAuthenticated: typeof RequireAuthenticated;
    let resolveForcePasswordChangeSession: typeof ResolveForcePasswordChangeSession;

    let adminUserId: string;
    let noGrantsUserId: string;
    let pendingUserId: string;
    let disabledUserId: string;
    let forcePasswordChangeUserId: string;
    let pendingForceChangeUserId: string;
    // cm16-spec §3.2 — a MANAGER (customers:EDIT) and a USER (customers:READ
    // only) principal, mirroring the real permission map (architecture §4),
    // needed to prove the READ/EDIT split itself rather than just that
    // "some" grant satisfies "some" level (the admin_user/no_grants_user
    // pair above only proves the general satisfaction hierarchy).
    let customerManagerUserId: string;
    let customerUserRoleUserId: string;
    let customerActions: Record<string, (input: unknown) => Promise<unknown>>;
    // pm24-spec §2.7/§3.8 — mirrors cm16-spec §3.2's customerManagerUserId/
    // customerUserRoleUserId split, but for the products:EDIT-vs-DELETE gate
    // specifically (customers only ever tested EDIT-vs-READ; there is no
    // customers:DELETE-gated action to compare against). adminUserId already
    // holds products:DELETE (⊃ EDIT ⊃ READ per level-rank), so it can't prove
    // the split exists on its own — an EDIT-only principal is required.
    let productsManagerUserId: string;
    let productActions: Record<string, () => Promise<unknown>>;

    async function insertUser(params: {
      id: string;
      status?: "ACTIVE" | "PENDING" | "DISABLED";
      forcePasswordChange?: boolean;
    }): Promise<void> {
      await db.insert(appuser).values({
        id: params.id,
        userName: "Test User",
        userEmail: `${params.id}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: params.status ?? "ACTIVE",
        forcePasswordChange: params.forcePasswordChange ?? false,
      });
    }

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql);
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({
        requirePermission,
        requireAuthenticated,
        resolveForcePasswordChangeSession,
      } = await import("@/auth/guard"));

      adminUserId = randomUUID();
      noGrantsUserId = randomUUID();
      pendingUserId = randomUUID();
      disabledUserId = randomUUID();
      forcePasswordChangeUserId = randomUUID();
      pendingForceChangeUserId = randomUUID();
      customerManagerUserId = randomUUID();
      customerUserRoleUserId = randomUUID();
      productsManagerUserId = randomUUID();

      await insertUser({ id: adminUserId });
      await insertUser({ id: noGrantsUserId });
      await insertUser({ id: pendingUserId, status: "PENDING" });
      await insertUser({ id: disabledUserId, status: "DISABLED" });
      await insertUser({
        id: forcePasswordChangeUserId,
        forcePasswordChange: true,
      });
      await insertUser({
        id: pendingForceChangeUserId,
        status: "PENDING",
        forcePasswordChange: true,
      });
      await insertUser({ id: customerManagerUserId });
      await insertUser({ id: customerUserRoleUserId });
      await insertUser({ id: productsManagerUserId });

      const [adminRole] = await db
        .insert(roles)
        .values({ roleName: "ADMIN", roleDescr: "Admin" })
        .returning({ roleId: roles.roleId });

      // cm16-spec §3.2 — MANAGER/USER roles for the customers:EDIT/READ
      // split (§3.2 point 2).
      const [customerManagerRole] = await db
        .insert(roles)
        .values({ roleName: "MANAGER", roleDescr: "Manager" })
        .returning({ roleId: roles.roleId });
      const [customerUserRole] = await db
        .insert(roles)
        .values({ roleName: "USER", roleDescr: "User" })
        .returning({ roleId: roles.roleId });
      // pm24-spec §2.7/§3.8 — products:EDIT-only role, the products analogue
      // of customerManagerRole above.
      const [productsManagerRole] = await db
        .insert(roles)
        .values({ roleName: "PRODUCTS_MANAGER", roleDescr: "Products Manager" })
        .returning({ roleId: roles.roleId });

      const insertedPermissions = await db
        .insert(permissions)
        .values([
          { permissionName: "users", permissionInfo: "Users" },
          { permissionName: "roles", permissionInfo: "Roles" },
          { permissionName: "system_config", permissionInfo: "Config" },
          { permissionName: "audit_log", permissionInfo: "Audit" },
        ])
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });

      // Unlike the four rows above, "products" and "customers" are not
      // seeded here — migrations 0006_product.sql / 0009_customer.sql insert
      // them directly as part of their schema migrations (code-standards
      // §8), so they already exist once `beforeAll`'s `migrate()` call has
      // run; inserting them again would violate the unique constraint.
      // Their ids are looked up instead.
      const [productsPermission] = await db
        .select({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        })
        .from(permissions)
        .where(eq(permissions.permissionName, "products"));
      if (!productsPermission) {
        throw new Error(
          "Expected migration 0006_product.sql to have seeded the 'products' permission row.",
        );
      }

      const [customersPermission] = await db
        .select({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        })
        .from(permissions)
        .where(eq(permissions.permissionName, "customers"));
      if (!customersPermission) {
        throw new Error(
          "Expected migration 0009_customer.sql to have seeded the 'customers' permission row.",
        );
      }

      const permissionIdByName = new Map(
        [...insertedPermissions, productsPermission, customersPermission].map(
          (p) => [p.permissionName, p.permissionId],
        ),
      );

      const grants: { name: PermissionName; type: PermissionType }[] = [
        { name: "users", type: "DELETE" },
        { name: "roles", type: "DELETE" },
        { name: "system_config", type: "DELETE" },
        { name: "audit_log", type: "READ" },
        { name: "products", type: "DELETE" }, // DELETE ⊃ EDIT ⊃ READ
      ];

      await db.insert(rolePermissionAssign).values(
        grants.map((g) => ({
          refRoleId: adminRole!.roleId,
          refPermissionId: permissionIdByName.get(g.name)!,
          permissionType: g.type,
        })),
      );

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRole!.roleId,
        assignedBy: null,
      });

      // cm16-spec §3.2 point 2 — customers:EDIT for MANAGER, customers:READ
      // for USER, mirroring the real permission map (architecture §4).
      await db.insert(rolePermissionAssign).values([
        {
          refRoleId: customerManagerRole!.roleId,
          refPermissionId: customersPermission.permissionId,
          permissionType: "EDIT",
        },
        {
          refRoleId: customerUserRole!.roleId,
          refPermissionId: customersPermission.permissionId,
          permissionType: "READ",
        },
      ]);

      await db.insert(roleAssign).values([
        {
          refUserId: customerManagerUserId,
          refRoleId: customerManagerRole!.roleId,
          assignedBy: null,
        },
        {
          refUserId: customerUserRoleUserId,
          refRoleId: customerUserRole!.roleId,
          assignedBy: null,
        },
      ]);

      // pm24-spec §2.7 point 1 — productsManagerUserId gets products:EDIT
      // only, never DELETE, so retireOfferingAction (DELETE-gated) has
      // something real to reject.
      await db.insert(rolePermissionAssign).values({
        refRoleId: productsManagerRole!.roleId,
        refPermissionId: productsPermission.permissionId,
        permissionType: "EDIT",
      });
      await db.insert(roleAssign).values({
        refUserId: productsManagerUserId,
        refRoleId: productsManagerRole!.roleId,
        assignedBy: null,
      });

      // cm16-spec §3.2 point 4 / §2.3 — the direct-Server-Action USER-denial
      // loop needs every actions/customer/* export. Imported dynamically,
      // after DATABASE_URL is confirmed set, same convention as
      // `@/auth/guard` above (their import graphs reach `@/db/client`).
      const [
        createCustomerMod,
        updateOrganizationMod,
        transitionOrganizationStatusMod,
        transitionCustomerStatusMod,
        updatePartyRoleSpecificationMod,
        addContactMod,
        updateContactMod,
        deleteContactMod,
        setPreferredContactMod,
        setPreferredContactMethodMod,
      ] = await Promise.all([
        import("@/actions/customer/create-customer"),
        import("@/actions/customer/update-organization"),
        import("@/actions/customer/transition-organization-status"),
        import("@/actions/customer/transition-customer-status"),
        import("@/actions/customer/update-party-role-specification"),
        import("@/actions/customer/add-contact"),
        import("@/actions/customer/update-contact"),
        import("@/actions/customer/delete-contact"),
        import("@/actions/customer/set-preferred-contact"),
        import("@/actions/customer/set-preferred-contact-method"),
      ]);

      customerActions = {
        createCustomerAction: createCustomerMod.createCustomerAction,
        updateOrganizationAction:
          updateOrganizationMod.updateOrganizationAction,
        transitionOrganizationStatusAction:
          transitionOrganizationStatusMod.transitionOrganizationStatusAction,
        transitionCustomerStatusAction:
          transitionCustomerStatusMod.transitionCustomerStatusAction,
        updatePartyRoleSpecificationAction:
          updatePartyRoleSpecificationMod.updatePartyRoleSpecificationAction,
        addContactAction: addContactMod.addContactAction,
        updateContactAction: updateContactMod.updateContactAction,
        deleteContactAction: deleteContactMod.deleteContactAction,
        setPreferredContactAction:
          setPreferredContactMod.setPreferredContactAction,
        setPreferredContactMethodAction:
          setPreferredContactMethodMod.setPreferredContactMethodAction,
      };

      // pm24-spec §2.7/§3.8 point 2 — same convention as the customer block
      // above, but each entry is a zero-arg closure (not a shared `(input:
      // unknown) => Promise<unknown>` shape) since the eight product actions
      // have varying arity (offeringId/specId positional params ahead of the
      // input object, or no input object at all for deleteSpecificationAction).
      // Placeholder ids are safe — the permission guard runs before any
      // argument is used (pm24-spec §2.7).
      const [
        createOfferingMod,
        updateOfferingMod,
        createSpecificationMod,
        updateSpecificationMod,
        deleteSpecificationMod,
        insertPriceMod,
        activateOfferingMod,
        retireOfferingMod,
      ] = await Promise.all([
        import("@/actions/product/create-offering.action"),
        import("@/actions/product/update-offering.action"),
        import("@/actions/product/create-specification.action"),
        import("@/actions/product/update-specification.action"),
        import("@/actions/product/delete-specification.action"),
        import("@/actions/product/insert-price.action"),
        import("@/actions/product/activate-offering.action"),
        import("@/actions/product/retire-offering.action"),
      ]);

      productActions = {
        createOfferingAction: () => createOfferingMod.createOfferingAction({}),
        updateOfferingAction: () =>
          updateOfferingMod.updateOfferingAction("PRDOFR000001", {}),
        createSpecificationAction: () =>
          createSpecificationMod.createSpecificationAction("PRDOFR000001", {}),
        updateSpecificationAction: () =>
          updateSpecificationMod.updateSpecificationAction(
            "PRDSMD000001",
            "PRDOFR000001",
            {},
          ),
        deleteSpecificationAction: () =>
          deleteSpecificationMod.deleteSpecificationAction(
            "PRDSMD000001",
            "PRDOFR000001",
          ),
        insertPriceAction: () =>
          insertPriceMod.insertPriceAction("PRDOFR000001", {}),
        activateOfferingAction: () =>
          activateOfferingMod.activateOfferingAction("PRDOFR000001", {}),
        retireOfferingAction: () =>
          retireOfferingMod.retireOfferingAction("PRDOFR000001", {}),
      };
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(() => {
      getSessionMock.mockReset();
    });

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    describe("requirePermission", () => {
      it.each([
        [PERMISSIONS.USERS, LEVELS.READ],
        [PERMISSIONS.USERS, LEVELS.EDIT],
        [PERMISSIONS.USERS, LEVELS.DELETE],
        [PERMISSIONS.ROLES, LEVELS.READ],
        [PERMISSIONS.ROLES, LEVELS.EDIT],
        [PERMISSIONS.ROLES, LEVELS.DELETE],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.EDIT],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.DELETE],
        [PERMISSIONS.AUDIT_LOG, LEVELS.READ],
        [PERMISSIONS.PRODUCTS, LEVELS.READ],
        [PERMISSIONS.PRODUCTS, LEVELS.EDIT],
        [PERMISSIONS.PRODUCTS, LEVELS.DELETE],
      ] as const)("admin_user satisfies %s:%s", async (name, level) => {
        mockSession(adminUserId);
        const result = await requirePermission(name, level);
        expect(result.userId).toBe(adminUserId);
        expect(result.permissionMap[name]).not.toBeNull();
      });

      it("admin_user is denied audit_log:EDIT (only READ granted)", async () => {
        mockSession(adminUserId);
        await expect(
          requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.EDIT),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      it.each([
        PERMISSIONS.USERS,
        PERMISSIONS.ROLES,
        PERMISSIONS.SYSTEM_CONFIG,
        PERMISSIONS.AUDIT_LOG,
        PERMISSIONS.PRODUCTS,
        PERMISSIONS.CUSTOMERS,
      ])("no_grants_user is denied %s:READ", async (name) => {
        mockSession(noGrantsUserId);
        await expect(requirePermission(name, LEVELS.READ)).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      // cm16-spec §3.2 point 5 — no-grants denial for both routes: READ
      // (`/customers/view`) is covered by the loop above; EDIT
      // (`/customers/manage`) needs its own case since no other permission
      // in the loop above has a level above READ to exercise.
      it("no_grants_user is denied customers:EDIT (/customers/manage)", async () => {
        mockSession(noGrantsUserId);
        await expect(
          requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      // cm16-spec §3.2 points 2/3 — the customers:READ/EDIT split itself,
      // using dedicated MANAGER/USER principals rather than admin_user
      // (whose grants sit at the ceiling of every permission and so can't
      // distinguish "satisfies READ" from "satisfies EDIT").
      it.each([
        [PERMISSIONS.CUSTOMERS, LEVELS.READ],
        [PERMISSIONS.CUSTOMERS, LEVELS.EDIT],
      ] as const)(
        "customer_manager_user satisfies %s:%s",
        async (name, level) => {
          mockSession(customerManagerUserId);
          const result = await requirePermission(name, level);
          expect(result.userId).toBe(customerManagerUserId);
          expect(result.permissionMap[name]).not.toBeNull();
        },
      );

      it("customer_user_role_user satisfies customers:READ", async () => {
        mockSession(customerUserRoleUserId);
        const result = await requirePermission(
          PERMISSIONS.CUSTOMERS,
          LEVELS.READ,
        );
        expect(result.userId).toBe(customerUserRoleUserId);
        expect(result.permissionMap.customers).not.toBeNull();
      });

      it("customer_user_role_user is denied customers:EDIT (only READ granted)", async () => {
        mockSession(customerUserRoleUserId);
        await expect(
          requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      it("redirects a PENDING user to /login and deletes their sessions", async () => {
        await db.insert(sessionTable).values({
          id: randomUUID(),
          userId: pendingUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        mockSession(pendingUserId);

        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");

        const remaining = await db
          .select()
          .from(sessionTable)
          .where(eq(sessionTable.userId, pendingUserId));
        expect(remaining).toHaveLength(0);
      });

      it("redirects a DISABLED user to /login", async () => {
        mockSession(disabledUserId);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");
      });

      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");
      });

      it("redirects to /set-password when force_password_change is true", async () => {
        mockSession(forcePasswordChangeUserId);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/set-password",
        );
      });
    });

    describe("requireAuthenticated", () => {
      it("returns context for admin_user", async () => {
        mockSession(adminUserId);
        const result = await requireAuthenticated();
        expect(result.userId).toBe(adminUserId);
      });

      it("returns context for a no-grants ACTIVE user (no permission check)", async () => {
        mockSession(noGrantsUserId);
        const result = await requireAuthenticated();
        expect(result.userId).toBe(noGrantsUserId);
      });

      it("redirects a PENDING user to /login", async () => {
        mockSession(pendingUserId);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /set-password when force_password_change is true", async () => {
        mockSession(forcePasswordChangeUserId);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/set-password",
        );
      });
    });

    describe("resolveForcePasswordChangeSession", () => {
      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /login for a DISABLED user", async () => {
        mockSession(disabledUserId);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to / when force_password_change is false", async () => {
        mockSession(adminUserId);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/",
        );
      });

      it("returns the session context for a PENDING user with the flag set", async () => {
        mockSession(pendingForceChangeUserId);
        const result = await resolveForcePasswordChangeSession();
        expect(result).toEqual({
          userId: pendingForceChangeUserId,
          userName: "Test User",
          status: "PENDING",
        });
      });

      it("returns the session context for an already-ACTIVE user (admin reset)", async () => {
        mockSession(forcePasswordChangeUserId);
        const result = await resolveForcePasswordChangeSession();
        expect(result).toEqual({
          userId: forcePasswordChangeUserId,
          userName: "Test User",
          status: "ACTIVE",
        });
      });
    });

    // cm16-spec §3.2 point 4 / §2.3 — the cross-cutting integration proof
    // that every actions/customer/*.ts mutation, called directly (bypassing
    // any page/nav render), rejects a USER-level caller. Each action already
    // has its own per-action unit-level USER-denial test (cm07–cm15); this
    // exercises the real `requirePermission` against a live DB instead of a
    // mock. Two behaviours coexist in the shipped code and are both
    // acceptable "rejected" outcomes: `createCustomerAction` doesn't catch
    // the guard's redirect (it propagates, same as a page guard —
    // tests/actions/create-customer.action.test.ts's "propagates the
    // guard's redirect" case), while the other nine catch it and return
    // `{ ok: false, code: "FORBIDDEN" }`.
    describe("direct Server Action calls reject a USER (bypassing the nav)", () => {
      const CUSTOMER_ACTION_NAMES = [
        "createCustomerAction",
        "updateOrganizationAction",
        "transitionOrganizationStatusAction",
        "transitionCustomerStatusAction",
        "updatePartyRoleSpecificationAction",
        "addContactAction",
        "updateContactAction",
        "deleteContactAction",
        "setPreferredContactAction",
        "setPreferredContactMethodAction",
      ] as const;

      it.each(CUSTOMER_ACTION_NAMES)(
        "%s rejects a customer_user_role_user (customers:READ only) caller",
        async (name) => {
          mockSession(customerUserRoleUserId);
          const action = customerActions[name]!;

          let result: unknown;
          try {
            result = await action({});
          } catch (err) {
            expect(redirectTarget(err)).toBe("/no-access");
            return;
          }
          expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
        },
      );

      it.each(CUSTOMER_ACTION_NAMES)(
        "%s rejects a no_grants_user caller",
        async (name) => {
          mockSession(noGrantsUserId);
          const action = customerActions[name]!;

          let result: unknown;
          try {
            result = await action({});
          } catch (err) {
            expect(redirectTarget(err)).toBe("/no-access");
            return;
          }
          expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
        },
      );
    });

    // pm24-spec §2.7/§3.8 — the products analogue of the customer block
    // above, but proving the products:EDIT-vs-DELETE split specifically
    // (customers only ever tested EDIT-vs-READ). Every product action
    // catches the guard's redirect and returns { ok: false, code:
    // "FORBIDDEN" } (unlike createCustomerAction's propagating exception),
    // so `isPermissionRejection` only needs to check one shape per branch —
    // both are still handled for robustness against either behavior.
    describe("direct Server Action calls reject an under-permissioned caller (products)", () => {
      const PRODUCTS_EDIT_ACTION_NAMES = [
        "createOfferingAction",
        "updateOfferingAction",
        "createSpecificationAction",
        "updateSpecificationAction",
        "deleteSpecificationAction",
        "insertPriceAction",
        "activateOfferingAction",
      ] as const;

      const ALL_PRODUCT_ACTION_NAMES = [
        ...PRODUCTS_EDIT_ACTION_NAMES,
        "retireOfferingAction",
      ] as const;

      async function isPermissionRejection(
        action: () => Promise<unknown>,
      ): Promise<boolean> {
        let result: unknown;
        try {
          result = await action();
        } catch (err) {
          return redirectTarget(err) === "/no-access";
        }
        return (
          typeof result === "object" &&
          result !== null &&
          (result as { ok?: unknown }).ok === false &&
          (result as { code?: unknown }).code === "FORBIDDEN"
        );
      }

      it.each(PRODUCTS_EDIT_ACTION_NAMES)(
        "%s does not reject products_manager_user (products:EDIT) on permission grounds",
        async (name) => {
          mockSession(productsManagerUserId);
          const rejected = await isPermissionRejection(productActions[name]!);
          expect(rejected).toBe(false);
        },
      );

      it.each(ALL_PRODUCT_ACTION_NAMES)(
        "%s rejects a no_grants_user caller",
        async (name) => {
          mockSession(noGrantsUserId);
          const rejected = await isPermissionRejection(productActions[name]!);
          expect(rejected).toBe(true);
        },
      );

      // The concrete, executable proof that products:EDIT and
      // products:DELETE are two different gates, not one (pm23-spec §2.3;
      // pm99's own words for this unit).
      it("retireOfferingAction rejects a products_manager_user (products:EDIT-only, DELETE required)", async () => {
        mockSession(productsManagerUserId);
        const rejected = await isPermissionRejection(
          productActions.retireOfferingAction!,
        );
        expect(rejected).toBe(true);
      });
    });
  },
);
