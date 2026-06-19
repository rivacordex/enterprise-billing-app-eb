import { describe, expect, it } from "vitest";

import { resolveRootRedirect, type RouteOrderEntry } from "@/lib/root-redirect";
import type { EffectivePermissionMap } from "@/types/permissions";

const ROUTE_ORDER: RouteOrderEntry[] = [
  { name: "users", route: "/administration/users" },
  { name: "roles", route: "/administration/roles" },
  { name: "system_config", route: "/administration/system-config" },
  { name: "audit_log", route: "/administration/audit-log" },
];

const NO_GRANTS: EffectivePermissionMap = {
  users: null,
  roles: null,
  system_config: null,
  audit_log: null,
};

const ADMIN_GRANTS: EffectivePermissionMap = {
  users: "DELETE",
  roles: "DELETE",
  system_config: "DELETE",
  audit_log: "READ",
};

describe("resolveRootRedirect", () => {
  it("redirects to /login when there is no session", async () => {
    const route = await resolveRootRedirect(null, null, ROUTE_ORDER);
    expect(route).toBe("/login");
  });

  it("redirects to /set-password when force_password_change is true", async () => {
    const route = await resolveRootRedirect(
      { forcePasswordChange: true },
      ADMIN_GRANTS,
      ROUTE_ORDER,
    );
    expect(route).toBe("/set-password");
  });

  it("redirects the seeded ADMIN to /administration/users", async () => {
    const route = await resolveRootRedirect(
      { forcePasswordChange: false },
      ADMIN_GRANTS,
      ROUTE_ORDER,
    );
    expect(route).toBe("/administration/users");
  });

  it("redirects a no-grants ACTIVE user to /no-access", async () => {
    const route = await resolveRootRedirect(
      { forcePasswordChange: false },
      NO_GRANTS,
      ROUTE_ORDER,
    );
    expect(route).toBe("/no-access");
  });

  it("redirects to /no-access when permissionMap is null and no force_password_change", async () => {
    const route = await resolveRootRedirect(
      { forcePasswordChange: false },
      null,
      ROUTE_ORDER,
    );
    expect(route).toBe("/no-access");
  });
});
