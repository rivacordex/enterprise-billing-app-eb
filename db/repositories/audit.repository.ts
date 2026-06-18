import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema/audit";
import type { AuditEventType } from "@/types/audit";

export async function insertAuditEvent(
  db: Database,
  event: {
    eventType: AuditEventType;
    actorUserId: string | null;
    targetEntity: string | null;
    targetId: string | null;
    beforeData: Record<string, unknown> | null;
    afterData: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    targetEntity: event.targetEntity,
    targetId: event.targetId,
    beforeData: event.beforeData,
    afterData: event.afterData,
  });
}
