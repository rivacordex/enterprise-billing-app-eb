// Shared CSV field escaping. Pure, framework-agnostic. Prefixes
// formula-trigger characters (=, +, -, @, TAB, CR) with a single quote to
// mitigate CSV/formula injection when the file is opened in a spreadsheet,
// then applies RFC-4180 quoting for commas, double-quotes, and newlines.
// Both the GL-journal export (services/accounts/journal-csv.ts) and the
// bill-run export (actions/billing/export-runs.action.ts) escape through here
// so the injection hardening lives in exactly one place.
export function csvField(value: string): string {
  let out = value;
  if (/^[=+\-@\t\r]/.test(out)) {
    out = `'${out}`;
  }
  if (
    out.includes(",") ||
    out.includes('"') ||
    out.includes("\r") ||
    out.includes("\n")
  ) {
    return `"${out.replace(/"/g, '""')}"`;
  }
  return out;
}

// Assembles a CSV document from a header + pre-stringified data rows, escaping
// every field through `csvField` and joining with RFC-4180 CRLF line endings
// plus a trailing newline so the file ends cleanly. Shared by the CSV export
// server actions (bill-runs, uncharged, …) so the wire format is identical
// across exports and lives in one place.
export function buildCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
