// cm20 (custmgmt-ui-context §9.3) — Suspense fallback while the Accounts tab
// streams.

import { Skeleton } from "@/components/ui/skeleton";

export function AccountsTabSkeleton(): React.JSX.Element {
  return (
    <div aria-label="Loading accounts" aria-busy="true" className="space-y-4">
      <Skeleton className="h-28 w-full bg-[color:var(--surface-sunken)]" />
      <Skeleton className="h-36 w-full bg-[color:var(--surface-sunken)]" />
      <Skeleton className="h-48 w-full bg-[color:var(--surface-sunken)]" />
    </div>
  );
}
