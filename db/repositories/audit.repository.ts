import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema/audit";
import type { AuditEventType } from "@/types/audit";

export interface AuditEventInput {
  eventType: AuditEventType;
  actorUserId: string | null;
  targetEntity: string | null;
  targetId: string | null;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
}

export async function insertAuditEvent(
  db: Database,
  event: AuditEventInput,
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

// bm83 — one multi-row INSERT with insertAuditEvent's column mapping (the retire
// switch audits each moved BAN in chunks). No events → no statement.
export async function insertAuditEvents(
  db: Database,
  events: readonly AuditEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await db.insert(auditLog).values(
    events.map((event) => ({
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      targetEntity: event.targetEntity,
      targetId: event.targetId,
      beforeData: event.beforeData,
      afterData: event.afterData,
    })),
  );
}
