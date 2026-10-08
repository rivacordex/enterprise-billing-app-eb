import { readFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db/client";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { bind } from "@/services/billing/invoice-template/bind";
import { loadDefaultTemplateFromRepo } from "@/services/billing/invoice-template/load-stopgap";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { layoutPageSetupSchema } from "@/validation/billing/layout-page-setup.schema";
import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
} from "@/types/billing";
import type { LayoutPageSetup } from "@/types/billing";

// bm47-spec §Design D1/§Implementation §5 — this module is now the binder's
// entry point: `loadInput → bind → compile → render HTML → PDF` (D1). It no
// longer exports any HTML-string builder — `buildDraftInvoiceHtml`/
// `buildFinalInvoiceHtml` and their param types are deleted (Inv #40, no
// legacy fallback). `render-invoice.ts` keeps only the Chromium
// orchestration (the semaphore, `BROWSER_CLOSE_TIMEOUT_MS`, `renderPdfFromHtml`).

const MANIFEST_PATH = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/INVTPL-STD-A4/v1/manifest.json",
);

let cachedPageSetup: LayoutPageSetup | null = null;

// D9 — `LayoutPageSetup` is read from the manifest and validated by Zod,
// ready for bm50's `page_setup` column. Memoized the same way the compiled
// template is (D8) — the manifest is immutable repo content, not mutable
// state.
async function loadPageSetup(): Promise<LayoutPageSetup> {
  if (cachedPageSetup) return cachedPageSetup;
  const raw = await readFile(MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(raw) as { pageSetup: unknown };
  cachedPageSetup = layoutPageSetupSchema.parse(manifest.pageSetup);
  return cachedPageSetup;
}

export interface BuildInvoiceHtmlParams {
  runId: string;
  banId: string;
  mode: "draft" | "final";
  // The final render's requested invoice number — the binder asserts it
  // against the bound `billing.document` row (render-invoice.ts §6). Unused
  // on a draft.
  invoiceNo?: string;
}

export interface BuildInvoiceHtmlResult {
  html: string;
  footerHtml: string;
  pageSetup: LayoutPageSetup;
}

export async function buildInvoiceHtml({
  runId,
  banId,
  mode,
  invoiceNo,
}: BuildInvoiceHtmlParams): Promise<BuildInvoiceHtmlResult> {
  const isDraft = mode === "draft";
  const timezone = getAppTimezone();
  // bm49-spec §Design D4 — the only template in bm49 is the all-on default, so
  // the Usage annex is always included; bm53 derives this from the resolved
  // version's `structure`.
  const includeUsage = true;

  // D1 — one repeatable-read, read-only transaction, used for BOTH modes now
  // (moved here from render-invoice.ts's former draft-only snapshot). Once a
  // bill is posted it is immutable (the finalization guard, 0033), so the
  // snapshot costs nothing extra on the final path and keeps one pipeline
  // for both. bm49 threads `timezone`/`includeUsage` so the usage read sees
  // the account's billed `udr_rated` rows in one snapshot with the lines.
  const raw = await db.transaction(
    (tx) =>
      invoiceRenderInputRepository.read(tx, {
        runId,
        banId,
        timezone,
        includeUsage,
      }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!raw) {
    throw isDraft
      ? new DraftInvoiceNotFoundError(runId, banId)
      : new FinalInvoiceNotFoundError(runId, banId);
  }

  const [locale, pageSetup] = await Promise.all([
    getAppLocale(),
    loadPageSetup(),
  ]);

  const input = bind(raw, {
    isDraft,
    locale,
    timezone,
    includeUsage,
    ...(invoiceNo !== undefined ? { invoiceNo } : {}),
  });

  // D8 STOPGAP — the hand-written default "generated" output, loaded from
  // the repo (deleted in bm53 once the real generator exists).
  const { render, renderFooter } = await loadDefaultTemplateFromRepo();

  return {
    html: render(input),
    footerHtml: renderFooter(input),
    pageSetup,
  };
}
