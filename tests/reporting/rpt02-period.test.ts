import { describe, expect, it } from "vitest";

import {
  parseKestraLines,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt02-spec T-R02-1 / T-R02-2 — common/period.py and the `validate date` /
// `validate period` commands behind report-validate-date and
// report-validate-period (unit: no database, no Kestra).

const ready = reportingRuntimeReady();

function runJson<T>(code: string, env: Record<string, string> = {}): T {
  const run = runReportingPython(["-c", code], { env });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim()) as T;
}

// Today's date in Asia/Kuala_Lumpur as YYYYMMDD, offset by `days`.
function klDate(days = 0): string {
  const kl = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000);
  return kl.toISOString().slice(0, 10).replaceAll("-", "");
}

function validate(args: string[]) {
  const run = runReportingPython(["-m", "runtime.reporting.validate", ...args]);
  return {
    status: run.status,
    ...parseKestraLines(run.stdout),
    stderr: run.stderr,
  };
}

describe.skipIf(!ready)(
  "T-R02-1 — dates (period.py, part of T17 / P-T10)",
  { timeout: 60_000 },
  () => {
    it("rejects 20261332, 2026103 and 20260230, and parses a real date", () => {
      const out = runJson<{ invalid: boolean[]; valid: string }>(`
import json
from runtime.reporting.common import period
print(json.dumps({
    "invalid": [period.parse_date(v) is None for v in ["20261332", "2026103", "20260230", "", "2026-10-30", "２０２６１０３０"]],
    "valid": period.parse_date("20240229").isoformat(),
}))`);
      expect(out.invalid).toEqual([true, true, true, true, true, true]);
      expect(out.valid).toBe("2024-02-29");
    });

    it("not_future: today passes, tomorrow fails; before_today: yesterday passes, today fails", () => {
      const out = runJson<Record<string, boolean>>(`
import json
from datetime import date
from runtime.reporting.common import period
t = date(2026, 10, 30)
print(json.dumps({
    "nf_today": period.check_date(date(2026, 10, 30), "not_future", t),
    "nf_tomorrow": period.check_date(date(2026, 10, 31), "not_future", t),
    "bt_yesterday": period.check_date(date(2026, 10, 29), "before_today", t),
    "bt_today": period.check_date(date(2026, 10, 30), "before_today", t),
}))`);
      expect(out).toEqual({
        nf_today: true,
        nf_tomorrow: false,
        bt_yesterday: true,
        bt_today: false,
      });
    });

    // 23:59 and 00:01 Kuala Lumpur time straddle midnight local; the host's
    // time zone must not move either one.
    for (const tz of ["UTC", "Asia/Kuala_Lumpur"]) {
      it(`"today" is the Asia/Kuala_Lumpur day at 23:59 and 00:01 local, under host TZ=${tz}`, () => {
        const out = runJson<Record<string, string>>(
          `
import json
from datetime import datetime, timezone
from runtime.reporting.common import period

late = datetime(2026, 10, 30, 15, 59, tzinfo=timezone.utc)   # 23:59 KL, 30 Oct
early = datetime(2026, 10, 30, 16, 1, tzinfo=timezone.utc)   # 00:01 KL, 31 Oct

class Clock(datetime):
    instant = None
    @classmethod
    def now(cls, tz=None):
        return cls.instant.astimezone(tz)

period.datetime = Clock  # the no-argument path reads the clock through this name
res = {}
for label, instant in (("late", late), ("early", early)):
    Clock.instant = instant
    res[label] = period.business_today(instant).isoformat()
    res[label + "_clock"] = period.business_today().isoformat()
    res[label + "_yesterday"] = period.resolve_default("yesterday", period.business_today()).isoformat()
print(json.dumps(res))`,
          { TZ: tz },
        );
        expect(out).toEqual({
          late: "2026-10-30",
          late_clock: "2026-10-30",
          late_yesterday: "2026-10-29",
          early: "2026-10-31",
          early_clock: "2026-10-31",
          early_yesterday: "2026-10-30",
        });
      });
    }

    it("validate date: an empty value resolves to its default; today passes not_future, tomorrow fails", () => {
      const empty = validate([
        "date",
        "--name=report_date",
        "--value=",
        "--rule=before_today",
        "--default=yesterday",
      ]);
      expect(empty.status).toBe(0);
      expect(empty.outputs).toEqual({ effective_date: klDate(-1) });

      const asOf = validate([
        "date",
        "--name=as_of_date",
        "--value=",
        "--rule=not_future",
        "--default=today",
      ]);
      expect(asOf.outputs).toEqual({ effective_date: klDate() });

      const today = validate([
        "date",
        "--name=as_of_date",
        `--value=${klDate()}`,
        "--rule=not_future",
        "--default=today",
      ]);
      expect(today.status).toBe(0);

      const tomorrow = validate([
        "date",
        "--name=as_of_date",
        `--value=${klDate(1)}`,
        "--rule=not_future",
        "--default=today",
      ]);
      expect(tomorrow.status).toBe(1);
      expect(tomorrow.logs).toEqual([
        { level: "ERROR", message: `INVALID_AS_OF_DATE ${klDate(1)}` },
      ]);
    });

    it("validate date: the failure code follows --name", () => {
      for (const [name, code] of [
        ["report_date", "INVALID_REPORT_DATE"],
        ["invoice_date", "INVALID_INVOICE_DATE"],
        ["posting_date", "INVALID_POSTING_DATE"],
        ["outstanding_date", "INVALID_OUTSTANDING_DATE"],
      ]) {
        const run = validate([
          "date",
          `--name=${name}`,
          "--value=20261332",
          "--rule=before_today",
          "--default=yesterday",
        ]);
        expect(run.status).toBe(1);
        expect(run.logs).toEqual([
          { level: "ERROR", message: `${code} 20261332` },
        ]);
        expect(run.outputs).toEqual({});
      }
    });

    it("validate date: an unregistered input name is refused (no free-form code)", () => {
      const run = validate([
        "date",
        "--name=start_date",
        "--value=",
        "--rule=before_today",
        "--default=yesterday",
      ]);
      expect(run.status).not.toBe(0);
      expect(run.logs).toEqual([]);
    });
  },
);

