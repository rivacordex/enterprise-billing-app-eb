import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/actions/users/reset-password.action", () => ({
  resetPasswordAction: vi.fn(),
}));
vi.mock("@/actions/users/unlock-account.action", () => ({
  unlockAccountAction: vi.fn(),
}));
vi.mock("@/actions/users/switch-auth-method.action", () => ({
  switchAuthMethodAction: vi.fn(),
}));
vi.mock("@/actions/users/delete-user.action", () => ({
  deleteUserAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { disableUserAction } from "@/actions/users/disable-user.action";
import { enableUserAction } from "@/actions/users/enable-user.action";
import { resetPasswordAction } from "@/actions/users/reset-password.action";
import { switchAuthMethodAction } from "@/actions/users/switch-auth-method.action";
import { deleteUserAction } from "@/actions/users/delete-user.action";
import { unlockAccountAction } from "@/actions/users/unlock-account.action";
import { updateUserDetailsAction } from "@/actions/users/update-user-details.action";
import { toast } from "sonner";

import { UserDetail } from "@/components/users/user-detail";
import type { RoleListItem } from "@/types/rbac";
import type { EffectivePermissionMap } from "@/types/permissions";
import type { UserDetailView } from "@/types/users";

const mockUpdateUserDetailsAction = vi.mocked(updateUserDetailsAction);
const mockDisableUserAction = vi.mocked(disableUserAction);
const mockEnableUserAction = vi.mocked(enableUserAction);
const mockResetPasswordAction = vi.mocked(resetPasswordAction);
const mockUnlockAccountAction = vi.mocked(unlockAccountAction);
const mockSwitchAuthMethodAction = vi.mocked(switchAuthMethodAction);
const mockDeleteUserAction = vi.mocked(deleteUserAction);
const mockToastError = vi.mocked(toast.error);
const mockToastSuccess = vi.mocked(toast.success);

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
  mockResetPasswordAction.mockReset();
  mockUnlockAccountAction.mockReset();
  mockSwitchAuthMethodAction.mockReset();
  mockDeleteUserAction.mockReset();
  mockToastError.mockReset();
  mockToastSuccess.mockReset();
});

describe("UserDetail edit mode", () => {
  it("renders the Edit button when the user has EDIT and a user is selected", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("does not render the Edit button when the user only has READ", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={READ_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Edit button when no user is selected", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={null}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the edit form when Edit is clicked, and back on Cancel", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
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
      screen.getByRole("heading", { name: "Edit User Details" }),
    ).toBeInTheDocument();
  });
});

describe("UserDetail timezone rendering", () => {
  // um29-spec §2.4: the `timezone` prop must thread through formatDatetime for
  // the timestamp fields, not just default to UTC. BASE_USER.createdDatetime
  // is 2026-01-01T00:00:00Z, which renders 08:00 in Asia/Kuala_Lumpur (UTC+8)
  // rather than 00:00 (UTC).
  it("renders timestamp fields in the configured non-UTC timezone", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="Asia/Kuala_Lumpur"
        user={BASE_USER}
        permissionMap={READ_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByText("Created").nextSibling?.textContent).toBe(
      "01 Jan 2026, 08:00",
    );
  });
});

