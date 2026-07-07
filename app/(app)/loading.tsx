export default function Loading(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <span role="status" aria-live="polite" className="sr-only">
        Loading…
      </span>
      <div className="w-full max-w-[440px] animate-pulse rounded-lg bg-card p-8 shadow-md">
        <div className="h-5 w-36 rounded-sm bg-muted" />
        <div className="mt-6 h-7 w-24 rounded-sm bg-muted" />
        <div className="mt-2 h-4 w-64 rounded-sm bg-muted" />
      </div>
    </div>
  );
}
