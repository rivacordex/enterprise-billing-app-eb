import { beforeEach, describe, expect, it, vi } from "vitest";

// bm47-spec §Implementation §5, D1 / bm53-spec §Design D5 — `buildInvoiceHtml`'s
// own orchestration: one repeatable-read, read-only transaction for every DB
// read (stamps → resolve → raw input → profile rows), blob I/O only after it
// closes, the mode-appropriate not-found error, and `includeUsage` derived
// from the resolved structure.

const events: string[] = [];
const transactionOptions: unknown[] = [];
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown, opts: unknown) => {
      transactionOptions.push(opts);
      events.push("txn:open");
      const result = await cb({});
      events.push("txn:close");
      return result;
    }),
  },
}));
vi.mock("@/db/repositories/billing/invoice-render-input", () => ({
  invoiceRenderInputRepository: { read: vi.fn(), readBillStamps: vi.fn() },
}));
vi.mock("@/services/billing/invoice-template/resolve-template", () => ({
  resolveTemplate: vi.fn(),
}));
vi.mock("@/services/billing/invoice-template/load", () => ({
  loadGenerated: vi.fn(),
}));
vi.mock("@/services/billing/invoice-profile/read-profile", () => ({
  readInvoiceProfile: vi.fn(),
  inlineLogo: vi.fn(),
}));
vi.mock("@/services/billing/invoice-template/bind", () => ({
  bind: vi.fn(() => ({ bound: true })),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn().mockResolvedValue("en-MY"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));

import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
} from "@/types/billing";
import type { InvoiceProfile, ResolvedTemplate } from "@/types/billing";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { bind } from "@/services/billing/invoice-template/bind";
import { loadGenerated } from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import {
  inlineLogo,
  readInvoiceProfile,
} from "@/services/billing/invoice-profile/read-profile";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

const mockRead = vi.mocked(invoiceRenderInputRepository.read);
const mockStamps = vi.mocked(invoiceRenderInputRepository.readBillStamps);
const mockResolve = vi.mocked(resolveTemplate);
const mockLoad = vi.mocked(loadGenerated);
const mockReadProfile = vi.mocked(readInvoiceProfile);
const mockInlineLogo = vi.mocked(inlineLogo);
const mockBind = vi.mocked(bind);

const NULL_STAMPS = {
  refBillTemplateVersionId: null,
  refInvoiceProfileVersion: null,
  refCsvTemplateVersionId: null,
};

const LAYOUT = {
  ...SEEDED_GENERATED_ROW,
  billTemplateVersionId: "BTV00000001",
  kind: "layout",
  layoutCode: "INVTPL-STD-A4",
  refLayoutVersionId: null,
  structure: null,
  pageSetup: {
    format: "A4" as const,
    orientation: "portrait" as const,
    margin: { top: "13mm", bottom: "16mm", left: "14mm", right: "14mm" },
    displayHeaderFooter: true,
    printBackground: true,
  },
};

function resolved(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return {
    generated: SEEDED_GENERATED_ROW,
    layout: LAYOUT,
    profileVersion: null,
    csv: { ...SEEDED_GENERATED_ROW, kind: "csv" },
    ...overrides,
  };
}

const HIDDEN_USAGE_GENERATED = {
  ...SEEDED_GENERATED_ROW,
  billTemplateVersionId: "BTV00000009",
  versionNo: 2,
  isDefault: false,
  structure: {
    ...SEEDED_GENERATED_ROW.structure!,
    sections: {
      ...SEEDED_GENERATED_ROW.structure!.sections,
      usageAnnex: false,
    },
  },
};

const RAW = { bill: {} } as unknown as RawInvoiceRenderInput;
const PROFILE = { configVersion: 3 } as unknown as InvoiceProfile;

beforeEach(() => {
  vi.clearAllMocks();
  transactionOptions.length = 0;
  events.length = 0;
  mockStamps.mockResolvedValue(NULL_STAMPS);
  mockResolve.mockResolvedValue(resolved());
  mockRead.mockResolvedValue(RAW);
  mockLoad.mockImplementation(async () => {
    events.push("blob:template");
    return {
      invoice: () => "<html>invoice</html>",
      footer: () => "<div>footer</div>",
      structure: SEEDED_GENERATED_ROW.structure!,
    };
  });
  mockReadProfile.mockImplementation(async () => {
    events.push("db:profile");
    return { profile: PROFILE, logo: null };
  });
  mockInlineLogo.mockImplementation(async ({ profile }) => {
    events.push("blob:logo");
    return profile;
  });
});

describe("buildInvoiceHtml — not found", () => {
  it("throws DraftInvoiceNotFoundError when no bill exists (draft)", async () => {
    mockStamps.mockResolvedValue(null);
    await expect(
      buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode: "draft",
      }),
    ).rejects.toBeInstanceOf(DraftInvoiceNotFoundError);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("throws FinalInvoiceNotFoundError when no bill exists (final)", async () => {
    mockStamps.mockResolvedValue(null);
    await expect(
      buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode: "final",
        invoiceNo: "INV00000001",
      }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
  });

  it("throws the mode's not-found error when the raw read finds no bill", async () => {
    mockRead.mockResolvedValue(null);
    await expect(
      buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode: "final",
      }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
  });
});

describe("buildInvoiceHtml — read snapshot (D1/D5)", () => {
  it.each(["draft", "final"] as const)(
    "reads inside one repeatable-read, read-only transaction (%s)",
    async (mode) => {
      await buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode,
      });
      expect(transactionOptions).toEqual([
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ]);
    },
  );

  it("does the template and logo blob I/O only after the transaction closes", async () => {
    mockResolve.mockResolvedValue(resolved({ profileVersion: 3 }));
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    const close = events.indexOf("txn:close");
    expect(events.indexOf("db:profile")).toBeLessThan(close);
    expect(events.indexOf("blob:template")).toBeGreaterThan(close);
    expect(events.indexOf("blob:logo")).toBeGreaterThan(close);
  });
});

