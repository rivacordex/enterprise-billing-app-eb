"use client";

// ac20-spec §2.7/§3.6 — amber banner reporting pending-approval count for the
// current FA context. "Review now →" sets ?status=pending_approval (SC11).
// Count comes from the page's listPendingApprovals call; the component never
// fetches (inv. #15 read-path discipline, and no data-fetch in components).

import { AlertTriangle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface ApprovalBannerProps {
  count: number;
}

export function ApprovalBanner({
  count,
}: ApprovalBannerProps): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (count === 0) return null;

  function handleReviewNow(): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set("status", "pending_approval");
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-md border border-[color:var(--color-warning-200)] bg-[color:var(--color-warning-50)] px-4 py-3"
    >
      <AlertTriangle
        size={16}
        className="shrink-0 text-[color:var(--color-warning-700)]"
        aria-hidden="true"
      />
      <p className="flex-1 text-body-sm text-[color:var(--color-warning-700)]">
        {count} document{count !== 1 ? "s" : ""} awaiting approval for this
        Financial Account.
      </p>
      <button
        type="button"
        onClick={handleReviewNow}
        className="text-body-sm font-semibold text-[color:var(--color-warning-700)] underline-offset-2 hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
      >
        Review now →
      </button>
    </div>
  );
}
