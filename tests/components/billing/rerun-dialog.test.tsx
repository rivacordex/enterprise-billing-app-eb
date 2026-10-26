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
// bm84 — the template-type warning read, called when the confirm opens.
vi.mock("@/actions/billing/list-rerun-template-changes.action", () => ({
  listRerunTemplateChangesAction: vi.fn(),
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listRerunTemplateChangesAction } from "@/actions/billing/list-rerun-template-changes.action";
import { rerunRunAction } from "@/actions/billing/rerun-run.action";
import { RerunDialog } from "@/components/billing/rerun-dialog";

const mockAction = vi.mocked(rerunRunAction);
const mockChanges = vi.mocked(listRerunTemplateChangesAction);

beforeEach(() => {
  vi.clearAllMocks();
  mockChanges.mockResolvedValue({ ok: true, changes: [] });
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

describe("RerunDialog — template-type warning (bm84)", () => {
  const HEADING = "Invoice template type changed since run start";

  function change(n: number) {
    return {
      billingAccountId: `BAN${String(n).padStart(8, "0")}`,
      fromTypeName: "Wholesale",
      toTypeName: "Standard",
    };
  }

  async function open(accountIds: string[] = ["BAN00000001"]) {
    const user = userEvent.setup();
    render(<RerunDialog billRunId="BRN00000001" accountIds={accountIds} />);
    await user.click(
      screen.getByRole("button", { name: /rerun these accounts/i }),
    );
    return user;
  }

  it("reads the changes once when the confirm opens, with the dialog's scope", async () => {
    const user = await open(["BAN00000001", "BAN00000002"]);
    await user.type(screen.getByLabelText(/reason/i), "re-check");
    expect(mockChanges).toHaveBeenCalledTimes(1);
    expect(mockChanges).toHaveBeenCalledWith({
      billRunId: "BRN00000001",
      accountIds: ["BAN00000001", "BAN00000002"],
    });
  });

  it("lists each changed BAN (mono id, from → to) in a Warning callout, and Confirm stays enabled", async () => {
    mockChanges.mockResolvedValue({ ok: true, changes: [change(1)] });
    const user = await open();
    const note = await screen.findByRole("note", { name: HEADING });
    expect(note).toHaveTextContent(HEADING);
    const item = within(note).getByRole("listitem");
    expect(item).toHaveTextContent("BAN00000001: Wholesale → Standard");
    expect(within(item).getByText("BAN00000001").className).toContain(
      "font-mono",
    );
    expect(note).toHaveTextContent(
      "The rerun uses each account's current type.",
    );
    expect(note.className).toContain("--color-warning-50");
    await user.type(screen.getByLabelText(/reason/i), "re-check");
    expect(
      (
        screen.getByRole("button", {
          name: /confirm rerun/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("shows the first 10 and 'and {n} more' above 10", async () => {
    mockChanges.mockResolvedValue({
      ok: true,
      changes: Array.from({ length: 13 }, (_, i) => change(i + 1)),
    });
    await open([]);
    const note = await screen.findByRole("note", { name: HEADING });
    expect(within(note).getAllByRole("listitem")).toHaveLength(10);
    expect(note).toHaveTextContent("and 3 more");
  });

  it.each([
    ["no change", { ok: true as const, changes: [] }],
    ["a failed read", { ok: false as const, code: "SERVER_ERROR" as const }],
  ])("shows no callout on %s", async (_label, result) => {
    mockChanges.mockResolvedValue(result);
    await open();
    await waitFor(() => expect(mockChanges).toHaveBeenCalled());
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("a rejected read shows nothing and never blocks the rerun", async () => {
    mockChanges.mockRejectedValue(new Error("network"));
    const user = await open();
    await user.type(screen.getByLabelText(/reason/i), "re-check");
    expect(screen.queryByRole("note")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: /confirm rerun/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
