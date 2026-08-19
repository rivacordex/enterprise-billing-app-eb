import { ListPagination } from "@/components/common/list-pagination";

// bm02-spec §6. Historical-tab pagination — the shared `ListPagination` with
// the "runs" noun (extracted so it no longer duplicates the audit-log copy).

interface BillRunsPaginationProps {
  total: number;
  page: number;
  pageSize: number;
}

export function BillRunsPagination(
  props: BillRunsPaginationProps,
): React.JSX.Element {
  return <ListPagination {...props} noun="runs" />;
}
