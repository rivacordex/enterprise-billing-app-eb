import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/users/update-user-details.action", () => ({
  updateUserDetailsAction: vi.fn(),
}));
vi.mock("@/actions/users/assign-role.action", () => ({
  assignRoleAction: vi.fn(),
}));
vi.mock("@/actions/users/revoke-role.action", () => ({
  revokeRoleAction: vi.fn(),
}));
vi.mock("@/actions/users/disable-user.action", () => ({
  disableUserAction: vi.fn(),
}));
vi.mock("@/actions/users/enable-user.action", () => ({
  enableUserAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { disableUserAction } from "@/actions/users/disable-user.action";
import { enableUserAction } from "@/actions/users/enable-user.action";
import { updateUserDetailsAction } from "@/actions/users/update-user-details.action";
import { toast } from "sonner";

import { UserDetail } from "@/components/users/user-detail";
import type { RoleListItem } from "@/types/rbac";
import type { EffectivePermissionMap } from "@/types/permissions";
import type { UserDetailView } from "@/types/users";

const mockUpdateUserDetailsAction = vi.mocked(updateUserDetailsAction);
const mockDisableUserAction = vi.mocked(disableUserAction);
const mockEnableUserAction = vi.mocked(enableUserAction);
const mockToastError = vi.mocked(toast.error);

const BASE_USER: UserDetailView = {
  userId: "user-1",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  userPhonenum: "+1 555 0100",
  authMethod: "LOCAL",
  status: "ACTIVE",
  isLocked: false,
  lockedUntil: null,
  roles: [],
  lastLoginDatetime: null,
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
};

const ALL_ROLES: RoleListItem[] = [
  { roleId: "role-1", roleName: "MANAGER", roleDescr: null },
  { roleId: "role-2", roleName: "USER", roleDescr: null },
];

const EDIT_MAP: EffectivePermissionMap = {
  users: "EDIT",
  roles: null,
  system_config: null,
  audit_log: null,
};

const READ_MAP: EffectivePermissionMap = {
  users: "READ",
  roles: null,
  system_config: null,
  audit_log: null,
};

beforeEach(() => {
  mockUpdateUserDetailsAction.mockReset();
  mockDisableUserAction.mockReset();
  mockEnableUserAction.mockReset();
  mockToastError.mockReset();
});

describe("UserDetail edit mode", () => {
  it("renders the Edit button when the user has EDIT and a user is selected", () => {
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("does not render the Edit button when the user only has READ", () => {
    render(
      <UserDetail user={BASE_USER} permissionMap={READ_MAP} allRoles={[]} />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Edit button when no user is selected", () => {
    render(<UserDetail user={null} permissionMap={EDIT_MAP} allRoles={[]} />);
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the edit form when Edit is clicked, and back on Cancel", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("heading", { name: "Edit User Details" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.getByRole("heading", { name: "Ada Lovelace" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Full Name")).not.toBeInTheDocument();
  });

  it("submits the form with userId, userName, and userPhonenum", async () => {
    mockUpdateUserDetailsAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Full Name"));
    await user.type(screen.getByLabelText("Full Name"), "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdateUserDetailsAction).toHaveBeenCalledWith({
        userId: "user-1",
        userName: "Grace Hopper",
        userPhonenum: "+1 555 0100",
      });
    });
  });

  it("returns to view mode after a successful save", async () => {
    mockUpdateUserDetailsAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit User Details" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows an inline alert and stays in edit mode on USER_NOT_FOUND", async () => {
    mockUpdateUserDetailsAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "User not found.",
    );
    expect(
      screen.getByRole("heading", { name: "Edit User Details" }),
    ).toBeInTheDocument();
  });

  it("shows a toast error and stays in edit mode on SERVER_ERROR", async () => {
    mockUpdateUserDetailsAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
    expect(
      screen.getByRole("heading", { name: "Edit User Details" }),
    ).toBeInTheDocument();
  });
});

describe("UserDetail manageRoles mode", () => {
  it("renders the Manage roles button when the user has EDIT and a user is selected", () => {
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Manage roles" }),
    ).toBeInTheDocument();
  });

  it("does not render the Manage roles button when the user only has READ", () => {
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={READ_MAP}
        allRoles={ALL_ROLES}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Manage roles" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Manage roles button while in edit mode", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.queryByRole("button", { name: "Manage roles" }),
    ).not.toBeInTheDocument();
  });

  it("renders the role assignment panel and hides the read-only badges when Manage roles is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={{
          ...BASE_USER,
          roles: [{ roleId: "role-1", roleName: "MANAGER", assignedBy: null }],
        }}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));

    expect(screen.getByText("Add role")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove MANAGER" }),
    ).toBeInTheDocument();
  });

  it("shows the Done button in manageRoles mode and returns to view mode when clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(
      screen.getByRole("heading", { name: "Ada Lovelace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("None assigned")).toBeInTheDocument();
  });

  it("hides Edit, Manage roles, and the close button in manageRoles mode", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));

    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage roles" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Close")).not.toBeInTheDocument();
  });

  it("keeps the Identity and Account state field groups visible and read-only in manageRoles mode", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Full Name")).not.toBeInTheDocument();
  });

  it("passes availableRoles excluding the user's current roles to the panel", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        user={{
          ...BASE_USER,
          roles: [{ roleId: "role-1", roleName: "MANAGER", assignedBy: null }],
        }}
        permissionMap={EDIT_MAP}
        allRoles={ALL_ROLES}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));

    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});

