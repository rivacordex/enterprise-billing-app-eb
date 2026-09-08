import { chromium } from "playwright";

import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { createSemaphore } from "@/lib/concurrency";
import {
  buildDraftInvoiceHtml,
  buildFinalInvoiceHtml,
} from "@/services/billing/render-invoice-template";
import { getAppLocale } from "@/services/system-config/app-config-read.service";

// bm18-spec §Design/§Implementation §2 — the draft (PRO-FORMA) renderer.
// Ephemeral (D18): reads, renders, streams — writes nothing to any table or
// blob. The HTML template itself lives in render-invoice-template.ts (kept
// pure/DB-free so it's unit-testable without a database); this file is the
// DB read + Chromium orchestration.

export class DraftInvoiceNotFoundError extends Error {
  constructor(runId: string, banId: string) {
    super(`No draft bill found for run ${runId} / account ${banId}.`);
    this.name = "DraftInvoiceNotFoundError";
  }
}

// bm19-spec §Implementation §3. Distinct from `DraftInvoiceNotFoundError` —
// this path only runs AFTER an account's INV has posted (D10's post-commit
// render/store step, `services/billing/post-run.ts`), so a missing bill here
// is an invariant breach (the posting transaction that stamped
// `ref_inv_document_id` would have failed first), never an ordinary
// not-yet-billed 404 the way the draft route treats it.
export class FinalInvoiceNotFoundError extends Error {
  constructor(runId: string, banId: string) {
    super(`No posted bill found for run ${runId} / account ${banId}.`);
    this.name = "FinalInvoiceNotFoundError";
  }
}

export interface RenderDraftInvoiceParams {
  runId: string;
  banId: string;
}

// Phase-2 review fold T9 — bound the launch-per-render (D19 defers real
// pooling/one-context-per-invoice/font-pinning): at most this many Chromium
// renders run concurrently; any more queue (FIFO) rather than launching, so a
// handful of active reviewers can't OOM the app container that now also
// carries Chromium.
const MAX_CONCURRENT_RENDERS = 2;
const renderSemaphore = createSemaphore(MAX_CONCURRENT_RENDERS);

export async function renderDraftInvoice({
  runId,
  banId,
}: RenderDraftInvoiceParams): Promise<Buffer> {
  // 1. Read — the account's trial `customer_bill` + its tax items + the
  // claimed `rating.udr_rated` charge lines, in one repeatable-read, read-
  // only snapshot (same idiom as list-account-bills.ts) so they can never
  // straddle a concurrent commit. Not-found → typed error → 404 at the route.
  const snapshot = await db.transaction(
    async (tx) => {
      const bill = await customerBillRepository.findForAccount(
        tx,
        runId,
        banId,
      );
      if (!bill) return null;
      const [taxItems, lines, run] = await Promise.all([
        customerBillTaxItemRepository.listForBill(
          tx,
          bill.customerBillId,
          bill.periodPartition,
        ),
        ratedLinesRepository.listClaimedForAccount(tx, runId, banId),
        billRunRepository.findDetailById(tx, runId),
      ]);
      return { bill, taxItems, lines, run };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  if (!snapshot || !snapshot.run) {
    throw new DraftInvoiceNotFoundError(runId, banId);
  }
  const { bill, taxItems, lines, run } = snapshot;

  const locale = await getAppLocale();

  const html = buildDraftInvoiceHtml({
    bill,
    taxItems,
    lines,
    run: { billRunId: run.billRunId, cycleName: run.cycleName },
    locale,
  });

  return renderPdfFromHtml(html);
}

export interface RenderFinalInvoiceParams {
  runId: string;
  banId: string;
  invoiceNo: string;
}

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" / §Implementation §3. Called ONLY after the account's INV has
// posted and the posting transaction committed (D10) — never inside that
// transaction, and its own failure must never roll the posted INV back
// (enforced by the caller, `post-run.ts`, which wraps this in its own
// try/catch). No repeatable-read snapshot needed here (unlike the draft
// path): once posted, `customer_bill` is immutable (the finalization
// trigger, 0033) — there is no concurrent-commit window left to straddle.
export async function renderFinalInvoice({
  runId,
  banId,
  invoiceNo,
}: RenderFinalInvoiceParams): Promise<Buffer> {
  const bill = await customerBillRepository.findForAccount(db, runId, banId);
  if (!bill) {
    throw new FinalInvoiceNotFoundError(runId, banId);
  }
  const [taxItems, lines, run] = await Promise.all([
    customerBillTaxItemRepository.listForBill(
      db,
      bill.customerBillId,
      bill.periodPartition,
    ),
    ratedLinesRepository.listClaimedForAccount(db, runId, banId),
    billRunRepository.findDetailById(db, runId),
  ]);
  if (!run) {
    throw new FinalInvoiceNotFoundError(runId, banId);
  }

  const locale = await getAppLocale();

  const html = buildFinalInvoiceHtml({
    bill,
    taxItems,
    lines,
    run: { billRunId: run.billRunId, cycleName: run.cycleName },
    locale,
    invoiceNumber: invoiceNo,
  });

  return renderPdfFromHtml(html);
}

// 2-4. Render — one launch per render (D19), shared by both draft and final
// rendering: the T9 concurrency guard (`renderSemaphore`) is a single
// process-level Chromium-launch cap, not one per mode (Phase-2 review fold
// T9 — "same render concurrency guard applies to final render"). The
// semaphore serializes beyond MAX_CONCURRENT_RENDERS; the browser always
// closes in `finally`, so a render error (or a queued request's later
// failure) never leaks a process.
function renderPdfFromHtml(html: string): Promise<Buffer> {
  return renderSemaphore.run(async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", bottom: "18mm", left: "15mm", right: "15mm" },
      });
      return pdf;
    } finally {
      await browser.close();
    }
  });
}
