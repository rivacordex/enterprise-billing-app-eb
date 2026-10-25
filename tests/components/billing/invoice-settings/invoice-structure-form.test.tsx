// bm55-spec §Tests (components) — `InvoiceStructureForm`: mandatory sections
// locked with "Required"; a READ user sees text, not inputs, and can still
// preview; a toggle drives a debounced preview call carrying the unsaved
// structure; the bill source list is offered only to a billrun_view holder;
// a posted bill shows the "as issued" banner. bm57: Save draft is EDIT-only,
// disabled while pristine or saving, sends the unsaved structure with the
// concurrency token, and reports success, a conflict and a refused structure.
// bm72 (D56 part 2, ui-context §10b Phase 3 rows): the form runs on React Hook
// Form; Payment information is the only toggle, and the Footnote field holds
// 1–5 labelled lines with a counter, add/remove buttons and inline errors; a
// READ user sees the lines as a plain list.

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
import { SEEDED_FOOTNOTE } from "@/tests/helpers/seeded-invoice-template";

const mockPreview = vi.mocked(previewInvoiceTemplateAction);
const mockSave = vi.mocked(saveTemplateDraftAction);
const mockActivate = vi.mocked(activateTemplateAction);
const TOKEN = "2026-10-10T01:02:03.123456Z";

const ALL_ON: InvoiceTemplateStructure = {
  sections: { payment: true },
  columns: {},
  footnote: [...SEEDED_FOOTNOTE],
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
      familyId="BTF00000001"
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

  it("renders Payment information as the one enabled checkbox with its value", () => {
    renderForm();
    const payment = within(screen.getByTestId("section-payment")).getByRole(
      "checkbox",
    );
    expect(payment).toBeEnabled();
    expect(payment).toHaveAttribute("data-state", "checked");
    expect(
      within(screen.getByTestId("section-payment")).queryByText("Required"),
    ).toBeNull();
  });

  it("bm71/bm72 — has no Usage annex or Notes row and no column toggles", () => {
    renderForm();
    expect(screen.queryByTestId("section-usageAnnex")).toBeNull();
    expect(screen.queryByTestId("section-notes")).toBeNull();
    expect(screen.queryByText("Usage annex")).toBeNull();
    expect(screen.queryByText("Notes & terms")).toBeNull();
    expect(screen.queryByText("Charge-detail columns")).toBeNull();
    expect(screen.queryAllByTestId(/^column-/)).toHaveLength(0);
    // The locked mandatory rows plus Payment information.
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
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
      // bm66 — the preview names the Standard family it renders with.
      familyId: "BTF00000001",
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

  it("debounces a burst of edits into one call carrying the unsaved footnote", async () => {
    renderForm();
    await flushDebounce();
    mockPreview.mockClear();
    fireEvent.click(
      within(screen.getByTestId("section-payment")).getByRole("checkbox"),
    );
    await typeLine(2, "Billed inclusive of USP");
    await flushDebounce();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview.mock.lastCall?.[0]).toMatchObject({
      structure: {
        sections: { payment: false },
        columns: {},
        footnote: [ALL_ON.footnote[0], "Billed inclusive of USP"],
      },
    });
  });

  it("sends no preview while a footnote line is invalid", async () => {
    renderForm();
    await flushDebounce();
    mockPreview.mockClear();
    await typeLine(1, "   ");
    await flushDebounce();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("a toggle or source change while a line is invalid previews the last valid structure, never sticking in loading", async () => {
    renderForm();
    await flushDebounce();
    mockPreview.mockClear();
    await typeLine(1, "   ");
    fireEvent.click(screen.getByRole("switch", { name: "Outline" }));
    expect(screen.getByTitle("Invoice preview").parentElement).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await flushDebounce();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview.mock.lastCall?.[0]).toMatchObject({
      structure: ALL_ON,
      outline: true,
    });
    expect(screen.getByTitle("Invoice preview").parentElement).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });

  it("marks the preview busy as soon as a footnote line changes, and hides a stale error", async () => {
    mockPreview.mockResolvedValueOnce({ ok: false, code: "PREVIEW_FAILED" });
    renderForm();
    await flushDebounce();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await typeLine(2, "Billed inclusive of USP");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Rendering draft invoice…")).toBeInTheDocument();
    await flushDebounce();
    expect(screen.queryByText("Rendering draft invoice…")).toBeNull();
  });
});

async function typeLine(line: number, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(`Line ${line}`), {
      target: { value },
    });
  });
}

