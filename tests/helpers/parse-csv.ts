// RFC 4180 parse of an invoice CSV download (bm62): a UTF-8 BOM, CRLF-ended
// records, quoted fields with doubled quotes, embedded newlines. Throws on a
// missing BOM or an unterminated last record. Shared by the guardrail 55
// suite and the bm63 journey so neither splits on raw commas.
export function parseInvoiceCsv(csv: string): string[][] {
  if (csv.charCodeAt(0) !== 0xfeff) throw new Error("CSV has no UTF-8 BOM");
  const text = csv.slice(1);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length > 0) {
    throw new Error("CSV does not end with a CRLF-terminated record");
  }
  return records;
}
