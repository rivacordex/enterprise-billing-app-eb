import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  InvoiceRenderError,
  type RenderMode,
  type ResolvedTemplate,
  type TemplateKind,
} from "@/types/billing";

// bm53-spec §Design D1 (Inv #42) — which versions a render uses.
//
//   draft                   → the non-default ACTIVE ?? the default; the ACTIVE
//                             `invoice.profile` version ?? null (G15 A).
//   final / preview-posted  → the bill's stamps. A posted bill NEVER resolves
//                             the current ACTIVE (code-standards General rule 4).
//                             An unstamped column resolves the immutable default
//                             (profile: null). Bills posted before bm54 carry no
//                             stamps at all, so they render with the default —
//                             deterministic, and identical to what was ACTIVE
//                             then (nothing is activatable before bm58).
//
// "No template" cannot occur: the default rows are trigger-protected (bm50 D2).
// If one is missing anyway (corrupted DB) this throws
// `TEMPLATE_VERSION_NOT_FOUND` and the account parks — never a fallback.
//
// NEVER cached (workflow rules §3.9): every render queries the rows. The one
// sanctioned cache is `load.ts`'s compiled-template memo, keyed by version id.

function notFound(
  message: string,
  detail: Record<string, unknown>,
): InvoiceRenderError {
  return new InvoiceRenderError("TEMPLATE_VERSION_NOT_FOUND", message, detail);
}

async function currentVersion(
  db: Database,
  kind: TemplateKind,
): Promise<BillTemplateVersion> {
  const row =
    (await billTemplateVersionRepository.findActive(db, { kind })) ??
    (await billTemplateVersionRepository.findDefault(db, { kind }));
  if (!row) {
    throw notFound(`no ACTIVE or default ${kind} template version`, { kind });
  }
  return row;
}

async function defaultVersion(
  db: Database,
  kind: TemplateKind,
): Promise<BillTemplateVersion> {
  const row = await billTemplateVersionRepository.findDefault(db, { kind });
  if (!row) throw notFound(`no default ${kind} template version`, { kind });
  return row;
}

// A pinned (or referenced) id must exist, be the expected kind, and be
// non-DRAFT — a DRAFT has no files and never rendered a posted bill.
async function versionById(
  db: Database,
  id: string,
  kind: TemplateKind,
): Promise<BillTemplateVersion> {
  const row = await billTemplateVersionRepository.findById(db, id);
  if (!row || row.kind !== kind || row.status === "DRAFT") {
    throw notFound(`${kind} template version ${id} not found`, {
      versionId: id,
      kind,
    });
  }
  return row;
}

export async function resolveTemplate(
  db: Database,
  mode: RenderMode,
): Promise<ResolvedTemplate> {
  let generated: BillTemplateVersion;
  let csv: BillTemplateVersion;
  let profileVersion: number | null;

  if (mode.kind === "draft") {
    [generated, csv, profileVersion] = await Promise.all([
      currentVersion(db, "generated"),
      currentVersion(db, "csv"),
      invoiceProfileRepository.findActiveVersion(db),
    ]);
  } else {
    const { bill } = mode;
    [generated, csv] = await Promise.all([
      bill.refBillTemplateVersionId === null
        ? defaultVersion(db, "generated")
        : versionById(db, bill.refBillTemplateVersionId, "generated"),
      bill.refCsvTemplateVersionId === null
        ? defaultVersion(db, "csv")
        : versionById(db, bill.refCsvTemplateVersionId, "csv"),
    ]);
    // G15 A — a `null` stamp stays `null` (never the current ACTIVE).
    profileVersion = bill.refInvoiceProfileVersion;
  }

  if (generated.refLayoutVersionId === null) {
    throw notFound(
      `generated version ${generated.billTemplateVersionId} has no layout`,
      { versionId: generated.billTemplateVersionId },
    );
  }
  const layout = await versionById(db, generated.refLayoutVersionId, "layout");

  return { generated, layout, profileVersion, csv };
}
