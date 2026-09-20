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
      offeringVersion={2}
      liveCount={0}
      {...overrides}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }));
}

describe("RetireOfferingDialog", () => {
  it("at zero live subscriptions shows the final-retire copy and a confirm button", async () => {
    const user = userEvent.setup();
    renderDialog({ liveCount: 0 });

    await openDialog(user);

    expect(
      screen.getByRole("heading", { name: "Retire version" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Retiring is final/, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retire version" }),
    ).toBeInTheDocument();
  });

  it("when live subscriptions block, shows the count message and no confirm button", async () => {
    const user = userEvent.setup();
    renderDialog({ liveCount: 4 });

    await openDialog(user);

    expect(
      screen.getByText(
        "4 subscriptions still bill from this version. It can be retired once they end.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retire version" }),
    ).not.toBeInTheDocument();
    // No reason field in the blocked state.
    expect(
      screen.queryByLabelText("Reason (optional)"),
    ).not.toBeInTheDocument();
  });

  it("submits with the typed reason and toasts on success", async () => {
    mockRetireOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
    });
    const user = userEvent.setup();
    renderDialog({ liveCount: 0 });

    await openDialog(user);
    await user.type(
      screen.getByLabelText("Reason (optional)"),
      "No longer needed",
    );
    await user.click(screen.getByRole("button", { name: "Retire version" }));

    await waitFor(() => {
      expect(mockRetireOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "No longer needed",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Version retired");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("on a server-reported block switches to the count message in place (no toast, no close)", async () => {
    mockRetireOfferingAction.mockResolvedValue({
      ok: false,
      code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
      liveCount: 2,
    });
    const user = userEvent.setup();
    renderDialog({ liveCount: 0 });

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Retire version" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "2 subscriptions still bill from this version. It can be retired once they end.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Retire version" }),
    ).not.toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
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
      renderDialog({ liveCount: 0 });

      await openDialog(user);
      await user.click(screen.getByRole("button", { name: "Retire version" }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "OFFERING_NOT_OBSOLETE",
      "This version can no longer be retired. Refreshing...",
    ],
    ["OFFERING_NOT_FOUND", "This offering no longer exists. Refreshing..."],
  ] as const)(
    "on %s the dialog closes and refreshes",
    async (code, message) => {
      mockRetireOfferingAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup();
      renderDialog({ liveCount: 0 });

      await openDialog(user);
      await user.click(screen.getByRole("button", { name: "Retire version" }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(mockRefresh).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
    },
  );
});
