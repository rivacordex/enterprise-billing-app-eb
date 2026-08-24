// bm10-spec §Visual/§Implementation §3. `ApproveAndPostPanel` — names the
// final trigger actor, pre-empts self-approval (Approve disabled + a reason),
// frames irreversibility in an explicit confirm before the danger-role
// submit, and shows the skipped count. The action module is mocked so its
// db/service graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/approve-run.action", () => ({
  approveRunAction: vi.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { approveRunAction } from "@/actions/billing/approve-run.action";
import { ApproveAndPostPanel } from "@/components/billing/approve-and-post-panel";
import type { ApprovePreview } from "@/types/billing";

const mockAction = vi.mocked(approveRunAction);

const ALL_PASS: ApprovePreview["checks"] = [
  { check: "period_open", pass: true, remediation: null },
  { check: "gl_mappings", pass: true, remediation: null },
  { check: "positive_totals", pass: true, remediation: null },
  { check: "four_eyes", pass: true, remediation: null },
  { check: "accounts_terminal", pass: true, remediation: null },
];

function preview(overrides: Partial<ApprovePreview> = {}): ApprovePreview {
  return {
    billRunId: "BRN00000001",
    cycleName: "Enterprise Monthly",
    status: "PROCESSED",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    triggeredByName: "alice",
    triggeredAt: new Date("2026-08-01T10:00:00Z"),
    postableCount: 2,
    skippedCount: 0,
    currency: "MYR",
    totalAmount: "315.00",
    checks: ALL_PASS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApproveAndPostPanel (bm10-spec §Visual)", () => {
  it("names the final trigger actor", () => {
    render(
      <ApproveAndPostPanel
        preview={preview()}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );
    expect(screen.getByText(/alice/)).toBeTruthy();
    expect(screen.getByText(/01 Aug 2026, 10:00/)).toBeTruthy();
  });

  it("[CRITICAL] disables Approve with a reason when the checks fail four-eyes (self-approval)", () => {
    render(
      <ApproveAndPostPanel
        preview={preview({
          checks: [
            ...ALL_PASS.slice(0, 3),
            {
              check: "four_eyes",
              pass: false,
              remediation:
                "You triggered the final attempt on this run and cannot also approve it.",
            },
            ALL_PASS[4]!,
          ],
        })}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );

    const approveButton = screen.getByRole("button", {
      name: /approve & post/i,
    });
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    // Shown twice by design — once in the checklist's remediation line, once
    // as the reason directly under the disabled button.
    expect(screen.getAllByText(/cannot also approve it/i).length).toBe(2);
  });

  it("disables Approve and shows a message when the run isn't PROCESSED", () => {
    render(
      <ApproveAndPostPanel
        preview={preview({ status: "APPROVED" })}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );

    expect(screen.getByText(/cannot be approved right now/i)).toBeTruthy();
    const approveButton = screen.getByRole("button", {
      name: /approve & post/i,
    });
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("frames irreversibility with the postable count and total, and the skipped count", async () => {
    const user = userEvent.setup();
    render(
      <ApproveAndPostPanel
        preview={preview({ skippedCount: 3 })}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );

    await user.click(screen.getByRole("button", { name: /approve & post/i }));

    expect(screen.getByText(/2 invoices/i)).toBeTruthy();
    expect(screen.getByText(/MYR 315\.00/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    expect(
      screen.getByText(/3 accounts will be recorded skipped/i),
    ).toBeTruthy();
  });

  it("submits on confirm and shows a success message with the skipped count", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        totalAmount: "315.00",
        skippedCount: 1,
      },
    });
    const user = userEvent.setup();
    render(
      <ApproveAndPostPanel
        preview={preview()}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );

    await user.click(screen.getByRole("button", { name: /approve & post/i }));
    await user.click(
      screen.getByRole("button", { name: /confirm approve & post/i }),
    );

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith({ billRunId: "BRN00000001" }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /1 account skipped/i,
    );
  });

  it("surfaces a typed failure without navigating away", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "FOUR_EYES_VIOLATION" });
    const user = userEvent.setup();
    render(
      <ApproveAndPostPanel
        preview={preview()}
        triggeredAtDisplay="01 Aug 2026, 10:00"
        totalAmountDisplay="MYR 315.00"
      />,
    );

    await user.click(screen.getByRole("button", { name: /approve & post/i }));
    await user.click(
      screen.getByRole("button", { name: /confirm approve & post/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /cannot also approve it/i,
      ),
    );
  });
});
