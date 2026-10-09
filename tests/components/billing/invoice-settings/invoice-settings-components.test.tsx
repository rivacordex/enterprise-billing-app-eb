// bm55-spec §Tests (components) — the preview frame is a sandboxed srcDoc
// iframe (never injected into the app DOM); the status badge variants incl.
// the Default chip; the version history "used by" column and actions; the
// Generated .hbs viewer renders the source as text.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GeneratedHbsViewer } from "@/components/billing/invoice-settings/generated-hbs-viewer";
import { InvoicePreviewFrame } from "@/components/billing/invoice-settings/invoice-preview-frame";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import type { TemplateVersionHistoryRow } from "@/types/billing";

describe("InvoicePreviewFrame", () => {
  const HTML =
    '<html><body><script>alert(1)</script><p id="x">Hi</p></body></html>';

  it("renders the HTML only inside an empty-sandbox iframe via srcDoc", () => {
    const { container } = render(
      <InvoicePreviewFrame
        html={HTML}
        status="ready"
        error={null}
        onRetry={vi.fn()}
      />,
    );
    const frame = screen.getByTitle("Invoice preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toBe(HTML);
    expect(frame).not.toHaveAttribute("src");
    // Nothing of the document reaches the app DOM.
    expect(container.querySelector("#x")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows the §6c skeleton captions while loading and queued", () => {
    const { rerender } = render(
      <InvoicePreviewFrame
        html={null}
        status="loading"
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Rendering draft invoice…")).toBeInTheDocument();
    rerender(
      <InvoicePreviewFrame
        html={null}
        status="queued"
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Queued — rendering shortly")).toBeInTheDocument();
  });

  it("shows a PREVIEW_FAILED code in a danger alert with Retry", () => {
    const onRetry = vi.fn();
    render(
      <InvoicePreviewFrame
        html={null}
        status="error"
        error={{
          code: "PREVIEW_FAILED",
          detail: "INVOICE_RECONCILIATION_FAILED",
        }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("INVOICE_RECONCILIATION_FAILED");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("TemplateVersionStatusBadge", () => {
  it.each([
    ["DRAFT", "Draft", "--color-neutral-500"],
    ["ACTIVE", "Active", "--color-success-50"],
    ["RETIRED", "Retired", "--color-neutral-100"],
  ] as const)(
    "renders %s with its label and family",
    (status, label, token) => {
      const { container } = render(
        <TemplateVersionStatusBadge status={status} />,
      );
      const pill = container.querySelector(`[data-status="${status}"]`)!;
      expect(pill).toHaveTextContent(label);
      expect(pill.className).toContain(token);
      expect(pill.querySelector("svg")).not.toBeNull();
      expect(container.querySelector("[data-default]")).toBeNull();
    },
  );

  it("RETIRED is never in the danger family", () => {
    const { container } = render(
      <TemplateVersionStatusBadge status="RETIRED" />,
    );
    expect(container.innerHTML).not.toContain("danger");
  });

  it("adds a primary-outline Default chip with a lock when isDefault", () => {
    const { container } = render(
      <TemplateVersionStatusBadge status="ACTIVE" isDefault />,
    );
    const chip = container.querySelector("[data-default]")!;
    expect(chip).toHaveTextContent("Default");
    expect(chip.className).toContain("--color-primary-500");
    expect(chip.querySelector("svg")).not.toBeNull();
  });
});

const ROW: TemplateVersionHistoryRow = {
  billTemplateVersionId: "BTV00000002",
  versionNo: 1,
  status: "ACTIVE",
  isDefault: true,
  layoutLabel: "INVTPL-STD-A4 v1",
  createdBy: null,
  createdAt: new Date("2026-10-08T00:00:00Z"),
  activatedAt: new Date("2026-10-08T00:00:00Z"),
  retiredAt: null,
  changeNote: "Seeded default generated template v1 (bm50).",
  usedByCount: 12,
};

describe("VersionHistoryTable", () => {
  function renderTable(rows = [ROW]) {
    return render(
      <VersionHistoryTable
        rows={rows}
        shownVersionId="BTV00000002"
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
  }

  it("lists v1 as Active + Default with its layout and 'used by N invoices'", () => {
    renderTable();
    const row = screen.getByText("v1").closest("tr")!;
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("Default")).toBeInTheDocument();
    expect(within(row).getByText("INVTPL-STD-A4 v1")).toBeInTheDocument();
    expect(within(row).getByTestId("used-by")).toHaveTextContent("12 invoices");
    expect(
      within(row).getByText("Seeded default generated template v1 (bm50)."),
    ).toBeInTheDocument();
  });

  it("uses the singular for one invoice", () => {
    renderTable([{ ...ROW, usedByCount: 1 }]);
    expect(screen.getByTestId("used-by")).toHaveTextContent("1 invoice");
  });

  it("links View to the read-only version and Download to the .hbs handler", () => {
    renderTable();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "?tab=edit&version=BTV00000002",
    );
    expect(screen.getByRole("link", { name: "Download .hbs" })).toHaveAttribute(
      "href",
      "/administration/invoice-settings/invoice-template/versions/BTV00000002/files/invoice.hbs",
    );
  });

  it("orders rows as given (newest first from the service)", () => {
    renderTable([
      {
        ...ROW,
        billTemplateVersionId: "BTV00000004",
        versionNo: 2,
        isDefault: false,
      },
      ROW,
    ]);
    const versions = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(versions[0]).toContain("v2");
    expect(versions[1]).toContain("v1");
  });
});

describe("GeneratedHbsViewer", () => {
  it("renders the stored sources as text with download links for all three files", () => {
    const { container } = render(
      <GeneratedHbsViewer
        versionId="BTV00000002"
        versionNo={1}
        invoiceHbs={'<section class="x">{{customer.name}}</section>\n'}
        footerHbs={"<div>{{invoice.number}}</div>\n"}
      />,
    );
    expect(screen.getByLabelText("invoice.hbs")).toHaveTextContent(
      '<section class="x">{{customer.name}}</section>',
    );
    expect(container.querySelector("section.x")).toBeNull();
    for (const file of ["invoice.hbs", "footer.hbs", "structure.json"]) {
      expect(
        screen.getByRole("link", { name: `Download ${file}` }),
      ).toHaveAttribute(
        "href",
        `/administration/invoice-settings/invoice-template/versions/BTV00000002/files/${file}`,
      );
    }
  });
});

describe("InvoiceSettingsTabs", () => {
  it("renders only the Invoice template tab until bm56 adds Company profile", () => {
    render(<InvoiceSettingsTabs />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Invoice template"]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
  });
});
