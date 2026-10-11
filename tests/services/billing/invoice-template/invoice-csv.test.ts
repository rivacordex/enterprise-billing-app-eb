import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm62-spec §Tests — `buildInvoiceCsv` (pure, D2/D3), its path resolver, the
// map-shape check (unknown roots rejected at load), and `getPostedInvoiceCsv`'s
// orchestration (D1: posted only, stamped CSV map, no usage read).

vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  },
}));
vi.mock("@/db/repositories/billing/invoice-render-input", () => ({
  invoiceRenderInputRepository: { read: vi.fn(), readBillStamps: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({ blobStore: {} }));
vi.mock("@/services/billing/invoice-template/load", async (importOriginal) => {
  const actual = await importOriginal<typeof LoadModule>();
  return { ...actual, loadCsvMap: vi.fn() };
});
vi.mock("@/services/billing/invoice-template/resolve-template", () => ({
  resolveTemplate: vi.fn(),
}));
vi.mock("@/services/billing/invoice-profile/read-profile", () => ({
  readInvoiceProfile: vi.fn(),
}));
vi.mock("@/services/billing/invoice-template/bind", () => ({
  bind: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn().mockResolvedValue("en-MY"),
  getAppTimezone: vi.fn().mockReturnValue("Asia/Kuala_Lumpur"),
}));

import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import type * as LoadModule from "@/services/billing/invoice-template/load";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { readInvoiceProfile } from "@/services/billing/invoice-profile/read-profile";
import { bind } from "@/services/billing/invoice-template/bind";
import {
  buildInvoiceCsv,
  getPostedInvoiceCsv,
  resolveCsvPath,
} from "@/services/billing/invoice-template/invoice-csv";
import {
  csvColumnMapSchema,
  loadCsvMap,
  type CsvColumnMap,
} from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import {
  FinalInvoiceNotFoundError,
  InvoiceRenderError,
  type InvoiceLine,
  type InvoiceProfile,
  type InvoiceRenderInput,
  type ResolvedTemplate,
} from "@/types/billing";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

const SEEDED_MAP: CsvColumnMap = csvColumnMapSchema.parse(
  JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "db/seeds/invoice-templates/system/csv/v1/invoice.csv.columns.json",
      ),
      "utf-8",
    ),
  ),
);

const BOM = "﻿";

function line(
  lineNo: number,
  overrides: Partial<InvoiceLine> = {},
): InvoiceLine {
  return {
    lineNo,
    source: "RECURRING",
    description: `Line ${lineNo}`,
    productOfferingId: "PO00000001",
    udrType: null,
    udrCount: null,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    quantity: "1.000000",
    unit: "MONTH",
    unitPrice: "1234.50",
    grossAmount: "1234.50",
    discountAmount: "0.00",
    netAmount: "1234.50",
    discountNote: null,
    ...overrides,
  };
}

function input(
  overrides: Partial<InvoiceRenderInput> = {},
): InvoiceRenderInput {
  return {
    template: { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 },
    company: null,
    payment: null,
    invoice: {
      number: "INV00000007",
      isDraft: false,
      date: "2026-10-01",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      dueDate: "2026-10-31",
      paymentTermsDays: null,
      currency: "MYR",
      billRunId: "BRN00000001",
      cycleName: "Monthly",
      billRef: "CBL00000001",
      poRef: null,
      contractRef: null,
    },
    customer: {
      billingAccountId: "BAN00000001",
      name: "Acme Sdn Bhd",
      tradingName: null,
      registrationNo: null,
      tin: null,
      sstRegNo: null,
      address: null,
      email: null,
      phone: null,
    },
    totals: {
      grossTotal: "0.00",
      discountTotal: "0.00",
      subtotalExclTax: "0.00",
      taxTotal: "0.00",
      totalAmount: "0.00",
      amountDue: "0.00",
    },
    taxes: [],
    chargeSummary: [],
    lineGroups: [],
    usage: null,
    isDraft: false,
    locale: "en-MY",
    timezone: "Asia/Kuala_Lumpur",
    ...overrides,
  };
}

const MINI_MAP: CsvColumnMap = {
  templateId: "INVTPL-CSV-TEST",
  version: 1,
  rowSource: "lines",
  encoding: "utf-8-bom",
  lineEnding: "CRLF",
  columns: [
    { header: "line_no", path: "line.lineNo" },
    { header: "description", path: "line.description" },
    { header: "net_amount", path: "line.netAmount" },
  ],
};