describe("buildInvoiceHtml — resolution mode (D1)", () => {
  it("a draft resolves the current versions", async () => {
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockResolve).toHaveBeenCalledWith({}, { kind: "draft" });
  });

  it("a final render resolves the bill's stamps", async () => {
    const stamps = {
      refBillTemplateVersionId: "BTV00000009",
      refInvoiceProfileVersion: 2,
      refCsvTemplateVersionId: "BTV00000003",
    };
    mockStamps.mockResolvedValue(stamps);
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "final",
      invoiceNo: "INV00000001",
    });
    expect(mockResolve).toHaveBeenCalledWith(
      {},
      { kind: "final", bill: stamps },
    );
  });
});

describe("buildInvoiceHtml — G15 A and the binder context (D5)", () => {
  it("no resolved profile: no profile read, bind gets profile null", async () => {
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockReadProfile).not.toHaveBeenCalled();
    expect(mockInlineLogo).not.toHaveBeenCalled();
    expect(mockBind.mock.calls[0]![1]).toMatchObject({ profile: null });
  });

  it("a resolved profile version is read, its logo inlined, and bound", async () => {
    mockResolve.mockResolvedValue(resolved({ profileVersion: 3 }));
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockReadProfile).toHaveBeenCalledWith({}, 3);
    expect(mockBind.mock.calls[0]![1]).toMatchObject({ profile: PROFILE });
  });

  it("binds template.* from the resolved layout + generated versions and returns the resolution and page setup", async () => {
    const result = await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockBind.mock.calls[0]![1]).toMatchObject({
      template: { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 },
    });
    expect(result.html).toBe("<html>invoice</html>");
    expect(result.footerHtml).toBe("<div>footer</div>");
    expect(result.pageSetup).toEqual(LAYOUT.pageSetup);
    expect(result.resolved.generated.billTemplateVersionId).toBe("BTV00000002");
  });

  it("the default (all-on) structure includes the usage read", async () => {
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockRead.mock.calls[0]![1]).toMatchObject({ includeUsage: true });
    expect(mockBind.mock.calls[0]![1]).toMatchObject({ includeUsage: true });
  });

  it("a hidden-usage structure fixture skips the usage read (bm49 D4)", async () => {
    mockResolve.mockResolvedValue(
      resolved({ generated: HIDDEN_USAGE_GENERATED }),
    );
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
    expect(mockRead.mock.calls[0]![1]).toMatchObject({ includeUsage: false });
    expect(mockBind.mock.calls[0]![1]).toMatchObject({ includeUsage: false });
  });
});
