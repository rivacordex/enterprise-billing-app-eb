import { z } from "zod";

import { DOC_TYPES, DOC_STATES } from "@/types/accounts";

// ac20-spec §2.5/§3.3 — the Transactions workbench's own URL state, parsed
// alongside the shared `?party/fa/ban` context strip (`parseAccountsContext`).
// Lenient by design (ledger-explorer-schema precedent): every field `.catch()`s
// to its default so a tampered or stale URL never 500s the page. `?party/fa/ban`
// are never parsed here — those belong to `parseAccountsContext` only
// (code-standards §3.1).

// Sort key with optional `-` prefix for descending (ledger-explorer precedent).
// Default is `-event_at` — newest documents first.
export const TRANSACTION_DOCUMENT_SORT_VALUES = [
  "event_at",
  "-event_at",
  "amount",
  "-amount",
] as const;
export type TransactionDocumentSort =
  (typeof TRANSACTION_DOCUMENT_SORT_VALUES)[number];

export const transactionsSearchParamsSchema = z.object({
  // Document type filter — exactly the five types (inv. #19).
  type: z.enum(DOC_TYPES).nullable().catch(null),
  // Document state filter — the five DOC_STATES values.
  status: z.enum(DOC_STATES).nullable().catch(null),
  // Reversibility filter — derived post-aggregate, never a sixth DOC_STATES
  // member (inv. #19, §2.6). "reversible" = posted + unreversed lines;
  // "partial" = posted + some but not all lines reversed.
  rev: z.enum(["reversible", "partial"]).nullable().catch(null),
  // Free text over documentId and reasonCode — trimmed, max 100.
  q: z.string().trim().max(100).catch(""),
  sort: z.enum(TRANSACTION_DOCUMENT_SORT_VALUES).catch("-event_at"),
  page: z.coerce.number().int().min(1).catch(1),
  // Reserved for ac21's document detail drawer — parsed here so ac21 adds no
  // schema change. Unused (inert) in this unit.
  doc: z.string().nullable().catch(null),
});
export type TransactionsSearchParams = z.infer<
  typeof transactionsSearchParamsSchema
>;
