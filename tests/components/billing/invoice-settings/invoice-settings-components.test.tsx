// bm55-spec §Tests (components) — the preview frame is a sandboxed srcDoc
// iframe (never injected into the app DOM); the status badge variants incl.
// the Default chip; the version history "used by" column and actions; the
// Generated .hbs viewer renders the source as text. bm79: the DRAFT row's
// Discard control and a discarded row.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock(
  "@/actions/billing/invoice-settings/discard-template-draft.action",
  () => ({ discardTemplateDraftAction: vi.fn() }),
);

import { discardTemplateDraftAction } from "@/actions/billing/invoice-settings/discard-template-draft.action";
import { toast } from "sonner";

import { DRAFT_CONFLICT_MESSAGE } from "@/components/billing/invoice-settings/draft-messages";

import { GeneratedHbsViewer } from "@/components/billing/invoice-settings/generated-hbs-viewer";
import { InvoicePreviewFrame } from "@/components/billing/invoice-settings/invoice-preview-frame";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
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

  it("bm83 — a TEMPLATE_TYPE_RETIRED preview shows the retired-type message", () => {
    render(
      <InvoicePreviewFrame
        html={null}
        status="error"
        error={{ code: "TEMPLATE_TYPE_RETIRED" }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This invoice template type has been retired, so it can no longer be edited or previewed.",
    );
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

describe("VersionHistoryTable: in-use captions (bm58 D5)", () => {
  const base = {
    layoutLabel: "INVTPL-STD-A4 v1",
    createdBy: null,
    createdAt: new Date("2026-10-10T00:00:00Z"),
    activatedAt: new Date("2026-10-10T00:00:00Z"),
    retiredAt: null,
    changeNote: null,
    usedByCount: 0,
  };
  const rows: TemplateVersionHistoryRow[] = [
    {
      ...base,
      billTemplateVersionId: "BTV00000005",
      versionNo: 3,
      status: "ACTIVE",
      isDefault: false,
    },
    {
      ...base,
      billTemplateVersionId: "BTV00000004",
      versionNo: 2,
      status: "RETIRED",
      isDefault: false,
    },
    {
      ...base,
      billTemplateVersionId: "BTV00000002",
      versionNo: 1,
      status: "ACTIVE",
      isDefault: true,
    },
  ];

  it("labels the non-default ACTIVE 'In use' and the default 'Fallback' while it is in use", () => {
    render(
      <VersionHistoryTable
        rows={rows}
        shownVersionId="BTV00000005"
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(screen.getByText("In use for new runs")).toBeInTheDocument();
    expect(screen.getByText("Fallback")).toBeInTheDocument();
    expect(screen.getAllByText("In use for new runs")).toHaveLength(1);
  });

  it("does not call the default a fallback when it is the version in use", () => {
    render(
      <VersionHistoryTable
        rows={[rows[2]!]}
        shownVersionId="BTV00000002"
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(screen.queryByText("Fallback")).toBeNull();
    expect(screen.queryByText("In use for new runs")).toBeNull();
  });
});

describe("VersionHistoryTable: DRAFT rows (bm57)", () => {
  const DRAFT: TemplateVersionHistoryRow = {
    billTemplateVersionId: "BTV00000004",
    versionNo: 2,
    status: "DRAFT",
    isDefault: false,
    layoutLabel: "INVTPL-STD-A4 v1",
    createdBy: "u1",
    createdAt: new Date("2026-10-10T00:00:00Z"),
    activatedAt: null,
    retiredAt: null,
    changeNote: null,
    usedByCount: 0,
  };

  it("shows a View link for a DRAFT to editors, and no download", () => {
    render(
      <VersionHistoryTable
        rows={[DRAFT]}
        shownVersionId="BTV00000004"
        canViewDrafts
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(screen.getByRole("link", { name: /View/ })).toHaveAttribute(
      "href",
      "?tab=edit&version=BTV00000004",
    );
    expect(screen.queryByText(/Download/)).toBeNull();
  });

  it("hides the View link for a DRAFT from a READ user (it would silently fall back)", () => {
    render(
      <VersionHistoryTable
        rows={[DRAFT]}
        shownVersionId="BTV00000002"
        canViewDrafts={false}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View/ })).toBeNull();
  });
});

describe("VersionHistoryTable: Discard (bm79)", () => {
  const DRAFT: TemplateVersionHistoryRow = {
    billTemplateVersionId: "BTV00000011",
    versionNo: 1,
    status: "DRAFT",
    isDefault: false,
    layoutLabel: "INVTPL-WHOLESALE v1 (draft)",
    createdBy: "u1",
    createdAt: new Date("2026-10-25T00:00:00Z"),
    activatedAt: null,
    retiredAt: null,
    changeNote: null,
    usedByCount: 0,
  };
  const DISCARD = {
    familyId: "BTF00000002",
    draftId: "BTV00000011",
    draftToken: "2026-10-25T01:02:03.123456Z",
    layoutDraft: { code: "INVTPL-WHOLESALE", versionNo: 1 },
  };

  function renderTable(
    discard: NonNullable<
      Parameters<typeof VersionHistoryTable>[0]["discard"]
    > | null,
    rows: TemplateVersionHistoryRow[] = [DRAFT],
  ) {
    return render(
      <VersionHistoryTable
        rows={rows}
        shownVersionId="BTV00000011"
        canViewDrafts
        discard={discard}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
  }

  it("renders Discard on the DRAFT row only when the page passes `discard` (EDIT on a non-retired type)", () => {
    const active: TemplateVersionHistoryRow = {
      ...DRAFT,
      billTemplateVersionId: "BTV00000002",
      status: "ACTIVE",
      isDefault: true,
      activatedAt: new Date("2026-10-10T00:00:00Z"),
    };
    renderTable(DISCARD, [DRAFT, active]);
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
    const draftRow = screen.getByText("BTV00000011").closest("tr")!;
    expect(
      within(draftRow).getByRole("button", { name: "Discard" }),
    ).toBeInTheDocument();
  });

  it("renders no Discard control without `discard` (a READ user, or a retired type)", () => {
    renderTable(null);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("names the layout DRAFT in the dialog when there is one, and only the settings otherwise", () => {
    const { unmount } = renderTable(DISCARD);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByRole("heading", { name: "Discard draft v1?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The draft settings v1 and the draft layout INVTPL-WHOLESALE v1 will be retired. Their version numbers are not reused.",
      ),
    ).toBeInTheDocument();
    unmount();

    renderTable({ ...DISCARD, layoutDraft: null });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByText(
        "The draft settings v1 will be retired. Their version numbers are not reused.",
      ),
    ).toBeInTheDocument();
  });

  it("confirms with the draft's id and token, then refreshes", async () => {
    vi.mocked(discardTemplateDraftAction).mockResolvedValue({
      ok: true,
      discardedVersionIds: ["BTV00000011", "BTV00000010"],
    });
    renderTable(DISCARD);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(vi.mocked(discardTemplateDraftAction)).toHaveBeenCalledWith({
      familyId: "BTF00000002",
      draftId: "BTV00000011",
      expectedDraftToken: "2026-10-25T01:02:03.123456Z",
    });
  });

  it("on DRAFT_CONFLICT closes, shows the shared conflict message as a Warning toast (it outlives the row) and refreshes", async () => {
    refresh.mockClear();
    vi.mocked(discardTemplateDraftAction).mockResolvedValue({
      ok: false,
      code: "DRAFT_CONFLICT",
    });
    renderTable(DISCARD);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await vi.waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        DRAFT_CONFLICT_MESSAGE,
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("review fix — a discarded row has no View link for a READ user (it is still a draft)", () => {
    render(
      <VersionHistoryTable
        rows={[
          {
            ...DRAFT,
            status: "RETIRED",
            retiredAt: new Date("2026-10-25T02:00:00Z"),
          },
        ]}
        shownVersionId="BTV00000002"
        canViewDrafts={false}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(screen.queryByRole("link", { name: /View/ })).toBeNull();
  });

  it("a discarded row keeps the Retired badge, shows — for Activated and has no download", () => {
    renderTable(null, [
      {
        ...DRAFT,
        status: "RETIRED",
        retiredAt: new Date("2026-10-25T02:00:00Z"),
      },
    ]);
    const row = screen.getByText("BTV00000011").closest("tr")!;
    expect(within(row).getByText("Retired")).toBeInTheDocument();
    // Activated at is the 6th column (Version, Status, Layout, Created by,
    // Created at, Activated at).
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("—");
    expect(within(row).queryByText(/Download/)).toBeNull();
  });
});

describe("InvoiceSettingsTabs", () => {
  it("lists Company profile first, then Invoice template, marking the active tab", () => {
    render(<InvoiceSettingsTabs active="invoice-template" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Company profile",
      "Invoice template",
    ]);
    expect(links[0]).not.toHaveAttribute("aria-current");
    expect(links[1]).toHaveAttribute("aria-current", "page");
  });
});

describe("VersionHistoryTable: Export (bm81)", () => {
  const EXPORT_BASE =
    "/administration/invoice-settings/invoice-template/versions";
  const RETIRED: TemplateVersionHistoryRow = {
    ...ROW,
    billTemplateVersionId: "BTV00000005",
    versionNo: 2,
    status: "RETIRED",
    isDefault: false,
    retiredAt: new Date("2026-10-20T00:00:00Z"),
  };
  const DRAFT: TemplateVersionHistoryRow = {
    ...ROW,
    billTemplateVersionId: "BTV00000006",
    versionNo: 3,
    status: "DRAFT",
    isDefault: false,
    activatedAt: null,
  };
  const DISCARDED: TemplateVersionHistoryRow = {
    ...DRAFT,
    billTemplateVersionId: "BTV00000007",
    versionNo: 4,
    status: "RETIRED",
    retiredAt: new Date("2026-10-25T00:00:00Z"),
  };

  function exportOf(id: string): HTMLElement | null {
    const row = screen.getByText(id).closest("tr")!;
    return within(row).queryByRole("link", {
      name: TEMPLATE_TYPE_MESSAGES.exportLink,
    });
  }

  function renderTable(canViewDrafts: boolean) {
    return render(
      <VersionHistoryTable
        rows={[DISCARDED, DRAFT, RETIRED, ROW]}
        shownVersionId="BTV00000002"
        canViewDrafts={canViewDrafts}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
  }

  it("a READ user gets Export on ACTIVE and RETIRED rows, never on the DRAFT or a discarded row", () => {
    renderTable(false);
    for (const id of ["BTV00000002", "BTV00000005"]) {
      const link = exportOf(id)!;
      expect(link).toHaveAttribute("href", `${EXPORT_BASE}/${id}/export`);
      expect(link).toHaveAttribute("download");
    }
    expect(exportOf("BTV00000006")).toBeNull();
    expect(exportOf("BTV00000007")).toBeNull();
  });

  it("an EDIT user also gets Export on the DRAFT and the discarded row", () => {
    renderTable(true);
    for (const id of [
      "BTV00000002",
      "BTV00000005",
      "BTV00000006",
      "BTV00000007",
    ]) {
      expect(exportOf(id)).toHaveAttribute(
        "href",
        `${EXPORT_BASE}/${id}/export`,
      );
    }
  });
});
