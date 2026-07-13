import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/actions/roles/update-role.action", () => ({
  updateRoleAction: vi.fn(),
}));

vi.mock("@/actions/roles/delete-role.action", () => ({
  deleteRoleAction: vi.fn(),
}));

// `RoleDetail` renders `PermissionMatrixEditor` when the actor has
// `roles:EDIT`, whose import chain (`set-permission-level.action` ->
// `auth/guard` -> `auth` -> `lib/config`) would otherwise trigger eager env
// validation just from importing this component, mirroring
// tests/components/role-table.test.tsx's `create-role.action` mock.
vi.mock("@/actions/roles/set-permission-level.action", () => ({
  setPermissionMappingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { updateRoleAction } from "@/actions/roles/update-role.action";
import { setPermissionMappingAction } from "@/actions/roles/set-permission-level.action";
import { toast } from "sonner";

import { RoleDetail } from "@/components/roles/role-detail";
import type { EffectivePermissionMap } from "@/types/permissions";
import type { RoleWithMappings } from "@/types/roles";

const mockUpdateRoleAction = vi.mocked(updateRoleAction);
const mockSetPermissionMappingAction = vi.mocked(setPermissionMappingAction);
const mockToastError = vi.mocked(toast.error);

function emptyMap(): EffectivePermissionMap {
  return {
    users: null,
    roles: null,
    system_config: null,
    audit_log: null,
    products: null,
    customers: null,
  };
}

function editMap(): EffectivePermissionMap {
  return { ...emptyMap(), roles: "EDIT" };
}

function deleteMap(): EffectivePermissionMap {
  return { ...emptyMap(), roles: "DELETE" };
}

const ADMIN_ROLE: RoleWithMappings = {
  roleId: "role-admin",
  roleName: "ADMIN",
  roleDescr: null,
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-02T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: "DELETE" },
    { permissionName: "roles", assignedLevel: "DELETE" },
    { permissionName: "system_config", assignedLevel: "DELETE" },
    { permissionName: "audit_log", assignedLevel: "READ" },
    { permissionName: "products", assignedLevel: "DELETE" },
    { permissionName: "customers", assignedLevel: null },
  ],
};

const CUSTOM_ROLE: RoleWithMappings = {
  roleId: "role-finance",
  roleName: "Finance",
  roleDescr: "Finance team",
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-02T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: null },
    { permissionName: "roles", assignedLevel: null },
    { permissionName: "system_config", assignedLevel: null },
    { permissionName: "audit_log", assignedLevel: null },
    { permissionName: "products", assignedLevel: null },
    { permissionName: "customers", assignedLevel: null },
  ],
};

const MANAGER_ROLE: RoleWithMappings = {
  roleId: "role-manager",
  roleName: "MANAGER",
  roleDescr: "Manages billing",
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-02T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: null },
    { permissionName: "roles", assignedLevel: null },
    { permissionName: "system_config", assignedLevel: null },
    { permissionName: "audit_log", assignedLevel: null },
    { permissionName: "products", assignedLevel: null },
    { permissionName: "customers", assignedLevel: null },
  ],
};

beforeEach(() => {
  mockPush.mockReset();
  mockUpdateRoleAction.mockReset();
  mockSetPermissionMappingAction.mockReset();
  mockToastError.mockReset();
});