describe("UserDetail manageRoles mode", () => {
  it("renders the Manage roles button when the user has EDIT and a user is selected", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("renders the Disable button for a PENDING user with EDIT", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={READ_MAP}
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

  it("opens the confirmation dialog when Disable is clicked, without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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
        locale="en-GB"
        timezone="UTC"
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

describe("UserDetail reset password", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the Reset Password button for a LOCAL ACTIVE user with EDIT", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reset Password" }),
    ).toBeInTheDocument();
  });

  it("renders the Reset Password button for PENDING and DISABLED LOCAL users", () => {
    const { rerender } = render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, status: "PENDING" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reset Password" }),
    ).toBeInTheDocument();

    rerender(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reset Password" }),
    ).toBeInTheDocument();
  });

  it("does not render the Reset Password button for an SSO user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, authMethod: "SSO" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Reset Password" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Reset Password button for a DELETED user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, status: "DELETED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Reset Password" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Reset Password button when the user only has READ", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={READ_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Reset Password" }),
    ).not.toBeInTheDocument();
  });

  it("opens the confirmation dialog when Reset Password is clicked, without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      screen.getByRole("heading", { name: "Reset Ada Lovelace's password?" }),
    ).toBeInTheDocument();
    expect(mockResetPasswordAction).not.toHaveBeenCalled();
  });

  it("closes the dialog without calling the action when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Reset Ada Lovelace's password?",
        }),
      ).not.toBeInTheDocument();
    });
    expect(mockResetPasswordAction).not.toHaveBeenCalled();
  });

  it("calls resetPasswordAction with the userId when confirmed", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(mockResetPasswordAction).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });
  });

  it("closes the confirmation dialog and opens the reveal modal on success", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      await screen.findByRole("heading", {
        name: "Temporary Password — Ada Lovelace",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("TmpPass123!")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Reset Ada Lovelace's password?",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on USER_NOT_FOUND", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      await screen.findByText(
        "User not found. The record may have been deleted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reset Ada Lovelace's password?" }),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on NOT_LOCAL_USER", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      code: "NOT_LOCAL_USER",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      await screen.findByText(
        "Password reset is only available for LOCAL users.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reset Ada Lovelace's password?" }),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on INVALID_STATE", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      code: "INVALID_STATE",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    expect(
      await screen.findByText(
        "Password reset cannot be applied to this user's current state.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reset Ada Lovelace's password?" }),
    ).toBeInTheDocument();
  });

  it("shows a toast and closes the dialog on FORBIDDEN", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Reset Ada Lovelace's password?",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a toast and closes the dialog on SERVER_ERROR", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
  });

  it("the reveal modal cannot be closed by pressing Escape", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await screen.findByText("TmpPass123!");

    await user.keyboard("{Escape}");

    expect(screen.getByText("TmpPass123!")).toBeInTheDocument();
  });

  it("clicking Copy calls navigator.clipboard.writeText and shows Copied! for 2 seconds", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    // `userEvent.setup()` installs its own clipboard stub on the window
    // (for `user.copy()`/`paste()` support) — defining our mock must happen
    // *after* setup, or the stub overwrites it.
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await screen.findByText("TmpPass123!");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Copy password" }));

    expect(writeTextMock).toHaveBeenCalledWith("TmpPass123!");
    expect(screen.getByText("Copied!")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
  });

  it("clicking Done closes the reveal modal and clears the temp password", async () => {
    mockResetPasswordAction.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await screen.findByText("TmpPass123!");

    await user.click(
      screen.getByRole("button", { name: "Done — I've saved the password" }),
    );

    expect(screen.queryByText("TmpPass123!")).not.toBeInTheDocument();
  });

  it("disables the Reset Password button while mode is edit", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.queryByRole("button", { name: "Reset Password" }),
    ).not.toBeInTheDocument();
  });
});

const LOCKED_USER: UserDetailView = {
  ...BASE_USER,
  isLocked: true,
  lockedUntil: new Date("2026-06-20T10:00:00Z"),
};

