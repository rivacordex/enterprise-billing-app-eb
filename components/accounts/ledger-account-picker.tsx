// Ledger account picker (ac06-spec §2.1, §3.1). Native GET form — no client
// JS required, matching the Overview search pattern (code-standards §3.1).
// Selecting a result sets `?account=pgla_…` and clears the drawer/page/sort
// state so a new account starts its own trace from page 1.

import Link from "next/link";

import { AmountCell } from "@/components/accounts/amount-cell";
import { LedgerKindChip } from "@/components/accounts/ledger-kind-chip";
import type { LedgerAccountSearchResult } from "@/types/accounts";

export interface LedgerAccountPickerProps {
  acctq: string;
  results: LedgerAccountSearchResult[];
  selectedAccountId: string | null;
  baseParams: Record<string, string | undefined>;
}

function buildUrl(
  baseParams: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  const merged = { ...baseParams, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) sp.set(k, v);
  }
  return `/accounts/ledger?${sp.toString()}`;
}

export function LedgerAccountPicker({
  acctq,
  results,
  selectedAccountId,
  baseParams,
}: LedgerAccountPickerProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-h3 font-semibold text-foreground">Account Picker</h2>

      <form
        method="get"
        action="/accounts/ledger"
        className="flex flex-wrap items-end gap-3"
      >
        {selectedAccountId && (
          <input type="hidden" name="account" value={selectedAccountId} />
        )}
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="ledger-acct-search"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Search by name (ban.*/fa.*/sys.*)
          </label>
          <input
            id="ledger-acct-search"
            name="acctq"
            type="search"
            defaultValue={acctq}
            placeholder="e.g. ban.BAN000001.receivables"
            className="h-9 min-w-[20rem] rounded-md border border-[color:var(--border-default)] bg-background px-3 font-mono text-body text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="h-9 rounded-md bg-[color:var(--action-primary-bg)] px-4 text-body font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)]"
        >
          Search
        </button>
      </form>

      {acctq.trim().length > 0 && (
        <div className="space-y-1">
          {results.length === 0 ? (
            <p className="text-body text-muted-foreground">
              No ledger accounts match &ldquo;{acctq}&rdquo;.
            </p>
          ) : (
            <div
              role="list"
              className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-default)]"
            >
              {results.map((r) => {
                const isSelected = r.id === selectedAccountId;
                const href = buildUrl(baseParams, {
                  account: r.id,
                  transfer: undefined,
                  page: undefined,
                });
                return (
                  <Link
                    key={r.id}
                    href={href}
                    role="listitem"
                    className={`flex items-center gap-4 px-4 py-3 text-body transition-colors hover:bg-[color:var(--surface-sunken)] ${
                      isSelected
                        ? "bg-[color:var(--acct-context-strip-bg)]"
                        : "bg-[color:var(--surface-card)]"
                    }`}
                  >
                    <LedgerKindChip kind={r.label.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-body text-foreground">
                        {r.name}
                      </span>
                      {r.label.ownerLabel && (
                        <span className="block truncate text-body-sm text-muted-foreground">
                          {r.label.ownerLabel}
                        </span>
                      )}
                    </span>
                    <AmountCell amount={r.balance} currency={r.currency} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
