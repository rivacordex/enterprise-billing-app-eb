import { db } from "@/db/client";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { AccountState } from "@/types/accounts";

export type AccountSearchMode = "customer" | "name";

export type AccountSearchResult = {
  financialAccountId: string;
  name: string;
  state: AccountState;
  currency: string;
  refPartyRoleId: string;
  organizationName: string;
};

export type AccountSearchResults = {
  results: AccountSearchResult[];
  hasMore: boolean;
  limit: number;
  query: string;
  mode: AccountSearchMode;
};

const DEFAULT_LIMIT = 5;
const LIMIT_REGEX = /^\d+$/;

async function resolveLimit(): Promise<number> {
  const raw = await systemConfigRepository.findActiveValue(
    db,
    "accounts",
    "ACCOUNTS_SEARCH_RESULT_LIMIT",
  );
  if (raw === null || !LIMIT_REGEX.test(raw)) return DEFAULT_LIMIT;
  const value = Number(raw);
  return value >= 1 ? value : DEFAULT_LIMIT;
}

// Backs the Accounts Overview search panel (ac05-spec §2.3). An empty /
// whitespace-only query never touches the database. Fetches `limit + 1` rows
// to derive `hasMore` without a COUNT query.
export async function searchAccounts(
  query: string,
  mode: AccountSearchMode,
): Promise<AccountSearchResults> {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return {
      results: [],
      hasMore: false,
      limit: DEFAULT_LIMIT,
      query: "",
      mode,
    };
  }

  const limit = await resolveLimit();

  const rows = await financialAccountRepository.searchForOverview(
    db,
    mode,
    trimmed,
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const trimmedRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    results: trimmedRows.map((r) => ({
      financialAccountId: r.financialAccountId,
      name: r.name,
      state: r.state as AccountState,
      currency: r.currency,
      refPartyRoleId: r.refPartyRoleId,
      organizationName: r.organizationName,
    })),
    hasMore,
    limit,
    query: trimmed,
    mode,
  };
}
