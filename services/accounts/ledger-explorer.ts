// ac06-spec §2.5/§3.3 — read-only Ledger Explorer use cases. Pages
// orchestrate; `ledger.repository.ts` is the only `pgledger_*_view` caller
// (code-standards §6.3). `resolveLedgerAccountLabel` is centralized here and
// reused by the picker, grid, and drawer so a pgledger account name renders
// one way everywhere.

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import type { LedgerTransferFilters } from "@/db/repositories/accounts/ledger.repository";
import { compare } from "@/services/accounts/money";
import type {
  LedgerAccountKind,
  LedgerAccountLabel,
  LedgerAccountSearchResult,
  LedgerAccountSummary,
  LedgerTransferDetail,
  LedgerTransferListItem,
  ZeroSumRow,
} from "@/types/accounts";

function kindFromName(name: string): LedgerAccountKind {
  if (name.startsWith("ban.")) return "ban";
  if (name.startsWith("fa.")) return "fa";
  return "sys";
}

// A pgledger name → {kind, ownerId?, ownerLabel?} (ac06-spec §2.5). ban.*/
// fa.* resolve their TMF owner via `ledger_binding` — never by parsing an id
// out of the name string, which is only a naming convention, not a contract.
// sys.* accounts have no owner.
export async function resolveLedgerAccountLabel(
  pgledgerAccountId: string,
  name: string,
): Promise<LedgerAccountLabel> {
  const kind = kindFromName(name);
  if (kind === "sys") {
    return { kind, ownerId: null, ownerLabel: null };
  }

  const binding = await ledgerBindingRepository.findByPgledgerAccountId(
    db,
    pgledgerAccountId,
  );
  if (!binding) {
    return { kind, ownerId: null, ownerLabel: null };
  }

  const owner =
    binding.ownerType === "billing_account"
      ? await billingAccountRepository.findById(db, binding.ownerId)
      : await financialAccountRepository.findById(db, binding.ownerId);

  return {
    kind,
    ownerId: binding.ownerId,
    ownerLabel: owner?.name ?? null,
  };
}

// ac06-spec §2.1 — the account picker.
export async function searchLedgerAccounts(
  query: string,
  limit: number,
): Promise<LedgerAccountSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const accounts = await ledgerRepository.searchAccountsByName(
    db,
    trimmed,
    limit,
  );
  return Promise.all(
    accounts.map(async (a) => ({
      ...a,
      label: await resolveLedgerAccountLabel(a.id, a.name),
    })),
  );
}

export async function getLedgerAccount(
  accountId: string,
): Promise<LedgerAccountSummary | null> {
  const account = await ledgerRepository.findAccountById(db, accountId);
  if (!account) return null;
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    label: await resolveLedgerAccountLabel(account.id, account.name),
  };
}

// ac06-spec §2.1 (locked item 5 continuity) — arriving from Overview with a
// BAN selected via the shared context strip pre-picks that BAN's
// `receivables` account.
export async function resolveReceivablesAccountForBan(
  billingAccountId: string,
): Promise<LedgerAccountSummary | null> {
  const bindings = await ledgerBindingRepository.findByOwner(
    db,
    "billing_account",
    billingAccountId,
  );
  const receivables = bindings.find((b) => b.ledgerRole === "receivables");
  if (!receivables) return null;
  return getLedgerAccount(receivables.pgledgerAccountId);
}

// ac06-spec §2.2 — the transfers grid.
export async function listTransfersForAccount(
  accountId: string,
  filters: LedgerTransferFilters,
): Promise<{ rows: LedgerTransferListItem[]; total: number }> {
  const { rows, total } = await ledgerRepository.listTransfersForAccount(
    db,
    accountId,
    filters,
  );

  const mapped = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      fromAccountId: r.fromAccountId,
      fromAccountName: r.fromAccountName,
      fromLabel: await resolveLedgerAccountLabel(
        r.fromAccountId,
        r.fromAccountName,
      ),
      toAccountId: r.toAccountId,
      toAccountName: r.toAccountName,
      toLabel: await resolveLedgerAccountLabel(r.toAccountId, r.toAccountName),
      amount: r.amount,
      eventAt: r.eventAt,
      createdAt: r.createdAt,
      metadataDoc:
        typeof r.metadata?.doc === "string" ? (r.metadata.doc as string) : null,
    })),
  );

  return { rows: mapped, total };
}

// ac06-spec §2.3 — the transfer-detail drawer: both signed legs with
// previous/current balances.
export async function getTransferLegs(
  transferId: string,
): Promise<LedgerTransferDetail | null> {
  const transfer = await ledgerRepository.findTransferById(db, transferId);
  if (!transfer) return null;

  const entries = await ledgerRepository.findEntriesByTransferId(
    db,
    transferId,
  );
  const legs = await Promise.all(
    entries.map(async (e) => ({
      accountId: e.accountId,
      accountName: e.accountName,
      label: await resolveLedgerAccountLabel(e.accountId, e.accountName),
      amount: e.amount,
      accountPreviousBalance: e.accountPreviousBalance,
      accountCurrentBalance: e.accountCurrentBalance,
    })),
  );

  return {
    id: transfer.id,
    fromAccountId: transfer.fromAccountId,
    fromAccountName: transfer.fromAccountName,
    toAccountId: transfer.toAccountId,
    toAccountName: transfer.toAccountName,
    amount: transfer.amount,
    eventAt: transfer.eventAt,
    createdAt: transfer.createdAt,
    metadata: transfer.metadata,
    legs,
  };
}

// ac06-spec §2.4 — V1 (zero-sum, module inv. #1) surfaced permanently in the
// UI. `ok` uses `money.ts`'s `compare`, never a raw numeric comparison.
export async function zeroSumByCurrency(): Promise<ZeroSumRow[]> {
  const rows = await ledgerRepository.zeroSumByCurrency(db);
  return rows.map((r) => ({
    currency: r.currency,
    total: r.total,
    ok: compare(r.total, "0") === 0,
  }));
}
