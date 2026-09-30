import { Skeleton } from "@/components/ui/skeleton";

// pm65-spec I1 — the version-list skeleton ONLY. The row preview has nothing to
// load until a version is selected (the §3.10 precedent from Manage Products'
// loading.tsx, which renders the families-table skeleton only, not panel
// skeletons).
export default function Loading(): React.JSX.Element {
  return (
    <div className="space-y-5 p-5">
      <Skeleton className="h-6 w-40" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
