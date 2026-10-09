import { db } from "@/db/client";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import {
  inlineLogo,
  readInvoiceProfile,
} from "@/services/billing/invoice-profile/read-profile";
import { bind } from "@/services/billing/invoice-template/bind";
import { executeInvoiceTemplate } from "@/services/billing/invoice-template/compile";
import { loadGenerated } from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { layoutPageSetupSchema } from "@/validation/billing/layout-page-setup.schema";
import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
  InvoiceRenderError,
} from "@/types/billing";
import type {
  LayoutPageSetup,
  RenderMode,
  ResolvedTemplate,
} from "@/types/billing";

// bm47-spec §Design D1 / bm53-spec §Design D5 — the binder's entry point:
// read → resolve → load (verified, from blob) → bind → execute. It exports no
// HTML-string builder (Inv #40, no legacy fallback). `render-invoice.ts` keeps
// only the Chromium orchestration. The bm47 D8 stopgap loader (a repo `fs`
// read) is deleted: every template byte now comes from the blob store,
// checksum-verified (Inv #45).

export interface BuildInvoiceHtmlParams {
  runId: string;
  banId: string;
  // `draft` resolves the current versions; `final` and `preview-posted` (the
  // editor preview of a posted bill, bm55) resolve the bill's stamps (D1).
  mode: "draft" | "final" | "preview-posted";
  // The final render's requested invoice number — the binder asserts it
  // against the bound `billing.document` row (render-invoice.ts §6). Unused
  // on a draft.
  invoiceNo?: string;
}

export interface BuildInvoiceHtmlResult {
  html: string;
  footerHtml: string;
  pageSetup: LayoutPageSetup;
  // D5 step 7 — consumed by bm54 (the posting stamps) and bm62 (the CSV map).
  resolved: ResolvedTemplate;
}

function parsePageSetup(resolved: ResolvedTemplate): LayoutPageSetup {
  const parsed = layoutPageSetupSchema.safeParse(resolved.layout.pageSetup);
  if (!parsed.success) {
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      `layout version ${resolved.layout.billTemplateVersionId} has an invalid page_setup`,
      { versionId: resolved.layout.billTemplateVersionId },
    );
  }
  return parsed.data;
}

export async function buildInvoiceHtml({
  runId,
  banId,
  mode,
  invoiceNo,
}: BuildInvoiceHtmlParams): Promise<BuildInvoiceHtmlResult> {
  const isFinal = mode === "final";
  const timezone = getAppTimezone();

  // D5 steps 1–3 — every DB read in ONE repeatable-read, read-only
  // transaction: the bill's stamps, the resolution, the raw input and the
  // profile rows all see one snapshot. Once a bill is posted it is immutable
  // (the finalization guard, 0033), so the snapshot costs nothing extra on the
  // final path. No blob I/O happens inside it (step 4).
  const read = await db.transaction(
    async (tx) => {
      const stamps = await invoiceRenderInputRepository.readBillStamps(tx, {
        runId,
        banId,
      });
      if (!stamps) return null;

      const renderMode: RenderMode =
        mode === "draft" ? { kind: "draft" } : { kind: mode, bill: stamps };
      const resolved = await resolveTemplate(tx, renderMode);

      // bm49 D4 — a hidden Usage annex skips the usage read (and its
      // over-limit/reconcile checks). The resolved row's `structure` is the
      // same value `loadGenerated` returns as `tpl.structure` (D2 step 7);
      // it is read here because the usage read happens in this snapshot.
      const includeUsage =
        resolved.generated.structure?.sections.usageAnnex !== false;

      const raw = await invoiceRenderInputRepository.read(tx, {
        runId,
        banId,
        timezone,
        includeUsage,
      });
      if (!raw) return null;

      // G15 A — no resolved profile version ⇒ no issuer/payment blocks.
      const profileRead =
        resolved.profileVersion === null
          ? null
          : await readInvoiceProfile(tx, resolved.profileVersion);

      return { resolved, includeUsage, raw, profileRead };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!read) {
    throw isFinal
      ? new FinalInvoiceNotFoundError(runId, banId)
      : new DraftInvoiceNotFoundError(runId, banId);
  }
  const { resolved, includeUsage, raw, profileRead } = read;

  // D5 step 4 — blob I/O after the transaction has closed: the verified,
  // compiled template (memoized per version) and the verified logo bytes.
  const [locale, tpl, profile] = await Promise.all([
    getAppLocale(),
    loadGenerated(resolved.generated),
    profileRead === null ? Promise.resolve(null) : inlineLogo(profileRead),
  ]);
  const pageSetup = parsePageSetup(resolved);

  // D5 step 5.
  const input = bind(raw, {
    isDraft: !isFinal,
    locale,
    timezone,
    includeUsage,
    profile,
    template: {
      layoutCode: resolved.layout.layoutCode ?? "",
      layoutVersion: resolved.layout.versionNo,
      version: resolved.generated.versionNo,
    },
    ...(invoiceNo !== undefined ? { invoiceNo } : {}),
  });

  // D5 steps 6–7.
  return {
    html: executeInvoiceTemplate(tpl.invoice, input),
    footerHtml: executeInvoiceTemplate(tpl.footer, input),
    pageSetup,
    resolved,
  };
}
