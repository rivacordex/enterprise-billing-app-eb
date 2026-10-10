import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { paymentFieldsChanged } from "@/lib/invoice-profile-changes";
import { DraftConflict } from "@/services/billing/invoice-profile/draft-conflict";
import {
  inlineLogo,
  parseInvoiceProfile,
} from "@/services/billing/invoice-profile/read-profile";
import {
  INVOICE_PROFILE_CONFIG_GROUP,
  InvoiceRenderError,
  type ProfileActivationErrorCode,
} from "@/types/billing";
import {
  activateProfileInputSchema,
  type ActivateProfileInput,
} from "@/validation/billing/activate-version.schema";
import {
  invoiceProfileSchema,
  toInvoiceProfileInput,
} from "@/validation/billing/invoice-profile.schema";

// bm61-spec §Design D2–D4, D6 (Inv #41/#42/#44/#45/#49): activate the working
// DRAFT company profile. Every check runs here (the disabled/hidden UI is UX
// only), in the D2 order; the first failure refuses and nothing changes:
//   2 change note → 3 draft + token → 4 logo set and its version ACTIVE →
//   5 the FULL `invoiceProfileSchema` → 6 the logo blob verifies.
// One `invoice_settings : EDIT` user may activate their own draft, bank
// changes included (G14 decided 2026-10-11: no four-eyes). Then one transaction: group lock → re-check the draft under FOR UPDATE →
// retire the ACTIVE version (+ `meta.retired_at`) → promote the draft
// (+ `meta.change_note/activated_by/activated_at`) → one
// `INVOICE_PROFILE_ACTIVATED` audit row. Retirement first, so two versions are
// never ACTIVE together. No blob is written; nothing is cached.

export type ActivateProfileResult =
  | { ok: true; configVersion: number; retiredVersion: number | null }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: ProfileActivationErrorCode };

const LOGO_KEY = "logo_asset_version_id";

function isMissingBlob(error: unknown): boolean {
  const e = error as { statusCode?: unknown; code?: unknown } | undefined;
  return e?.statusCode === 404 || e?.code === "BlobNotFound";
}

export async function activateProfile(
  rawInput: ActivateProfileInput,
  actorId: string,
): Promise<ActivateProfileResult> {
  // D2.2 — re-parsed here too (services assume an authorized context, not a
  // valid one).
  const parsed = activateProfileInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.message === "CHANGE_NOTE_REQUIRED")) {
      return { ok: false, code: "CHANGE_NOTE_REQUIRED" };
    }
    return { ok: false, code: "VALIDATION_ERROR", fieldErrors: {} };
  }
  const { configVersion, expectedDraftToken, changeNote } = parsed.data;

  // D2.3 — the draft exists, is a DRAFT, and the token matches.
  const draft = await invoiceProfileRepository.findDraftVersion(db);
  if (
    draft?.configVersion !== configVersion ||
    draft.token !== expectedDraftToken
  ) {
    return { ok: false, code: "DRAFT_CONFLICT" };
  }
  const fields = await invoiceProfileRepository.readVersion(db, configVersion);

  // D2.4 — a logo, whose asset version exists and is ACTIVE.
  const logoId = fields[LOGO_KEY]?.trim() || null;
  const logo = logoId
    ? await billAssetRepository.findVersionById(db, logoId)
    : null;
  if (logo?.status !== "ACTIVE") {
    return { ok: false, code: "PROFILE_LOGO_REQUIRED" };
  }

  // D2.5 — the FULL schema (every required field present and valid).
  const full = invoiceProfileSchema.safeParse(toInvoiceProfileInput(fields));
  if (!full.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of full.error.issues) {
      const key = issue.path.join(".") || "profile";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { ok: false, code: "VALIDATION_ERROR", fieldErrors };
  }

  // D2.6 — the logo blob verifies against its checksum: the render's own
  // parse + `inlineLogo`, over the rows and logo row already read above, so an
  // activated profile is renderable (DR-01 option A).
  try {
    await inlineLogo({
      profile: parseInvoiceProfile(configVersion, fields),
      logo,
    });
  } catch (error) {
    if (
      (error instanceof InvoiceRenderError &&
        error.code === "ASSET_CHECKSUM_MISMATCH") ||
      isMissingBlob(error)
    ) {
      return { ok: false, code: "ASSET_CHECKSUM_MISMATCH" };
    }
    throw error;
  }

  // D5 — the ACTIVE fields, for the audit row's before-image and its
  // `bankDetailsChanged` flag (no four-eyes: G14 decided 2026-10-11).
  const activeVersion = await invoiceProfileRepository.findActiveVersion(db);
  const activeFields =
    activeVersion === null
      ? null
      : await invoiceProfileRepository.readVersion(db, activeVersion);
  const bankDetailsChanged = paymentFieldsChanged(activeFields, fields);

  try {
    return await db.transaction(async (tx): Promise<ActivateProfileResult> => {
      await invoiceProfileRepository.lockProfileGroup(tx);
      // D3 — re-check D2.3 under FOR UPDATE of the draft rows. An unchanged
      // token means the fields and logo checked above still hold.
      const token = await invoiceProfileRepository.findDraftTokenForUpdate(
        tx,
        configVersion,
      );
      if (token !== expectedDraftToken) throw new DraftConflict();

      const now = new Date().toISOString();
      const retired = await invoiceProfileRepository.retireActiveVersion(tx);
      for (const version of retired) {
        await invoiceProfileRepository.writeMeta(tx, {
          configVersion: version,
          status: "RETIRED",
          values: { "meta.retired_at": now },
          actor: actorId,
        });
      }
      const retiredVersion = retired[0] ?? null;

      const promoted = await invoiceProfileRepository.promoteDraftVersion(
        tx,
        configVersion,
      );
      if (promoted === 0) throw new DraftConflict();
      await invoiceProfileRepository.writeMeta(tx, {
        configVersion,
        status: "ACTIVE",
        values: {
          "meta.change_note": changeNote,
          "meta.activated_by": actorId,
          "meta.activated_at": now,
        },
        actor: actorId,
      });

      await insertAuditEvent(tx, {
        eventType: "INVOICE_PROFILE_ACTIVATED",
        actorUserId: actorId,
        targetEntity: "SYSTEM_CONFIG",
        targetId: `${INVOICE_PROFILE_CONFIG_GROUP}:v${configVersion}`,
        beforeData: {
          activeVersion: retiredVersion,
          fields: retiredVersion === null ? null : activeFields,
        },
        afterData: {
          activatedVersion: configVersion,
          retiredVersion,
          changeNote,
          logoAssetVersionId: logo.billAssetVersionId,
          fields,
          bankDetailsChanged,
        },
      });
      return { ok: true, configVersion, retiredVersion };
    });
  } catch (error) {
    if (error instanceof DraftConflict) {
      return { ok: false, code: "DRAFT_CONFLICT" };
    }
    throw error;
  }
}
