// bm12-spec §Visual/§5. CancelRunDialog: a spelled-out confirm (irreversible,
// resets accounts, consumes no invoice numbers), confirm in the danger role,
// and a success message on submit. The action module is mocked so its
// db/service graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/cancel-run.action", () => ({
  cancelRunAction: vi.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelRunAction } from "@/actions/billing/cancel-run.action";
import { CancelRunDialog } from "@/components/billing/cancel-run-dialog";

const mockAction = vi.mocked(cancelRunAction);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CancelRunDialog (bm12-spec §Visual)", () => {
  it("shows the spelled-out confirm panel before submitting anything", async () => {
    const user = userEvent.setup();
    render(<CancelRunDialog billRunId="BRN00000001" />);

    await user.click(screen.getByRole("button", { name: /cancel run/i }));

    expect(mockAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/no invoice numbers are consumed/i)).toBeTruthy();
  });

  it("submits and shows a success message on confirm", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: { billRunId: "BRN00000001", accountsReset: 3 },
    });
    const user = userEvent.setup();
    render(<CancelRunDialog billRunId="BRN00000001" />);

    await user.click(screen.getByRole("button", { name: /cancel run/i }));
    await user.click(screen.getByRole("button", { name: /confirm cancel/i }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith({ billRunId: "BRN00000001" }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /3 accounts reset to pending/i,
    );
  });

  it("surfaces a typed failure without navigating away", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "NOT_CANCELLABLE" });
    const user = userEvent.setup();
    render(<CancelRunDialog billRunId="BRN00000001" />);

    await user.click(screen.getByRole("button", { name: /cancel run/i }));
    await user.click(screen.getByRole("button", { name: /confirm cancel/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /can no longer be cancelled/i,
      ),
    );
  });

  it("dismisses the confirm panel on Keep running without submitting", async () => {
    const user = userEvent.setup();
    render(<CancelRunDialog billRunId="BRN00000001" />);

    await user.click(screen.getByRole("button", { name: /cancel run/i }));
    await user.click(screen.getByRole("button", { name: /keep running/i }));

    expect(mockAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
