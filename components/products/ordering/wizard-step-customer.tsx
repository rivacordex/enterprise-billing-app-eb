"use client";

import { useEffect, useState } from "react";

import { wizardSearchCustomersAction } from "@/actions/accounts/new-order-wizard-reads";
import type { CustomerSearchResult } from "@/types/customer";

export interface WizardStepCustomerProps {
  selectedCustomer: CustomerSearchResult | null;
  onSelect: (customer: CustomerSearchResult) => void;
}

// pm29-spec §Implementation-2 (`WizardStepCustomer`). Search input reusing
// the customer-search pattern (`searchCustomers`, customer module). A single
// name/trading-name search mode — `searchCustomers` itself has no
// party-role-id lookup mode to toggle onto (unlike `searchAccounts`'s
// `customer`/`name` modes), so this step deliberately offers one search box
// rather than a non-functional toggle. Non-`ACTIVE` parties render disabled
// with a status pill and reason (pm29-spec §Verification checklist).
export function WizardStepCustomer({
  selectedCustomer,
  onSelect,
}: WizardStepCustomerProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchResult[]>([]);
  // `isSearching` is derived, not its own setState toggled inside the effect
  // (react-hooks/set-state-in-effect forbids a synchronous setState call in
  // an effect body) — `resultsForQuery` only ever moves inside the async
  // `.then()` continuation below.
  const [resultsForQuery, setResultsForQuery] = useState<string | null>(null);
  const isSearching = query.trim() !== "" && resultsForQuery !== query;

  useEffect(() => {
    if (query.trim() === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void wizardSearchCustomersAction(query).then((data) => {
        if (cancelled) return;
        setResults(data?.results ?? []);
        setResultsForQuery(query);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const visibleResults = query.trim() === "" ? [] : results;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label
          className="text-body-sm font-medium text-foreground"
          htmlFor="wizard-customer-search"
        >
          Search customers
        </label>
        <input
          id="wizard-customer-search"
          type="text"
          autoFocus
          placeholder="Organization or trading name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        />
      </div>

      {isSearching && (
        <p className="text-body-sm text-muted-foreground">Searching…</p>
      )}

      {selectedCustomer && (
        <div className="rounded-[var(--radius)] bg-[color:var(--surface-selected)] px-3 py-2 text-body-sm">
          Selected: <strong>{selectedCustomer.organizationName}</strong> (
          {selectedCustomer.partyRoleId})
        </div>
      )}

      <ul className="divide-y divide-border rounded-md border border-border">
        {visibleResults.map((customer) => {
          const isOrderable = customer.customerStatus === "ACTIVE";
          const isSelected =
            selectedCustomer?.partyRoleId === customer.partyRoleId;
          return (
            <li key={customer.partyRoleId}>
              <button
                type="button"
                disabled={!isOrderable}
                aria-disabled={!isOrderable}
                onClick={() => isOrderable && onSelect(customer)}
                className={
                  "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-body-sm " +
                  (isOrderable
                    ? "hover:bg-[color:var(--action-ghost-hover)]"
                    : "cursor-not-allowed opacity-60") +
                  (isSelected ? " bg-[color:var(--surface-selected)]" : "")
                }
              >
                <span>
                  {customer.organizationName}
                  {customer.tradingName && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({customer.tradingName})
                    </span>
                  )}
                  <span className="ml-2 font-mono text-mono text-muted-foreground">
                    {customer.partyRoleId}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-full bg-[color:var(--surface-sunken)] px-2 py-0.5 text-caption text-muted-foreground uppercase">
                    {customer.customerStatus}
                  </span>
                  {!isOrderable && (
                    <span className="text-caption text-[color:var(--text-danger)]">
                      Not orderable — customer not ACTIVE
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {visibleResults.length === 0 && !isSearching && query.trim() !== "" && (
          <li className="px-3 py-4 text-center text-body-sm text-muted-foreground">
            No customers match your search
          </li>
        )}
      </ul>
    </div>
  );
}