describe("UserDetail unlock", () => {
  it("renders the Unlock button for a locked ACTIVE user with EDIT", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("renders the Unlock button for locked PENDING and DISABLED users", () => {
    const { rerender } = render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...LOCKED_USER, status: "PENDING" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();

    rerender(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...LOCKED_USER, status: "DISABLED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("does not render the Unlock button when the user is not locked", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Unlock" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Unlock button for a DELETED user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...LOCKED_USER, status: "DELETED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Unlock" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the Unlock button when the user only has READ", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={READ_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Unlock" }),
    ).not.toBeInTheDocument();
  });

  it("opens the confirmation dialog when Unlock is clicked, without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      screen.getByRole("heading", { name: "Unlock Ada Lovelace?" }),
    ).toBeInTheDocument();
    expect(mockUnlockAccountAction).not.toHaveBeenCalled();
  });

  it("closes the dialog without calling the action when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Unlock Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
    expect(mockUnlockAccountAction).not.toHaveBeenCalled();
  });

  it("calls unlockAccountAction with the userId when confirmed", async () => {
    mockUnlockAccountAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(mockUnlockAccountAction).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });
  });

  it("closes the dialog after a successful unlock", async () => {
    mockUnlockAccountAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Unlock Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the dialog open and shows the inline error on USER_NOT_FOUND", async () => {
    mockUnlockAccountAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      await screen.findByText(
        "User not found. The record may have been deleted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Unlock Ada Lovelace?" }),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on NOT_LOCKED", async () => {
    mockUnlockAccountAction.mockResolvedValue({
      ok: false,
      code: "NOT_LOCKED",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      await screen.findByText(
        "This account is no longer locked. Refresh the page to see the current state.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Unlock Ada Lovelace?" }),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on INVALID_STATE", async () => {
    mockUnlockAccountAction.mockResolvedValue({
      ok: false,
      code: "INVALID_STATE",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      await screen.findByText(
        "Unlock cannot be applied to this user's current state.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Unlock Ada Lovelace?" }),
    ).toBeInTheDocument();
  });

  it("shows a toast and closes the dialog on FORBIDDEN", async () => {
    mockUnlockAccountAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Unlock Ada Lovelace?" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a toast and closes the dialog on SERVER_ERROR", async () => {
    mockUnlockAccountAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
  });

  it("disables the Unlock button while mode is edit", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.queryByRole("button", { name: "Unlock" }),
    ).not.toBeInTheDocument();
  });

  it("disables the Unlock button while mode is manageRoles", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Manage roles" }));

    expect(
      screen.queryByRole("button", { name: "Unlock" }),
    ).not.toBeInTheDocument();
  });

  it("existing field groups render without regression for a locked user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={LOCKED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset Password" }),
    ).toBeInTheDocument();
  });
});

const SSO_USER: UserDetailView = { ...BASE_USER, authMethod: "SSO" };

