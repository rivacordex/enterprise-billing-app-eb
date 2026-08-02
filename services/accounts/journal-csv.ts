// ac14-spec §3.2 / code-standards §5.3 — fixed CSV serializer for the GL
// journal export. Shared by the Route Handler and tests. Format: header row
// `gl_code,gl_name,debit,credit`, UTF-8, CRLF, amounts plain `1234.56` (no
// thousands separators). Module Inv. #10: refuses to emit an unbalanced journal.

import { db } from "@/db/client";
import { glJournalRepository } from "@/db/repositories/accounts/gl-journal.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { sum, stringToSen } from "@/services/accounts/money";

export type JournalCsvRow = {
  glCode: string;
  name: string;
  debit: string;
  credit: string;
};

export type BuildJournalCsvResult =
  | {
      ok: true;
      rows: JournalCsvRow[];
      rowCount: number;
      totalDebit: string;
      totalCredit: string;
      csv: string;
    }
  | {
      ok: false;
      code: "UNBALANCED_JOURNAL";
      totalDebit: string;
      totalCredit: string;
    };

const CRLF = "\r\n";
const CSV_HEADER = "gl_code,gl_name,debit,credit";

// Escapes a CSV field value if it contains commas, double-quotes, or newlines.
function csvEscape(val: string): string {
  if (
    val.includes(",") ||
    val.includes('"') ||
    val.includes("\r") ||
    val.includes("\n")
  ) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

// Pure serializer (testable without DB). Returns UTF-8 string with CRLF line
// endings; the last line also ends with CRLF per RFC 4180.
export function serializeJournalCsv(rows: JournalCsvRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [csvEscape(row.glCode), csvEscape(row.name), row.debit, row.credit].join(
        ",",
      ),
    );
  }
  return lines.join(CRLF) + CRLF;
}

// Fetches the period-movement rows from gl_journal_view, checks balance, and
// serializes to CSV. Rows are in gl_code ASC order (spec §2.3: same sort order
// as ac13's on-screen default). Only 'movement' view (period-specific entries);
// cumulative trial balance is a separate export concern not in scope for v1.
export async function buildJournalCsv(
  period: string,
): Promise<BuildJournalCsvResult> {
  const rawRows = await glJournalRepository.listSummary(
    db,
    period,
    "movement",
    "gl_code",
  );

  const totalDebit =
    rawRows.length > 0 ? sum(...rawRows.map((r) => r.debit)) : "0.00";
  const totalCredit =
    rawRows.length > 0 ? sum(...rawRows.map((r) => r.credit)) : "0.00";

  // Defensive balanced-guard (spec §2.4 / Module Inv. #10): refuse to emit a
  // corrupt journal. This can only trigger if an upstream invariant broke.
  if (stringToSen(totalDebit) !== stringToSen(totalCredit)) {
    return { ok: false, code: "UNBALANCED_JOURNAL", totalDebit, totalCredit };
  }

  const rows: JournalCsvRow[] = rawRows.map((r) => ({
    glCode: r.glCode,
    name: r.name,
    debit: r.debit,
    credit: r.credit,
  }));

  const csv = serializeJournalCsv(rows);

  return {
    ok: true,
    rows,
    rowCount: rows.length,
    totalDebit,
    totalCredit,
    csv,
  };
}

// Writes the JOURNAL_EXPORTED audit event. Separated from buildJournalCsv so
// the Route Handler can call it after confirming the export is balanced (the
// audit should only fire on a successful export, not on 409 rejection).
export async function auditJournalExport(
  period: string,
  currency: string,
  rowCount: number,
  totalDebit: string,
  totalCredit: string,
  actorId: string,
): Promise<void> {
  await insertAuditEvent(db, {
    eventType: "JOURNAL_EXPORTED",
    actorUserId: actorId,
    targetEntity: "ACCOUNTING_PERIOD",
    targetId: `${period}/${currency}`,
    beforeData: null,
    afterData: { period, currency, rowCount, totalDebit, totalCredit },
  });
}