describe("RoleDetail", () => {
  it("renders the empty-state placeholder when role is null and selectedRoleId is null", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={null}
        selectedRoleId={null}
        permissionMap={emptyMap()}
      />,
    );
    expect(
      screen.getByText("Select a role to view details."),
    ).toBeInTheDocument();
  });

  it("renders 'Role not found.' when role is null and selectedRoleId is non-null", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={null}
        selectedRoleId="role-missing"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("Role not found.")).toBeInTheDocument();
  });

  it("'Back to roles' link points to /administration/roles", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={null}
        selectedRoleId="role-missing"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("Back to roles")).toHaveAttribute(
      "href",
      "/administration/roles",
    );
  });

  it("renders the role name as an h3 heading when role is provided", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "ADMIN", level: 3 }),
    ).toBeInTheDocument();
  });

  it("renders all 6 permission rows in PERMISSION_NAMES order", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    const rowLabels = screen
      .getAllByRole("row")
      .slice(1) // drop the matrix's own header row
      .map((row) => row.querySelector("td")?.textContent);
    expect(rowLabels).toEqual([
      "Users",
      "Roles",
      "System Config",
      "Audit Log",
      "Products",
      "Customers",
    ]);
  });

  it("ADMIN: shows DELETE for users/roles/system_config/products and READ for audit_log", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getAllByText("DELETE")).toHaveLength(4);
    expect(screen.getByText("READ")).toBeInTheDocument();
  });

  it("MANAGER: all 6 matrix rows show '—'", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getAllByText("—")).toHaveLength(6);
  });

  it("renders '—' for description when roleDescr is null", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("Description").nextSibling?.textContent).toBe("—");
  });

  // um29-spec §2.4: the `timezone` prop must thread through to the timestamp
  // fields, not just default to UTC. ADMIN_ROLE.createdDatetime is
  // 2026-01-01T00:00:00Z, which renders 08:00 in Asia/Kuala_Lumpur (UTC+8).
  it("renders timestamps in the configured non-UTC timezone", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="Asia/Kuala_Lumpur"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(screen.getByText("Created").nextSibling?.textContent).toBe(
      "01 Jan 2026, 08:00",
    );
  });

  it("close button navigates to /administration/roles", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(mockPush).toHaveBeenCalledWith("/administration/roles");
  });

  it("does not render the Edit button for a no-grants permission map", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Edit button when the permission map grants roles:EDIT", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});

describe("RoleDetail edit mode", () => {
  it("clicking Edit shows RoleForm pre-populated, changes the header, and hides the close button", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("heading", { name: "Edit Role", level: 3 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Role Name")).toHaveValue("MANAGER");
    expect(screen.getByLabelText(/Description/)).toHaveValue("Manages billing");
  });

  it("keeps the Permissions section (now PermissionMatrixEditor) visible in edit mode", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Permission level for Users" }),
    ).toBeInTheDocument();
  });

  it("Cancel returns to view mode and restores the close button", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.getByRole("heading", { name: "MANAGER", level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("submitting calls updateRoleAction with the roleId and form values", async () => {
    mockUpdateRoleAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Role Name"));
    await user.type(screen.getByLabelText("Role Name"), "Manager Renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdateRoleAction).toHaveBeenCalledWith({
        roleId: "role-manager",
        roleName: "Manager Renamed",
        roleDescr: "Manages billing",
      });
    });
  });

  it("returns to view mode on a successful save", async () => {
    mockUpdateRoleAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "MANAGER", level: 3 }),
      ).toBeInTheDocument();
    });
  });

  it("shows a field error on NAME_CONFLICT and stays in edit mode", async () => {
    mockUpdateRoleAction.mockResolvedValue({
      ok: false,
      code: "NAME_CONFLICT",
    });
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("A role with this name already exists."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Edit Role", level: 3 }),
    ).toBeInTheDocument();
  });

  it("shows an inline destructive alert and stays in edit mode on ROLE_NOT_FOUND", async () => {
    mockUpdateRoleAction.mockResolvedValue({
      ok: false,
      code: "ROLE_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "Role not found. It may have been deleted by another admin.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Edit Role", level: 3 }),
    ).toBeInTheDocument();
  });

  it("shows a toast error and stays in edit mode on SERVER_ERROR", async () => {
    mockUpdateRoleAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
    expect(
      screen.getByRole("heading", { name: "Edit Role", level: 3 }),
    ).toBeInTheDocument();
  });

  it("disables Save changes and shows a spinner while saving", async () => {
    let resolveAction!: (value: { ok: true }) => void;
    mockUpdateRoleAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();

    resolveAction({ ok: true });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "MANAGER", level: 3 }),
      ).toBeInTheDocument();
    });
  });

  it("resets edit mode and error states when the selected role changes (key remount)", async () => {
    mockUpdateRoleAction.mockResolvedValue({
      ok: false,
      code: "NAME_CONFLICT",
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        key={MANAGER_ROLE.roleId}
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={editMap()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("A role with this name already exists.");

    rerender(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        key={ADMIN_ROLE.roleId}
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "ADMIN", level: 3 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("A role with this name already exists."),
    ).not.toBeInTheDocument();
  });
});

describe("RoleDetail permissions section (um20)", () => {
  it("renders PermissionMatrixEditor (not the read-only matrix) when roles:EDIT is granted", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Permission level for Users" }),
    ).toBeInTheDocument();
    // The read-only matrix's "Assigned Level" column header is absent.
    expect(screen.queryByText("Assigned Level")).not.toBeInTheDocument();
  });

  it("renders the read-only matrix (not PermissionMatrixEditor) when roles:EDIT is not granted", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={emptyMap()}
      />,
    );

    expect(screen.getByText("Assigned Level")).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Permission level for Users" }),
    ).not.toBeInTheDocument();
  });

  it("PermissionMatrixEditor is visible in both view mode and edit mode", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Permission level for Users" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("group", { name: "Permission level for Users" }),
    ).toBeInTheDocument();
  });

  it("never mounts both the read-only matrix and PermissionMatrixEditor at once", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={editMap()}
      />,
    );

    const hasEditor = screen.queryByRole("group", {
      name: "Permission level for Users",
    });
    const hasReadOnly = screen.queryByText("Assigned Level");
    expect(Boolean(hasEditor) && Boolean(hasReadOnly)).toBe(false);
    expect(hasEditor).toBeInTheDocument();
  });
});

