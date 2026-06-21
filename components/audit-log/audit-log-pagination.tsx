"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface AuditLogPaginationProps {
  total: number;
  page: number;
  pageSize: number;
}

export function AuditLogPagination({
  total,
  page,
  pageSize,
}: AuditLogPaginationProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const totalPages = Math.ceil(total / pageSize);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  function navigateToPage(targetPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(targetPage));
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] pt-4">
      <span className="text-body text-muted-foreground">
        Showing {start}–{end} of {total} events
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigateToPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 text-body text-muted-foreground">
          Page {page} of {totalPages || 1}
        </span>
        <button
          type="button"
          onClick={() => navigateToPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
