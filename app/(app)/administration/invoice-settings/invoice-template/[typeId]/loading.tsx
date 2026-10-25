// bm55-spec §Implementation 4 — the §6c PDF-shaped skeleton beside the form
// column, captioned as the preview's loading state.
export default function Loading(): React.JSX.Element {
  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="animate-pulse space-y-3 rounded-md border border-border bg-card p-4">
        <div className="h-3 w-1/3 rounded bg-[color:var(--color-neutral-200)]" />
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="h-4 w-full rounded bg-[color:var(--color-neutral-100)]"
          />
        ))}
      </div>
      <div className="flex aspect-[210/297] w-full flex-col items-center justify-center gap-3 rounded-none border border-[color:var(--border-default)] bg-[color:var(--surface-sunken)] p-6">
        <div className="pdfwrap w-2/3 max-w-xs animate-pulse space-y-2 rounded-sm bg-[color:var(--surface-card)] p-4 shadow-sm">
          <div className="h-3 w-1/2 rounded bg-[color:var(--color-neutral-200)]" />
          <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
          <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
          <div className="h-2 w-5/6 rounded bg-[color:var(--color-neutral-100)]" />
          <div className="mt-4 h-2 w-1/3 rounded bg-[color:var(--color-neutral-100)]" />
        </div>
        <p className="text-body-sm text-muted-foreground">
          Rendering draft invoice…
        </p>
      </div>
    </div>
  );
}
