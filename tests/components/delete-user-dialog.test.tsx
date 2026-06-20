import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/users/delete-user.action", () => ({
  deleteUserAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { deleteUserAction } from "@/actions/users/delete-user.action";
import { toast } from "sonner";

import { DeleteUserDialog } from "@/components/users/delete-user-dialog";

const mockDeleteUserAction = vi.mocked(deleteUserAction);
const mockToastError = vi.mocked(toast.error);

const TARGET_USER_ID = "user-1";
const TARGET_USER_NAME = "Ada Lovelace";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof DeleteUserDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  const props = {
    targetUserId: TARGET_USER_ID,
    targetUserName: TARGET_USER_NAME,
    actorId: "actor-1",
    isOpen: true,
    onOpenChange,
    onSuccess,
    ...overrides,
  };
  const utils = render(<DeleteUserDialog {...props} />);
  return { onOpenChange, onSuccess, ...utils };
}

beforeEach(() => {
  mockDeleteUserAction.mockReset();
  mockToastError.mockReset();
});

describe("DeleteUserDialog", () => {
  it("is not visible when isOpen is false", () => {
    renderDialog({ isOpen: false });
    expect(
      screen.queryByText(`Permanently delete ${TARGET_USER_NAME}?`),
    ).not.toBeInTheDocument();
  });

  it("renders the title when isOpen is true", () => {
    renderDialog();
    expect(
      screen.getByText(`Permanently delete ${TARGET_USER_NAME}?`),
    ).toBeInTheDocument();
  });

  it("shows the self-delete warning when actorId === targetUserId", () => {
    renderDialog({ actorId: TARGET_USER_ID });
    expect(
      screen.getByText(/You are deleting your own account\./),
    ).toBeInTheDocument();
  });

  it("hides the self-delete warning when actorId !== targetUserId", () => {
    renderDialog({ actorId: "someone-else" });
    expect(
      screen.queryByText(/You are deleting your own account\./),
    ).not.toBeInTheDocument();
  });

  it("Cancel closes the dialog without calling the action", async () => {
    const { onOpenChange } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDeleteUserAction).not.toHaveBeenCalled();
  });

  it("confirm calls deleteUserAction with the target userId", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: true });
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    expect(mockDeleteUserAction).toHaveBeenCalledWith({
      userId: TARGET_USER_ID,
    });
  });

  it("disables the confirm button and shows a spinner while deleting", async () => {
    let resolve: (v: { ok: true }) => void = () => {};
    mockDeleteUserAction.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderDialog();

    const confirm = screen.getByRole("button", { name: "Delete user" });
    await userEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeDisabled());

    resolve({ ok: true });
  });

  it("on success calls onOpenChange(false) and onSuccess", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: true });
    const { onOpenChange, onSuccess } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on LAST_ADMIN shows the inline ADMIN error and keeps the dialog open", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: false, code: "LAST_ADMIN" });
    const { onOpenChange, onSuccess } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    expect(await screen.findByText(/only remaining ADMIN/)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("on INVALID_STATE shows the 'must be disabled' inline error and stays open", async () => {
    mockDeleteUserAction.mockResolvedValue({
      ok: false,
      code: "INVALID_STATE",
    });
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    expect(
      await screen.findByText(/must be disabled before they can be deleted/),
    ).toBeInTheDocument();
  });

  it("on USER_NOT_FOUND shows the 'not found' inline error and stays open", async () => {
    mockDeleteUserAction.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    expect(await screen.findByText(/User not found/)).toBeInTheDocument();
  });

  it("on SERVER_ERROR shows a toast and closes the dialog", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: false, code: "SERVER_ERROR" });
    const { onOpenChange, onSuccess } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("clears a prior error when the dialog re-opens", async () => {
    mockDeleteUserAction.mockResolvedValue({ ok: false, code: "LAST_ADMIN" });
    const { rerender } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Delete user" }));
    expect(await screen.findByText(/only remaining ADMIN/)).toBeInTheDocument();

    // Close, then re-open: the stale error must be gone.
    rerender(
      <DeleteUserDialog
        targetUserId={TARGET_USER_ID}
        targetUserName={TARGET_USER_NAME}
        actorId="actor-1"
        isOpen={false}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    rerender(
      <DeleteUserDialog
        targetUserId={TARGET_USER_ID}
        targetUserName={TARGET_USER_NAME}
        actorId="actor-1"
        isOpen={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.queryByText(/only remaining ADMIN/)).not.toBeInTheDocument();
  });
});
