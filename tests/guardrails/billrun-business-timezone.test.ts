import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RATING_BILLING_TIMEZONE } from "@/services/billing/rating-timezone";

// The bill run dates usage and prices in the business time zone (DB-free).
//
// rating.period_of() buckets usage into the billing month in the config zone
// (Asia/Kuala_Lumpur, rating X1). The bill-run flow used to take calendar
// dates in UTC, so the first live run (bm73 manual run, 2026-10-18) rejected
// every record from 00:00–07:59 +08 on the 1st as out of window. The app now
// sends getAppTimezone() as the flow's `business_timezone` input and every
// zone conversion in the flow reads it. This pins that: no hard-coded zone in
// the flow, the input declared, both engine callers sending it, and the
// billing guard's zone equal to rating's.

const REPO_ROOT = path.resolve(__dirname, "../..");

// LF-normalised, so a CRLF checkout (Git for Windows) reads the same.
function read(rel: string): string {
  return fs
    .readFileSync(path.join(REPO_ROOT, rel), "utf8")
    .replace(/\r\n/g, "\n");
}

// SQL code only: `--` comments and `#` (YAML) comment lines dropped.
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const FLOW = read(
  "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
);
const FLOW_CODE = code(FLOW);

describe("bill run uses the business time zone for calendar dates", () => {
  it("declares the business_timezone input", () => {
    expect(FLOW).toMatch(/- id: business_timezone\n\s+type: STRING/);
  });

  it("every AT TIME ZONE in the flow reads the business zone", () => {
    const zones = [...FLOW_CODE.matchAll(/AT TIME ZONE\s+(\S+)/gi)].map(
      (m) => m[1],
    );
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      expect(zone).toMatch(/^(:'tz'|current_setting\('billrun\.tz'\))/);
    }
  });

  it("never converts zones another way (timezone(), a zone literal)", () => {
    expect(FLOW_CODE).not.toMatch(/\btimezone\s*\(/i);
    expect(FLOW_CODE).not.toMatch(/'(UTC|GMT|[A-Z][a-z]+\/[A-Za-z_]+)'/);
  });

  it("sets the billrun.tz GUC only from the bound input", () => {
    const sets = [
      ...FLOW_CODE.matchAll(/set_config\('billrun\.tz',\s*([^,]+),/g),
    ];
    expect(sets.length).toBeGreaterThan(0);
    for (const m of sets) expect(m[1]!.trim()).toBe(":'tz'");
  });

  it("binds :'tz' on every psql call whose SQL reads it", () => {
    const heredocs = FLOW.split(/psql -v ON_ERROR_STOP=1/).slice(1);
    for (const block of heredocs) {
      const body = block.split(/\n\s+SQL\n/)[0] ?? "";
      if (/:'tz'/.test(code(body.split("<<'SQL'")[1] ?? ""))) {
        expect(body.split("<<'SQL'")[0]).toMatch(
          /-v tz="\{\{ inputs\.business_timezone \}\}"/,
        );
      }
    }
  });

  it.each(["services/billing/trigger-run.ts", "services/billing/rerun-run.ts"])(
    "%s sends getAppTimezone() and guards it against rating's zone",
    (file) => {
      const text = read(file);
      expect(text).toMatch(/business_timezone: getAppTimezone\(\)/);
      expect(text).toMatch(/if \(!isBusinessTimezoneAligned\(\)\)/);
    },
  );

  it("the billing guard's zone is rating.period_of()'s zone", () => {
    const periodOf = read("db/migrations/0034_rating.sql");
    const literal = /date_trunc\('month', ts AT TIME ZONE '([^']+)'\)/.exec(
      periodOf,
    )?.[1];
    expect(literal).toBe(RATING_BILLING_TIMEZONE);
  });

  it("the Rated Lines window dates usage in the passed zone, not UTC", () => {
    const repo = read("db/repositories/billing/rated-lines.repository.ts");
    expect(repo).not.toMatch(/AT TIME ZONE 'UTC'/);
    expect(repo).toMatch(/AT TIME ZONE \$\{window\.timezone\}/);
  });
});

// bm73 review (2026-10-18). Scoping no longer EXCLUDES an account holding a
// subscription that starts after the period, so every ACTIVE-subscription
// selection in the flow must itself keep to subscriptions that overlap the
// period, or a not-yet-started subscription is billed.
describe("bill-run flow bills only subscriptions that overlap the period", () => {
  it("every ACTIVE product_inventory selection carries the start_date bound", () => {
    // Code lines only (comment-only lines are blank after `code()`).
    const lines = FLOW_CODE.split("\n").filter((line) => line.trim() !== "");
    const active = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /status\s*=\s*'ACTIVE'/.test(line));
    expect(active.length).toBeGreaterThan(0);
    for (const { i } of active) {
      const window = lines.slice(i, i + 6).join("\n");
      expect(window).toMatch(/start_date\s*<=/);
      expect(window).toMatch(/end_date IS NULL\s+OR\s+\w*\.?end_date\s*>=/);
    }
  });
});
