import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import {
  inlineLogo,
  readInvoiceProfile,
} from "@/services/billing/invoice-profile/read-profile";
import { bind } from "@/services/billing/invoice-template/bind";
import { executeInvoiceTemplate } from "@/services/billing/invoice-template/compile";
import {
  loadGenerated,
  type LoadedGeneratedTemplate,
} from "@/services/billing/invoice-template/load";
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
  InvoiceTemplateStructure,
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
  // `draft` renders the BAN's captured run stamps (bm66, `run` mode) — or,
  // with an `override`, the render mode the editor preview supplies;
  // `final` and `preview-posted` (the editor preview of a posted bill, bm55)
  // resolve the bill's stamps (D1).
  mode: "draft" | "final" | "preview-posted";
  // The final render's requested invoice number — the binder asserts it
  // against the bound `billing.document` row (render-invoice.ts §6). Unused
  // on a draft.
  invoiceNo?: string;
  // bm55-spec §Design D3 — the editor preview of an UNPOSTED bill renders the
  // admin's unsaved structure: `load` builds the template in memory from the
  // resolved layout (generated + compiled, never stored or memoized) in place
  // of the stored generated version. Draft mode only — a posted bill always
  // renders its stamped version (Inv #42). bm66/bm67: the override carries
  // its own live render mode, built by the editor preview (`preview.ts`) for
  // the family it names — this module never constructs a live mode
  // (guardrail 57, Inv #53).
  override?: {
    structure: InvoiceTemplateStructure;
    load: (
      resolved: ResolvedTemplate,
    ) => Promise<Pick<LoadedGeneratedTemplate, "invoice" | "footer">>;
    renderMode: LiveFamilyRenderMode;
  };
}

// The editor preview's live, family-scoped render mode (bm66).
type LiveFamilyRenderMode = Extract<RenderMode, { familyId: string }>;

export interface BuildInvoiceHtmlResult {
  html: string;
  footerHtml: string;
  pageSetup: LayoutPageSetup;
  // D5 step 7 — the versions this render resolved (posting copies the run
  // stamps and resolves nothing, bm67; the CSV path resolves separately).
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
  override,
}: BuildInvoiceHtmlParams): Promise<BuildInvoiceHtmlResult> {
  const isFinal = mode === "final";
  // bm55-spec §Design D3 — `isDraft: !posted`: the editor preview of a
  // posted bill shows it as issued (no watermark), like the final render.
  const isDraft = mode === "draft";
  if (override && !isDraft) {
    throw new Error("buildInvoiceHtml: a template override is draft-only");
  }
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

      // bm66-spec §3 (D33, Inv #51) — a draft in a run renders the BAN's
      // captured stamps. No row, or an EXCLUDED row (never captured, never
      // rendered), is not found → 404.
      // An `override` (draft-only, guarded above) is the editor preview of an
      // unposted bill: the family's live versions, not the run's.
      let renderMode: RenderMode;
      if (override) {
        // Review fix (Inv #42) — the caller decided "unposted" from an earlier
        // read; re-check in this snapshot so a bill posted in between never
        // renders with live versions. Not found → the caller's NOT_FOUND.
        if (stamps.refInvDocumentId !== null) return null;
        renderMode = override.renderMode;
      } else if (mode === "draft") {
        const runStamps = await billRunAccountRepository.readStamps(
          tx,
          runId,
          banId,
        );
        if (!runStamps || runStamps.status === "EXCLUDED") return null;
        // Review fix — a non-EXCLUDED row with no capture (a run started before
        // bm65 on a DB not rebuilt per the bm64 runbook) is not "no active
        // version": say so, so the D55 "activate, then rerun" copy is not shown.
        if (runStamps.templateCapturedAt === null) {
          throw new InvoiceRenderError(
            "TEMPLATE_VERSION_NOT_FOUND",
            `account ${banId} in run ${runId} has no captured template stamps`,
            { reason: "TEMPLATE_NOT_CAPTURED", banId },
          );
        }
        renderMode = { kind: "run", stamps: runStamps, banId };
      } else {
        renderMode = { kind: mode, bill: stamps };
      }
      const resolved = await resolveTemplate(tx, renderMode);

      // bm71 — the capacity detail is always read (`chargeDetails` is
      // mandatory), in this snapshot.
      const raw = await invoiceRenderInputRepository.read(tx, {
        runId,
        banId,
      });
      if (!raw) return null;

      // G15 A — no resolved profile version ⇒ no issuer/payment blocks.
      const profileRead =
        resolved.profileVersion === null
          ? null
          : await readInvoiceProfile(tx, resolved.profileVersion);

      return { resolved, raw, profileRead };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!read) {
    throw isFinal
      ? new FinalInvoiceNotFoundError(runId, banId)
      : new DraftInvoiceNotFoundError(runId, banId);
  }
  const { resolved, raw, profileRead } = read;

  // D5 step 4 — blob I/O after the transaction has closed: the verified,
  // compiled template (memoized per version) and the verified logo bytes.
  const [locale, tpl, profile] = await Promise.all([
    getAppLocale(),
    override ? override.load(resolved) : loadGenerated(resolved.generated),
    profileRead === null ? Promise.resolve(null) : inlineLogo(profileRead),
  ]);
  const pageSetup = parsePageSetup(resolved);

  // D5 step 5.
  const input = bind(raw, {
    isDraft,
    locale,
    timezone,
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
