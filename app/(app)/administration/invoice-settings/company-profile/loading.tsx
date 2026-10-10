// bm56-spec §Implementation 5 — the §6c skeleton: four stacked group cards.
export default function Loading(): React.JSX.Element {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, group) => (
        <div
          key={group}
          className="animate-pulse space-y-3 rounded-none border border-border bg-card p-4"
        >
          <div className="h-4 w-1/4 rounded bg-[color:var(--color-neutral-200)]" />
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((__, i) => (
              <div
                key={i}
                className="h-8 w-full rounded bg-[color:var(--color-neutral-100)]"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