describe.skipIf(!ready)(
  "T-R02-2 — periods (period.py, part of T17)",
  { timeout: 60_000 },
  () => {
    it("rejects 202613 and 20269; 202602 is 20260201–20260228", () => {
      const out = runJson<{
        invalid: boolean[];
        feb: string[];
        leap: string[];
      }>(`
import json
from runtime.reporting.common import period
print(json.dumps({
    "invalid": [period.parse_period(v) is None for v in ["202613", "20269", "202600", "000001", ""]],
    "feb": [d.isoformat() for d in period.parse_period("202602")],
    "leap": [d.isoformat() for d in period.parse_period("202402")],
}))`);
      expect(out.invalid).toEqual([true, true, true, true, true]);
      expect(out.feb).toEqual(["2026-02-01", "2026-02-28"]);
      expect(out.leap).toEqual(["2024-02-01", "2024-02-29"]);
    });

    it("validate period: bounds for a valid period, INVALID_BILLING_PERIOD otherwise", () => {
      const ok = validate(["period", "--billing-period=202602"]);
      expect(ok.status).toBe(0);
      expect(ok.outputs).toEqual({
        period_start: "20260201",
        period_end: "20260228",
      });

      for (const bad of ["202613", "20269", ""]) {
        const run = validate(["period", `--billing-period=${bad}`]);
        expect(run.status).toBe(1);
        expect(run.logs).toEqual([
          {
            level: "ERROR",
            message: `INVALID_BILLING_PERIOD ${bad}`.trimEnd(),
          },
        ]);
      }
    });

    it("validate period: as_of_date 20260815 for 202609 fails INVALID_AS_OF_DATE; the period's first day passes", () => {
      const early = validate([
        "period",
        "--billing-period=202609",
        "--as-of-date=20260815",
      ]);
      expect(early.status).toBe(1);
      expect(early.logs).toEqual([
        { level: "ERROR", message: "INVALID_AS_OF_DATE 20260815" },
      ]);

      const first = validate([
        "period",
        "--billing-period=202609",
        "--as-of-date=20260901",
      ]);
      expect(first.status).toBe(0);
      expect(first.outputs).toEqual({
        period_start: "20260901",
        period_end: "20260930",
        effective_as_of_date: "20260901",
      });
    });
  },
);
