import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/users/assign-role.action", () => ({
  assignRoleAction: vi.fn(),
}));
vi.mock("@/actions/users/revoke-role.action", () => ({
  revokeRoleAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { assignRoleAction } from "@/actions/users/assign-role.action";
import { revokeRoleAction } from "@/actions/users/revoke-role.action";
import { toast } from "sonner";

import { RoleAssignmentPanel } from "@/components/users/role-assignment-panel";

const mockAssignRoleAction = vi.mocked(assignRoleAction);
const mockRevokeRoleAction = vi.mocked(revokeRoleAction);
const mockToastError = vi.mocked(toast.error);

const CURRENT_ROLES = [
  { roleId: "role-1", roleName: "MANAGER", assignedBy: "admin-1" },
];
const AVAILABLE_ROLES = [{ roleId: "role-2", roleName: "USER" }];

beforeEach(() => {
  mockAssignRoleAction.mockReset();
  mockRevokeRoleAction.mockReset();
  mockToastError.mockReset();
});

describe("RoleAssignmentPanel", () => {
  it("renders the deleted-user message and no controls when userStatus is DELETED", () => {
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="DELETED"
      />,
    );

    expect(
      screen.getByText("Cannot manage roles for a deleted user."),
    ).toBeInTheDocument();
    expect(screen.queryByText("MANAGER")).not.toBeInTheDocument();
    expect(screen.queryByText("Add role")).not.toBeInTheDocument();
  });

  it("renders 'No roles assigned.' when currentRoles is empty", () => {
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={[]}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    expect(screen.getByText("No roles assigned.")).toBeInTheDocument();
    expect(screen.getByText("Add role")).toBeInTheDocument();
  });

  it("renders a role badge and remove button for each current role", () => {
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    expect(screen.getByText("MANAGER")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove MANAGER" }),
    ).toBeInTheDocument();
  });

  it("does not render the add-role section when availableRoles is empty", () => {
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={[]}
        userStatus="ACTIVE"
      />,
    );

    expect(screen.queryByText("Add role")).not.toBeInTheDocument();
  });

  it("calls revokeRoleAction with userId/roleId when remove is clicked", async () => {
    mockRevokeRoleAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove MANAGER" }));

    await waitFor(() => {
      expect(mockRevokeRoleAction).toHaveBeenCalledWith({
        userId: "user-1",
        roleId: "role-1",
      });
    });
  });

  it("shows an inline destructive alert on LAST_ADMIN_ROLE, not a toast", async () => {
    mockRevokeRoleAction.mockResolvedValue({
      ok: false,
      code: "LAST_ADMIN_ROLE",
    });
    const user = userEvent.setup();
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove MANAGER" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot remove the last ADMIN role.",
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows a toast on other revoke errors, not an inline alert", async () => {
    mockRevokeRoleAction.mockResolvedValue({
      ok: false,
      code: "ASSIGNMENT_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove MANAGER" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to remove role. Please try again.",
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the Add button when no role is selected", () => {
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("selects a role and calls assignRoleAction on Add", async () => {
    mockAssignRoleAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "USER" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(mockAssignRoleAction).toHaveBeenCalledWith({
        userId: "user-1",
        roleId: "role-2",
      });
    });
  });

  it("shows a toast on assign error", async () => {
    mockAssignRoleAction.mockResolvedValue({
      ok: false,
      code: "ALREADY_ASSIGNED",
    });
    const user = userEvent.setup();
    render(
      <RoleAssignmentPanel
        userId="user-1"
        currentRoles={CURRENT_ROLES}
        availableRoles={AVAILABLE_ROLES}
        userStatus="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "USER" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to assign role. Please try again.",
      );
    });
  });
});
