import { db } from "@/db/client";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { localDayToUtcBounds } from "@/lib/timezone";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import type {
  AuditLogActorOption,
  AuditLogFiltersInput,
  AuditLogPage,
} from "@/types/audit-log";
import type { AuditLogSearchParams } from "@/validation/audit-log-filters.schema";

const PAGE_SIZE = 50;

// Backs the `/administration/audit-log` page (um24-spec §24.4). Converts
// validated URL params into repository-shaped filters — a picked `YYYY-MM-DD`
// is interpreted as a **local day in the configured business zone** and
// converted to the correct UTC start/end instants here (um29-spec §2.6), so
// the repository's `gte`/`lte` clauses stay simple UTC column comparisons.
// When the zone is `UTC` the conversion is the identity, preserving today's
// behavior exactly. The `params.dateFrom ? … : null` guards keep a null
// filter unfiltered, and `localDayToUtcBounds` never throws — together
// preserving um24's "never 500s" lenient-filter contract.
export async function getAuditLog(
  params: AuditLogSearchParams,
): Promise<AuditLogPage> {
  const timezone = getAppTimezone();

  const filters: AuditLogFiltersInput = {
    eventType: params.eventType,
    actorUserId: params.actorUserId,
    dateFrom: params.dateFrom
      ? localDayToUtcBounds(params.dateFrom, timezone).start
      : null,
    dateTo: params.dateTo
      ? localDayToUtcBounds(params.dateTo, timezone).end
      : null,
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
