// `/` is a temporary public placeholder, replaced by the authenticated root
// redirect in um06. No auth, no nav, no data fetching — theme demo only.

export default function Home(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--surface-app)]">
      <header className="bg-[image:var(--gradient-chrome)] px-6 py-4">
        <span className="text-h4 font-semibold text-[var(--text-on-brand)]">
          Enterprise Billing
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-lg bg-card p-8 shadow-md">
          <h1 className="text-display font-semibold text-foreground">
            User Management
          </h1>
          <p className="mt-2 text-body text-foreground">
            User Management — coming online
          </p>

          <span className="mt-6 inline-flex items-center rounded-sm bg-primary px-3 py-1.5 text-body-sm font-medium text-primary-foreground">
            Module scaffold ready
          </span>

          <p className="mt-4 text-caption text-muted-foreground">
            Tooling and themed shell only — see um01.
          </p>
        </div>
      </main>
    </div>
  );
}