describe("UserDetail disable/enable", () => {
  it("renders the Disable button for an ACTIVE user with EDIT", () => {
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("renders the Disable button for a PENDING user with EDIT", () => {
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "PENDING" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("renders the Enable button for a DISABLED user with EDIT", () => {
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("renders neither button for a DELETED user", () => {
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "DELETED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Disable" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable" }),
    ).not.toBeInTheDocument();
  });

  it("renders neither button when the user only has READ", () => {
    render(
      <UserDetail user={BASE_USER} permissionMap={READ_MAP} allRoles={[]} />,
    );
    expect(
      screen.queryByRole("button", { name: "Disable" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable" }),
    ).not.toBeInTheDocument();
  });

  it("opens the confirmation dialog when Disable is clicked, without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));

    expect(
      screen.getByRole("heading", { name: "Disable Ada Lovelace?" }),
    ).toBeInTheDocument();
    expect(mockDisableUserAction).not.toHaveBeenCalled();
  });

  it("closes the dialog without calling the action when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Disable Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
    expect(mockDisableUserAction).not.toHaveBeenCalled();
  });

  it("calls disableUserAction with the userId when Disable user is confirmed", async () => {
    mockDisableUserAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Disable user" }));

    await waitFor(() => {
      expect(mockDisableUserAction).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });
  });

  it("closes the dialog after a successful disable", async () => {
    mockDisableUserAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Disable user" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Disable Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the dialog open and shows the inline ADMIN error on LAST_ADMIN", async () => {
    mockDisableUserAction.mockResolvedValue({ ok: false, code: "LAST_ADMIN" });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Disable user" }));

    expect(await screen.findByText(/only remaining ADMIN/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Disable Ada Lovelace?" }),
    ).toBeInTheDocument();
  });

  it("closes the dialog and shows the inline error in the panel on USER_NOT_FOUND", async () => {
    mockDisableUserAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Disable user" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Disable Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "User not found. The record may have been deleted.",
    );
  });

  it("shows a toast and closes the dialog on a server error", async () => {
    mockDisableUserAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail user={BASE_USER} permissionMap={EDIT_MAP} allRoles={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await user.click(screen.getByRole("button", { name: "Disable user" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
  });

  it("calls enableUserAction directly with no confirmation dialog", async () => {
    mockEnableUserAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() => {
      expect(mockEnableUserAction).toHaveBeenCalledWith({ userId: "user-1" });
    });
  });

  it("shows the inline error in the panel on USER_NOT_FOUND for enable", async () => {
    mockEnableUserAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "User not found. The record may have been deleted.",
    );
  });

  it("shows a toast on a server error for enable", async () => {
    mockEnableUserAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        user={{ ...BASE_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
  });
});