describe("RoleDetail delete button (um21)", () => {
  it("renders Delete in the header when roles:DELETE is granted and the role is non-seeded", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={CUSTOM_ROLE}
        selectedRoleId="role-finance"
        permissionMap={deleteMap()}
      />,
    );
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
  });

  it("does not render Delete when the actor lacks roles:DELETE", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={CUSTOM_ROLE}
        selectedRoleId="role-finance"
        permissionMap={editMap()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Delete/ }),
    ).not.toBeInTheDocument();
  });

  it("Delete is disabled with a title for the seeded ADMIN role", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={ADMIN_ROLE}
        selectedRoleId="role-admin"
        permissionMap={deleteMap()}
      />,
    );
    const button = screen.getByRole("button", { name: /Delete/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Seeded roles (ADMIN, MANAGER, USER) cannot be deleted",
    );
  });

  it("Delete is disabled with a title for the seeded MANAGER/USER roles", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={MANAGER_ROLE}
        selectedRoleId="role-manager"
        permissionMap={deleteMap()}
      />,
    );
    const button = screen.getByRole("button", { name: /Delete/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Seeded roles (ADMIN, MANAGER, USER) cannot be deleted",
    );
  });

  it("Delete is enabled (no title) for a non-seeded role", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={CUSTOM_ROLE}
        selectedRoleId="role-finance"
        permissionMap={deleteMap()}
      />,
    );
    const button = screen.getByRole("button", { name: /Delete/ });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("title");
  });

  it("clicking the enabled Delete button opens DeleteRoleDialog", async () => {
    const user = userEvent.setup();
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={CUSTOM_ROLE}
        selectedRoleId="role-finance"
        permissionMap={deleteMap()}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Delete role" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Delete/ }));

    expect(
      screen.getByRole("heading", { name: "Delete role" }),
    ).toBeInTheDocument();
  });

  it("DeleteRoleDialog is not mounted (no dialog content) before Delete is clicked", () => {
    render(
      <RoleDetail
        locale="en-GB"
        timezone="UTC"
        role={CUSTOM_ROLE}
        selectedRoleId="role-finance"
        permissionMap={deleteMap()}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Delete role" }),
    ).not.toBeInTheDocument();
  });
});
