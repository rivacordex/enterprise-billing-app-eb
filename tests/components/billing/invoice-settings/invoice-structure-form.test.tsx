// bm55-spec §Tests (components) — `InvoiceStructureForm`: mandatory sections
// locked with "Required"; a READ user sees text, not inputs, and can still
// preview; a toggle drives a debounced preview call carrying the unsaved
// structure; the bill source list is offered only to a billrun_view holder;
// a posted bill shows the "as issued" banner. bm57: Save draft is EDIT-only,
// disabled while pristine or saving, sends the unsaved structure with the
// concurrency token, and reports success, a conflict and a refused structure.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/actions/billing/invoice-settings/preview-invoice-template.action",
  () => ({ previewInvoiceTemplateAction: vi.fn() }),
);
vi.mock(
  "@/actions/billing/invoice-settings/save-template-draft.action",
  () => ({ saveTemplateDraftAction: vi.fn() }),
);
vi.mock("@/actions/billing/invoice-settings/activate-template.action", () => ({
  activateTemplateAction: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import { activateTemplateAction } from "@/actions/billing/invoice-settings/activate-template.action";
import { saveTemplateDraftAction } from "@/actions/billing/invoice-settings/save-template-draft.action";
import { toast } from "sonner";
import { InvoiceStructureForm } from "@/components/billing/invoice-settings/invoice-structure-form";
import {
  MANDATORY_SECTION_KEYS,
  type InvoiceTemplateStructure,
} from "@/types/billing";

const mockPreview = vi.mocked(previewInvoiceTemplateAction);
const mockSave = vi.mocked(saveTemplateDraftAction);
const mockActivate = vi.mocked(activateTemplateAction);
const TOKEN = "2026-10-10T01:02:03.123456Z";

const ALL_ON: InvoiceTemplateStructure = {
  sections: {
    billTo: true,
    identification: true,
    amountDue: true,
    chargeSummary: true,
    taxSummary: true,
    payment: true,
    chargeDetails: true,
    usageAnnex: true,
    notes: false,
  },
  columns: {
    showServicePeriod: true,
    showDiscountColumn: false,
    showProductId: true,
    showUdrCount: true,
  },
};

const BILLS = [
  {
    customerBillId: "CBL00000007",
    invoiceNumber: "INV00000077",
    billingAccountId: "BAN00000001",
    accountName: "Acme Communications",
  },
];

function renderForm(
  props: Partial<React.ComponentProps<typeof InvoiceStructureForm>> = {},
) {
  return render(
    <InvoiceStructureForm
      initialStructure={ALL_ON}
      editable
      recentBills={BILLS}
      canPreviewBills
      {...props}
    />,
  );
}

async function flushDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPreview.mockReset();
  mockSave.mockReset();
  mockActivate.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.error).mockReset();
  refresh.mockReset();
  mockPreview.mockResolvedValue({
    ok: true,
    html: "<html><body>preview</body></html>",
    templateLabel: "Unsaved structure · INVTPL-STD-A4 v1 · sample bill",
    pinnedVersionNo: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InvoiceStructureForm — EDIT user", () => {
  it("renders every mandatory section checked, disabled and marked Required", () => {
    renderForm();
    for (const key of MANDATORY_SECTION_KEYS) {
      const row = screen.getByTestId(`section-${key}`);
      const box = within(row).getByRole("checkbox");
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute("data-state", "checked");
      expect(within(row).getByText("Required")).toBeInTheDocument();
    }
  });

  it("renders optional sections and columns as enabled checkboxes with their values", () => {
    renderForm();
    const payment = within(screen.getByTestId("section-payment")).getByRole(
      "checkbox",
    );
    expect(payment).toBeEnabled();
    expect(payment).toHaveAttribute("data-state", "checked");
    expect(
      within(screen.getByTestId("section-notes")).getByRole("checkbox"),
    ).toHaveAttribute("data-state", "unchecked");
    expect(
      within(screen.getByTestId("column-showDiscountColumn")).getByRole(
        "checkbox",
      ),
    ).toHaveAttribute("data-state", "unchecked");
    expect(
      within(screen.getByTestId("section-payment")).queryByText("Required"),
    ).toBeNull();
  });

  it("previews the initial structure after the 400 ms debounce, then the toggled one", async () => {
    renderForm();
    expect(mockPreview).not.toHaveBeenCalled();
    await flushDebounce();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview).toHaveBeenLastCalledWith({
      structure: ALL_ON,
      source: "sample",
      annotate: false,
      outline: false,
    });

    fireEvent.click(
      within(screen.getByTestId("section-payment")).getByRole("checkbox"),
    );
    await flushDebounce();
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(mockPreview.mock.lastCall?.[0]).toMatchObject({
      structure: { sections: { payment: false } },
    });
  });

  it("debounces a burst of toggles into one call", async () => {
    renderForm();
    await flushDebounce();
    mockPreview.mockClear();
    const discount = within(
      screen.getByTestId("column-showDiscountColumn"),
    ).getByRole("checkbox");
    fireEvent.click(discount);
    fireEvent.click(
      within(screen.getByTestId("section-notes")).getByRole("checkbox"),
    );
    await flushDebounce();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview.mock.lastCall?.[0]).toMatchObject({
      structure: {
        sections: { notes: true },
        columns: { showDiscountColumn: true },
      },
    });
  });
});