describe("UserDetail switch auth method", () => {
  it("renders 'Switch to SSO' for a LOCAL user with EDIT and an actorId", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Switch to SSO" }),
    ).toBeInTheDocument();
  });

  it("renders 'Switch to LOCAL' for an SSO user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={SSO_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Switch to LOCAL" }),
    ).toBeInTheDocument();
  });

  it("does not render the switch button when actorId is absent", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Switch to SSO" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the switch button when the user only has READ", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={READ_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Switch to SSO" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the switch button for a DELETED user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, status: "DELETED" }}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Switch to SSO" }),
    ).not.toBeInTheDocument();
  });

  it("opens the confirmation dialog without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    expect(
      screen.getByRole("heading", { name: "Switch to SSO authentication" }),
    ).toBeInTheDocument();
    expect(mockSwitchAuthMethodAction).not.toHaveBeenCalled();
  });

  it("shows the self-switch warning when the actor switches their own account", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="user-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    expect(
      screen.getByText(/You are switching your own account/),
    ).toBeInTheDocument();
  });

  it("does not show the self-switch warning for another user", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    expect(
      screen.queryByText(/You are switching your own account/),
    ).not.toBeInTheDocument();
  });

  it("calls switchAuthMethodAction with the userId and target method when confirmed", async () => {
    mockSwitchAuthMethodAction.mockResolvedValue({
      ok: true,
      newAuthMethod: "SSO",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));
    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    await waitFor(() => {
      expect(mockSwitchAuthMethodAction).toHaveBeenCalledWith({
        userId: "user-1",
        newAuthMethod: "SSO",
      });
    });
  });

  it("closes the dialog and fires a success toast on a LOCAL → SSO switch", async () => {
    mockSwitchAuthMethodAction.mockResolvedValue({
      ok: true,
      newAuthMethod: "SSO",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));
    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Authentication method switched to SSO. Ada Lovelace must sign in via Microsoft.",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Switch to SSO authentication" }),
      ).not.toBeInTheDocument();
    });
  });

  it("reveals the temp password on an SSO → LOCAL switch", async () => {
    mockSwitchAuthMethodAction.mockResolvedValue({
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: "TmpPass123!",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={SSO_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to LOCAL" }));
    await user.click(screen.getByRole("button", { name: "Switch to LOCAL" }));

    expect(
      await screen.findByRole("heading", {
        name: "Temporary Password — Ada Lovelace",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("TmpPass123!")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the inline error on ALREADY_METHOD", async () => {
    mockSwitchAuthMethodAction.mockResolvedValue({
      ok: false,
      code: "ALREADY_METHOD",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));
    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    expect(
      await screen.findByText("User already uses this authentication method."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Switch to SSO authentication" }),
    ).toBeInTheDocument();
  });

  it("shows a toast and closes the dialog on SERVER_ERROR", async () => {
    mockSwitchAuthMethodAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={BASE_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));
    await user.click(screen.getByRole("button", { name: "Switch to SSO" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Something went wrong. Please try again.",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Switch to SSO authentication" }),
      ).not.toBeInTheDocument();
    });
  });
});

const DELETE_MAP: EffectivePermissionMap = {
  users: "DELETE",
  roles: null,
  system_config: null,
  audit_log: null,
};

const DISABLED_USER: UserDetailView = { ...BASE_USER, status: "DISABLED" };

describe("UserDetail tombstone delete", () => {
  it("renders Delete user for a DISABLED user with the DELETE level", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Delete user" }),
    ).toBeInTheDocument();
  });

  it.each(["ACTIVE", "PENDING", "DELETED"] as const)(
    "does not render Delete user for a %s user",
    (status) => {
      render(
        <UserDetail
          locale="en-GB"
          timezone="UTC"
          user={{ ...BASE_USER, status }}
          permissionMap={DELETE_MAP}
          allRoles={[]}
          actorId="admin-1"
        />,
      );
      expect(
        screen.queryByRole("button", { name: "Delete user" }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not render Delete user when only EDIT is held (no DELETE)", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={EDIT_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Delete user" }),
    ).not.toBeInTheDocument();
    // Enable and Edit remain available with EDIT.
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("hides Edit and shows the muted Deleted header for a DELETED user", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={{ ...BASE_USER, status: "DELETED" }}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(screen.getByText("· Deleted")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete user" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Close" })).toBeInTheDocument();
  });

  it("Delete user and Enable coexist for a DISABLED user with DELETE", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete user" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("does not open the dialog on initial render", () => {
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(
      screen.queryByText("Permanently delete Ada Lovelace?"),
    ).not.toBeInTheDocument();
  });

  it("opens DeleteUserDialog when Delete user is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete user" }));
    expect(
      screen.getByText("Permanently delete Ada Lovelace?"),
    ).toBeInTheDocument();
  });

  it("disables Delete user, Enable, and Edit while the dialog is open", async () => {
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete user" }));
    // While the dialog is open Radix marks the panel aria-hidden, so query with
    // `hidden: true` to reach the header buttons. Two "Delete user" buttons now
    // exist (header + dialog confirm); assert the header one (not in the dialog).
    const dialog = screen.getByRole("alertdialog");
    const headerDelete = screen
      .getAllByRole("button", { name: "Delete user", hidden: true })
      .find((b) => !dialog.contains(b));
    expect(headerDelete).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Enable", hidden: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit", hidden: true }),
    ).toBeDisabled();
  });

  it("transitions the header to the Deleted state on a successful delete", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete user" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete user",
      }),
    );
    expect(await screen.findByText("· Deleted")).toBeInTheDocument();
  });

  it("resets the deleted/dialog state when the selected user changes (key remount)", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { rerender } = render(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        key={DISABLED_USER.userId}
        user={DISABLED_USER}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete user" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete user",
      }),
    );
    await screen.findByText("· Deleted");

    const otherUser: UserDetailView = {
      ...BASE_USER,
      userId: "user-2",
      userName: "Grace Hopper",
      status: "DISABLED",
    };
    rerender(
      <UserDetail
        locale="en-GB"
        timezone="UTC"
        key={otherUser.userId}
        user={otherUser}
        permissionMap={DELETE_MAP}
        allRoles={[]}
        actorId="admin-1"
      />,
    );
    expect(screen.queryByText("· Deleted")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete user" }),
    ).toBeInTheDocument();
  });
});
