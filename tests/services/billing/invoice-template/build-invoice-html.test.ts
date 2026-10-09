import { beforeEach, describe, expect, it, vi } from "vitest";

// bm47-spec §Implementation §5, D1 — `buildInvoiceHtml`'s own DB
// orchestration: one repeatable-read, read-only transaction used for BOTH
// modes, and the mode-appropriate not-found error when no bill exists.

const transactionOptions: unknown[] = [];
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown, opts: unknown) => {
      transactionOptions.push(opts);
      return cb({});
    }),
  },
}));
vi.mock("@/db/repositories/billing/invoice-render-input", () => ({
  invoiceRenderInputRepository: { read: vi.fn() },
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn().mockResolvedValue("en-MY"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));

import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
} from "@/types/billing";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";

const mockRead = vi.mocked(invoiceRenderInputRepository.read);

beforeEach(() => {
  vi.clearAllMocks();
  transactionOptions.length = 0;
});

describe("buildInvoiceHtml — not found", () => {
  it("throws DraftInvoiceNotFoundError when the repository finds no bill (draft)", async () => {
    mockRead.mockResolvedValue(null);

    await expect(
      buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode: "draft",
      }),
    ).rejects.toBeInstanceOf(DraftInvoiceNotFoundError);
  });

  it("throws FinalInvoiceNotFoundError when the repository finds no bill (final)", async () => {
    mockRead.mockResolvedValue(null);

    await expect(
      buildInvoiceHtml({
        runId: "BRN00000042",
        banId: "BAN00000001",
        mode: "final",
        invoiceNo: "INV00000001",
      }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
  });
});

describe("buildInvoiceHtml — read snapshot (D1)", () => {
  it("reads inside one repeatable-read, read-only transaction for the draft mode", async () => {
    mockRead.mockResolvedValue(null);
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    }).catch(() => {});
    expect(transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);
  });

  it("reads inside one repeatable-read, read-only transaction for the final mode too (D1 — both modes now)", async () => {
    mockRead.mockResolvedValue(null);
    await buildInvoiceHtml({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "final",
      invoiceNo: "INV00000001",
    }).catch(() => {});
    expect(transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);
  });
});
