import { ListPagination } from "@/components/common/list-pagination";

// Audit-log pagination — the shared `ListPagination` with the "events" noun.
// (Extracted; the billing run list uses the same control with "runs".)

interface AuditLogPaginationProps {
  total: number;
  page: number;
  pageSize: number;
}

export function AuditLogPagination(
  props: AuditLogPaginationProps,
): React.JSX.Element {
  return <ListPagination {...props} noun="events" />;
}
