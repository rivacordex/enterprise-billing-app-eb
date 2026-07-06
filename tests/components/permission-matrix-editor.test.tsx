import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/roles/set-permission-level.action", () => ({
  setPermissionMappingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { setPermissionMappingAction } from "@/actions/roles/set-permission-level.action";
import { toast } from "sonner";

import { PermissionMatrixEditor } from "@/components/roles/permission-matrix-editor";
import type { RoleWithMappings } from "@/types/roles";

const mockSetPermissionMappingAction = vi.mocked(setPermissionMappingAction);
const mockToastError = vi.mocked(toast.error);

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
  ],
};

const MANAGER_ROLE: RoleWithMappings = {
  roleId: "role-manager",
  roleName: "MANAGER",
  roleDescr: null,
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-02T00:00:00Z"),
  mappings: [
    { permissionName: "users", assignedLevel: null },
    { permissionName: "roles", assignedLevel: null },
    { permissionName: "system_config", assignedLevel: null },
    { permissionName: "audit_log", assignedLevel: null },
    { permissionName: "products", assignedLevel: null },
  ],
};

function rowGroup(label: string): HTMLElement {
  return screen.getByRole("group", { name: `Permission level for ${label}` });
}

beforeEach(() => {
  mockSetPermissionMappingAction.mockReset();
  mockToastError.mockReset();
});

describe("PermissionMatrixEditor", () => {
  it("renders 5 rows in PERMISSION_NAMES order", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    const rowLabels = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent);
    expect(rowLabels).toEqual([
      "Users",
      "Roles",
      "System Config",
      "Audit Log",
      "Products",
    ]);
  });

  it("ADMIN users row: DELETE is pressed, others are not", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    const group = rowGroup("Users");
    expect(
      within(group).getByRole("button", { name: "DELETE" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "READ" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(group).getByRole("button", { name: "EDIT" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(group).getByRole("button", { name: "—" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("ADMIN audit_log row: READ pressed; EDIT/DELETE disabled; — not disabled", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    const group = rowGroup("Audit Log");
    expect(within(group).getByRole("button", { name: "READ" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "EDIT" })).toBeDisabled();
    expect(
      within(group).getByRole("button", { name: "DELETE" }),
    ).toBeDisabled();
    expect(within(group).getByRole("button", { name: "—" })).not.toBeDisabled();
  });

  it("MANAGER role: all rows show '—' pressed", () => {
    render(<PermissionMatrixEditor role={MANAGER_ROLE} />);
    for (const label of [
      "Users",
      "Roles",
      "System Config",
      "Audit Log",
      "Products",
    ]) {
      const group = rowGroup(label);
      expect(within(group).getByRole("button", { name: "—" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
  });

  it("audit_log EDIT/DELETE carry the read-only title", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    const group = rowGroup("Audit Log");
    expect(within(group).getByRole("button", { name: "EDIT" })).toHaveAttribute(
      "title",
      "Audit log permissions are read-only",
    );
    expect(
      within(group).getByRole("button", { name: "DELETE" }),
    ).toHaveAttribute("title", "Audit log permissions are read-only");
  });

  it("users row: no button is disabled", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    const group = rowGroup("Users");
    for (const button of within(group).getAllByRole("button")) {
      expect(button).not.toBeDisabled();
    }
  });

  it("clicking READ on users (currently DELETE) calls setPermissionMappingAction", async () => {
    mockSetPermissionMappingAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Users")).getByRole("button", { name: "READ" }),
    );

    await waitFor(() => {
      expect(mockSetPermissionMappingAction).toHaveBeenCalledWith({
        roleId: "role-admin",
        permissionName: "users",
        level: "READ",
      });
    });
  });

  it("clicking the currently-selected level does not call the action", async () => {
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Users")).getByRole("button", { name: "DELETE" }),
    );

    expect(mockSetPermissionMappingAction).not.toHaveBeenCalled();
  });

  it("clicking EDIT on audit_log does not call the action (disabled)", async () => {
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Audit Log")).getByRole("button", { name: "EDIT" }),
    );

    expect(mockSetPermissionMappingAction).not.toHaveBeenCalled();
  });

  it("disables only the saving row's buttons; other rows stay enabled", async () => {
    let resolveAction!: (value: { ok: true }) => void;
    mockSetPermissionMappingAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Users")).getByRole("button", { name: "READ" }),
    );

    for (const button of within(rowGroup("Users")).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    for (const button of within(rowGroup("Roles")).getAllByRole("button")) {
      expect(button).not.toBeDisabled();
    }

    resolveAction({ ok: true });
    await waitFor(() => {
      for (const button of within(rowGroup("Users")).getAllByRole("button")) {
        expect(button).not.toBeDisabled();
      }
    });
  });

  it("shows no toast on success", async () => {
    mockSetPermissionMappingAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Users")).getByRole("button", { name: "READ" }),
    );

    await waitFor(() => {
      expect(mockSetPermissionMappingAction).toHaveBeenCalled();
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows a toast and re-enables buttons on failure", async () => {
    mockSetPermissionMappingAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);

    await user.click(
      within(rowGroup("Users")).getByRole("button", { name: "READ" }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to update permission. Please try again.",
      );
    });
    for (const button of within(rowGroup("Users")).getAllByRole("button")) {
      expect(button).not.toBeDisabled();
    }
  });

  it("renders role='group' with an aria-label per row", () => {
    render(<PermissionMatrixEditor role={ADMIN_ROLE} />);
    expect(rowGroup("Users")).toHaveAttribute("role", "group");
    expect(
      screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")),
    ).toEqual([
      "Permission level for Users",
      "Permission level for Roles",
      "Permission level for System Config",
      "Permission level for Audit Log",
      "Permission level for Products",
    ]);
  });
});
