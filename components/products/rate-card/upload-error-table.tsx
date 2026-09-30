import { AlertTriangle } from "lucide-react";

import type { RateCardIssue } from "@/validation/product/ratecard.schema";

// pm66-spec D4 — the row-level error report. NOT an AlertDialog (the failure
// already happened, there is nothing to confirm): the caller renders it inside
// a PLAIN dialog. This is the table body — a danger banner then Line · Column ·
// Value · Reason (§4.28): `tabular-nums` on Line, `--font-mono` on Value,
// reason in plain body text QUOTING THE VALIDATOR VERBATIM (issue.reason,
// straight from pm58 — never paraphrased, so the user reads exactly what the
// contract says).
//
// Line numbers are pm58's, header counted as line 1 (first data row = 2),
// rendered exactly as returned — never re-derived here (an off-by-one would
// point every reported row at its neighbour, D4). There is deliberately no copy
// keyed to `SNAPSHOT_DATE_NOT_CONSTANT`: that violation is withdrawn (D-A8) and
// the type does not carry it — the three codes are HEADER_MISMATCH,
// DUPLICATE_ROW_KEY, ROW_SCHEMA_INVALID, and each issue arrives already
// classified and phrased by the validator.

export interface UploadErrorTableProps {
  issues: readonly RateCardIssue[];
}

export function UploadErrorTable({
  issues,
}: UploadErrorTableProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md bg-[color:var(--bg-danger)] p-3 text-[color:var(--text-danger)]">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
        <p className="text-body-sm font-medium">
          No version was created. Fix the file and upload again.
        </p>
      </div>

      <div className="max-h-80 overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0">
            <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
              {["Line", "Column", "Value", "Reason"].map((label) => (
                <th
                  key={label}
                  className="px-3 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, index) => (
              <tr
                key={`${issue.line}-${issue.column ?? "-"}-${index}`}
                className="border-b border-[color:var(--border-subtle)] align-top last:border-0"
              >
                <td className="px-3 py-2 tabular-nums">{issue.line}</td>
                <td className="px-3 py-2">
                  {issue.column ?? (
                    <span className="text-[color:var(--text-muted)]">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-mono break-all">
                  {issue.value ?? (
                    <span className="text-[color:var(--text-muted)]">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-foreground">{issue.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
