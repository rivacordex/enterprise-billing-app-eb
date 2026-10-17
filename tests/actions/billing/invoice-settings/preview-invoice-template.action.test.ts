import { beforeEach, describe, expect, it, vi } from "vitest";

// bm55-spec §Tests — `previewInvoiceTemplateAction` through the REAL preview
// service, resolver, loaders, generator, binder and locked Handlebars. Mocked
// at the edges only: the guard, the repositories (DB rows), the DB client (a
// spy that records any DML) and the blob store (repo bytes + a `putObject`
// spy). Covers: READ allowed; no permission → FORBIDDEN; `{ billId }` without
// `billrun_view` → FORBIDDEN before any read; invalid structure →
// VALIDATION_ERROR; a posted bill → its stamped version, structure ignored;
// the rate limit; zero `putObject` and zero DML. bm66-spec §6 — the input
// names the template family (`familyId`, required and validated); unposted
// previews resolve that family's live versions (`preview-family`).

const dml = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/db/client", () => {
  const db = {
    ...dml,
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db };
});
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findActive: vi.fn(),
    findDefault: vi.fn(),
    findById: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: {
    findById: vi.fn(async (_db: unknown, id: string) => ({
      billTemplateFamilyId: id,
      retiredDatetime: null,
    })),
  },
}));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: { findActiveVersion: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { findPreviewTarget: vi.fn() },
}));
vi.mock("@/db/repositories/billing/invoice-render-input", () => ({
  invoiceRenderInputRepository: { readBillStamps: vi.fn(), read: vi.fn() },
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn().mockResolvedValue("en-MY"),
  getAppTimezone: vi.fn().mockReturnValue("Asia/Kuala_Lumpur"),
}));
vi.mock("@/services/billing/blob-store", async () => {
  const { repoBlobStoreModule } =
    await import("@/tests/helpers/seeded-invoice-template");
  return {
    blobStore: {
      ...repoBlobStoreModule.blobStore,
      getObject: vi.fn(repoBlobStoreModule.blobStore.getObject),
      putObject: vi.fn(),
      putInvoice: vi.fn(),
      putReport: vi.fn(),
    },
  };
});

import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import {
  SEEDED_FOOTNOTE,
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";
import type { InvoiceTemplateStructure } from "@/types/billing";
import {
  BARE_RAW_CUSTOMER,
  rawInvoiceRenderInputFixture,
} from "@/tests/helpers/invoice-render-input-fixtures";

const mockRequirePermission = vi.mocked(requirePermission);
const repo = vi.mocked(billTemplateVersionRepository);
const bills = vi.mocked(customerBillRepository);
const renderInput = vi.mocked(invoiceRenderInputRepository);

function redirectError(): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = "NEXT_REDIRECT;replace;/no-access;307;";
  return error;
}

const ALL_ON: InvoiceTemplateStructure = {
  sections: { payment: true },
  columns: {},
  footnote: [...SEEDED_FOOTNOTE],
};

// bm72 (D56 part 2): the footnote is the visible difference between a
// submitted structure and the stamped v1 (Notes & terms is gone).
const EDITED_LINE = "Edited footnote line";
const NO_PAYMENT_EDITED: InvoiceTemplateStructure = {
  sections: { payment: false },
  columns: {},
  footnote: [EDITED_LINE],
};

const CSV_ROW: BillTemplateVersion = {
  ...SEEDED_GENERATED_ROW,
  billTemplateVersionId: "BTV00000003",
  kind: "csv",
  refLayoutVersionId: null,
  structure: null,
  blobRef: "invoice-templates/system/csv/v1/",
};

// A newer ACTIVE generated version whose blobs do not exist — a posted bill
// stamped with v1 must never touch it (Inv #42).
const ACTIVE_V2: BillTemplateVersion = {
  ...SEEDED_GENERATED_ROW,
  billTemplateVersionId: "BTV00000009",
  versionNo: 2,
  isDefault: false,
  blobRef: "invoice-templates/generated/INVOICE/v2/",
};

