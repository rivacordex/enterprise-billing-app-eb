import { z } from "zod";

// ac06-spec §2.2/§3.1 — the Ledger Explorer's own URL state (`?account/
// transfer/from/to/q/sort/page/acctq`), parsed alongside the shared
// `?party/fa/ban` context strip (`parseAccountsContext`). Lenient by design
// (offering-list precedent, code-standards §3.3): every field `.catch()`s to
// its default so a tampered or stale URL never 500s the page.

const ACCOUNT_ID_PATTERN = /^pgla_[0-9A-Za-z]+$/;
const TRANSFER_ID_PATTERN = /^pglt_[0-9A-Za-z]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// One `sort` searchParam (offering-list precedent): a sort key with an
// optional `-` prefix for descending. Default is `-event_at` (most recent
// activity first — a forensic explorer reads newest-first).
export const LEDGER_TRANSFER_SORT_VALUES = [
  "event_at",
  "-event_at",
  "created_at",
  "-created_at",
  "amount",
  "-amount",
] as const;
export type LedgerTransferSort = (typeof LEDGER_TRANSFER_SORT_VALUES)[number];

export const ledgerExplorerSearchParamsSchema = z.object({
  // Selected pgledger account (picker selection / pre-picked from `?ban`).
  account: z.string().regex(ACCOUNT_ID_PATTERN).nullable().catch(null),
  // Selected transfer — opens the two-leg drawer.
  transfer: z.string().regex(TRANSFER_ID_PATTERN).nullable().catch(null),
  // event_at range filter (§2.2).
  from: z.string().regex(DATE_PATTERN).nullable().catch(null),
  to: z.string().regex(DATE_PATTERN).nullable().catch(null),
  // Metadata search across doc/ban/type (§2.2).
  q: z.string().trim().max(100).catch(""),
  sort: z.enum(LEDGER_TRANSFER_SORT_VALUES).catch("-event_at"),
  page: z.coerce.number().int().min(1).catch(1),
  // Account picker's own search text (§2.1) — distinct from `q`, the grid's
  // metadata search.
  acctq: z.string().trim().max(100).catch(""),
});
export type LedgerExplorerSearchParams = z.infer<
  typeof ledgerExplorerSearchParamsSchema
>;
