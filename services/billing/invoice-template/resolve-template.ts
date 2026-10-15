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

// bm53-spec §Design D1 (Inv #42), bm66-spec §Design (D33, Inv #51/#53) —
// which versions a render uses.
//
//   run                     → a draft PRO-FORMA in a run: exactly the BAN's
//                             captured `bill_run_account` stamps (bm65). Never
//                             live. A NULL generated stamp (its family had no
//                             ACTIVE version at capture, D55) throws
//                             `TEMPLATE_VERSION_NOT_FOUND` — never the default
//                             (architecture P3). A NULL profile stays NULL.
//   preview-family          → the Invoice Settings preview: the family's live,
//                             current versions (`resolveCurrentVersionsForFamily`).
//   final / preview-posted  → the bill's stamps. A posted bill NEVER resolves
//                             the current ACTIVE (code-standards General rule 4).
//                             An unstamped column resolves the immutable default
//                             (profile: null). Bills posted before bm54 carry no
//                             stamps at all, so they render with the default —
//                             deterministic, and identical to what was ACTIVE
//                             then (nothing is activatable before bm58).
//   run start (bm65)        → `resolveCurrentVersionsForFamily`: "current"
//                             within one template family, captured onto
//                             `bill_run_account` at trigger and rerun.
//
// Posting resolves nothing: it copies the BAN's run stamps onto the bill (bm67,
// Inv #41 amended). The only live resolutions are run-start capture and
// `preview-family` (Inv #53, guardrail 57).
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

// bm65-spec §3 (Inv #51, #53) — the versions a BAN in `familyId` is captured
// with at run start: the only live resolution on a run path, run at capture.
// `generated` is the family's non-default ACTIVE, else the family's default,
// else `null` — no throw (D55, Inv #58: a family with no ACTIVE version is
// stamped NULL and acted on by render/posting). CSV and profile are global:
// the non-default ACTIVE ?? the default, and the ACTIVE profile ?? null (G15 A).
export async function resolveCurrentVersionsForFamily(
  db: Database,
  familyId: string,
): Promise<{
  generated: BillTemplateVersion | null;
  csv: BillTemplateVersion;
  profileVersion: number | null;
}> {
  const [active, csv, profileVersion] = await Promise.all([
    billTemplateVersionRepository.findActiveInFamily(db, { familyId }),
    currentVersion(db, "csv"),
    invoiceProfileRepository.findActiveVersion(db),
  ]);
  const generated =
    active ??
    (await billTemplateVersionRepository.findDefaultInFamily(db, { familyId }));
  return { generated, csv, profileVersion };
}

// bm66-spec §2 (D55) — a family with no ACTIVE (or default) generated
// version: the run's stamp is NULL, or the preview family has nothing to show.
function familyNotActive(familyId: string | null): InvoiceRenderError {
  return new InvoiceRenderError(
    "TEMPLATE_VERSION_NOT_FOUND",
    `template family ${familyId ?? "(none)"} has no active generated version`,
    { reason: "FAMILY_HAS_NO_ACTIVE_VERSION", familyId },
  );
}

export async function resolveTemplate(
  db: Database,
  mode: RenderMode,
): Promise<ResolvedTemplate> {
  let generated: BillTemplateVersion;
  let csv: BillTemplateVersion;
  let profileVersion: number | null;

  switch (mode.kind) {
    case "run": {
      const { stamps } = mode;
      if (stamps.refBillTemplateVersionId === null) {
        throw familyNotActive(stamps.refBillTemplateFamilyId);
      }
      if (stamps.refCsvTemplateVersionId === null) {
        throw notFound("the run stamp has no CSV template version", {
          familyId: stamps.refBillTemplateFamilyId,
        });
      }
      [generated, csv] = await Promise.all([
        versionById(db, stamps.refBillTemplateVersionId, "generated"),
        versionById(db, stamps.refCsvTemplateVersionId, "csv"),
      ]);
      // G15 A — a `null` stamp stays `null` (never the current ACTIVE).
      profileVersion = stamps.refInvoiceProfileVersion;
      break;
    }
    case "preview-family": {
      const current = await resolveCurrentVersionsForFamily(db, mode.familyId);
      if (current.generated === null) throw familyNotActive(mode.familyId);
      generated = current.generated;
      csv = current.csv;
      profileVersion = current.profileVersion;
      break;
    }
    case "final":
    case "preview-posted": {
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
      break;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`unknown render mode ${JSON.stringify(exhaustive)}`);
    }
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
