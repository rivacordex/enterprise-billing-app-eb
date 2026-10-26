import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm77-spec §11 — the invoice template TYPE list page: Standard renders as
// Usable + Default, a created type as Not yet usable, a READ user gets no
// "New invoice template type", and an old single-template bookmark
// (`?tab=…&version=…`) redirects to Standard's detail page with the same query.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/invoice-template-settings", () => ({
  listTemplateTypes: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn(),
  getAppTimezone: vi.fn(),
}));
// The dialog is a client island whose action pulls the db/service graph.
vi.mock(
  "@/components/billing/invoice-settings/create-template-type-dialog",
  () => ({
    CreateTemplateTypeDialog: () => (
      <button type="button">New invoice template type</button>
    ),
  }),
);
vi.mock("@/components/billing/invoice-settings/invoice-settings-tabs", () => ({
  InvoiceSettingsTabs: () => <nav data-testid="invoice-settings-tabs" />,
}));

import InvoiceTemplateTypesPage from "@/app/(app)/administration/invoice-settings/invoice-template/page";
import { requirePermission } from "@/auth/guard";
import { listTemplateTypes } from "@/services/billing/read/invoice-template-settings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import type { TemplateTypeListRow } from "@/types/billing";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListTemplateTypes = vi.mocked(listTemplateTypes);

const STANDARD: TemplateTypeListRow = {
  billTemplateFamilyId: "BTF00000001",
  name: "Standard",
  isDefault: true,
  status: "USABLE",
  activeVersionNo: 1,
  activeSince: new Date("2026-10-08T00:00:00Z"),
  retiredAt: null,
  boundBanCount: 4,
};
const WHOLESALE: TemplateTypeListRow = {
  billTemplateFamilyId: "BTF00000002",
  name: "Wholesale",
  isDefault: false,
  status: "NOT_YET_USABLE",
  activeVersionNo: null,
  activeSince: null,
  retiredAt: null,
  boundBanCount: 0,
};

function grant(level: "READ" | "EDIT") {
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: { invoice_settings: level } as never,
  });
}

function props(search: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(search) };
}

beforeEach(() => {
  vi.clearAllMocks();
  grant("EDIT");
  mockListTemplateTypes.mockResolvedValue([STANDARD, WHOLESALE]);
  vi.mocked(getAppLocale).mockResolvedValue("en-MY");
  vi.mocked(getAppTimezone).mockReturnValue("Asia/Kuala_Lumpur");
});

describe("InvoiceTemplateTypesPage (bm77)", () => {
  it("guards at invoice_settings : READ", async () => {
    await InvoiceTemplateTypesPage(props());
    expect(mockRequirePermission).toHaveBeenCalledWith(
      "invoice_settings",
      "READ",
    );
  });

  it("lists Standard as Usable with the Default chip, linking to its detail page", async () => {
    const { getByRole } = render(await InvoiceTemplateTypesPage(props()));
    const row = getByRole("link", { name: "Standard" }).closest("tr")!;
    expect(row.textContent).toContain("Usable");
    expect(row.querySelector('[data-default="true"]')).not.toBeNull();
    expect(row.textContent).toContain("v1");
    expect(getByRole("link", { name: "Standard" }).getAttribute("href")).toBe(
      "/administration/invoice-settings/invoice-template/BTF00000001",
    );
  });

  it("lists a created type as Not yet usable, with no active version", async () => {
    const { getByRole } = render(await InvoiceTemplateTypesPage(props()));
    const row = getByRole("link", { name: "Wholesale" }).closest("tr")!;
    expect(row.textContent).toContain("Not yet usable");
    expect(row.querySelector('[data-default="true"]')).toBeNull();
    expect(row.textContent).toContain("—");
  });

  it("shows a right-aligned Bound BANs column after Status, with each type's count (bm82)", async () => {
    const { getByRole, getAllByRole } = render(
      await InvoiceTemplateTypesPage(props()),
    );
    const headers = getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([
      "Name",
      "Status",
      "Bound BANs",
      "Active version",
      "Active since",
    ]);
    const header = getByRole("columnheader", { name: "Bound BANs" });
    expect(header.className).toContain("text-right");

    const cellOf = (name: string): HTMLElement => {
      const row = getByRole("link", { name }).closest("tr")!;
      return row.querySelectorAll("td")[2] as HTMLElement;
    };
    expect(cellOf("Standard").textContent).toBe("4");
    expect(cellOf("Wholesale").textContent).toBe("0");
    expect(cellOf("Standard").className).toContain("text-right");
    expect(cellOf("Standard").className).toContain("tabular-nums");
  });

  it("an EDIT user sees 'New invoice template type'; a READ user does not", async () => {
    const edit = render(await InvoiceTemplateTypesPage(props()));
    expect(
      edit.queryByRole("button", { name: "New invoice template type" }),
    ).not.toBeNull();
    edit.unmount();

    grant("READ");
    const read = render(await InvoiceTemplateTypesPage(props()));
    expect(
      read.queryByRole("button", { name: "New invoice template type" }),
    ).toBeNull();
  });

  it("hides retired types unless ?retired=1", async () => {
    mockListTemplateTypes.mockResolvedValue([
      STANDARD,
      {
        ...WHOLESALE,
        billTemplateFamilyId: "BTF00000003",
        name: "Old",
        status: "RETIRED",
        retiredAt: new Date("2026-10-20T00:00:00Z"),
      },
    ]);
    const hidden = render(await InvoiceTemplateTypesPage(props()));
    expect(hidden.queryByRole("link", { name: "Old" })).toBeNull();
    expect(
      hidden.queryByRole("link", { name: "Show retired types" }),
    ).not.toBeNull();
    hidden.unmount();

    const shown = render(
      await InvoiceTemplateTypesPage(props({ retired: "1" })),
    );
    expect(shown.queryByRole("link", { name: "Old" })).not.toBeNull();
  });

  it("an old ?tab=history&version=BTV… bookmark redirects to Standard's detail page with the same query", async () => {
    await expect(
      InvoiceTemplateTypesPage(
        props({ tab: "history", version: "BTV00000002" }),
      ),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(
        "/administration/invoice-settings/invoice-template/BTF00000001?tab=history&version=BTV00000002",
      ),
    });
  });
});
