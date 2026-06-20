import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/roles/delete-role.action", () => ({
  deleteRoleAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { deleteRoleAction } from "@/actions/roles/delete-role.action";
import { toast } from "sonner";

import { DeleteRoleDialog } from "@/components/roles/delete-role-dialog";

const mockDeleteRoleAction = vi.mocked(deleteRoleAction);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockDeleteRoleAction.mockReset();
  mockToastError.mockReset();
});

describe("DeleteRoleDialog", () => {
  it("renders the title and role name in the description when open", () => {
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Delete role" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={false}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Delete role" }),
    ).not.toBeInTheDocument();
  });

  it("Cancel calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking 'Delete role' calls deleteRoleAction with the roleId", async () => {
    mockDeleteRoleAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    await waitFor(() => {
      expect(mockDeleteRoleAction).toHaveBeenCalledWith({ roleId: "role-1" });
    });
  });

  it("ROLE_IN_USE (assignedCount: 2) shows a pluralized inline error and stays open", async () => {
    mockDeleteRoleAction.mockResolvedValue({
      ok: false,
      code: "ROLE_IN_USE",
      assignedCount: 2,
    });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    expect(
      await screen.findByText(
        "This role is assigned to 2 users. Revoke all role assignments before deleting.",
      ),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("ROLE_IN_USE (assignedCount: 1) uses singular 'user'", async () => {
    mockDeleteRoleAction.mockResolvedValue({
      ok: false,
      code: "ROLE_IN_USE",
      assignedCount: 1,
    });
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    expect(
      await screen.findByText(
        "This role is assigned to 1 user. Revoke all role assignments before deleting.",
      ),
    ).toBeInTheDocument();
  });

  it("ROLE_NOT_FOUND shows an inline error and stays open", async () => {
    mockDeleteRoleAction.mockResolvedValue({
      ok: false,
      code: "ROLE_NOT_FOUND",
    });
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    expect(
      await screen.findByText(
        "Role not found. It may have been deleted by another admin.",
      ),
    ).toBeInTheDocument();
  });

  it("SERVER_ERROR shows a generic inline error and stays open", async () => {
    mockDeleteRoleAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    expect(
      await screen.findByText("Something went wrong. Please try again."),
    ).toBeInTheDocument();
  });

  it("on success calls onOpenChange(false), then onSuccess", async () => {
    mockDeleteRoleAction.mockResolvedValue({ ok: true });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    const callOrder: string[] = [];
    onOpenChange.mockImplementation(() => callOrder.push("onOpenChange"));
    onSuccess.mockImplementation(() => callOrder.push("onSuccess"));
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(callOrder).toEqual(["onOpenChange", "onSuccess"]);
  });

  it("disables 'Delete role' and 'Cancel' while pending", async () => {
    let resolveAction!: (value: { ok: true }) => void;
    mockDeleteRoleAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete role" }));

    expect(screen.getByRole("button", { name: /Delete role/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveAction({ ok: true });
    await waitFor(() => {
      expect(mockDeleteRoleAction).toHaveBeenCalled();
    });
  });

  it("clears a prior error when isOpen transitions false -> true", () => {
    const { rerender } = render(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    rerender(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={false}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    rerender(
      <DeleteRoleDialog
        roleId="role-1"
        roleName="Finance"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("Something went wrong. Please try again."),
    ).not.toBeInTheDocument();
  });
});
