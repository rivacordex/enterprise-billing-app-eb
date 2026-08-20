import { Skeleton } from "@/components/ui/skeleton";

export default function Loading(): React.JSX.Element {
  return (
    <div className="p-6">
      <div className="max-w-2xl rounded-md bg-card p-6 shadow-sm">
        <Skeleton className="h-6 w-40" />
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </div>
      </div>
    </div>
  );
}
