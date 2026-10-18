import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The bill run dates usage and prices in the business time zone (DB-free).
//
// rating.period_of() buckets usage into the billing month in the config zone
// (Asia/Kuala_Lumpur, rating X1). The bill-run flow used to take calendar
// dates in UTC, so the first live run (bm73 manual run, 2026-10-18) rejected
// every record from 00:00–07:59 +08 on the 1st as WINDOW_COVERAGE. The app now
// sends getAppTimezone() as the flow's `business_timezone` input and every
// `AT TIME ZONE` in the flow reads it. This pins that: no hard-coded zone in
// the flow, the input declared, and both engine callers sending it.

const REPO_ROOT = path.resolve(__dirname, "../..");
const FLOW = path.join(
  REPO_ROOT,
  "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
);

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// SQL lines only: `--` and `#` comments dropped.
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .filter((line) => !/^\s*#/.test(line));
}

describe("bill run uses the business time zone for calendar dates", () => {
  const flow = fs.readFileSync(FLOW, "utf8");

  it("declares the business_timezone input", () => {
    expect(flow).toMatch(/- id: business_timezone\n\s+type: STRING/);
  });

  it("never takes a calendar date in a hard-coded zone", () => {
    const zoned = codeLines(flow).filter((line) => /AT TIME ZONE/i.test(line));
    expect(zoned.length).toBeGreaterThan(0);
    for (const line of zoned) {
      expect(line).toMatch(
        /AT TIME ZONE (:'tz'|current_setting\('billrun\.tz'\))/,
      );
    }
  });

  it("binds :'tz' on every psql call whose SQL reads it", () => {
    const heredocs = flow.split(/psql -v ON_ERROR_STOP=1/).slice(1);
    for (const block of heredocs) {
      const body = block.split(/\n\s+SQL\n/)[0] ?? "";
      if (/:'tz'/.test(body.split("<<'SQL'")[1] ?? "")) {
        expect(body.split("<<'SQL'")[0]).toMatch(
          /-v tz="\{\{ inputs\.business_timezone \}\}"/,
        );
      }
    }
  });

  it.each(["services/billing/trigger-run.ts", "services/billing/rerun-run.ts"])(
    "%s sends getAppTimezone() as business_timezone",
    (file) => {
      expect(read(file)).toMatch(/business_timezone: getAppTimezone\(\)/);
    },
  );

  it("the Rated Lines window dates usage in the passed zone, not UTC", () => {
    const repo = read("db/repositories/billing/rated-lines.repository.ts");
    expect(repo).not.toMatch(/AT TIME ZONE 'UTC'/);
    expect(repo).toMatch(/AT TIME ZONE \$\{window\.timezone\}/);
  });
});
