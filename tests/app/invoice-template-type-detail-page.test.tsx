import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm77-spec §11 — an invoice template TYPE's detail page, `[typeId]`:
// Standard renders today's tabs and heading (with "(default)"), its layout
// code and next layout version; a Not-yet-usable type renders the Info empty
// state and no tabs body; an unknown or malformed `typeId` is `notFound()`;
// the type and `?version=` reach the read service, which falls a foreign
// version back to the type's own (invoice-template-settings.test.ts).

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/invoice-template-settings", () => ({
  getInvoiceTemplatePageData: vi.fn(),
  getGeneratedHbsSources: vi.fn(),
  listRecentPostedBills: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn(),
  getAppTimezone: vi.fn(),
}));
// Client islands whose actions pull the db/service graph.
const formProps = vi.hoisted(() => ({ last: null as unknown }));
vi.mock("@/components/billing/invoice-settings/invoice-structure-form", () => ({
  InvoiceStructureForm: (props: unknown) => {
    formProps.last = props;
    return <div data-testid="structure-form" />;
  },
}));
// bm78 — the upload dialog's action pulls the db/service graph.
vi.mock("@/components/billing/invoice-settings/upload-layout-dialog", () => ({
  UploadLayoutDialog: (props: { openLayoutDraft: unknown }) => (
    <button
      type="button"
      data-testid="upload-layout"
      disabled={props.openLayoutDraft !== null}
    >
      Upload layout package
    </button>
  ),
}));
vi.mock("@/components/billing/invoice-settings/generated-hbs-viewer", () => ({
  GeneratedHbsViewer: () => <div data-testid="generated-viewer" />,
}));
vi.mock("@/components/billing/invoice-settings/invoice-settings-tabs", () => ({
  InvoiceSettingsTabs: () => <nav data-testid="invoice-settings-tabs" />,
}));

import InvoiceTemplateTypePage from "@/app/(app)/administration/invoice-settings/invoice-template/[typeId]/page";
import { requirePermission } from "@/auth/guard";
import { getInvoiceTemplatePageData } from "@/services/billing/read/invoice-template-settings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import {
  SEEDED_FOOTNOTE,
  SEEDED_GENERATED_ROW,
} from "@/tests/helpers/seeded-invoice-template";

const mockRequirePermission = vi.mocked(requirePermission);
const mockPageData = vi.mocked(getInvoiceTemplatePageData);

const STRUCTURE = {
  sections: { payment: true },
  columns: {},
  footnote: [...SEEDED_FOOTNOTE],
};

const STANDARD_DATA = {
  typeId: "BTF00000001",
  typeName: "Standard",
  typeStatus: "USABLE" as const,
  isDefaultType: true,
  layoutCode: "INVTPL-STD-A4",
  nextLayoutVersionNo: 2,
  openLayoutDraft: null,
  empty: false as const,
  current: SEEDED_GENERATED_ROW,
  shown: SEEDED_GENERATED_ROW,
  defaultShown: SEEDED_GENERATED_ROW,
  draft: null,
  shownStructure: STRUCTURE,
  currentStructure: STRUCTURE,
  history: [],
};

const EMPTY_DATA = {
  typeId: "BTF00000002",
  typeName: "Wholesale",
  typeStatus: "NOT_YET_USABLE" as const,
  isDefaultType: false,
  layoutCode: "INVTPL-WHOLESALE",
  nextLayoutVersionNo: 1,
  openLayoutDraft: null,
  empty: true as const,
  current: null,
  history: [] as [],
};

function props(typeId: string, search: Record<string, string> = {}) {
  return {
    params: Promise.resolve({ typeId }),
    searchParams: Promise.resolve(search),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  formProps.last = null;
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: { invoice_settings: "EDIT" } as never,
  });
  mockPageData.mockResolvedValue(STANDARD_DATA);
  vi.mocked(getAppLocale).mockResolvedValue("en-MY");
  vi.mocked(getAppTimezone).mockReturnValue("Asia/Kuala_Lumpur");
});

describe("InvoiceTemplateTypePage (bm77)", () => {
  it("guards at invoice_settings : READ", async () => {
    await InvoiceTemplateTypePage(props("BTF00000001"));
    expect(mockRequirePermission).toHaveBeenCalledWith(
      "invoice_settings",
      "READ",
    );
  });

  it("Standard renders today's tabs, the heading with (default), layout code and next layout version", async () => {
    const { getByRole, getByText, getByTestId } = render(
      await InvoiceTemplateTypePage(props("BTF00000001")),
    );
    const heading = getByRole("heading", { level: 2 });
    expect(heading.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Invoice template type — Standard (default)",
    );
    expect(getByText("INVTPL-STD-A4")).toBeTruthy();
    expect(getByText("v2")).toBeTruthy();
    expect(getByText("Usable")).toBeTruthy();
    expect(
      getByRole("navigation", { name: "Invoice template tabs" }),
    ).toBeTruthy();
    expect(getByTestId("structure-form")).toBeTruthy();
    expect(formProps.last).toMatchObject({ familyId: "BTF00000001" });
    expect(
      getByRole("link", { name: "← All invoice template types" }).getAttribute(
        "href",
      ),
    ).toBe("/administration/invoice-settings/invoice-template");
  });

  it("a Not-yet-usable type renders the Info empty state and no tabs body", async () => {
    mockPageData.mockResolvedValue(EMPTY_DATA);
    const { getByText, queryByRole, queryByTestId, getByRole } = render(
      await InvoiceTemplateTypePage(props("BTF00000002")),
    );
    expect(
      getByText(
        "No layout uploaded yet. Upload a layout package to create the first draft.",
      ),
    ).toBeTruthy();
    expect(
      getByRole("heading", { level: 2 }).textContent?.replace(/\s+/g, " "),
    ).toBe("Invoice template type — Wholesale");
    expect(getByText("Not yet usable")).toBeTruthy();
    expect(getByText("INVTPL-WHOLESALE")).toBeTruthy();
    expect(
      queryByRole("navigation", { name: "Invoice template tabs" }),
    ).toBeNull();
    expect(queryByTestId("structure-form")).toBeNull();
  });

  it("an unknown typeId is notFound()", async () => {
    mockPageData.mockResolvedValue(null);
    await expect(
      InvoiceTemplateTypePage(props("BTF00009999")),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("a malformed typeId is notFound() and never reaches the service", async () => {
    await expect(
      InvoiceTemplateTypePage(props("not-a-type")),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mockPageData).not.toHaveBeenCalled();
  });

  it("passes the type and ?version= to the read service, which owns the same-type fallback", async () => {
    await InvoiceTemplateTypePage(
      props("BTF00000001", { version: "BTV00000099" }),
    );
    expect(mockPageData).toHaveBeenCalledWith("BTF00000001", "BTV00000099", {
      canEdit: true,
    });
  });
});
