import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/retire-offering.action", () => ({
  retireOfferingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { retireOfferingAction } from "@/actions/product/retire-offering.action";
import { toast } from "sonner";

import { RetireOfferingDialog } from "@/components/products/manage/retire-offering-dialog";

const mockRetireOfferingAction = vi.mocked(retireOfferingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockRefresh.mockReset();
  mockRetireOfferingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof RetireOfferingDialog>> = {},
) {
  return render(
    <RetireOfferingDialog
      trigger={<button>Open</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      currentStatus="DRAFT"
      {...overrides}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }));
}

describe("RetireOfferingDialog", () => {
  it("renders 'Discard draft' copy for a DRAFT target", async () => {
    const user = userEvent.setup();
    renderDialog({ currentStatus: "DRAFT" });

    await openDialog(user);

    expect(
      screen.getByRole("heading", { name: "Discard draft" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Discarding Test Plan removes this draft — it never went live and this cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard draft" }),
    ).toBeInTheDocument();
  });

  it("renders 'Retire offering' copy for an ACTIVE target", async () => {
    const user = userEvent.setup();
    renderDialog({ currentStatus: "ACTIVE" });

    await openDialog(user);

    expect(
      screen.getByRole("heading", { name: "Retire offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Retiring Test Plan hides it from new billing selection. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retire offering" }),
    ).toBeInTheDocument();
  });

  it("submits with the typed reason", async () => {
    mockRetireOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      eventType: "PRODUCT_OFFERING_DISCARDED",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.type(
      screen.getByLabelText("Reason (optional)"),
      "No longer needed",
    );
    await user.click(screen.getByRole("button", { name: "Discard draft" }));

    await waitFor(() => {
      expect(mockRetireOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "No longer needed",
      });
    });
  });

  it("toasts 'Draft discarded' when eventType is DISCARDED, regardless of the currentStatus prop", async () => {
    mockRetireOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      eventType: "PRODUCT_OFFERING_DISCARDED",
    });
    const user = userEvent.setup();
    renderDialog({ currentStatus: "ACTIVE" });

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Retire offering" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Draft discarded");
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("toasts 'Offering retired' when eventType is RETIRED", async () => {
    mockRetireOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      eventType: "PRODUCT_OFFERING_RETIRED",
    });
    const user = userEvent.setup();
    renderDialog({ currentStatus: "ACTIVE" });

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Retire offering" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Offering retired");
    });
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    ["VALIDATION_ERROR", "Something went wrong. Please try again."],
    ["SERVER_ERROR", "Something went wrong. Please try again."],
  ] as const)(
    "on %s the dialog stays open with the matching toast",
    async (code, message) => {
      mockRetireOfferingAction.mockResolvedValue(
        code === "VALIDATION_ERROR"
          ? { ok: false, code, fieldErrors: {} }
          : { ok: false, code },
      );
      const user = userEvent.setup();
      renderDialog();

      await openDialog(user);
      await user.click(screen.getByRole("button", { name: "Discard draft" }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["OFFERING_RETIRED", "This offering has already been retired."],
    ["OFFERING_NOT_FOUND", "This offering no longer exists. Refreshing..."],
  ] as const)(
    "on %s the dialog closes and refreshes",
    async (code, message) => {
      mockRetireOfferingAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup();
      renderDialog();

      await openDialog(user);
      await user.click(screen.getByRole("button", { name: "Discard draft" }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(mockRefresh).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
    },
  );

  it("Cancel and confirm are both disabled while a submission is in flight", async () => {
    let resolveAction: (value: {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }) => void = () => {};
    mockRetireOfferingAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Discard draft" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Discard draft" }),
    ).toBeDisabled();

    resolveAction({
      ok: true,
      offeringId: "PRDOFR1",
      eventType: "PRODUCT_OFFERING_DISCARDED",
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });
});