describe("InvoiceStructureForm — Activate (bm58)", () => {
  const DRAFT_PROPS = {
    expectedDraftToken: TOKEN,
    draftVersionId: "BTV00000004",
    draftVersionNo: 2,
    activeStructure: {
      ...ALL_ON,
      sections: { ...ALL_ON.sections, usageAnnex: false },
    },
  } as const;

  function togglePayment(): void {
    fireEvent.click(
      within(screen.getByTestId("section-payment")).getByRole("checkbox"),
    );
  }

  it("is disabled with no saved draft and the form pristine", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
  });

  it("is enabled as 'Activate v{n}' for a saved draft with no unsaved edits", () => {
    renderForm(DRAFT_PROPS);
    expect(screen.getByRole("button", { name: "Activate v2" })).toBeEnabled();
  });

  it("reads 'Save draft first' and is disabled while there are unsaved edits", () => {
    renderForm(DRAFT_PROPS);
    togglePayment();
    expect(
      screen.getByRole("button", { name: "Save draft first" }),
    ).toBeDisabled();
  });

  it("uses the Deep Petrol accent on the trigger (ui-context §7)", () => {
    renderForm(DRAFT_PROPS);
    expect(
      screen.getByRole("button", { name: "Activate v2" }).className,
    ).toContain("billrun-cta-bg");
  });

  it("is not rendered for a READ user", () => {
    renderForm({ ...DRAFT_PROPS, editable: false });
    expect(screen.queryByRole("button", { name: /Activate/ })).toBeNull();
  });

  it("opens the dialog with the structure diff against the version in use", () => {
    renderForm(DRAFT_PROPS);
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    expect(screen.getByText("Activate template v2")).toBeInTheDocument();
    expect(screen.getByTestId("activate-summary")).toHaveTextContent(
      "+ Usage annex shown",
    );
  });

  it("says so when the structure is unchanged", () => {
    renderForm({ ...DRAFT_PROPS, activeStructure: ALL_ON });
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    expect(screen.getByTestId("activate-summary")).toHaveTextContent(
      "No change in structure.",
    );
  });

  it("activates with the draft id, token and trimmed note, then toasts without a redundant refresh", async () => {
    mockActivate.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      retiredVersionId: null,
    });
    renderForm(DRAFT_PROPS);
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "  Show the usage annex  " },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Activate v2",
        }),
      );
    });
    expect(mockActivate).toHaveBeenCalledWith({
      draftId: "BTV00000004",
      expectedDraftToken: TOKEN,
      changeNote: "Show the usage annex",
    });
    expect(toast.success).toHaveBeenCalledWith("Template v2 activated");
    // The action revalidates the layout and the form remounts on the new token.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the server's refusal inline in the dialog", async () => {
    mockActivate.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    renderForm(DRAFT_PROPS);
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "note" },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Activate v2",
        }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another user changed the draft",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers a Reload on DRAFT_CONFLICT so a stale token is not retried forever", async () => {
    mockActivate.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    renderForm(DRAFT_PROPS);
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "note" },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Activate v2",
        }),
      );
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "Another user changed the draft — reload to see it.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reload" }),
      }),
    );
    const options = vi.mocked(toast.warning).mock.calls[0]?.[1] as unknown as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not offer a Reload for other refusals", async () => {
    mockActivate.mockResolvedValue({
      ok: false,
      code: "TEMPLATE_COMPILE_FAILED",
    });
    renderForm(DRAFT_PROPS);
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "note" },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Activate v2",
        }),
      );
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("test render");
  });

  it("uses the draft created by its own save for the next activation", async () => {
    mockSave.mockResolvedValue({
      ok: true,
      versionId: "BTV00000009",
      versionNo: 3,
      draftToken: "2026-10-10T02:00:00.000001Z",
    });
    mockActivate.mockResolvedValue({
      ok: true,
      versionId: "BTV00000009",
      versionNo: 3,
      retiredVersionId: null,
    });
    renderForm();
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate v3" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "n" },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Activate v3",
        }),
      );
    });
    expect(mockActivate).toHaveBeenCalledWith({
      draftId: "BTV00000009",
      expectedDraftToken: "2026-10-10T02:00:00.000001Z",
      changeNote: "n",
    });
  });
});

