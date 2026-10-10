import { db } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { getInvoiceProfile } from "@/services/billing/invoice-profile/read-profile";
import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import { loadLayout } from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import {
  type InvoiceRenderInput,
  type InvoiceTemplateStructure,
  type ResolvedTemplate,
} from "@/types/billing";

// bm55-spec §Design D3 (Inv #42, General rule 9) — the Invoice template live
// preview. A READ: it writes no blob, no row and no audit. The HTML comes from
// the real pipeline (bind → helpers → locked Handlebars); there is no PDF.
//
//   'sample'        → generate(the current generated version's layout, the
//                     submitted structure) compiled IN MEMORY (never
//                     memoized), bound to the layout's verified
//                     `sample-data.json` as a draft, with the current ACTIVE
//                     profile (or none, G15) — exactly what new invoices show.
//   { billId }      → posted: the bill's STAMPED generated version (the
//                     submitted structure is ignored) via the binder, as
//                     issued. Unposted: generated as for 'sample', bound to
//                     the bill through the binder as a draft.
//
// The caller (the action) has already checked `invoice_settings : READ`, and
// `billrun_view : READ` for a `{ billId }` source.

export type PreviewSource = "sample" | { billId: string };

export interface PreviewInvoiceTemplateParams {
  structure: InvoiceTemplateStructure;
  source: PreviewSource;
  annotate?: boolean | undefined;
  outline?: boolean | undefined;
}

export interface PreviewInvoiceTemplateResult {
  html: string;
  templateLabel: string;
  // The generated version a POSTED bill is pinned to (the form's "Showing as
  // issued under template vN" banner); `null` for a structure preview.
  pinnedVersionNo: number | null;
}

export class PreviewBillNotFoundError extends Error {
  constructor(billId: string) {
    super(`No bill ${billId} to preview.`);
    this.name = "PreviewBillNotFoundError";
  }
}

// ui-context §10b — preview-only overlays, appended to the rendered document
// here and never part of a stored file.
const ANNOTATE_STYLE = ".ph { background:#E2F8FA; color:#006975 }";
const OUTLINE_STYLE = ".sec { outline:1px dashed #99A1B0 }";

function withPreviewStyles(
  html: string,
  { annotate, outline }: { annotate: boolean; outline: boolean },
): string {
  const rules = [
    annotate ? ANNOTATE_STYLE : null,
    outline ? OUTLINE_STYLE : null,
  ]
    .filter((r): r is string => r !== null)
    .join("\n");
  if (rules === "") return html;
  const style = `<style data-preview="true">\n${rules}\n</style>\n`;
  const at = html.search(/<\/head>/i);
  return at === -1 ? style + html : html.slice(0, at) + style + html.slice(at);
}

// The structure → in-memory template step shared by both unposted paths.
async function generateInMemory(
  resolved: ResolvedTemplate,
  structure: InvoiceTemplateStructure,
  annotate: boolean,
): Promise<{
  invoice: HandlebarsTemplateDelegate<InvoiceRenderInput>;
  footer: HandlebarsTemplateDelegate<InvoiceRenderInput>;
  layoutFiles: Map<string, Buffer>;
}> {
  const layoutFiles = await loadLayout(resolved.layout);
  const generated = generate(layoutFilesFromVerified(layoutFiles), structure, {
    annotate,
  });
  return {
    invoice: compileInvoiceTemplate(generated.invoiceHbs),
    footer: compileInvoiceTemplate(generated.footerHbs),
    layoutFiles,
  };
}

function layoutLabel(resolved: ResolvedTemplate): string {
  return `${resolved.layout.layoutCode ?? "layout"} v${resolved.layout.versionNo}`;
}

async function previewSample(
  structure: InvoiceTemplateStructure,
  annotate: boolean,
): Promise<{ html: string; templateLabel: string }> {
  // Rows only; never cached (Inv #42). The profile is the current ACTIVE one,
  // or none (G15 A).
  const resolved = await resolveTemplate(db, { kind: "draft" });
  const [tpl, profile, locale] = await Promise.all([
    generateInMemory(resolved, structure, annotate),
    resolved.profileVersion === null
      ? Promise.resolve(null)
      : getInvoiceProfile(db, resolved.profileVersion),
    getAppLocale(),
  ]);
  const sample = parseSampleData(tpl.layoutFiles);

  const input: InvoiceRenderInput = {
    ...sample,
    template: {
      layoutCode: resolved.layout.layoutCode ?? "",
      layoutVersion: resolved.layout.versionNo,
      version: resolved.generated.versionNo,
    },
    company: profile?.company ?? null,
    payment: profile?.payment ?? null,
    invoice: {
      ...sample.invoice,
      isDraft: true,
      paymentTermsDays: profile?.paymentTermsDays ?? null,
    },
    usage: structure.sections.usageAnnex ? sample.usage : null,
    isDraft: true,
    locale,
    timezone: getAppTimezone(),
  };

  return {
    html: executeInvoiceTemplate(tpl.invoice, input),
    templateLabel: `Unsaved structure · ${layoutLabel(resolved)} · sample bill`,
  };
}

export async function previewInvoiceTemplate({
  structure,
  source,
  annotate = false,
  outline = false,
}: PreviewInvoiceTemplateParams): Promise<PreviewInvoiceTemplateResult> {
  if (source === "sample") {
    const { html, templateLabel } = await previewSample(structure, annotate);
    return {
      html: withPreviewStyles(html, { annotate, outline }),
      templateLabel,
      pinnedVersionNo: null,
    };
  }

  const target = await customerBillRepository.findPreviewTarget(
    db,
    source.billId,
  );
  if (!target) throw new PreviewBillNotFoundError(source.billId);

  if (target.refInvDocumentId !== null) {
    // Inv #42 / R10 — a posted bill previews with ITS stamped versions; the
    // submitted structure is ignored. Its stored template cannot be
    // annotated (that would regenerate it), so only the outline applies.
    const built = await buildInvoiceHtml({
      runId: target.billRunId,
      banId: target.billingAccountId,
      mode: "preview-posted",
    });
    const versionNo = built.resolved.generated.versionNo;
    return {
      html: withPreviewStyles(built.html, { annotate: false, outline }),
      templateLabel: `Template v${versionNo} (as issued) · ${target.customerBillId}`,
      pinnedVersionNo: versionNo,
    };
  }

  const built = await buildInvoiceHtml({
    runId: target.billRunId,
    banId: target.billingAccountId,
    mode: "draft",
    override: {
      structure,
      load: async (resolved) => {
        const { invoice, footer } = await generateInMemory(
          resolved,
          structure,
          annotate,
        );
        return { invoice, footer };
      },
    },
  });
  return {
    html: withPreviewStyles(built.html, { annotate, outline }),
    templateLabel: `Unsaved structure · ${layoutLabel(built.resolved)} · ${target.customerBillId}`,
    pinnedVersionNo: null,
  };
}