describe("InvoiceStructureForm — Footnote (bm72)", () => {
  function lineInputs(): HTMLElement[] {
    return screen.queryAllByLabelText(/^Line \d$/);
  }

  it("renders a labelled input per line under the Footnote group, with its hint", () => {
    renderForm();
    expect(screen.getByRole("group", { name: "Footnote" })).toBeInTheDocument();
    expect(
      screen.getByText("Printed after Total Amount on the last page"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Line 1")).toHaveValue(ALL_ON.footnote[0]);
    expect(screen.getByLabelText("Line 2")).toHaveValue(ALL_ON.footnote[1]);
    expect(lineInputs()).toHaveLength(2);
  });

  it("adds lines up to 5, then hides Add line", async () => {
    renderForm();
    for (let n = 3; n <= 5; n++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add line" }));
      });
      expect(screen.getByLabelText(`Line ${n}`)).toHaveValue("");
    }
    expect(lineInputs()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Add line" })).toBeNull();
  });

  it("removes a line, and hides Remove when one line is left", async () => {
    renderForm();
    expect(
      screen.getByRole("button", { name: "Remove line 2" }),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove line 1" }));
    });
    expect(lineInputs()).toHaveLength(1);
    expect(screen.getByLabelText("Line 1")).toHaveValue(ALL_ON.footnote[1]);
    expect(screen.queryByRole("button", { name: /Remove line/ })).toBeNull();
  });

  it("counts characters against 200 and turns the counter Danger past it", async () => {
    renderForm();
    expect(screen.getByText("29/200")).toBeInTheDocument();
    await typeLine(1, "x".repeat(201));
    const counter = screen.getByText("201/200");
    expect(counter.className).toContain("--color-danger-700");
  });

  it("counts a line as the schema does, without its surrounding spaces", async () => {
    renderForm();
    await typeLine(1, ` ${"x".repeat(200)}  `);
    const counter = screen.getByText("200/200");
    expect(counter.className).not.toContain("--color-danger-700");
  });

  it("shows the schema's message under the offending line", async () => {
    renderForm();
    await typeLine(2, "x".repeat(201));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "200 characters at most",
    );
    expect(screen.getByLabelText("Line 2")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await typeLine(2, "   ");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter text or remove the line",
    );
    expect(screen.getByLabelText("Line 1")).not.toHaveAttribute("aria-invalid");
  });

  it("refuses to save an added blank line and shows the error instead", async () => {
    renderForm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter text or remove the line",
    );
  });

  it("saves the trimmed footnote", async () => {
    mockSave.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: "2026-10-10T02:00:00.000001Z",
    });
    renderForm();
    await typeLine(2, "  Billed inclusive of USP  ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(mockSave).toHaveBeenCalledWith({
      structure: {
        sections: { payment: true },
        columns: {},
        footnote: [ALL_ON.footnote[0], "Billed inclusive of USP"],
      },
      expectedDraftToken: null,
      familyId: "BTF00000001",
    });
    expect(screen.getByLabelText("Line 2")).toHaveValue(
      "Billed inclusive of USP",
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("shows a server refusal of a line under that line", async () => {
    mockSave.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { "structure.footnote.1": ["200 characters at most"] },
    });
    renderForm();
    await typeLine(2, "Changed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "200 characters at most",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("InvoiceStructureForm — Activate (bm58)", () => {
  const DRAFT_PROPS = {
    expectedDraftToken: TOKEN,
    draftVersionId: "BTV00000004",
    draftVersionNo: 2,
    activeStructure: {
      ...ALL_ON,
      sections: { ...ALL_ON.sections, payment: false },
    },
  } as const;

  function togglePayment(): void {
    fireEvent.click(
      within(screen.getByTestId("section-payment")).getByRole("checkbox"),
    );
  }

  function formWith(
    props: Partial<React.ComponentProps<typeof InvoiceStructureForm>>,
  ): React.JSX.Element {
    return (
      <InvoiceStructureForm
        initialStructure={ALL_ON}
        editable
        recentBills={BILLS}
        canPreviewBills
        familyId="BTF00000001"
        {...DRAFT_PROPS}
        {...props}
      />
    );
  }

  it("keeps an open dialog and its note when the page refreshes with the draft the form already holds", () => {
    const { rerender } = render(formWith({}));
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "typed before the refresh" },
    });
    rerender(formWith({ initialStructure: { ...ALL_ON } }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/Change note/)).toHaveValue(
      "typed before the refresh",
    );
  });

  it("adopts a newer server draft (a Reload after DRAFT_CONFLICT): its structure, token and version", async () => {
    const { rerender } = render(formWith({}));
    await act(async () => {
      rerender(
        formWith({
          expectedDraftToken: "2026-10-11T00:00:00.000000Z",
          draftVersionNo: 3,
          draftVersionId: "BTV00000005",
          initialStructure: {
            ...ALL_ON,
            footnote: [ALL_ON.footnote[0]!, "Another admin's line"],
          },
        }),
      );
    });
    expect(screen.getByLabelText("Line 2")).toHaveValue("Another admin's line");
    expect(screen.getByRole("button", { name: "Activate v3" })).toBeEnabled();
  });

  it("drops the activated draft when the refreshed page has none", async () => {
    const { rerender } = render(formWith({}));
    await act(async () => {
      rerender(
        formWith({
          expectedDraftToken: null,
          draftVersionId: null,
          draftVersionNo: null,
        }),
      );
    });
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
  });

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
      "+ Payment information shown",
    );
  });

  it("bm72 — lists a changed footnote line with its old and new text", () => {
    renderForm({
      ...DRAFT_PROPS,
      activeStructure: {
        ...ALL_ON,
        footnote: [ALL_ON.footnote[0]!, "Exclusive of USP"],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate v2" }));
    expect(screen.getByTestId("activate-summary")).toHaveTextContent(
      `Footnote line 2: "Exclusive of USP" → "${ALL_ON.footnote[1]}"`,
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
      layout: null,
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
      familyId: "BTF00000001",
    });
    expect(toast.success).toHaveBeenCalledWith("Template v2 activated");
    // The action revalidates the layout; the form adopts the refreshed page.
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
      layout: null,
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
      familyId: "BTF00000001",
    });
  });
});