describe("InvoiceStructureForm — Save draft (bm57)", () => {
  function togglePayment(): void {
    fireEvent.click(
      within(screen.getByTestId("section-payment")).getByRole("checkbox"),
    );
  }

  it("renders Save draft for an EDIT user, disabled while pristine", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("enables Save draft once the structure changes, and disables it again when reverted", () => {
    renderForm();
    togglePayment();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    togglePayment();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("does not render Save draft for a READ user", () => {
    renderForm({ editable: false });
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("sends the unsaved structure with the token, then toasts and goes pristine", async () => {
    mockSave.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: "2026-10-10T02:00:00.000001Z",
    });
    renderForm({ expectedDraftToken: TOKEN });
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(mockSave).toHaveBeenCalledWith({
      structure: {
        ...ALL_ON,
        sections: { ...ALL_ON.sections, payment: false },
      },
      expectedDraftToken: TOKEN,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Draft v2 saved — not used on invoices",
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("uses the token returned by the last save for the next one", async () => {
    mockSave.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: "2026-10-10T02:00:00.000001Z",
    });
    renderForm();
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
      expectedDraftToken: null,
    });
    expect(mockSave.mock.calls[1]?.[0]).toMatchObject({
      expectedDraftToken: "2026-10-10T02:00:00.000001Z",
    });
  });

  it("shows a Warning toast with Reload on DRAFT_CONFLICT and stays dirty", async () => {
    mockSave.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    renderForm({ expectedDraftToken: TOKEN });
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "Another user changed the draft — reload to see it.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reload" }),
      }),
    );
    const options = vi.mocked(toast.warning).mock.calls[0]?.[1] as unknown as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("shows inline danger text under the offending row on MANDATORY_SECTION_HIDDEN", async () => {
    mockSave.mockResolvedValue({
      ok: false,
      code: "MANDATORY_SECTION_HIDDEN",
      fieldErrors: {
        "structure.sections.billTo": ["MANDATORY_SECTION_HIDDEN"],
      },
    });
    renderForm();
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(
      within(screen.getByTestId("section-billTo")).getByRole("alert"),
    ).toHaveTextContent("required");
    expect(
      within(screen.getByTestId("section-payment")).queryByRole("alert"),
    ).toBeNull();
  });

  it("shows an error toast when the server refuses with FORBIDDEN", async () => {
    mockSave.mockResolvedValue({ ok: false, code: "FORBIDDEN" });
    renderForm();
    togglePayment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(toast.error).toHaveBeenCalled();
  });
});

describe("InvoiceStructureForm — read-only (READ user)", () => {
  it("renders sections and columns as text, not inputs", () => {
    renderForm({ editable: false });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(screen.getByTestId("section-notes")).getByText("Hidden"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("section-payment")).getByText("Shown"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("section-billTo")).getByText("Required"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("column-showDiscountColumn")).getByText(
        "Hidden",
      ),
    ).toBeInTheDocument();
  });

  it("can still drive the preview (placeholders toggle)", async () => {
    renderForm({ editable: false });
    await flushDebounce();
    fireEvent.click(screen.getByRole("switch", { name: "Show placeholders" }));
    await flushDebounce();
    expect(mockPreview.mock.lastCall?.[0]).toMatchObject({ annotate: true });
  });
});

describe("InvoiceStructureForm — preview sources and states", () => {
  it("shows the as-issued banner for a posted bill's pinned version", async () => {
    mockPreview.mockResolvedValue({
      ok: true,
      html: "<html><body>issued</body></html>",
      templateLabel: "Template v1 (as issued) · CBL00000007",
      pinnedVersionNo: 1,
    });
    renderForm();
    await flushDebounce();
    expect(
      screen.getByText("Showing as issued under template v1"),
    ).toBeInTheDocument();
  });

  it("shows the PREVIEW_FAILED code in a danger alert", async () => {
    mockPreview.mockResolvedValue({
      ok: false,
      code: "PREVIEW_FAILED",
      detail: "TEMPLATE_CHECKSUM_MISMATCH",
    });
    renderForm();
    await flushDebounce();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The preview could not be rendered.");
    expect(alert).toHaveTextContent("TEMPLATE_CHECKSUM_MISMATCH");
  });
});