const ROWS: Record<string, BillTemplateVersion> = {
  BTV00000001: SEEDED_LAYOUT_ROW,
  BTV00000002: SEEDED_GENERATED_ROW,
  BTV00000003: CSV_ROW,
};

// The shared fixture cut to its RM50 recurring line, on a customer with no
// optional fields; `posted` adds the INV document.
function rawBill(posted: boolean): RawInvoiceRenderInput {
  const base = rawInvoiceRenderInputFixture();
  return {
    ...base,
    bill: {
      ...base.bill,
      customerBillId: "CBL00000007",
      paymentDueDate: "2026-09-30",
      subtotal: "50.00",
      totalAmount: "50.00",
      linesNetSum: "50.00",
      grossTotal: "50.00",
      otherChargesSubTotal: "50.00",
      summaryBlocksSum: "50.00",
    },
    run: { ...base.run, billRunId: "BRN00000004" },
    lines: [base.lines[0]!],
    otherCharges: [base.otherCharges[0]!],
    document: posted
      ? { documentId: "INV00000077", postingDate: new Date("2026-09-01") }
      : null,
    customer: { ...BARE_RAW_CUSTOMER },
  };
}

function setPermissions(map: Record<string, string>, userId = "user-1"): void {
  mockRequirePermission.mockResolvedValue({
    userId,
    userEmail: `${userId}@example.com`,
    permissionMap: map as never,
  });
}

let userSeq = 0;

// bm66 — the Standard family the page hands the form.
const FAMILY = "BTF00000001";

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh principal per test keeps the in-memory rate limiter independent.
  userSeq += 1;
  setPermissions(
    { invoice_settings: "READ", billrun_view: "READ" },
    `user-${userSeq}`,
  );
  repo.findActive.mockResolvedValue(null);
  repo.findDefault.mockImplementation(async (_db, { kind }) =>
    kind === "generated"
      ? SEEDED_GENERATED_ROW
      : kind === "layout"
        ? SEEDED_LAYOUT_ROW
        : CSV_ROW,
  );
  repo.findById.mockImplementation(async (_db, id) => ROWS[id] ?? null);

  vi.mocked(invoiceProfileRepository.findActiveVersion).mockResolvedValue(null);
});

function expectNoWrites(): void {
  expect(vi.mocked(blobStore.putObject)).not.toHaveBeenCalled();
  expect(vi.mocked(blobStore.putInvoice)).not.toHaveBeenCalled();
  expect(vi.mocked(blobStore.putReport)).not.toHaveBeenCalled();
  for (const fn of Object.values(dml)) expect(fn).not.toHaveBeenCalled();
}

describe("previewInvoiceTemplateAction — familyId (bm66)", () => {
  it("requires familyId: a missing id is VALIDATION_ERROR, before any read", async () => {
    const result = await previewInvoiceTemplateAction({
      structure: ALL_ON,
      source: "sample",
    });
    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(repo.findDefault).not.toHaveBeenCalled();
  });

  it("rejects a malformed familyId (not BTF + digits) as VALIDATION_ERROR", async () => {
    for (const familyId of ["BTV00000002", "BTF", "btf00000001", 1]) {
      const result = await previewInvoiceTemplateAction({
        structure: ALL_ON,
        source: "sample",
        familyId,
      });
      expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    }
    expect(repo.findDefault).not.toHaveBeenCalled();
  });

  it("the sample preview resolves the named family's versions", async () => {
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: "sample",
    });
    expect(result.ok).toBe(true);
    expect(repo.findActive).toHaveBeenCalledWith(expect.anything(), {
      kind: "generated",
      familyId: FAMILY,
    });
  });
});

