// bm07-spec §Visual — the Audit tab: the run's `AUDIT_LOG` events, newest
// first. Reuses the platform `AuditLogTable` unchanged (code-standards §4.8 —
// never fork a parallel table); this thin wrapper only supplies the
// module-scoped empty-state framing and keeps the `components/billing/*`
// file-org convention (code-standards §7). Server component — `AuditLogTable`
// is the interaction leaf (its own `'use client'`).

import { AuditLogTable } from "@/components/audit-log/audit-log-table";
import type { AuditLogRow } from "@/types/audit-log";

export interface AuditTableProps {
  rows: AuditLogRow[];
  timezone: string;
}

export function AuditTable({
  rows,
  timezone,
}: AuditTableProps): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-none bg-card shadow-sm">
      <AuditLogTable rows={rows} timezone={timezone} />
    </div>
  );
}