// Splits the CSV body (after the BOM) into its CRLF-terminated records.
function records(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  return csv.slice(1, -2).split("\r\n");
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof InvoiceRenderError ? err.code : "untyped";
  }
  return undefined;
}

describe("buildInvoiceCsv (D2/D3)", () => {
  it("writes the header row in the map's order", () => {
    const csv = buildInvoiceCsv(SEEDED_MAP, input(), [line(1)]);
    expect(records(csv)[0]).toBe(
      SEEDED_MAP.columns.map((c) => c.header).join(","),
    );
  });

  it("writes one row per line, in the order given", () => {
    const rows = [line(1), line(2), line(3)];
    const csv = buildInvoiceCsv(MINI_MAP, input(), rows);
    const body = records(csv).slice(1);
    expect(body).toHaveLength(3);
    expect(body.map((r) => r.split(",")[0])).toEqual(["1", "2", "3"]);
  });

  it("keeps raw amount strings: a negative is not prefixed, nothing is grouped", () => {
    const csv = buildInvoiceCsv(MINI_MAP, input(), [
      line(1, { netAmount: "-12.50" }),
      line(2, { netAmount: "1234.50" }),
    ]);
    const body = records(csv).slice(1);
    expect(body[0]).toBe("1,Line 1,-12.50");
    expect(body[1]).toBe("2,Line 2,1234.50");
  });

  it("neutralises a formula-leading text cell with a quote", () => {
    const csv = buildInvoiceCsv(MINI_MAP, input(), [
      line(1, { description: '=HYPERLINK("http://x","y")' }),
      line(2, { description: "-not a number" }),
      line(3, { description: "@SUM(A1)" }),
    ]);
    const body = records(csv).slice(1);
    expect(body[0]).toBe(`1,"'=HYPERLINK(""http://x"",""y"")",1234.50`);
    expect(body[1]).toBe("2,'-not a number,1234.50");
    expect(body[2]).toBe("3,'@SUM(A1),1234.50");
  });

  it("quotes commas, double quotes and newlines (RFC 4180)", () => {
    const csv = buildInvoiceCsv(MINI_MAP, input(), [
      line(1, { description: "a, b" }),
      line(2, { description: 'say "hi"' }),
      line(3, { description: "two\nlines" }),
    ]);
    const text = csv.slice(1);
    expect(text).toContain('1,"a, b",1234.50\r\n');
    expect(text).toContain('2,"say ""hi""",1234.50\r\n');
    expect(text).toContain('3,"two\nlines",1234.50\r\n');
  });

  it("starts with a UTF-8 BOM and ends every row with CRLF", () => {
    const csv = buildInvoiceCsv(MINI_MAP, input(), [line(1), line(2)]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(
      `${BOM}line_no,description,net_amount\r\n1,Line 1,1234.50\r\n2,Line 2,1234.50\r\n`,
    );
    expect(Buffer.from(csv, "utf-8").subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it("leaves null cells empty (no profile: supplier columns blank)", () => {
    const csv = buildInvoiceCsv(SEEDED_MAP, input(), [line(1)]);
    const headers = records(csv)[0]!.split(",");
    const cells = records(csv)[1]!.split(",");
    const at = (h: string) => cells[headers.indexOf(h)];
    expect(at("supplier_name")).toBe("");
    expect(at("supplier_tin")).toBe("");
    expect(at("customer_tin")).toBe("");
    expect(at("udr_type")).toBe("");
    expect(at("invoice_number")).toBe("INV00000007");
    expect(at("invoice_date")).toBe("2026-10-01");
    expect(at("net_amount")).toBe("1234.50");
  });

  it("resolves an unknown path to an empty cell", () => {
    const map: CsvColumnMap = {
      ...MINI_MAP,
      columns: [
        ...MINI_MAP.columns,
        { header: "nope", path: "line.notAField" },
        { header: "deep", path: "invoice.number.length" },
      ],
    };
    const body = records(buildInvoiceCsv(map, input(), [line(1)]))[1];
    expect(body).toBe("1,Line 1,1234.50,,");
  });

  it("emits no rows (header only) for a bill with no lines", () => {
    expect(buildInvoiceCsv(MINI_MAP, input(), [])).toBe(
      `${BOM}line_no,description,net_amount\r\n`,
    );
  });

  it("rejects an unsupported encoding or line ending as TEMPLATE_COMPILE_FAILED", () => {
    const badEncoding = { ...MINI_MAP, encoding: "latin1" } as never;
    const badEol = { ...MINI_MAP, lineEnding: "LF" } as never;
    expect(codeOf(() => buildInvoiceCsv(badEncoding, input(), []))).toBe(
      "TEMPLATE_COMPILE_FAILED",
    );
    expect(codeOf(() => buildInvoiceCsv(badEol, input(), []))).toBe(
      "TEMPLATE_COMPILE_FAILED",
    );
  });

  it("rejects a map with no net_amount column (guardrail 55 cannot hold)", () => {
    const map: CsvColumnMap = {
      ...MINI_MAP,
      columns: MINI_MAP.columns.filter((c) => c.path !== "line.netAmount"),
    };
    expect(codeOf(() => buildInvoiceCsv(map, input(), [line(1)]))).toBe(
      "TEMPLATE_COMPILE_FAILED",
    );
  });

  it("fails (a CSV-code defect, not the bill's 409) when a net amount would be reformatted, never adjusting it", () => {
    // A non-decimal net string would be escaped, so the emitted cell no
    // longer equals the stored amount.
    expect(() =>
      buildInvoiceCsv(MINI_MAP, input(), [line(1, { netAmount: "+5.00" })]),
    ).toThrow(/emitted net_amount cells differ/);
    expect(
      codeOf(() =>
        buildInvoiceCsv(MINI_MAP, input(), [line(1, { netAmount: "+5.00" })]),
      ),
    ).toBe("untyped");
  });

  it("carries no per-line tax column in the seeded v1 map (Inv #50)", () => {
    expect(SEEDED_MAP.columns.some((c) => /tax/i.test(c.header))).toBe(false);
  });
});

describe("resolveCsvPath", () => {
  it("reads own properties only, never the prototype chain", () => {
    expect(resolveCsvPath({ a: { b: 1 } }, "a.b")).toBe("1");
    expect(resolveCsvPath({ a: {} }, "a.constructor")).toBe("");
    expect(resolveCsvPath({ a: {} }, "a.toString")).toBe("");
  });

  it("renders null, objects and arrays as empty cells", () => {
    expect(resolveCsvPath({ a: null }, "a")).toBe("");
    expect(resolveCsvPath({ a: { b: 1 } }, "a")).toBe("");
    expect(resolveCsvPath({ a: [1] }, "a")).toBe("");
    expect(resolveCsvPath({ a: false }, "a")).toBe("false");
  });
});

describe("csvColumnMapSchema (map shape, checked at load)", () => {
  function withPath(p: string) {
    return {
      ...MINI_MAP,
      columns: [...MINI_MAP.columns, { header: "x", path: p }],
    };
  }

  it("accepts the seeded v1 map", () => {
    expect(SEEDED_MAP.columns).toHaveLength(26);
  });

  it("rejects an unknown root", () => {
    expect(
      csvColumnMapSchema.safeParse(withPath("bill.subtotal")).success,
    ).toBe(false);
    expect(csvColumnMapSchema.safeParse(withPath("process.env")).success).toBe(
      false,
    );
  });

  it("rejects non-identifier segments", () => {
    for (const p of ["line.__proto__", "line[0]", "line..netAmount", "{{x}}"]) {
      expect(csvColumnMapSchema.safeParse(withPath(p)).success).toBe(false);
    }
  });
});

describe("getPostedInvoiceCsv (D1)", () => {
  const mockStamps = vi.mocked(invoiceRenderInputRepository.readBillStamps);
  const mockRead = vi.mocked(invoiceRenderInputRepository.read);
  const mockResolve = vi.mocked(resolveTemplate);
  const mockReadProfile = vi.mocked(readInvoiceProfile);
  const mockLoadCsvMap = vi.mocked(loadCsvMap);
  const mockBind = vi.mocked(bind);

  const CSV_ROW = { ...SEEDED_GENERATED_ROW, kind: "csv" };
  const RESOLVED: ResolvedTemplate = {
    generated: SEEDED_GENERATED_ROW,
    layout: { ...SEEDED_GENERATED_ROW, kind: "layout", layoutCode: "L" },
    profileVersion: 4,
    csv: CSV_ROW,
  };
  const RAW = {
    bill: {},
    lines: [{}, {}, {}],
  } as unknown as RawInvoiceRenderInput;
  const PROFILE = { configVersion: 4 } as unknown as InvoiceProfile;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStamps.mockResolvedValue({
      refBillTemplateVersionId: "BTV00000002",
      refInvoiceProfileVersion: 4,
      refCsvTemplateVersionId: "BTV00000003",
      refInvDocumentId: "INV00000007",
    });
    mockResolve.mockResolvedValue(RESOLVED);
    mockRead.mockResolvedValue(RAW);
    mockReadProfile.mockResolvedValue({ profile: PROFILE, logo: null });
    mockLoadCsvMap.mockResolvedValue(MINI_MAP);
    mockBind.mockReturnValue(
      input({
        lineGroups: [
          {
            name: "Usage charges",
            source: "USAGE",
            grossTotal: "0",
            discountTotal: "0",
            subtotal: "0",
            lines: [line(3), line(1)],
          },
          {
            name: "Other charges",
            source: "OCC",
            grossTotal: "0",
            discountTotal: "0",
            subtotal: "0",
            lines: [line(2)],
          },
        ],
      }),
    );
  });

  it("404s (FinalInvoiceNotFoundError) an unknown or unposted bill before resolving anything", async () => {
    mockStamps.mockResolvedValueOnce(null);
    await expect(
      getPostedInvoiceCsv({ runId: "BRN00000001", banId: "BAN00000001" }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);

    mockStamps.mockResolvedValueOnce({
      refBillTemplateVersionId: null,
      refInvoiceProfileVersion: null,
      refCsvTemplateVersionId: null,
      refInvDocumentId: null,
    });
    await expect(
      getPostedInvoiceCsv({ runId: "BRN00000001", banId: "BAN00000001" }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockLoadCsvMap).not.toHaveBeenCalled();
  });

  it("resolves the bill's stamps, loads the stamped CSV map, and binds final without usage", async () => {
    const result = await getPostedInvoiceCsv({
      runId: "BRN00000001",
      banId: "BAN00000001",
    });

    expect(mockResolve).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        kind: "final",
        bill: expect.objectContaining({
          refCsvTemplateVersionId: "BTV00000003",
        }),
      }),
    );
    expect(mockRead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ includeUsage: false }),
    );
    expect(mockLoadCsvMap).toHaveBeenCalledWith(CSV_ROW);
    expect(mockBind).toHaveBeenCalledWith(
      RAW,
      expect.objectContaining({
        isDraft: false,
        includeUsage: false,
        profile: PROFILE,
      }),
    );
    expect(result.invoiceNumber).toBe("INV00000007");
    // line_no order across the groups (Inv #21).
    expect(
      records(result.csv)
        .slice(1)
        .map((r) => r.split(",")[0]),
    ).toEqual(["1", "2", "3"]);
  });

  it("binds a null profile when the bill has none stamped", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, profileVersion: null });
    await getPostedInvoiceCsv({ runId: "BRN00000001", banId: "BAN00000001" });
    expect(mockReadProfile).not.toHaveBeenCalled();
    expect(mockBind).toHaveBeenCalledWith(
      RAW,
      expect.objectContaining({ profile: null }),
    );
  });

  it("fails (500, not 409) when the bound groups drop a bill line", async () => {
    mockRead.mockResolvedValue({
      bill: { customerBillId: "CBL1" },
      lines: [{}, {}, {}, {}],
    } as unknown as RawInvoiceRenderInput);
    await expect(
      getPostedInvoiceCsv({ runId: "BRN00000001", banId: "BAN00000001" }),
    ).rejects.toThrow(/4 lines but 3 bound/);
  });

  it("propagates the binder's reconciliation failure (no file)", async () => {
    mockBind.mockImplementation(() => {
      throw new InvoiceRenderError("INVOICE_RECONCILIATION_FAILED", "x");
    });
    await expect(
      getPostedInvoiceCsv({ runId: "BRN00000001", banId: "BAN00000001" }),
    ).rejects.toMatchObject({ code: "INVOICE_RECONCILIATION_FAILED" });
  });
});
