import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/actions/roles/create-role.action", () => ({
  createRoleAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createRoleAction } from "@/actions/roles/create-role.action";
import { toast } from "sonner";

import { CreateRoleDialog } from "@/components/roles/create-role-dialog";
import { Button } from "@/components/ui/button";

const mockCreateRoleAction = vi.mocked(createRoleAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

function renderDialog() {
  return render(<CreateRoleDialog trigger={<Button>Add Role</Button>} />);
}

beforeEach(() => {
  mockPush.mockReset();
  mockCreateRoleAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

describe("CreateRoleDialog", () => {
  it("is not visible when closed", () => {
    renderDialog();
    expect(screen.queryByText("Add Role")).toBeInTheDocument(); // trigger only
    expect(screen.queryByLabelText("Role Name")).not.toBeInTheDocument();
  });

  it("clicking the trigger opens the dialog", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));

    expect(
      screen.getByRole("heading", { name: "Add Role" }),
    ).toBeInTheDocument();
  });

  it("submit with valid values calls createRoleAction", async () => {
    mockCreateRoleAction.mockResolvedValue({ ok: true, roleId: "role-1" });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "Finance");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    await waitFor(() => {
      expect(mockCreateRoleAction).toHaveBeenCalledWith({
        roleName: "Finance",
        roleDescr: null,
      });
    });
  });

  it("disables and shows a spinner on the Create Role button while submitting", async () => {
    let resolveAction!: (value: { ok: true; roleId: string }) => void;
    mockCreateRoleAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "Finance");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    expect(screen.getByRole("button", { name: /Create Role/ })).toBeDisabled();

    resolveAction({ ok: true, roleId: "role-1" });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it("on ok:true closes the dialog, navigates to the new role, and toasts success", async () => {
    mockCreateRoleAction.mockResolvedValue({ ok: true, roleId: "role-9" });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "Finance");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/administration/roles?roleId=role-9",
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Role created");
    await waitFor(() => {
      expect(screen.queryByLabelText("Role Name")).not.toBeInTheDocument();
    });
  });

  it("on NAME_CONFLICT keeps the dialog open and shows the field error", async () => {
    mockCreateRoleAction.mockResolvedValue({
      ok: false,
      code: "NAME_CONFLICT",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "ADMIN");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    expect(
      await screen.findByText("A role with this name already exists."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Role Name")).toBeInTheDocument();
  });

  it("on SERVER_ERROR closes the dialog and shows a toast", async () => {
    mockCreateRoleAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "Finance");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByLabelText("Role Name")).not.toBeInTheDocument();
    });
  });

  it("Cancel closes the dialog without calling the action", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockCreateRoleAction).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByLabelText("Role Name")).not.toBeInTheDocument();
    });
  });

  it("clears a NAME_CONFLICT error on the next submit attempt", async () => {
    mockCreateRoleAction.mockResolvedValueOnce({
      ok: false,
      code: "NAME_CONFLICT",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add Role" }));
    await user.type(screen.getByLabelText("Role Name"), "ADMIN");
    await user.click(screen.getByRole("button", { name: "Create Role" }));
    await screen.findByText("A role with this name already exists.");

    mockCreateRoleAction.mockResolvedValueOnce({ ok: true, roleId: "role-2" });
    await user.type(screen.getByLabelText("Role Name"), " Renamed");
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    await waitFor(() => {
      expect(
        screen.queryByText("A role with this name already exists."),
      ).not.toBeInTheDocument();
    });
  });
});
