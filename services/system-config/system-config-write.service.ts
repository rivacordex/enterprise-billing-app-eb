import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { UpdateConfigInput } from "@/validation/update-config.schema";

export type UpdateConfigResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "SECRET_ROW" };

// um23-spec §23.4. Defense-in-depth: `findAllNonSecret` (um22) already
// excludes secret rows from the UI, so a secret row can only reach this
// service via a stale/forged `configId` — the `isSecret` check below blocks
// the write regardless. Reads the before-snapshot ahead of the transaction;
// the value write + `SYSTEM_CONFIG_CHANGED` audit entry run atomically
// inside it, mirroring `updateRole`'s shape. No internal try/catch — a
// thrown error propagates to the action's catch (`SERVER_ERROR` is an
// action-boundary concern, not modeled here, per `deleteRole`'s documented
// um21 precedent).
export async function updateConfigValue(
  input: UpdateConfigInput,
  actorId: string,
): Promise<UpdateConfigResult> {
  const row = await systemConfigRepository.findById(db, input.configId);
  if (!row) {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (row.isSecret) {
    return { ok: false, code: "SECRET_ROW" };
  }

  const beforeData = {
    configGroup: row.configGroup,
    configKey: row.configKey,
    configValue: row.configValue,
    status: row.status,
    modifiedBy: row.modifiedByUserId,
  };

  await db.transaction(async (tx) => {
    await systemConfigRepository.updateValue(
      tx,
      input.configId,
      input.configValue,
      actorId,
    );

    await insertAuditEvent(tx, {
      eventType: "SYSTEM_CONFIG_CHANGED",
      actorUserId: actorId,
      targetEntity: "SYSTEM_CONFIG",
      targetId: input.configId,
      beforeData,
      afterData: {
        configGroup: row.configGroup,
        configKey: row.configKey,
        configValue: input.configValue,
        status: row.status,
        modifiedBy: actorId,
      },
    });
  });

  return { ok: true };
}
