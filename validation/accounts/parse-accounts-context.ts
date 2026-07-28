// The sole context-strip URL parser (code-standards §3.1, ac05-spec §3.2).
// Shared by all three Accounts pages: Overview, Ledger Explorer, Transactions.
// id-pattern validation ensures only well-formed IDs enter the service layer.

const PARTY_PATTERN = /^PTRL\d{8}$/;
const FA_PATTERN = /^FIN\d{6}$/;
const BAN_PATTERN = /^BAN\d{6}$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Explicit `string | undefined` (not `?:`) because exactOptionalPropertyTypes
// is enabled — the return value always sets all three keys.
export type AccountsContext = {
  party: string | undefined;
  fa: string | undefined;
  ban: string | undefined;
};

export function parseAccountsContext(
  searchParams: Record<string, string | string[] | undefined>,
): AccountsContext {
  const party = first(searchParams.party);
  const fa = first(searchParams.fa);
  const ban = first(searchParams.ban);

  return {
    party: party && PARTY_PATTERN.test(party) ? party : undefined,
    fa: fa && FA_PATTERN.test(fa) ? fa : undefined,
    ban: ban && BAN_PATTERN.test(ban) ? ban : undefined,
  };
}
