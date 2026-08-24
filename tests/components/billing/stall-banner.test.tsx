// bm12-spec §Visual/§5. StallBanner: the Warning-family derived-state banner
// with "Check status" (primary) and, via CancelRunDialog, "Cancel run"
// (secondary). Both action modules are mocked so their db/service graphs
// never load.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/check-status.action", () => ({
  checkStatusAction: vi.fn(),
}));
vi.mock("@/actions/billing/cancel-run.action", () => ({
  cancelRunAction: vi.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkStatusAction } from "@/actions/billing/check-status.action";
import { StallBanner } from "@/components/billing/stall-banner";

const mockAction = vi.mocked(checkStatusAction);

const LAST_PROGRESS_AT = new Date("2026-08-24T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StallBanner (bm12-spec §Visual)", () => {
  it("shows the no-heartbeat warning plus Check status and Cancel run affordances", () => {
    render(
      <StallBanner
        billRunId="BRN00000001"
        lastProgressAt={LAST_PROGRESS_AT}
        locale="en-MY"
        timezone="UTC"
      />,
    );

    expect(screen.getByText(/this run may be stalled/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /check status/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel run/i })).toBeTruthy();
  });

  it("checks status and reports the reconciled state on success", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING",
        engineState: "RUNNING",
        mismatch: false,
      },
    });
    const user = userEvent.setup();
    render(
      <StallBanner
        billRunId="BRN00000001"
        lastProgressAt={LAST_PROGRESS_AT}
        locale="en-MY"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("button", { name: /check status/i }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith({ billRunId: "BRN00000001" }),
    );
    expect(await screen.findByText(/engine reports running/i)).toBeTruthy();
  });

  it("surfaces a typed Check status failure", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "ENGINE_UNREACHABLE" });
    const user = userEvent.setup();
    render(
      <StallBanner
        billRunId="BRN00000001"
        lastProgressAt={LAST_PROGRESS_AT}
        locale="en-MY"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("button", { name: /check status/i }));

    expect(await screen.findByText(/could not be reached/i)).toBeTruthy();
  });

  it("surfaces a mismatch distinctly from a clean reconcile", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING",
        engineState: "SUCCESS",
        mismatch: true,
      },
    });
    const user = userEvent.setup();
    render(
      <StallBanner
        billRunId="BRN00000001"
        lastProgressAt={LAST_PROGRESS_AT}
        locale="en-MY"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("button", { name: /check status/i }));

    expect(
      await screen.findByText(/not every account has reached a terminal/i),
    ).toBeTruthy();
  });

  it("opens the Cancel run confirm dialog inline", async () => {
    const user = userEvent.setup();
    render(
      <StallBanner
        billRunId="BRN00000001"
        lastProgressAt={LAST_PROGRESS_AT}
        locale="en-MY"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("button", { name: /cancel run/i }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});