describe("InvoiceStructureForm — Activate a pair (bm79)", () => {
  const PAIR_PROPS = {
    expectedDraftToken: TOKEN,
    draftVersionId: "BTV00000011",
    draftVersionNo: 1,
    familyId: "BTF00000002",
  } as const;

  async function confirmActivate(versionNo: number): Promise<void> {
    fireEvent.click(
      screen.getByRole("button", { name: `Activate v${versionNo}` }),
    );
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "Wholesale layout" },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: `Activate v${versionNo}`,
        }),
      );
    });
  }

  it("leads the summary with the layout line, old → new", () => {
    renderForm({
      ...PAIR_PROPS,
      draftVersionNo: 3,
      activeStructure: ALL_ON,
      layoutChange: {
        code: "INVTPL-WHOLESALE",
        fromVersionNo: 1,
        toVersionNo: 2,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate v3" }));
    const summary = screen.getByTestId("activate-summary");
    expect(summary).toHaveTextContent(
      "Layout: INVTPL-WHOLESALE v1 → v2No change in structure.",
    );
    expect(
      within(summary).getByText("Layout: INVTPL-WHOLESALE v1 → v2"),
    ).toHaveClass("font-mono");
  });

  it("for a new type reads '(first version)' and 'First version of this type.'", () => {
    renderForm({
      ...PAIR_PROPS,
      activeStructure: null,
      layoutChange: {
        code: "INVTPL-WHOLESALE",
        fromVersionNo: null,
        toVersionNo: 1,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate v1" }));
    const summary = screen.getByTestId("activate-summary");
    expect(
      within(summary).getByText("Layout: INVTPL-WHOLESALE v1 (first version)"),
    ).toBeInTheDocument();
    expect(
      within(summary).getByText("First version of this type."),
    ).toBeInTheDocument();
  });

  it("a settings-only draft has no layout line", () => {
    renderForm({ ...PAIR_PROPS, activeStructure: ALL_ON, layoutChange: null });
    fireEvent.click(screen.getByRole("button", { name: "Activate v1" }));
    expect(screen.getByTestId("activate-summary")).not.toHaveTextContent(
      "Layout:",
    );
  });

  it("on LAYOUT_REJECTED says nothing was activated and renders the problems alert above the preview", async () => {
    mockActivate.mockResolvedValue({
      ok: false,
      code: "LAYOUT_REJECTED",
      problems: [
        {
          file: "(render)",
          code: "LAYOUT_EXTERNAL_FETCH",
          message: "the layout tried to fetch 1 URL: http://x/a.png",
        },
      ],
    });
    renderForm({ ...PAIR_PROPS, activeStructure: null });
    await confirmActivate(1);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "The layout no longer passes the compliance check. Nothing was activated.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The draft layout failed the compliance check."),
    ).toBeInTheDocument();
    expect(screen.getByText("LAYOUT_EXTERNAL_FETCH")).toBeInTheDocument();
    expect(screen.getByText("(render)")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on TEMPLATE_TYPE_RETIRED shows the retired message and refreshes", async () => {
    mockActivate.mockResolvedValue({
      ok: false,
      code: "TEMPLATE_TYPE_RETIRED",
    });
    renderForm({ ...PAIR_PROPS, activeStructure: null });
    await confirmActivate(1);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "This invoice template type has been retired, so its drafts can no longer be activated or discarded.",
      ),
    ).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
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
      familyId: "BTF00000001",
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

  // bm72 — the structure stores only `payment` (bm71 Deviation 3), so a
  // section refusal can no longer name a row; it is reported generically.
  it("shows an error toast for a refusal that names no footnote line", async () => {
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
    expect(toast.error).toHaveBeenCalledWith(
      "The draft could not be saved. Please try again.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
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
  it("renders sections as text, not inputs", () => {
    renderForm({
      editable: false,
      initialStructure: { ...ALL_ON, sections: { payment: false } },
    });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(screen.getByTestId("section-payment")).getByText("Hidden"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("section-billTo")).getByText("Shown"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("section-billTo")).getByText("Required"),
    ).toBeInTheDocument();
  });

  it("bm72 — renders the footnote as a plain list with no inputs or buttons", () => {
    renderForm({ editable: false });
    const list = screen.getByRole("list", { name: "Footnote lines" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(ALL_ON.footnote);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add line" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove line/ })).toBeNull();
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
