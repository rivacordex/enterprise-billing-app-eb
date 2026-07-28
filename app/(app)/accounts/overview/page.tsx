import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { AmountCell } from "@/components/accounts/amount-cell";
import { ContextStrip } from "@/components/accounts/context-strip";
import { PaymentStatusBadge } from "@/components/accounts/payment-status-badge";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { searchAccounts } from "@/services/accounts/search-accounts";
import type { AccountSearchMode } from "@/services/accounts/search-accounts";
import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Accounts Overview" };

// ─── helpers ────────────────────────────────────────────────────────────────

function firstStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function buildUrl(
  base: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  const merged = { ...base, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) sp.set(k, v);
  }
  return `/accounts/overview?${sp.toString()}`;
}

const STATE_LABELS: Record<string, string> = {
  active: "Active",
  suspended: "Suspended",
  closed: "Closed",
};

const STATE_CLASSES: Record<string, string> = {
  active:
    "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
  suspended:
    "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
  closed:
    "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
};

function StateChip({ state }: { state: string }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase ${STATE_CLASSES[state] ?? ""}`}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export default async function AccountsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.ACCOUNTS_VIEW, LEVELS.READ);

  const params = await searchParams;
  const ctx = parseAccountsContext(params);

  const rawQ = firstStr(params.q)?.trim();
  const q = rawQ || undefined;
  const mode: AccountSearchMode =
    firstStr(params.mode) === "name" ? "name" : "customer";

  // Shared base params — preserved across all navigation links so context
  // is maintained when drilling between sections.
  const baseParams: Record<string, string | undefined> = {
    ...(q ? { q } : {}),
    mode,
    party: ctx.party,
    fa: ctx.fa,
    ban: ctx.ban,
  };

  const [searchResults, faDetail, banDetail] = await Promise.all([
    q ? searchAccounts(q, mode) : null,
    ctx.fa ? getFinancialAccountDetail(ctx.fa) : null,
    ctx.ban ? getBillingAccountDetail(ctx.ban) : null,
  ]);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Accounts Overview
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          Search for a customer, select a Financial Account and Billing Account
          to view live balances.
        </p>
      </header>

      <ContextStrip
        party={ctx.party}
        partyName={faDetail?.relatedParty[0]?.name}
        fa={ctx.fa}
        faName={faDetail?.fa.name}
        ban={ctx.ban}
        banName={banDetail?.ban.name}
      />

      {/* ── Section 1: Search ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-h3 font-semibold text-foreground">
          Search Accounts
        </h2>

        {/* Native GET form — no client JS required; submit updates URL params. */}
        <form
          method="get"
          action="/accounts/overview"
          className="flex flex-wrap items-end gap-3"
        >
          {/* Preserve active context across a new search. */}
          {ctx.party && <input type="hidden" name="party" value={ctx.party} />}
          {ctx.fa && <input type="hidden" name="fa" value={ctx.fa} />}
          {ctx.ban && <input type="hidden" name="ban" value={ctx.ban} />}

          <div className="flex flex-col gap-1">
            <label
              htmlFor="acct-search-mode"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Search by
            </label>
            <select
              id="acct-search-mode"
              name="mode"
              defaultValue={mode}
              className="h-9 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              <option value="customer">Customer ID</option>
              <option value="name">Name</option>
            </select>
          </div>

          <div className="flex flex-1 flex-col gap-1">
            <label
              htmlFor="acct-search-q"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              {mode === "customer"
                ? "Party role ID (PTRL…)"
                : "Organisation name"}
            </label>
            <input
              id="acct-search-q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder={
                mode === "customer" ? "e.g. PTRL00000001" : "e.g. Acme Corp"
              }
              className="h-9 min-w-[18rem] rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            />
          </div>

          <button
            type="submit"
            className="h-9 rounded-md bg-[color:var(--action-primary-bg)] px-4 text-body font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)]"
          >
            Search
          </button>
        </form>

        {searchResults !== null && (
          <div className="space-y-1">
            {searchResults.hasMore && (
              <p className="text-body-sm text-muted-foreground">
                Showing first {searchResults.limit} results — refine your search
                to narrow down.
              </p>
            )}

            {searchResults.results.length === 0 ? (
              <p className="text-body text-muted-foreground">
                No financial accounts found.
              </p>
            ) : (
              <div
                role="list"
                className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-default)]"
              >
                {searchResults.results.map((r) => {
                  const isSelected = ctx.fa === r.financialAccountId;
                  const href = buildUrl(baseParams, {
                    party: r.refPartyRoleId,
                    fa: r.financialAccountId,
                    ban: undefined,
                  });
                  return (
                    <Link
                      key={r.financialAccountId}
                      href={href}
                      role="listitem"
                      className={`flex items-center gap-4 px-4 py-3 text-body transition-colors hover:bg-[color:var(--surface-sunken)] ${
                        isSelected
                          ? "bg-[color:var(--acct-context-strip-bg)]"
                          : "bg-[color:var(--surface-card)]"
                      }`}
                    >
                      <span className="flex-1 font-medium text-foreground">
                        {r.organizationName}
                      </span>
                      <span className="font-mono text-body-sm text-muted-foreground">
                        {r.financialAccountId}
                      </span>
                      <span className="text-body-sm text-muted-foreground">
                        {r.currency}
                      </span>
                      <StateChip state={r.state} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Section 2: FA detail ──────────────────────────────────────────── */}
      {faDetail && (
        <section className="space-y-4">
          <h2 className="text-h3 font-semibold text-foreground">
            Financial Account
          </h2>

          <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)]">
            {/* FA header row */}
            <div className="flex flex-wrap items-start gap-4 border-b border-[color:var(--border-subtle)] px-4 py-3">
              <div className="flex-1 space-y-0.5">
                <p className="font-medium text-foreground">
                  {faDetail.fa.name}
                </p>
                {faDetail.fa.description && (
                  <p className="text-body-sm text-muted-foreground">
                    {faDetail.fa.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-body-sm text-muted-foreground">
                  {faDetail.fa.financialAccountId}
                </span>
                <StateChip state={faDetail.fa.state} />
              </div>
            </div>

            {/* Related party */}
            {faDetail.relatedParty.length > 0 && (
              <div className="border-b border-[color:var(--border-subtle)] px-4 py-3">
                <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Customer
                </p>
                {faDetail.relatedParty.map((p) => (
                  <p key={p.id} className="mt-0.5 text-body text-foreground">
                    {p.name}{" "}
                    <span className="font-mono text-body-sm text-muted-foreground">
                      {p.id}
                    </span>
                  </p>
                ))}
              </div>
            )}

            {/* Live balances */}
            <div className="grid grid-cols-2 gap-0 divide-x divide-y divide-[color:var(--border-subtle)] sm:grid-cols-4">
              {(
                [
                  {
                    label: "Receivable (A/R)",
                    amount: faDetail.receivableBalance,
                    currency: faDetail.fa.currency,
                  },
                  {
                    label: "Unapplied Cash",
                    amount: faDetail.unappliedCashBalance,
                    currency: faDetail.fa.currency,
                  },
                  {
                    label: "Deposit Held",
                    amount: faDetail.depositBalance,
                    currency: faDetail.fa.currency,
                  },
                  ...(faDetail.creditLimitAmount !== null
                    ? [
                        {
                          label: "Credit Limit",
                          amount: faDetail.creditLimitAmount,
                          currency: faDetail.fa.currency,
                        },
                      ]
                    : []),
                ] as { label: string; amount: string; currency: string }[]
              ).map(({ label, amount, currency }) => (
                <div key={label} className="flex flex-col gap-0.5 px-4 py-3">
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {label}
                  </span>
                  <AmountCell amount={amount} currency={currency} />
                </div>
              ))}

              {faDetail.utilisationPct !== null && (
                <div className="flex flex-col gap-0.5 px-4 py-3">
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Utilisation
                  </span>
                  <span className="text-right font-[tabular-nums] text-body text-[color:var(--acct-amount)]">
                    {faDetail.utilisationPct.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>

            {/* BAN selector */}
            {faDetail.bans.length > 0 && (
              <div className="border-t border-[color:var(--border-subtle)] px-4 py-3">
                <p className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Billing Accounts
                </p>
                <div
                  role="list"
                  className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-default)]"
                >
                  {faDetail.bans.map((ban) => {
                    const isSelected = ctx.ban === ban.billingAccountId;
                    const href = buildUrl(baseParams, {
                      ban: ban.billingAccountId,
                    });
                    return (
                      <Link
                        key={ban.billingAccountId}
                        href={href}
                        role="listitem"
                        className={`flex items-center gap-4 px-3 py-2.5 text-body transition-colors hover:bg-[color:var(--surface-sunken)] ${
                          isSelected
                            ? "bg-[color:var(--acct-context-strip-bg)]"
                            : "bg-[color:var(--surface-card)]"
                        }`}
                      >
                        <span className="flex-1 font-medium text-foreground">
                          {ban.name}
                        </span>
                        <span className="font-mono text-body-sm text-muted-foreground">
                          {ban.billingAccountId}
                        </span>
                        <StateChip state={ban.state} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Section 3: BAN detail ─────────────────────────────────────────── */}
      {banDetail && (
        <section className="space-y-4">
          <h2 className="text-h3 font-semibold text-foreground">
            Billing Account
          </h2>

          <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)]">
            {/* BAN header row */}
            <div className="flex flex-wrap items-start gap-4 border-b border-[color:var(--border-subtle)] px-4 py-3">
              <div className="flex-1 space-y-0.5">
                <p className="font-medium text-foreground">
                  {banDetail.ban.name}
                </p>
                {banDetail.ban.description && (
                  <p className="text-body-sm text-muted-foreground">
                    {banDetail.ban.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-body-sm text-muted-foreground">
                  {banDetail.ban.billingAccountId}
                </span>
                <StateChip state={banDetail.ban.state} />
              </div>
            </div>

            {/* Bill cycle + payment status */}
            <div className="grid grid-cols-2 gap-0 divide-x divide-y divide-[color:var(--border-subtle)] sm:grid-cols-4">
              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Bill Cycle
                </span>
                <span className="text-body text-foreground">
                  {banDetail.billCycle.name}
                </span>
                <span className="text-body-sm text-muted-foreground">
                  Due {banDetail.billCycle.paymentDueDays} days after cycle
                  {banDetail.ban.paymentDueDaysOverride !== null && (
                    <span className="ml-1 font-medium">
                      (override: {banDetail.ban.paymentDueDaysOverride}d)
                    </span>
                  )}
                </span>
              </div>

              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Payment Status
                </span>
                <PaymentStatusBadge
                  paymentStatus={banDetail.paymentStatus}
                  derivedOverdue={banDetail.derivedOverdue}
                />
              </div>

              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Live A/R
                </span>
                <AmountCell
                  amount={banDetail.receivableBalance}
                  currency={banDetail.ban.currency}
                />
              </div>

              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Rating Type
                </span>
                <span className="text-body text-foreground capitalize">
                  {banDetail.ban.ratingType}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
