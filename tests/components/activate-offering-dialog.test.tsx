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
  const onSuperseded = vi.fn();
  const utils = render(
    <ActivateOfferingDialog
      trigger={<button>Activate</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      onSuperseded={onSuperseded}
      {...overrides}
    />,
  );
  return { onSuperseded, ...utils };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Activate" }));
}

function getConfirmButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Activate" });
  return buttons[buttons.length - 1]!;
}

describe("ActivateOfferingDialog", () => {
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

  it("on a direct success (no superseded sibling) closes, toasts, refreshes, and does not call onSuperseded", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: null,
    });
    const user = userEvent.setup();
    const { onSuperseded } = renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Offering activated");
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(onSuperseded).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("on a superseding success toasts the superseded copy and calls onSuperseded", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      supersededOfferingId: "PRDOFR2",
    });
    const user = userEvent.setup();
    const { onSuperseded } = renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Offering activated — previous version retired",
      );
    });
    expect(onSuperseded).toHaveBeenCalled();
  });

  it("on NO_PRICE_ROWS shows the inline alert copy and keeps the dialog open (no toast)", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: false,
      code: "NO_PRICE_ROWS",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(
        screen.getByText(
          "This draft has no prices yet. Add at least one price before activating.",
        ),
      ).toBeInTheDocument();
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("on SPECIFICATIONS_NOT_RESOLVED shows the inline alert copy and keeps the dialog open (no toast)", async () => {
    mockActivateOfferingAction.mockResolvedValue({
      ok: false,
      code: "SPECIFICATIONS_NOT_RESOLVED",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(
        screen.getByText(
          "This draft has an unresolved mandatory specification. Set a value for every mandatory specification before activating.",
        ),
      ).toBeInTheDocument();
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    ["OFFERING_NOT_DRAFT", "Something went wrong. Please try again."],
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
