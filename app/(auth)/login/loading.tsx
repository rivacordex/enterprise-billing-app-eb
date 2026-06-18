export default function Loading(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--surface-nav)] px-4 py-12">
      <div className="w-full max-w-[440px] animate-pulse rounded-lg bg-card p-8 shadow-lg">
        <div className="mx-auto h-5 w-36 rounded-sm bg-muted" />
        <div className="mx-auto mt-6 h-7 w-24 rounded-sm bg-muted" />
        <div className="mx-auto mt-2 h-4 w-64 rounded-sm bg-muted" />
        <div className="mt-8 flex flex-col gap-4">
          <div className="h-8 rounded-sm bg-muted" />
          <div className="h-8 rounded-sm bg-muted" />
          <div className="h-8 rounded-sm bg-muted" />
        </div>
      </div>
    </div>
  );
}
