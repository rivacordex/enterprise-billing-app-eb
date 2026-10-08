import { chromium } from "playwright";

import { createSemaphore } from "@/lib/concurrency";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import type { LayoutPageSetup } from "@/types/billing";

// bm47-spec §Implementation §6 — this module keeps ONLY the Chromium
// orchestration (the semaphore, `BROWSER_CLOSE_TIMEOUT_MS`,
// `renderPdfFromHtml`'s launch/close race). All reading, binding and
// templating moved into `render-invoice-template.ts`'s `buildInvoiceHtml`
// (D1). `renderDraftInvoice`/`renderFinalInvoice` keep their signatures and
// error classes for existing callers (the draft/stored-invoice routes,
// `post-run.ts`).

// bm18-spec §Design, now defined in `types/billing.ts` (bm47-spec
// §Implementation §3 — avoids an import cycle back to
// `render-invoice-template.ts`, which this module imports). Re-exported here
// unchanged so every existing caller/test keeps importing from this module.
export {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
} from "@/types/billing";

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
// `browser.close()` (unlike setContent/pdf, which carry Playwright's own
// default timeouts) has no built-in bound; a wedged Chromium could hang it
// forever, holding the render permit and — since post-run.ts awaits the render
// inside the sequential posting loop — stalling the whole run. Cap it.
//
// On some hosts (observed: Windows dev) the headless shutdown does not resolve
// promptly, so every render otherwise paid the full cap — the PDF is already
// produced by this point, so the close is pure cleanup we don't need to block
// the response on. We abandon the WAIT after this bound; the underlying
// close() keeps running in the background and completes (no process leak
// observed), so the render returns in ~1s instead of ~cap seconds.
const BROWSER_CLOSE_TIMEOUT_MS = 1_500;

export async function renderDraftInvoice({
  runId,
  banId,
}: RenderDraftInvoiceParams): Promise<Buffer> {
  const { html, footerHtml, pageSetup } = await buildInvoiceHtml({
    runId,
    banId,
    mode: "draft",
  });
  return renderPdfFromHtml(html, { pageSetup, footerHtml });
}

export interface RenderFinalInvoiceParams {
  runId: string;
  banId: string;
  invoiceNo: string;
}

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" / §Implementation §3, bm47-spec §Implementation §6. Called ONLY
// after the account's INV has posted and the posting transaction committed
// (D10) — never inside that transaction, and its own failure must never
// roll the posted INV back (enforced by the caller, `post-run.ts`). The
// binder reads the number from `billing.document` and asserts it equals
// `invoiceNo` — a mismatch is an internal wiring-bug error, not a data
// problem.
export async function renderFinalInvoice({
  runId,
  banId,
  invoiceNo,
}: RenderFinalInvoiceParams): Promise<Buffer> {
  const { html, footerHtml, pageSetup } = await buildInvoiceHtml({
    runId,
    banId,
    mode: "final",
    invoiceNo,
  });
  return renderPdfFromHtml(html, { pageSetup, footerHtml });
}

// D9 — `renderPdfFromHtml` gains one optional parameter object; nothing else
// in this file changes (the semaphore, `chromium.launch()`, `setContent`
// `networkidle`, and the `BROWSER_CLOSE_TIMEOUT_MS` race are byte-identical
// to before bm47).
export interface PdfRenderOptions {
  pageSetup: LayoutPageSetup;
  footerHtml: string;
}

// 2-4. Render — one launch per render (D19), shared by both draft and final
// rendering: the T9 concurrency guard (`renderSemaphore`) is a single
// process-level Chromium-launch cap, not one per mode (Phase-2 review fold
// T9 — "same render concurrency guard applies to final render"). The
// semaphore serializes beyond MAX_CONCURRENT_RENDERS; the browser always
// closes in `finally`, so a render error (or a queued request's later
// failure) never leaks a process.
function renderPdfFromHtml(
  html: string,
  { pageSetup, footerHtml }: PdfRenderOptions,
): Promise<Buffer> {
  return renderSemaphore.run(async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle" });
      const pdf = await page.pdf({
        format: pageSetup.format,
        landscape: pageSetup.orientation === "landscape",
        printBackground: pageSetup.printBackground,
        margin: pageSetup.margin,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: footerHtml,
      });
      return pdf;
    } finally {
      // Bound the close and swallow any rejection: a hung close must not wedge
      // the permit/loop, and a close failure must not mask the real render
      // error propagating from the try block. The `.catch` is attached to
      // close() itself (not just the race) so a rejection arriving AFTER the
      // timeout has already won the race can't surface as an unhandled
      // rejection once we've stopped awaiting it.
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>((resolve) =>
          setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS),
        ),
      ]);
    }
  });
}