describe("previewInvoiceTemplateAction — authz and validation", () => {
  it("guards on invoice_settings : READ", async () => {
    await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: "sample",
    });
    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.READ,
    );
  });

  it("returns FORBIDDEN without invoice_settings (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError());
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: "sample",
    });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(repo.findDefault).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN for a { billId } source without billrun_view, before any read", async () => {
    setPermissions({ invoice_settings: "EDIT" }, `user-${userSeq}-nobill`);
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: { billId: "CBL00000007" },
    });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(bills.findPreviewTarget).not.toHaveBeenCalled();
    expect(renderInput.readBillStamps).not.toHaveBeenCalled();
    expect(renderInput.read).not.toHaveBeenCalled();
    expect(repo.findDefault).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a mandatory section key",
      { ...ALL_ON, sections: { ...ALL_ON.sections, billTo: false } },
    ],
    [
      "the retired usageAnnex section",
      { ...ALL_ON, sections: { ...ALL_ON.sections, usageAnnex: true } },
    ],
    ["an unknown key", { ...ALL_ON, extra: true }],
    ["a column key", { ...ALL_ON, columns: { showDiscountColumn: true } }],
  ])("returns VALIDATION_ERROR for %s", async (_label, structure) => {
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure,
      source: "sample",
    });
    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("returns VALIDATION_ERROR for a malformed bill id", async () => {
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: { billId: "INV00000001" },
    });
    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("rate-limits at 30 previews per 60 s per user", async () => {
    let last: Awaited<ReturnType<typeof previewInvoiceTemplateAction>> | null =
      null;
    for (let i = 0; i < 31; i++) {
      last = await previewInvoiceTemplateAction({
        familyId: FAMILY,
        // Valid input that reaches the limiter (a validation failure returns
        // before it); a missing bill keeps each call cheap.
        structure: ALL_ON,
        source: { billId: "CBL00000099" },
      });
      if (i < 30) expect(last).toEqual({ ok: false, code: "NOT_FOUND" });
    }
    expect(last).toEqual({ ok: false, code: "RATE_LIMITED" });
  });
});

describe("previewInvoiceTemplateAction — sample source", () => {
  it("renders the sample bill from the submitted structure as a draft, writing nothing", async () => {
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: NO_PAYMENT_EDITED,
      source: "sample",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pinnedVersionNo).toBeNull();
    expect(result.templateLabel).toContain("INVTPL-STD-A4 v1");
    expect(result.html).toContain("DRAFT&nbsp;&middot;&nbsp;PRO-FORMA");
    expect(result.html).toContain("Acme Communications Sdn Bhd");
    expect(result.html).not.toContain("sec--payment");
    // bm72 — the submitted footnote, not the sample's.
    expect(result.html).toContain(EDITED_LINE);
    expect(result.html).not.toContain(SEEDED_FOOTNOTE[0]);
    // No profile ACTIVE (G15 A): no issuer block.
    expect(result.html).not.toContain("Sample Telco Sdn Bhd");
    expectNoWrites();
  });

  it("adds the annotate/outline preview styles only on request", async () => {
    const plain = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: "sample",
    });
    const styled = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: "sample",
      annotate: true,
      outline: true,
    });
    if (!plain.ok || !styled.ok) throw new Error("expected ok");
    expect(plain.html).not.toContain('data-preview="true"');
    expect(styled.html).toContain(".ph { background:#E2F8FA; color:#006975 }");
    expect(styled.html).toContain(".sec { outline:1px dashed #99A1B0 }");
    expect(styled.html).toContain('<span class="ph" data-ph="customer.name">');
    expectNoWrites();
  });
});

