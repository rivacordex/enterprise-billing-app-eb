import { Skeleton } from "@/components/ui/skeleton";

export default function Loading(): React.JSX.Element {
  return (
    <div className="flex h-full gap-4 p-6">
      <div className="min-w-0 flex-[2] rounded-md bg-card p-4 shadow-sm">
        <Skeleton className="h-6 w-24" />
        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-[1] rounded-md bg-card p-4 shadow-md">
        <Skeleton className="h-6 w-32" />
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}
