// ac22-spec §3.5 — component tests for the document-bound ReversalDialog:
// already-reversed lines render disabled and are never submitted; submit is
// disabled with nothing checked; the stated call (and the sent payload) flips
// between reverseDocument and reverseLine as boxes toggle; legs render for
// checked lines only.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock the "use server" action module so its db/service graph never loads.
vi.mock("@/actions/accounts/reverse-document", () => ({
  getReversalPreviewAction: vi.fn(),
  reverseDocumentAction: vi.fn(),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReversalPreviewAction,
  reverseDocumentAction,
} from "@/actions/accounts/reverse-document";
import { ReversalDialog } from "@/components/accounts/reversal-dialog";

const FA_ID = "FIN000001";

function makePreview() {
  return {
    ok: true as const,
    value: {
      documentId: "PAY00000001",
      docType: "PAY",
      reasonCode: "CUST_PAYMENT",
      totalAmount: "1000.00",
      currency: "MYR",
      state: "posted",
      lastModified: "2026-03-15T01:00:00.000Z",
      lines: [
        {
          documentLineId: "DLN1",
          lineNo: 1,
          lineKind: "capture",
          amount: "400.00",
          reversalFromAccountId: "a1",
          reversalFromAccountName: "line1.from",
          reversalToAccountId: "a2",
          reversalToAccountName: "line1.to",
          isAllocation: false,
          alreadyReversed: false,
        },
        {
          documentLineId: "DLN2",
          lineNo: 2,
          lineKind: "allocation",
          amount: "600.00",
          reversalFromAccountId: "b1",
          reversalFromAccountName: "line2.from",
          reversalToAccountId: "b2",
          reversalToAccountName: "line2.to",
          isAllocation: true,
          alreadyReversed: false,
        },
        {
          documentLineId: "DLN3",
          lineNo: 3,
          lineKind: "allocation",
          amount: "300.00",
          reversalFromAccountId: "c1",
          reversalFromAccountName: "line3.from",
          reversalToAccountId: "c2",
          reversalToAccountName: "line3.to",
          isAllocation: true,
          alreadyReversed: true,
        },
      ],
    },
  };
}

function renderDialog() {
  return render(
    <ReversalDialog
      documentId="PAY00000001"
      financialAccountId={FA_ID}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

function fillRequiredFields(): void {
  // Two text inputs: Reversal Comment (placeholder) + Reference Info.
  const commentInput = screen.getByPlaceholderText(/reason for reversal/i);
  fireEvent.change(commentInput, { target: { value: "Correcting error" } });
  const textboxes = screen.getAllByRole("textbox");
  // Reference Info is the second textbox (comment is the first).
  fireEvent.change(textboxes[1]!, { target: { value: "REF-001" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReversalPreviewAction).mockResolvedValue(makePreview());
  vi.mocked(reverseDocumentAction).mockResolvedValue({
    ok: true,
    value: { documentId: "PAY00000002", state: "posted" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

describe("ReversalDialog — line rendering", () => {
  it("renders already-reversed lines disabled and marked", async () => {
    renderDialog();
    const reversedBox = await screen.findByRole("checkbox", {
      name: /reverse line 3 allocation/i,
    });
    expect(reversedBox).toBeDisabled();
    expect(screen.getByText(/already reversed/i)).toBeInTheDocument();
  });

  it("shows opposite legs for checked lines only (§2.5)", async () => {
    renderDialog();
    // DLN1 and DLN2 checked by default → their legs show.
    expect(await screen.findByText("line1.from")).toBeInTheDocument();
    expect(screen.getByText("line2.from")).toBeInTheDocument();
    // DLN3 is already reversed and never checked → its legs never render.
    expect(screen.queryByText("line3.from")).not.toBeInTheDocument();

    // Unchecking DLN1 hides its legs.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /reverse line 1 capture/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText("line1.from")).not.toBeInTheDocument(),
    );
  });
});

describe("ReversalDialog — submit gating and routing", () => {
  it("disables submit when nothing is checked (§2.4)", async () => {
    renderDialog();
    await screen.findByRole("checkbox", { name: /reverse line 1 capture/i });
    fillRequiredFields();
    // Uncheck both unreversed lines.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /reverse line 1 capture/i }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /reverse line 2 allocation/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/select at least one line to reverse/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /reverse/i })).toBeDisabled();
  });

  it("all lines checked → omits selectedLineIds (reverseDocument path)", async () => {
    renderDialog();
    await screen.findByText(
      /reverses the entire document — it will be marked reversed/i,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /reverse document/i }));
    await waitFor(() => expect(reverseDocumentAction).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(reverseDocumentAction).mock.calls[0]![0] as {
      selectedLineIds?: string[];
      originalDocumentId: string;
      lastModified: string;
    };
    expect(arg.selectedLineIds).toBeUndefined();
    expect(arg.originalDocumentId).toBe("PAY00000001");
    // Concurrency: preview.lastModified is passed straight through (§2.6).
    expect(arg.lastModified).toBe("2026-03-15T01:00:00.000Z");
  });

  it("a strict subset → sends selectedLineIds (reverseLine path)", async () => {
    renderDialog();
    await screen.findByRole("checkbox", { name: /reverse line 2 allocation/i });
    fillRequiredFields();
    // Uncheck line 1 → only line 2 (allocation) remains checked.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /reverse line 1 capture/i }),
    );
    await screen.findByText(
      /reverses 1 of 2 lines — the document stays posted/i,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /reverse selected lines/i }),
    );
    await waitFor(() => expect(reverseDocumentAction).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(reverseDocumentAction).mock.calls[0]![0] as {
      selectedLineIds?: string[];
    };
    expect(arg.selectedLineIds).toEqual(["DLN2"]);
  });

  it("surfaces a reload prompt and does not silently retry on CONFLICT (§2.6)", async () => {
    vi.mocked(reverseDocumentAction).mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    renderDialog();
    await screen.findByText(
      /reverses the entire document — it will be marked reversed/i,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /reverse document/i }));
    // The CONFLICT message is a reload prompt …
    expect(
      await screen.findByText(/modified concurrently.*reload/i),
    ).toBeInTheDocument();
    // … and the action ran exactly once (no silent retry).
    expect(reverseDocumentAction).toHaveBeenCalledTimes(1);
  });
});
