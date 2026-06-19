interface EntraConfigRowProps {
  label: string;
  value: string | null;
  children?: React.ReactNode;
}

// Presentational row for the read-only Entra ID Settings section
// (um10-spec §10.8) — label on the left, monospace value (or "Not
// configured") on the right, with an optional trailing slot for the
// redirect URI's copy button.
export function EntraConfigRow({
  label,
  value,
  children,
}: EntraConfigRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[color:var(--border-subtle)] py-3 last:border-b-0">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        {value === null ? (
          <span className="text-body text-muted-foreground">
            Not configured
          </span>
        ) : (
          <span className="truncate font-mono text-body-sm text-foreground">
            {value}
          </span>
        )}
        {children}
      </dd>
    </div>
  );
}
