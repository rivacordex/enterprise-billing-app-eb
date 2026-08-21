import { db } from "@/db/client";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import type { AuditLogRow } from "@/types/audit-log";

// bm07-spec §Design/§Implementation §2. The Audit tab's read — reuses the
// platform `AUDIT_LOG` read filtered to the run (`target_id = runId`), newest
// first. The run's `BILL_RUN_*` events (materialize/trigger, and later
// rerun/approve/cancel) all stamp `targetId = billRunId`, so this surfaces the
// run's whole trail. The row shape is the platform `AuditLogRow` so the
// existing `AuditLogTable` renders it unchanged (code-standards §4.8 — never
// fork a parallel table).
export async function listRunAudit(billRunId: string): Promise<AuditLogRow[]> {
  return auditLogRepository.findByTargetId(db, billRunId);
}
