// bm17-spec §Design "Confirmation modals" / §Implementation §5. RejectDialog:
// scope preview ("whole run" vs. an explicit account count), a MANDATORY
// reason (confirm blocked until entered), a spelled-out consequence, and a
// success message on submit. The action module is mocked so its db/service
// graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/reject-run.action", () => ({
  rejectRunAction: vi.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rejectRunAction } from "@/actions/billing/reject-run.action";
import { RejectDialog } from "@/components/billing/reject-dialog";

const mockAction = vi.mocked(rejectRunAction);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RejectDialog (bm17-spec §Design/§Implementation §5)", () => {
  it("previews the explicit selected account count", async () => {
    const user = userEvent.setup();
    render(
      <RejectDialog
        billRunId="BRN00000001"
        accountIds={["BAN00000001", "BAN00000002"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(screen.getByText(/2 accounts/i)).toBeTruthy();
  });

  it("previews 'the whole run' when no accounts are passed", async () => {
    const user = userEvent.setup();
    render(<RejectDialog billRunId="BRN00000001" accountIds={[]} />);

    await user.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(screen.getByText(/the whole run/i)).toBeTruthy();
  });

  it("blocks Confirm Reject until a reason is entered (mandatory)", async () => {
    const user = userEvent.setup();
    render(
      <RejectDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(screen.getByRole("button", { name: /^reject$/i }));

    const confirm = screen.getByRole("button", { name: /confirm reject/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText(/reason/i), "bad rate card");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits scope 'selected' with the account ids and reason, then shows a success message", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: { billRunId: "BRN00000001", accountCount: 1, priorTotals: "107.50" },
    });
    const user = userEvent.setup();
    render(
      <RejectDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    await user.type(screen.getByLabelText(/reason/i), "bad rate card");
    await user.click(screen.getByRole("button", { name: /confirm reject/i }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith({
        billRunId: "BRN00000001",
        scope: "selected",
        banIds: ["BAN00000001"],
        reason: "bad rate card",
      }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /sent back to reprocess/i,
    );
  });

  it("submits scope 'all' when no accounts are passed", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: { billRunId: "BRN00000001", accountCount: 3, priorTotals: "315.00" },
    });
    const user = userEvent.setup();
    render(<RejectDialog billRunId="BRN00000001" accountIds={[]} />);

    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    await user.type(screen.getByLabelText(/reason/i), "bad rate card");
    await user.click(screen.getByRole("button", { name: /confirm reject/i }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "all", banIds: [] }),
      ),
    );
  });

  it("surfaces a typed failure without navigating away", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "NOT_REJECTABLE" });
    const user = userEvent.setup();
    render(
      <RejectDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    await user.type(screen.getByLabelText(/reason/i), "bad rate card");
    await user.click(screen.getByRole("button", { name: /confirm reject/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /can no longer be rejected/i,
      ),
    );
  });
});
