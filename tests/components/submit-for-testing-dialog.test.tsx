import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/submit-for-testing.action", () => ({
  submitForTestingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { submitForTestingAction } from "@/actions/product/submit-for-testing.action";
import { toast } from "sonner";

import { SubmitForTestingDialog } from "@/components/products/manage/submit-for-testing-dialog";

const mockSubmitForTestingAction = vi.mocked(submitForTestingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockRefresh.mockReset();
  mockSubmitForTestingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderDialog() {
  return render(
    <SubmitForTestingDialog
      trigger={<button>Submit for testing</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      offeringVersion={1}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Submit for testing" }));
}

function getConfirmButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Submit for testing" });
  return buttons[buttons.length - 1]!;
}

describe("SubmitForTestingDialog", () => {
  it("shows the plain read-only-while-testing copy", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);

    expect(
      screen.getByText(/becomes read-only while in testing/, { exact: false }),
    ).toBeInTheDocument();
  });

  it("submits with an empty reason and refreshes on success", async () => {
    mockSubmitForTestingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockSubmitForTestingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Submitted for testing");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it.each(["NO_PRICE_ROWS", "SPECIFICATIONS_NOT_RESOLVED"] as const)(
    "on %s closes and refreshes (precondition failures never appear as dialog copy)",
    async (code) => {
      mockSubmitForTestingAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup();
      renderDialog();

      await openDialog(user);
      await user.click(getConfirmButton());

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
      });
      // The requirement is not restated as dialog copy — it lives at the panel.
      expect(screen.queryByText(/no prices/i)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    },
  );

  it("on FORBIDDEN keeps the dialog open with a permission toast", async () => {
    mockSubmitForTestingAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(getConfirmButton());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "You don't have permission to do that.",
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
