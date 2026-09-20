import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/obsolete-offering.action", () => ({
  obsoleteOfferingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { obsoleteOfferingAction } from "@/actions/product/obsolete-offering.action";
import { toast } from "sonner";

import { ObsoleteOfferingDialog } from "@/components/products/manage/obsolete-offering-dialog";

const mockObsoleteOfferingAction = vi.mocked(obsoleteOfferingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockRefresh.mockReset();
  mockObsoleteOfferingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderDialog() {
  return render(
    <ObsoleteOfferingDialog
      trigger={<button>Open</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }));
}

function getConfirmButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Stop selling" });
  return buttons[buttons.length - 1]!;
}

describe("ObsoleteOfferingDialog", () => {
  it("shows the stop-selling copy stating existing subscriptions keep billing", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);

    expect(
      screen.getByRole("heading", { name: "Stop selling" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/keep billing from this version unchanged/, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("submits with the typed reason and toasts on success", async () => {
    mockObsoleteOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.type(screen.getByLabelText("Reason (optional)"), "EOL");
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockObsoleteOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "EOL",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Stopped selling");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    ["SERVER_ERROR", "Something went wrong. Please try again."],
  ] as const)(
    "on %s the dialog stays open with the matching toast",
    async (code, message) => {
      mockObsoleteOfferingAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup();
      renderDialog();

      await openDialog(user);
      await user.click(getConfirmButton());

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it("on OFFERING_NOT_ACTIVE the dialog closes and refreshes", async () => {
    mockObsoleteOfferingAction.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_ACTIVE",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "This version is no longer active. Refreshing...",
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });
});
