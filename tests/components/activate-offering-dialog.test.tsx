import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/activate-offering.action", () => ({
  activateOfferingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { activateOfferingAction } from "@/actions/product/activate-offering.action";
import { toast } from "sonner";

import { ActivateOfferingDialog } from "@/components/products/manage/activate-offering-dialog";

const mockActivateOfferingAction = vi.mocked(activateOfferingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockRefresh.mockReset();
  mockActivateOfferingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ActivateOfferingDialog>> = {},
) {
  return render(
    <ActivateOfferingDialog
      trigger={<button>Activate</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      offeringVersion={2}
      {...overrides}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Activate" }));
}

function getConfirmButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Activate" });
  return buttons[buttons.length - 1]!;
}

describe("ActivateOfferingDialog", () => {
  it("shows the revised copy naming the version and the supersession", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);

    expect(
      screen.getByText(/becomes orderable/, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/becomes obsolete/, { exact: false }),
    ).toBeInTheDocument();
  });

  it("submits with an empty reason by default", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: null,
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockActivateOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "",
      });
    });
  });

  it("passes typed reason text through to the action call", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: null,
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.type(screen.getByLabelText("Reason (optional)"), "Q3 refresh");
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockActivateOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "Q3 refresh",
      });
    });
  });

  it("on a direct success (no superseded sibling) closes, toasts, and refreshes", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: null,
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Offering activated");
    });
    expect(mockRefresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("on a superseding success toasts the obsolete copy", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: "PRDOFR2",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Offering activated — previous version marked obsolete",
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    ["VALIDATION_ERROR", "Something went wrong. Please try again."],
    ["SERVER_ERROR", "Something went wrong. Please try again."],
  ] as const)(
    "on %s the dialog stays open with the matching toast",
    async (code, message) => {
      mockActivateOfferingAction.mockResolvedValue(
        code === "VALIDATION_ERROR"
          ? { ok: false, code, fieldErrors: {} }
          : { ok: false, code },
      );
      const user = userEvent.setup();
      renderDialog();

      await openDialog(user);
      await user.click(getConfirmButton());

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it("on OFFERING_NOT_TESTING the dialog closes and refreshes", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_TESTING",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "This version is no longer in testing. Refreshing...",
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("on OFFERING_NOT_FOUND the dialog closes and refreshes", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "This offering no longer exists. Refreshing...",
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("cannot be dismissed via Cancel while a submission is in flight", async () => {
    let resolveAction: (value: {
      ok: true;
      offeringId: string;
      supersededOfferingId: string | null;
    }) => void = () => {};
    mockActivateOfferingAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    resolveAction({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: null,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
