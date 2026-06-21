import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { AuditLogFilters } from "@/components/audit-log/audit-log-filters";
import { AuditLogPagination } from "@/components/audit-log/audit-log-pagination";
import { AuditLogTable } from "@/components/audit-log/audit-log-table";
import {
  getAuditLog,
  getAuditLogActors,
} from "@/services/audit-log/audit-log-read.service";
import { auditLogSearchParamsSchema } from "@/validation/audit-log-filters.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit Log — Enterprise Billing",
};

interface AuditLogPageProps {
  searchParams: Promise<{
    eventType?: string | string[];
    actorUserId?: string | string[];
    dateFrom?: string | string[];
    dateTo?: string | string[];
    page?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuditLogPage({
  searchParams,
}: AuditLogPageProps): Promise<React.JSX.Element> {
  // audit_log is READ-max (Invariant #11) — LEVELS.READ is the only valid
  // guard level for this route; no canEdit/permissionMap branching follows.
  await requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.READ);

  const raw = await searchParams;
  const parsed = auditLogSearchParamsSchema.parse({
    eventType: firstValue(raw.eventType) ?? null,
    actorUserId: firstValue(raw.actorUserId) ?? null,
    dateFrom: firstValue(raw.dateFrom) ?? null,
    dateTo: firstValue(raw.dateTo) ?? null,
    page: firstValue(raw.page) ?? 1,
  });

  const [auditPage, actors] = await Promise.all([
    getAuditLog(parsed),
    getAuditLogActors(),
  ]);

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-h1 font-semibold text-foreground">Audit Log</h1>
        <p className="mt-1 text-body text-muted-foreground">
          A complete, immutable record of all system events.
        </p>
      </div>

      <Suspense>
        <AuditLogFilters actors={actors} />
      </Suspense>

      <div className="overflow-hidden rounded-md bg-card shadow-sm">
        <AuditLogTable rows={auditPage.rows} />
        {auditPage.total > 0 && (
          <div className="px-4 pb-4">
            <Suspense>
              <AuditLogPagination
                total={auditPage.total}
                page={auditPage.page}
                pageSize={auditPage.pageSize}
              />
            </Suspense>
          </div>
        )}
      </div>
    </main>
  );
}
