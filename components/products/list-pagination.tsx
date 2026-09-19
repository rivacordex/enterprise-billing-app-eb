import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Shared "Showing X–Y of N" + prev/next pager for the product list tables (pm39
// review dedup). Serves both interaction models: pass `hrefFor` for a server
// component (renders `<Link>`s, family-table) or `onNavigate` for a client
// component (renders `<button>`s with a `disabled` pending state, offering-table).
// The caller decides when to render it (e.g. only when there are rows).
export interface ListPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  itemLabel: string; // "offerings" / "products"
  hrefFor?: (page: number) => string; // server (Link) mode
  onNavigate?: (page: number) => void; // client (button) mode
  disabled?: boolean; // client mode: pending state
}

const CONTROL_CLASS =
  "rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function ListPagination({
  page,
  pageSize,
  total,
  itemLabel,
  hrefFor,
  onNavigate,
  disabled = false,
}: ListPaginationProps): React.JSX.Element {
  const totalPages = Math.ceil(total / pageSize) || 1;

  function control(
    direction: "prev" | "next",
    targetPage: number,
    atBound: boolean,
  ): React.JSX.Element {
    const label = direction === "prev" ? "Previous page" : "Next page";
    const Icon = direction === "prev" ? ChevronLeft : ChevronRight;

    // Server (Link) mode: a real link when navigable, a muted span at the bound.
    if (hrefFor) {
      return atBound ? (
        <span aria-hidden className="p-1 text-muted-foreground opacity-50">
          <Icon className="size-4" />
        </span>
      ) : (
        <Link
          href={hrefFor(targetPage)}
          aria-label={label}
          className={CONTROL_CLASS}
        >
          <Icon className="size-4" />
        </Link>
      );
    }

    // Client (button) mode: disabled at the bound or while a transition pends.
    return (
      <button
        type="button"
        onClick={() => onNavigate?.(targetPage)}
        disabled={atBound || disabled}
        aria-label={label}
        className={CONTROL_CLASS}
      >
        <Icon className="size-4" />
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-4 py-4">
      <span className="text-body text-muted-foreground">
        Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}{" "}
        of {total} {itemLabel}
      </span>
      <div className="flex items-center gap-1">
        {control("prev", page - 1, page <= 1)}
        <span className="px-2 text-body text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        {control("next", page + 1, page >= totalPages)}
      </div>
    </div>
  );
}
