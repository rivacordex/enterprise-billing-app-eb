// bm55-spec §Tests (components) — `InvoiceStructureForm`: mandatory sections
// locked with "Required"; a READ user sees text, not inputs, and can still
// preview; a toggle drives a debounced preview call carrying the unsaved
// structure; the bill source list is offered only to a billrun_view holder;
// a posted bill shows the "as issued" banner.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/actions/billing/invoice-settings/preview-invoice-template.action",
  () => ({ previewInvoiceTemplateAction: vi.fn() }),
);

import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import { InvoiceStructureForm } from "@/components/billing/invoice-settings/invoice-structure-form";
import {
  MANDATORY_SECTION_KEYS,
  type InvoiceTemplateStructure,
} from "@/types/billing";

const mockPreview = vi.mocked(previewInvoiceTemplateAction);

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

  it("has no Save or Activate control (bm57/bm58)", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
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
