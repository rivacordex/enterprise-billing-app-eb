import { beforeEach, describe, expect, it, vi } from "vitest";

// bm19-spec §Implementation §5 — the stored-invoice download route's single
// read, kept as its own service so the Route Handler stays db-free
// (code-standards §3 / eslint boundaries: `app/**` may import `services/**`,
// never `db/**` directly).

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-invoices.repository", () => ({
  billRunInvoicesRepository: { findByRunAndAccount: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: { getInvoice: vi.fn() },
}));

import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { blobStore } from "@/services/billing/blob-store";
import {
  StoredInvoiceNotFoundError,
  getStoredInvoice,
} from "@/services/billing/read/get-stored-invoice";

const mockFindByRunAndAccount = vi.mocked(
  billRunInvoicesRepository.findByRunAndAccount,
);
const mockGetInvoice = vi.mocked(blobStore.getInvoice);

const STORED = {
  billRunInvoiceId: "BRI00000001",
  refInvDocumentId: "INV00000001",
  blobRef: "invoices/2026-07/INV00000001.pdf",
  checksum: "abc123",
  renderedAt: new Date("2026-08-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByRunAndAccount.mockResolvedValue(STORED);
  mockGetInvoice.mockResolvedValue(Buffer.from("PDF-BYTES"));
});

describe("getStoredInvoice", () => {
  it("throws StoredInvoiceNotFoundError when no bill_run_invoices row exists for this account", async () => {
    mockFindByRunAndAccount.mockResolvedValue(null);

    await expect(
      getStoredInvoice("BRN00000042", "BAN00000001"),
    ).rejects.toBeInstanceOf(StoredInvoiceNotFoundError);
    expect(mockGetInvoice).not.toHaveBeenCalled();
  });

  it("retrieves the blob using the stored row's blobRef and returns the artifact's identity", async () => {
    const result = await getStoredInvoice("BRN00000042", "BAN00000001");

    expect(mockGetInvoice).toHaveBeenCalledWith(
      "invoices/2026-07/INV00000001.pdf",
    );
    expect(result).toEqual({
      pdf: Buffer.from("PDF-BYTES"),
      invoiceNumber: "INV00000001",
      blobRef: "invoices/2026-07/INV00000001.pdf",
      checksum: "abc123",
    });
  });
});
