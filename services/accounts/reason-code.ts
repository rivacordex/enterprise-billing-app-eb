import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { reasonCodeRepository } from "@/db/repositories/accounts/reason-code.repository";
import type { ReasonCode } from "@/db/schema/billing/catalogs";
import type { UpsertReasonCodeInput } from "@/validation/accounts/reason-code.schema";

export type { ReasonCode };

export type UpsertReasonCodeResult =
  | { ok: true }
  | { ok: false; code: "DUPLICATE_CODE" }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "LAST_MODIFIED_REQUIRED" };

export type RetireReasonCodeResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ALREADY_RETIRED" }
  | { ok: false; code: "CONFLICT" };

export async function listReasonCodes(): Promise<ReasonCode[]> {
  return reasonCodeRepository.findAll(db);
}

export async function upsertReasonCode(
  input: UpsertReasonCodeInput,
  actorId: string,
): Promise<UpsertReasonCodeResult> {
  const existing = await reasonCodeRepository.findByCode(db, input.reasonCode);

  if (!existing) {
    try {
      await reasonCodeRepository.insert(db, {
        reasonCode: input.reasonCode,
        name: input.name ?? null,
        description: input.description ?? null,
        docType: input.docType,
        postingNature: input.postingNature,
        autoPostLimit: input.autoPostLimit,
        lastEditedBy: actorId,
      });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        (e as { code?: string }).code === "23505"
      ) {
        return { ok: false, code: "DUPLICATE_CODE" };
      }
      throw e;
    }
    await insertAuditEvent(db, {
      eventType: "REASON_CODE_CHANGED",
      actorUserId: actorId,
      targetEntity: "reason_code",
      targetId: input.reasonCode,
      beforeData: null,
      afterData: {
        reasonCode: input.reasonCode,
        docType: input.docType,
        postingNature: input.postingNature,
        autoPostLimit: input.autoPostLimit,
      },
    });
    return { ok: true };
  }

  // Edit existing — CAS on lastModified required.
  if (!input.lastModified) {
    return { ok: false, code: "LAST_MODIFIED_REQUIRED" };
  }

  return db.transaction(async (tx) => {
    const result = await reasonCodeRepository.update(tx, {
      reasonCode: input.reasonCode,
      name: input.name ?? null,
      description: input.description ?? null,
      autoPostLimit: input.autoPostLimit,
      lastModified: new Date(input.lastModified!),
      lastEditedBy: actorId,
    });

    if (result !== "updated") {
      return {
        ok: false,
        code: ({ not_found: "NOT_FOUND", conflict: "CONFLICT" } as const)[
          result
        ],
      };
    }

    // Q20: threshold changes are audited config — always audit the update
    // so before/after autoPostLimit is visible in the audit log.
    await insertAuditEvent(tx, {
      eventType: "REASON_CODE_CHANGED",
      actorUserId: actorId,
      targetEntity: "reason_code",
      targetId: input.reasonCode,
      beforeData: { autoPostLimit: existing.autoPostLimit },
      afterData: { autoPostLimit: input.autoPostLimit },
    });

    return { ok: true };
  });
}

export async function retireReasonCode(
  reasonCodeValue: string,
  lastModified: Date,
  actorId: string,
): Promise<RetireReasonCodeResult> {
  const result = await reasonCodeRepository.retire(
    db,
    reasonCodeValue,
    lastModified,
  );

  if (result === "updated") {
    await insertAuditEvent(db, {
      eventType: "REASON_CODE_CHANGED",
      actorUserId: actorId,
      targetEntity: "reason_code",
      targetId: reasonCodeValue,
      beforeData: { state: "active" },
      afterData: { state: "retired" },
    });
    return { ok: true };
  }

  return {
    ok: false,
    code: (
      {
        not_found: "NOT_FOUND",
        already_retired: "ALREADY_RETIRED",
        conflict: "CONFLICT",
      } as const
    )[result],
  };
}
