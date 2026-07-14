"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CustomerSearchPanelProps {
  query: string;
  baseHref: string;
}

export function CustomerSearchPanel({
  query,
  baseHref,
}: CustomerSearchPanelProps): React.JSX.Element {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [isPending, startTransition] = useTransition();

  function apply(): void {
    const params = new URLSearchParams();
    if (value.trim()) params.set("q", value.trim());
    startTransition(() => {
      router.replace(params.toString() ? `${baseHref}?${params}` : baseHref);
    });
  }

  function clear(): void {
    setValue("");
    startTransition(() => router.replace(baseHref));
  }

  return (
    <div className={cn("flex items-center gap-2", isPending && "opacity-60")}>
      <input
        aria-label="Search customers by organization or trading name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        disabled={isPending}
        className="h-9 w-72 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      />
      <Button onClick={apply} disabled={isPending}>
        Apply
      </Button>
      {query && (
        <Button variant="ghost" onClick={clear} disabled={isPending}>
          Clear
        </Button>
      )}
    </div>
  );
}
