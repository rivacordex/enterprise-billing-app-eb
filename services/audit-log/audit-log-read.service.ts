import { db } from "@/db/client";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import type {
  AuditLogActorOption,
  AuditLogFiltersInput,
  AuditLogPage,
} from "@/types/audit-log";
import type { AuditLogSearchParams } from "@/validation/audit-log-filters.schema";

const PAGE_SIZE = 50;

// Backs the `/administration/audit-log` page (um24-spec §24.4). Converts
// validated URL params into repository-shaped filters — `dateFrom`/`dateTo`
// become UTC day boundaries here so the repository's `gte`/`lte` clauses
// stay simple column comparisons.
export async function getAuditLog(
  params: AuditLogSearchParams,
): Promise<AuditLogPage> {
  const filters: AuditLogFiltersInput = {
    eventType: params.eventType,
    actorUserId: params.actorUserId,
    dateFrom: params.dateFrom
      ? new Date(`${params.dateFrom}T00:00:00.000Z`)
      : null,
    dateTo: params.dateTo ? new Date(`${params.dateTo}T23:59:59.999Z`) : null,
  };

  const result = await auditLogRepository.findFiltered(
    db,
    filters,
    params.page,
    PAGE_SIZE,
  );

  return {
    rows: result.rows,
    total: result.total,
    page: params.page,
    pageSize: PAGE_SIZE,
  };
}

// Thin wrapper preserving the page -> service -> repository boundary
// (tests mock this service, not the repository directly).
export async function getAuditLogActors(): Promise<AuditLogActorOption[]> {
  return auditLogRepository.findActors(db);
}