describe("previewInvoiceTemplateAction — bill source", () => {
  it("a POSTED bill renders its stamped version as issued; the submitted structure is ignored", async () => {
    repo.findActive.mockResolvedValue(ACTIVE_V2);
    bills.findPreviewTarget.mockResolvedValue({
      customerBillId: "CBL00000007",
      billRunId: "BRN00000004",
      billingAccountId: "BAN00000001",
      refInvDocumentId: "INV00000077",
      refBillTemplateVersionId: "BTV00000002",
    });
    renderInput.readBillStamps.mockResolvedValue({
      refBillTemplateFamilyId: "BTF00000001",
      refBillTemplateVersionId: "BTV00000002",
      refInvoiceProfileVersion: null,
      refCsvTemplateVersionId: "BTV00000003",
      refInvDocumentId: "INV00000001",
    });
    renderInput.read.mockResolvedValue(rawBill(true));

    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: NO_PAYMENT_EDITED,
      source: { billId: "CBL00000007" },
      annotate: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pinnedVersionNo).toBe(1);
    expect(result.templateLabel).toContain("Template v1 (as issued)");
    // The stamped v1 and its footnote, not the submitted structure.
    expect(result.html).toContain(SEEDED_FOOTNOTE[0]);
    expect(result.html).not.toContain(EDITED_LINE);
    expect(result.html).toContain("INV00000077");
    expect(result.html).toContain("<title>Tax invoice INV00000077</title>");
    expect(result.html).not.toContain("PRO-FORMA&nbsp;&middot;");
    // A stored template is never re-generated, so it is never annotated.
    expect(result.html).not.toContain('class="ph"');
    // The current ACTIVE (v2) is never resolved or loaded.
    expect(repo.findActive).not.toHaveBeenCalled();
    expect(vi.mocked(blobStore.getObject)).not.toHaveBeenCalledWith(
      "invoice-templates",
      expect.stringContaining("generated/INVOICE/v2/"),
    );
    expectNoWrites();
  });

  it("an UNPOSTED bill renders the submitted structure through the binder as a draft", async () => {
    bills.findPreviewTarget.mockResolvedValue({
      customerBillId: "CBL00000007",
      billRunId: "BRN00000004",
      billingAccountId: "BAN00000001",
      refInvDocumentId: null,
      refBillTemplateVersionId: null,
    });
    renderInput.readBillStamps.mockResolvedValue({
      refBillTemplateFamilyId: null,
      refBillTemplateVersionId: null,
      refInvoiceProfileVersion: null,
      refCsvTemplateVersionId: null,
      refInvDocumentId: null,
    });
    renderInput.read.mockResolvedValue(rawBill(false));

    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: NO_PAYMENT_EDITED,
      source: { billId: "CBL00000007" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pinnedVersionNo).toBeNull();
    expect(result.html).toContain("Enterprise Fibre 1Gbps");
    expect(result.html).toContain("DRAFT&nbsp;&middot;&nbsp;PRO-FORMA");
    expect(result.html).toContain(EDITED_LINE);
    expect(result.html).not.toContain(SEEDED_FOOTNOTE[0]);
    expectNoWrites();
  });

  it("returns NOT_FOUND for an unknown bill", async () => {
    bills.findPreviewTarget.mockResolvedValue(null);
    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: { billId: "CBL00000099" },
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("maps a pipeline failure to PREVIEW_FAILED with its code", async () => {
    bills.findPreviewTarget.mockResolvedValue({
      customerBillId: "CBL00000007",
      billRunId: "BRN00000004",
      billingAccountId: "BAN00000001",
      refInvDocumentId: null,
      refBillTemplateVersionId: null,
    });
    renderInput.readBillStamps.mockResolvedValue({
      refBillTemplateFamilyId: null,
      refBillTemplateVersionId: null,
      refInvoiceProfileVersion: null,
      refCsvTemplateVersionId: null,
      refInvDocumentId: null,
    });
    renderInput.read.mockResolvedValue({
      ...rawBill(false),
      bill: { ...rawBill(false).bill, linesNetSum: "49.99" },
    });

    const result = await previewInvoiceTemplateAction({
      familyId: FAMILY,
      structure: ALL_ON,
      source: { billId: "CBL00000007" },
    });
    expect(result).toEqual({
      ok: false,
      code: "PREVIEW_FAILED",
      detail: "INVOICE_RECONCILIATION_FAILED",
    });
    expectNoWrites();
  });
});
