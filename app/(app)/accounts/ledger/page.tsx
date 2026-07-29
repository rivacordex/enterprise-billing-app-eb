import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { BalanceCheckStrip } from "@/components/accounts/balance-check-strip";
import { ContextStrip } from "@/components/accounts/context-strip";
import { LedgerAccountPicker } from "@/components/accounts/ledger-account-picker";
import { LedgerTransfersGrid } from "@/components/accounts/ledger-transfers-grid";
import { TransferDetailDrawer } from "@/components/accounts/transfer-detail-drawer";
import {
  getLedgerAccount,
  getTransferLegs,
  listTransfersForAccount,
  resolveReceivablesAccountForBan,
  searchLedgerAccounts,
  zeroSumByCurrency,
} from "@/services/accounts/ledger-explorer";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";
import { ledgerExplorerSearchParamsSchema } from "@/validation/accounts/ledger-explorer-search-params.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ledger Explorer" };

// ac06-spec §2.2 — no configurable page size decision in this unit (spec §4:
// zero new config); a fixed page size for the dense transfers grid.
const TRANSFERS_PAGE_SIZE = 20;
// Account-picker result cap — a fixed constant, distinct from Overview's
// configurable `ACCOUNTS_SEARCH_RESULT_LIMIT` (a different search surface).
const ACCOUNT_PICKER_LIMIT = 10;

function firstStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LedgerExplorerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.ACCOUNTS_VIEW, LEVELS.READ);

  const raw = await searchParams;
  const ctx = parseAccountsContext(raw);
  const parsed = ledgerExplorerSearchParamsSchema.parse({
    account: firstStr(raw.account) ?? null,
    transfer: firstStr(raw.transfer) ?? null,
    from: firstStr(raw.from) ?? null,
    to: firstStr(raw.to) ?? null,
    q: firstStr(raw.q) ?? "",
    sort: firstStr(raw.sort),
    page: firstStr(raw.page) ?? 1,
    acctq: firstStr(raw.acctq) ?? "",
  });

  const [locale, timezone, zeroSum] = await Promise.all([
    getAppLocale(),
    Promise.resolve(getAppTimezone()),
    zeroSumByCurrency(),
  ]);

  // Locked item 5 continuity (§2.1): an explicit `?account` always wins; a
  // shared `?ban` context otherwise pre-picks that BAN's receivables account.
  const selectedAccount = parsed.account
    ? await getLedgerAccount(parsed.account)
    : ctx.ban
      ? await resolveReceivablesAccountForBan(ctx.ban)
      : null;

  const [pickerResults, transfersPage, transferDetail] = await Promise.all([
    parsed.acctq
      ? searchLedgerAccounts(parsed.acctq, ACCOUNT_PICKER_LIMIT)
      : Promise.resolve([]),
    selectedAccount
      ? listTransfersForAccount(selectedAccount.id, {
          eventFrom: parsed.from ? new Date(`${parsed.from}T00:00:00Z`) : null,
          eventTo: parsed.to ? new Date(`${parsed.to}T23:59:59Z`) : null,
          metadataQuery: parsed.q,
          sort: parsed.sort,
          page: parsed.page,
          pageSize: TRANSFERS_PAGE_SIZE,
        })
      : Promise.resolve(null),
    parsed.transfer ? getTransferLegs(parsed.transfer) : Promise.resolve(null),
  ]);

  const baseParams: Record<string, string | undefined> = {
    party: ctx.party,
    fa: ctx.fa,
    ban: ctx.ban,
    account: selectedAccount?.id,
    from: parsed.from ?? undefined,
    to: parsed.to ?? undefined,
    q: parsed.q || undefined,
    sort: parsed.sort,
    acctq: parsed.acctq || undefined,
  };

  const closeDrawerParams = new URLSearchParams();
  for (const [k, v] of Object.entries(baseParams)) {
    if (v !== undefined) closeDrawerParams.set(k, v);
  }
  if (parsed.page !== 1) closeDrawerParams.set("page", String(parsed.page));
  const closeDrawerHref = `/accounts/ledger?${closeDrawerParams.toString()}`;

  return (
    <main className="space-y-6">
      <BalanceCheckStrip balances={zeroSum} />

      <div className="space-y-6 p-6">
        <header>
          <h1 className="text-h1 font-semibold text-foreground">
            Ledger Explorer
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            Trace any ledger account&rsquo;s transfers to their double-entry
            legs — a read-only forensic window over the ledger.
          </p>
        </header>

        <ContextStrip
          party={ctx.party}
          partyName={undefined}
          fa={ctx.fa}
          faName={undefined}
          ban={ctx.ban}
          banName={undefined}
        />

        <LedgerAccountPicker
          acctq={parsed.acctq}
          results={pickerResults}
          selectedAccountId={selectedAccount?.id ?? null}
          baseParams={baseParams}
        />

        {selectedAccount && transfersPage && (
          <section className="space-y-3">
            <h2 className="text-h3 font-semibold text-foreground">
              Transfers —{" "}
              <span className="font-mono text-body">
                {selectedAccount.label.ownerLabel ?? selectedAccount.name}
              </span>
            </h2>

            <Suspense>
              <LedgerTransfersGrid
                accountId={selectedAccount.id}
                currency={selectedAccount.currency}
                rows={transfersPage.rows}
                total={transfersPage.total}
                page={parsed.page}
                pageSize={TRANSFERS_PAGE_SIZE}
                sort={parsed.sort}
                from={parsed.from}
                to={parsed.to}
                q={parsed.q}
                selectedTransferId={parsed.transfer}
                locale={locale}
                timezone={timezone}
              />
            </Suspense>
          </section>
        )}

        {!selectedAccount && (
          <p className="text-body text-muted-foreground">
            Search for and select a ledger account above to trace its transfers.
          </p>
        )}

        {transferDetail && selectedAccount && (
          <TransferDetailDrawer
            detail={transferDetail}
            currency={selectedAccount.currency}
            closeHref={closeDrawerHref}
            locale={locale}
            timezone={timezone}
          />
        )}
      </div>
    </main>
  );
}
