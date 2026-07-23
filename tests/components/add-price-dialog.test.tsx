import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/insert-price.action", () => ({
  insertPriceAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { insertPriceAction } from "@/actions/product/insert-price.action";
import { toast } from "sonner";

import { AddPriceDialog } from "@/components/products/manage/add-price-dialog";

const mockInsertPriceAction = vi.mocked(insertPriceAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

// Fixed local "now" so a "tomorrow" start date never trips the 3-day
// backdating field error regardless of the real wall-clock date.
const FIXED_NOW = new Date(2026, 6, 23, 0, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  mockRefresh.mockReset();
  mockInsertPriceAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof AddPriceDialog>> = {},
) {
  const onBranched = vi.fn();
  const utils = render(
    <AddPriceDialog
      trigger={<button>Add price</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      currentStatus="DRAFT"
      onBranched={onBranched}
      {...overrides}
    />,
  );
  return { onBranched, ...utils };
}

// The trigger and the dialog's own submit button share the accessible name
// "Add price" once the dialog is open — the submit button is always the
// last match.
function getSubmitButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Add price" });
  return buttons[buttons.length - 1]!;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add price" }));
}

async function fillMinimalValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Price name"), "Monthly recurring");
  await user.type(screen.getByLabelText("Currency"), "USD");
  await user.type(screen.getByLabelText("Amount"), "50.00");
  fireEvent.change(screen.getByLabelText("Start date"), {
    target: { value: "2026-07-24" },
  });
}

describe("AddPriceDialog", () => {
  it("clicking the trigger opens the dialog titled 'Add price — <Name>' for a DRAFT target", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog({ currentStatus: "DRAFT" });

    await openDialog(user);

    expect(
      screen.getByRole("heading", { name: "Add price — Test Plan" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is active\. Saving will not/)).toBeNull();
  });

  it("titles the dialog 'Add price — creates new draft — <Name>' with the warning banner for an ACTIVE target", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog({ currentStatus: "ACTIVE" });

    await openDialog(user);

    expect(
      screen.getByRole("heading", {
        name: "Add price — creates new draft — Test Plan",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Test Plan is active. Saving will not change it — a new draft version is created instead.",
      ),
    ).toBeInTheDocument();
  });

  it("submits the assembled input, and on a direct (non-branched) success closes, toasts, refreshes, without calling onBranched", async () => {
    mockInsertPriceAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      productOfferingPriceId: "PRDPRC1",
      branched: false,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onBranched } = renderDialog();

    await openDialog(user);
    await fillMinimalValidForm(user);
    await user.click(getSubmitButton());

    await waitFor(() => {
      expect(mockInsertPriceAction).toHaveBeenCalledWith(
        "PRDOFR1",
        expect.objectContaining({ name: "Monthly recurring" }),
      );
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Price added");
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(onBranched).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("on a branched success toasts 'Price added to new draft version' and calls onBranched", async () => {
    mockInsertPriceAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR2",
      productOfferingPriceId: "PRDPRC2",
      branched: true,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onBranched } = renderDialog({ currentStatus: "ACTIVE" });

    await openDialog(user);
    await fillMinimalValidForm(user);
    await user.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Price added to new draft version",
      );
    });
    expect(onBranched).toHaveBeenCalled();
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    [
      "OFFERING_RETIRED",
      "This offering has been retired and prices can no longer be added.",
    ],
    [
      "BACKDATED_START_TOO_FAR",
      "Start date is more than 3 days in the past and can no longer be used.",
    ],
    ["SERVER_ERROR", "Something went wrong. Please try again."],
  ] as const)(
    "on %s the dialog stays open with the matching error toast",
    async (code, message) => {
      mockInsertPriceAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderDialog();

      await openDialog(user);
      await fillMinimalValidForm(user);
      await user.click(getSubmitButton());

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(message);
      });
      expect(screen.getByLabelText("Price name")).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it("on OFFERING_NOT_FOUND the dialog closes and refreshes", async () => {
    mockInsertPriceAction.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    await openDialog(user);
    await fillMinimalValidForm(user);
    await user.click(getSubmitButton());

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
});
