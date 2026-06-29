import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
// `RoleTable` now renders `CreateRoleDialog`, whose import chain (the
// `create-role.action` -> `auth/guard` -> `auth` -> `lib/config`) would
// otherwise trigger eager env validation just from importing this
// component, mirroring tests/app/users-page.test.tsx's `db/client` mock.
vi.mock("@/actions/roles/create-role.action", () => ({
  createRoleAction: vi.fn(),
}));

import { RoleTable } from "@/components/roles/role-table";
import type { EffectivePermissionMap } from "@/types/permissions";
import type { RoleWithMappings } from "@/types/roles";

function emptyMap(): EffectivePermissionMap {
  return { users: null, roles: null, system_config: null, audit_log: null };
}

const ADMIN_ROLE: RoleWithMappings = {
  roleId: "role-admin",
  roleName: "ADMIN",
  roleDescr: "Full access",
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: "DELETE" },
    { permissionName: "roles", assignedLevel: "DELETE" },
    { permissionName: "system_config", assignedLevel: "DELETE" },
    { permissionName: "audit_log", assignedLevel: "READ" },
  ],
};

const MANAGER_ROLE: RoleWithMappings = {
  roleId: "role-manager",
  roleName: "MANAGER",
  roleDescr: null,
  createdDatetime: new Date("2026-01-02T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-02T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: null },
    { permissionName: "roles", assignedLevel: null },
    { permissionName: "system_config", assignedLevel: null },
    { permissionName: "audit_log", assignedLevel: null },
  ],
};

const USER_ROLE: RoleWithMappings = {
  ...MANAGER_ROLE,
  roleId: "role-user",
  roleName: "USER",
};

beforeEach(() => {
  mockPush.mockReset();
});

describe("RoleTable", () => {
  it("renders 3 rows when given 3 roles", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE, MANAGER_ROLE, USER_ROLE]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("ADMIN row shows 4 permission chips", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    const cell = screen.getByText("ADMIN").closest("tr") as HTMLElement;
    expect(within(cell).getByText("Users")).toBeInTheDocument();
    expect(within(cell).getByText("Roles")).toBeInTheDocument();
    expect(within(cell).getByText("System Config")).toBeInTheDocument();
    expect(within(cell).getByText("Audit Log")).toBeInTheDocument();
  });

  it("MANAGER row shows 'No permissions'", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[MANAGER_ROLE]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("No permissions")).toBeInTheDocument();
  });

  it("clicking a row calls router.push with ?roleId=<role_id>", async () => {
    const user = userEvent.setup();
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    await user.click(screen.getByText("ADMIN"));
    expect(mockPush).toHaveBeenCalledWith(
      "/administration/roles?roleId=role-admin",
    );
  });

  it("applies the selected-row class to the matching role", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE, MANAGER_ROLE]}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("ADMIN").closest("tr")).toHaveClass(
      "bg-[color:var(--surface-selected)]",
    );
  });

  it("does not render the Add Role trigger for a no-grants permission map", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.queryByText("Add Role")).not.toBeInTheDocument();
  });

  it("renders an enabled Add Role trigger when the permission map grants roles:EDIT", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[ADMIN_ROLE]}
        selectedRoleId={null}
        permissionMap={{ ...emptyMap(), roles: "DELETE" }}
      />,
    );
    expect(screen.getByText("Add Role")).not.toBeDisabled();
  });

  it("renders 'No roles found.' when roles is empty", () => {
    render(
      <RoleTable
        locale="en-GB"
        roles={[]}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("No roles found.")).toBeInTheDocument();
  });
});
