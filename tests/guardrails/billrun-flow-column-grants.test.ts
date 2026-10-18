import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The bill-run flow only writes columns billrun_runtime is granted (DB-free).
//
// billrun_runtime's INSERT on billing.customer_bill_line is a column list
// (db/bootstrap/billrun-db-roles.sql Step 5a). bm41 (0044) added
// `rated_amount` + `additional_info` and bm42's aggregation started writing
// them, but the grant list was never extended; the integration suites run the
// flow SQL as the table owner, so the first real run as billrun_runtime (bm73
// manual run, 2026-10-18) failed "permission denied for table
// customer_bill_line". This pins every column the flow inserts to the grant.

const REPO_ROOT = path.resolve(__dirname, "../..");
const FLOW = fs.readFileSync(
  path.join(
    REPO_ROOT,
    "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
  ),
  "utf8",
);
const ROLES = fs.readFileSync(
  path.join(REPO_ROOT, "db/bootstrap/billrun-db-roles.sql"),
  "utf8",
);

function columnList(text: string): string[] {
  return text
    .replace(/--.*$/gm, "")
    .split(",")
    .map((c) => c.replace(/"/g, "").trim())
    .filter(Boolean);
}

describe("bill-run flow inserts stay inside billrun_runtime's column grant", () => {
  const granted = new Set(
    columnList(
      /GRANT INSERT \(([\s\S]*?)\) ON TABLE "billing"\."customer_bill_line" TO billrun_runtime/.exec(
        ROLES,
      )?.[1] ?? "",
    ),
  );

  const inserts = [
    ...FLOW.matchAll(/INSERT INTO billing\.customer_bill_line\s*\(([^)]*)\)/g),
  ].map((m) => columnList(m[1] ?? ""));

  it("finds the grant and at least one flow insert", () => {
    expect(granted.size).toBeGreaterThan(0);
    expect(inserts.length).toBeGreaterThan(0);
  });

  it("grants INSERT on every customer_bill_line column the flow writes", () => {
    const missing = inserts.flat().filter((c) => !granted.has(c));
    expect(missing).toEqual([]);
  });
});
