import { createHash } from "node:crypto";

import { db } from "@/db/client";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { blobStore } from "@/services/billing/blob-store";

// bm19-spec §Implementation §5 — the stored-invoice download route's single
// read: the `bill_run_invoices` row (identity: invoice number, blob ref, PDF
// checksum) plus the actual bytes from the blob store. Kept as its own
// service (not inlined in the Route Handler) so the route stays db-free per
// code-standards §3 (`app/**` may import `services/**`, never `db/**`
// directly — the same layering `renderDraftInvoice`/bm18 already follows).

export class StoredInvoiceNotFoundError extends Error {
  constructor(runId: string, banId: string) {
    super(`No stored invoice found for run ${runId} / account ${banId}.`);
    this.name = "StoredInvoiceNotFoundError";
  }
}

// The stored PDF's bytes no longer hash to the checksum recorded when it was
// stored (corruption, or a diverged blob). Thrown so the route fails closed
// (500) rather than serving content that can't be proven authentic.
export class StoredInvoiceChecksumMismatchError extends Error {
  constructor(invoiceNumber: string, expected: string, actual: string) {
    super(
      `Stored invoice ${invoiceNumber} failed checksum verification (expected ${expected}, got ${actual}).`,
    );
    this.name = "StoredInvoiceChecksumMismatchError";
  }
}

export interface StoredInvoiceResult {
  pdf: Buffer;
  invoiceNumber: string;
  blobRef: string;
  checksum: string;
}

export async function getStoredInvoice(
  runId: string,
  banId: string,
): Promise<StoredInvoiceResult> {
  const stored = await billRunInvoicesRepository.findByRunAndAccount(
    db,
    runId,
    banId,
  );
  if (!stored) {
    throw new StoredInvoiceNotFoundError(runId, banId);
  }
  const pdf = await blobStore.getInvoice(stored.blobRef);
  // Integrity gate (Design "Two checksums, two purposes" — the PDF-bytes
  // checksum exists precisely to prove the bytes came back intact). Verify
  // before returning so corrupted/diverged content is never served as a valid
  // invoice; fail closed on mismatch.
  const actualChecksum = createHash("md5").update(pdf).digest("hex");
  if (actualChecksum !== stored.checksum) {
    throw new StoredInvoiceChecksumMismatchError(
      stored.refInvDocumentId,
      stored.checksum,
      actualChecksum,
    );
  }
  return {
    pdf,
    invoiceNumber: stored.refInvDocumentId,
    blobRef: stored.blobRef,
    checksum: stored.checksum,
  };
}
