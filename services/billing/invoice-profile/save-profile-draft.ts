import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { INVOICE_PROFILE_CONFIG_GROUP } from "@/types/billing";
import {
  INVOICE_PROFILE_FIELD_KEYS,
  saveProfileDraftInputSchema,
  type InvoiceProfileDraftValues,
  type SaveProfileDraftInput,
} from "@/validation/billing/invoice-profile.schema";

// bm59-spec §Design D1/D2/D4 (Inv #44/#49): save the company profile as the
// single working DRAFT version of `invoice.profile`. No activation, no logo
// write (bm60), no `meta.*` write (bm61); a DRAFT is never resolved for
// rendering (`findActiveVersion` reads ACTIVE rows only).
//
// One transaction: group advisory lock (taken first, so two concurrent first
// saves become one insert plus one `DRAFT_CONFLICT`) → re-parse (defense in
// depth: services assume an authorized context, not a valid one) → insert the
// full key set at `max + 1`, or update only the changed keys under the token →
// exactly one `INVOICE_PROFILE_DRAFT_SAVED` audit row. A save that changes no
// key of the existing draft writes nothing and is not audited (`changed:
// false`).
export type SaveProfileDraftResult =
  | { ok: true; versionNo: number; draftToken: string; changed: boolean }
  | { ok: false; code: "DRAFT_CONFLICT" | "VALIDATION_ERROR" };

const UNIQUE_VIOLATION = "23505";
const PROFILE_VERSION_UNIQUE = "system_config_group_version_key_unique";
const LOGO_KEY = "logo_asset_version_id";

interface PgErrorFields {
  code?: string;
  constraint_name?: string;
}

// Only a lost race on the version key is a conflict; any other unique
// violation (the audit insert, say) is a real fault.
export function isProfileDraftRaceViolation(error: unknown): boolean {
  const e = error as (PgErrorFields & { cause?: PgErrorFields }) | undefined;
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint_name ?? e?.cause?.constraint_name;
  return code === UNIQUE_VIOLATION && constraint === PROFILE_VERSION_UNIQUE;
}

// The submitted field set as stored text: every form key present, a blank
// (absent) value is `NULL` (D1 — no "missing key" state).
function toStoredValues(
  fields: InvoiceProfileDraftValues,
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const key of INVOICE_PROFILE_FIELD_KEYS) {
    const value = fields[key];
    values[key] = value === undefined ? null : String(value);
  }
  return values;
}

function targetId(version: number): string {
  return `${INVOICE_PROFILE_CONFIG_GROUP}:v${version}`;
}

export async function saveProfileDraft(
  rawInput: SaveProfileDraftInput,
  actorId: string,
): Promise<SaveProfileDraftResult> {
  const parsed = saveProfileDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };
  const { expectedDraftToken } = parsed.data;
  const submitted = toStoredValues(parsed.data.fields);

  try {
    return await db.transaction(async (tx): Promise<SaveProfileDraftResult> => {
      await invoiceProfileRepository.lockProfileGroup(tx);
      const draft = await invoiceProfileRepository.findDraftVersion(tx);

      if (draft) {
        if (expectedDraftToken !== draft.token) {
          return { ok: false, code: "DRAFT_CONFLICT" };
        }
        const stored = await invoiceProfileRepository.readVersion(
          tx,
          draft.configVersion,
        );
        const before: Record<string, string | null> = {};
        const changes: Record<string, string | null> = {};
        for (const key of INVOICE_PROFILE_FIELD_KEYS) {
          const old = stored[key] ?? null;
          if (old !== submitted[key]) {
            before[key] = old;
            changes[key] = submitted[key] ?? null;
          }
        }
        // Nothing differs after normalisation ("Acme " → "Acme"): no write
        // and no audit row (owner decision 2026-10-11); the token is unchanged.
        if (Object.keys(changes).length === 0) {
          return {
            ok: true,
            versionNo: draft.configVersion,
            draftToken: draft.token,
            changed: false,
          };
        }
        const token = await invoiceProfileRepository.updateDraftFields(tx, {
          version: draft.configVersion,
          changes,
          actor: actorId,
          expectedToken: expectedDraftToken,
        });
        if (token === null) return { ok: false, code: "DRAFT_CONFLICT" };

        await insertAuditEvent(tx, {
          eventType: "INVOICE_PROFILE_DRAFT_SAVED",
          actorUserId: actorId,
          targetEntity: "SYSTEM_CONFIG",
          targetId: targetId(draft.configVersion),
          beforeData: { configVersion: draft.configVersion, fields: before },
          afterData: { configVersion: draft.configVersion, fields: changes },
        });
        return {
          ok: true,
          versionNo: draft.configVersion,
          draftToken: token,
          changed: true,
        };
      }

      // No draft exists. A client that believed one did is stale.
      if (expectedDraftToken !== null) {
        return { ok: false, code: "DRAFT_CONFLICT" };
      }

      // The form never sends the logo (bm60 writes it). A new draft starts
      // from the ACTIVE version, so it carries the ACTIVE logo over rather
      // than silently dropping it.
      const active = await invoiceProfileRepository.findActiveVersion(tx);
      const activeLogo =
        active === null
          ? null
          : ((await invoiceProfileRepository.readVersion(tx, active))[
              LOGO_KEY
            ] ?? null);
      const fields = { ...submitted, [LOGO_KEY]: activeLogo };

      const version = await invoiceProfileRepository.nextProfileVersion(tx);
      const token = await invoiceProfileRepository.insertDraftVersion(tx, {
        version,
        fields,
        actor: actorId,
      });
      await insertAuditEvent(tx, {
        eventType: "INVOICE_PROFILE_DRAFT_SAVED",
        actorUserId: actorId,
        targetEntity: "SYSTEM_CONFIG",
        targetId: targetId(version),
        beforeData: null,
        afterData: { configVersion: version, fields },
      });
      return { ok: true, versionNo: version, draftToken: token, changed: true };
    });
  } catch (error) {
    if (isProfileDraftRaceViolation(error)) {
      return { ok: false, code: "DRAFT_CONFLICT" };
    }
    throw error;
  }
}
