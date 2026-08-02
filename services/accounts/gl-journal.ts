// ac13-spec §3.2 — GL Journal service: period summary (movement + trial-balance)
// and per-GL-code drill-down. Read-only; no writes in this unit (export/close
// are ac14). Money totals computed via money.ts (code-standards §2.2).

import { db } from "@/db/client";
import { sum, stringToSen } from "@/services/accounts/money";
import {
  glJournalRepository,
  type GlJournalSort,
  type GlJournalSummaryRow,
  type GlJournalEntryRow,
} from "@/db/repositories/accounts/gl-journal.repository";

export type { GlJournalSummaryRow, GlJournalEntryRow, GlJournalSort };

export type GlJournalTotals = {
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
};

export type GlJournalResult = {
  rows: GlJournalSummaryRow[];
  totals: GlJournalTotals;
};

// ac13-spec §2.2 — period summary with balanced Σ total row (V6). Returns the
// rows plus pre-computed totals so the page never does arithmetic.
export async function getPeriodSummary(
  period: string,
  view: "movement" | "trial",
  sort: GlJournalSort,
): Promise<GlJournalResult> {
  const rows = await glJournalRepository.listSummary(db, period, view, sort);

  const totalDebit =
    rows.length > 0 ? sum(...rows.map((r) => r.debit)) : "0.00";
  const totalCredit =
    rows.length > 0 ? sum(...rows.map((r) => r.credit)) : "0.00";
  const balanced = stringToSen(totalDebit) === stringToSen(totalCredit);

  return { rows, totals: { totalDebit, totalCredit, balanced } };
}

// ac13-spec §2.3 — drill-down: contributing pgledger_entries_view legs for a
// given GL code + period scope. Closes the Goal 4 trace chain:
// document → line → transfer → entry → GL code.
export async function getCodeDrilldown(
  glCode: string,
  period: string,
  view: "movement" | "trial",
): Promise<GlJournalEntryRow[]> {
  return glJournalRepository.listDrilldown(db, glCode, period, view);
}
