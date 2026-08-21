// bm08-spec §Visual/§4. RerunDialog: preview (account count + recompute note),
// a Validation→Verification stage selector, a MANDATORY reason (confirm blocked
// until entered), and a success message on submit. The action module is mocked
// so its db/service graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/rerun-run.action", () => ({
  rerunRunAction: vi.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rerunRunAction } from "@/actions/billing/rerun-run.action";
import { RerunDialog } from "@/components/billing/rerun-dialog";

const mockAction = vi.mocked(rerunRunAction);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RerunDialog (bm08-spec §Visual)", () => {
  it("previews the selected account count and lists only Validation→Verification stages", async () => {
    const user = userEvent.setup();
    render(
      <RerunDialog
        billRunId="BRN00000001"
        accountIds={["BAN00000001", "BAN00000002"]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /rerun these accounts/i }),
    );

    expect(screen.getByText(/2 accounts/i)).toBeTruthy();

    const select = screen.getByLabelText(/start from stage/i);
    expect(
      within(select).getByRole("option", { name: "Validation" }),
    ).toBeTruthy();
    expect(
      within(select).getByRole("option", { name: "Verification" }),
    ).toBeTruthy();
    // The stages downstream of the pipeline (posting/rendering/distribution)
    // and scoping are NOT offered as a rerun origin.
    expect(
      within(select).queryByRole("option", { name: "Posting" }),
    ).toBeNull();
  });

  it("blocks Confirm until a reason is entered (mandatory)", async () => {
    const user = userEvent.setup();
    render(
      <RerunDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(
      screen.getByRole("button", { name: /rerun these accounts/i }),
    );

    const confirm = screen.getByRole("button", { name: /confirm rerun/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText(/reason/i), "profile fixed");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits the run id, accounts, stage, and reason, then shows a success message", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        accountCount: 1,
        fromStage: "validation",
        attempt: 2,
        priorTotals: "107.50",
        executionId: "stub-exec-BRN00000001",
      },
    });
    const user = userEvent.setup();
    render(
      <RerunDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(
      screen.getByRole("button", { name: /rerun these accounts/i }),
    );
    await user.type(screen.getByLabelText(/reason/i), "profile fixed");
    await user.click(screen.getByRole("button", { name: /confirm rerun/i }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith({
        billRunId: "BRN00000001",
        accountIds: ["BAN00000001"],
        fromStage: "validation",
        reason: "profile fixed",
      }),
    );
    expect(screen.getByRole("status").textContent).toMatch(/attempt 2/i);
  });

  it("surfaces a typed failure without navigating away", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "NOT_RERUNNABLE" });
    const user = userEvent.setup();
    render(
      <RerunDialog billRunId="BRN00000001" accountIds={["BAN00000001"]} />,
    );

    await user.click(
      screen.getByRole("button", { name: /rerun these accounts/i }),
    );
    await user.type(screen.getByLabelText(/reason/i), "profile fixed");
    await user.click(screen.getByRole("button", { name: /confirm rerun/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /can no longer be rerun/i,
      ),
    );
  });

  it("renders the run-level 'Rerun' trigger with an all-eligible preview when no accounts are passed", async () => {
    const user = userEvent.setup();
    render(
      <RerunDialog
        billRunId="BRN00000001"
        accountIds={[]}
        triggerLabel="Rerun"
        variant="neutral"
      />,
    );

    await user.click(screen.getByRole("button", { name: /^rerun$/i }));
    expect(screen.getByText(/all eligible accounts/i)).toBeTruthy();
  });
});
