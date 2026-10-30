import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  dropAppSchemas,
  parseKestraLines,
  parseReportCsv,
  REPORTING_CONTRACTS_DIR,
  reportingDbEnv,
  reportingRuntimeReady,
  resetReportingDatabase,
  runReport,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";
import type { ReportRun } from "@/tests/helpers/reporting-harness";
import {
  CARD_X,
  EXPECTED_20261026,
  insertOffering,
  insertUsagePrice,
  insertVersion,
  seedPolygonCapacityFixture,
  SKIPPED_20261026,
} from "@/tests/fixtures/reporting/polygon-capacity-seed";
import type { PolygonCapacityFixture } from "@/tests/fixtures/reporting/polygon-capacity-seed";

// rpt04-spec Tests — the polygon capacity lookup (Part B) against a seeded
// LIVE database, with the fixture capacity source: plan §B.3 P-T1–P-T13 and
// the runtime half of P-T14, R04-T1–R04-T4. The runtime runs as a subprocess
// connected as `reporting_runtime` (tests/helpers/reporting-harness.ts). The
// flow cases (P-T10's today/tomorrow, P-T14 end to end, R04-T7) are
// rpt04-polygon-capacity-flow.live.test.ts; R04-T5, R04-T6 and the static
// halves of R04-T7/T8 are rpt04-guardrails.test.ts.
//
// DATABASE_URL must be a SUPERUSER connection on a THROWAWAY cluster: the
// suite drops and re-migrates every schema and sets reporting_runtime's
// password to a test value (roles are cluster-level).
const databaseUrl = process.env.DATABASE_URL;
const ready = reportingRuntimeReady();

const CAPACITY_FIXTURE = join(
  process.cwd(),
  "tests/fixtures/reporting/polygon_capacity/capacity.csv",
);
const fileName = (day: string) => `Polygon_capacity_lookup_${day}.csv`;

const errors = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "ERROR").map((l) => l.message);
const warnings = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "WARN").map((l) => l.message);

describe.skipIf(!databaseUrl || !ready)(
  "rpt04 polygon capacity lookup (requires a superuser DATABASE_URL and the reporting runtime)",
  { timeout: 60_000 },
  () => {
    let sql: postgresjs.Sql;
    let fx: PolygonCapacityFixture;
    let env: Record<string, string>;
    let main: ReportRun; // the default run: 20261026

    const lookup = (
      reportDate: string,
      extra: {
        source?: string;
        fixture?: string;
        env?: Record<string, string>;
      } = {},
    ) =>
      runReport(
        "polygon_capacity",
        [
          `--report-date=${reportDate}`,
          `--capacity-source=${extra.source ?? "fixture"}`,
          `--capacity-fixture=${extra.fixture ?? CAPACITY_FIXTURE}`,
        ],
        { ...env, ...extra.env },
      );

    const expectFailed = (r: ReportRun, line: string) => {
      expect(r.status).not.toBe(0);
      expect(errors(r)).toEqual([line]);
      expect(r.files).toEqual({}); // no file left behind
    };

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await resetReportingDatabase(databaseUrl as string, sql);
      fx = await seedPolygonCapacityFixture(sql);
      env = reportingDbEnv(databaseUrl as string);
      main = lookup("20261026");
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        await dropAppSchemas(sql);
        await sql.end();
      }
    }, 120_000);

    it("the default run (20261026) writes exactly the expected file from V2 and ends WARNING (P-T1–P-T4, P-T6, P-T13)", () => {
      expect(main.status, main.stderr).toBe(0);
      expect(Object.keys(main.files)).toEqual([fileName("20261026")]);
      expect(main.files[fileName("20261026")]).toBe(EXPECTED_20261026);
      expect(main.outputs).toEqual({
        file: fileName("20261026"),
        ratecard_card_name: CARD_X,
        ratecard_version_id: fx.versions.v2,
        rows: 5,
        skipped_polygons: 3,
        status: "WARNING",
      });
    });

    it("R04-T1 — the card is the one the RAN usage product names: CARD_X's version, label ratecard_card_name=CARD_X", () => {
      expect(main.outputs.ratecard_card_name).toBe(CARD_X);
      expect(main.outputs.ratecard_version_id).toBe(fx.versions.v2);
    });

    it("P-T6 — V3, left as a DRAFT, is never used", () => {
      expect(main.files[fileName("20261026")]).not.toContain("PDRAFT");
      for (const day of ["20261026", "20261029"]) {
        expect(lookup(day).outputs.ratecard_version_id).toBe(fx.versions.v2);
      }
    });

    it("P-T7 / R04-T4 — blank district, blank service code and missing capacity skip the row with one SKIPPED line each; WARNING", () => {
      expect(warnings(main)).toEqual(SKIPPED_20261026);
      expect(main.outputs.skipped_polygons).toBe(3);
      expect(main.outputs.status).toBe("WARNING");
    });

    it("P-T11 — format: no header, 8 fields, YYYYMMDD dates, integer capacity, UTF-8 without BOM, LF, sorted; passes the contract", () => {
      const text = main.files[fileName("20261026")]!;
      const rows = parseReportCsv(text); // throws on a BOM, CR or no final LF
      expect(rows[0]![0]).toBe("MNO1"); // a data row, not a header
      for (const row of rows) {
        expect(row).toHaveLength(8);
        expect(row[3]).toMatch(/^\d{8}$/);
        expect(row[4]).toMatch(/^\d{8}$/);
        expect(row[7]).toMatch(/^(0|[1-9]\d*)$/);
      }
      // PC10 — by mno, then commercial unit, then polygon, each by code point.
      const keys = rows.map((r) => [r[0]!, r[1]!, r[2]!]);
      const byColumns = (a: string[], b: string[]) => {
        for (let i = 0; i < 3; i++)
          if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
        return 0;
      };
      expect(keys).toEqual([...keys].sort(byColumns));
      const check = runReportingPython(
        [
          "-m",
          "runtime.reporting.validate",
          "output",
          "--contract=contracts/polygon_capacity.yaml",
          `--file=${join(main.outDir, fileName("20261026"))}`,
        ],
        { cwd: join(REPORTING_CONTRACTS_DIR, "..") },
      );
      expect(check.status, check.stdout).toBe(0);
      expect(parseKestraLines(check.stdout).outputs).toEqual({ rows: 5 });
    });

    it("P-T5 — a past date reproduces that day's version: 20261020 and 20261024 read V1, 20261025 reads V2", () => {
      const r = lookup("20261020");
      expect(r.status, r.stderr).toBe(0);
      expect(Object.keys(r.files)).toEqual([fileName("20261020")]);
      expect(r.files[fileName("20261020")]).toBe(
        "MNO1,AAA,PAAA_01,20261020,20260101,MNO1_DISTRICT-001,SVCCODE0001,1000\n" +
          "MNO1,AAA,PV1_ONLY,20261020,20260101,MNO1_DISTRICT-099,SVCCODE0099,500\n",
      );
      expect(r.outputs).toMatchObject({
        ratecard_version_id: fx.versions.v1,
        skipped_polygons: 0,
        status: "SUCCESS",
      });
      expect(lookup("20261024").outputs.ratecard_version_id).toBe(
        fx.versions.v1,
      );
      expect(lookup("20261025").outputs.ratecard_version_id).toBe(
        fx.versions.v2,
      );
    });

    it("Inv 8 — the day boundaries are Asia/Kuala_Lumpur's whatever the session time zone", () => {
      for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
        const r = lookup("20261026", { env: { PGTZ: tz } });
        expect(r.files[fileName("20261026")], tz).toBe(EXPECTED_20261026);
        expect(
          lookup("20261024", { env: { PGTZ: tz } }).outputs.ratecard_version_id,
          tz,
        ).toBe(fx.versions.v1);
      }
    });

    it("P-T9 — a report date before V1 was activated fails NO_ACTIVE_RATECARD_VERSION", () => {
      expectFailed(lookup("20260930"), "NO_ACTIVE_RATECARD_VERSION 20260930");
    });

    it("P-T10 (runtime) — a malformed date fails INVALID_REPORT_DATE (today / tomorrow are refused by report-validate-date, in the live suite)", () => {
      expectFailed(lookup("20261332"), "INVALID_REPORT_DATE 20261332");
    });

    it("P-T12 — two runs for the same report date give identical content", () => {
      const again = lookup("20261026");
      expect(again.files[fileName("20261026")]).toBe(
        main.files[fileName("20261026")],
      );
      expect(again.outputs).toEqual(main.outputs);
    });

    it("D5 — an unknown capacity source or an unreadable fixture fails CAPACITY_SOURCE_UNAVAILABLE", () => {
      expectFailed(
        lookup("20261026", { source: "mediation" }),
        "CAPACITY_SOURCE_UNAVAILABLE mediation",
      );
      expectFailed(
        lookup("20261026", {
          fixture: join(tmpdir(), "rpt04-no-such-fixture.csv"),
        }),
        "CAPACITY_SOURCE_UNAVAILABLE fixture",
      );
    });

    it("R04-T3 — no card named fails NO_RATECARD_NAMED; two cards fail MULTIPLE_RATECARDS_NAMED naming both", async () => {
      // CARD_X is named from 20260901.
      expectFailed(lookup("20260831"), "NO_RATECARD_NAMED 20260831");
      const other = await insertOffering(sql, "rpt04 second RAN usage");
      try {
        await insertUsagePrice(
          sql,
          other,
          "CARD_Z",
          "2026-10-01T00:00:00+08:00",
        );
        expectFailed(
          lookup("20261026"),
          "MULTIPLE_RATECARDS_NAMED 20261026 CARD_X,CARD_Z",
        );
        // Not yet named on 20260930: only CARD_X counts.
        expect(errors(lookup("20260930"))).toEqual([
          "NO_ACTIVE_RATECARD_VERSION 20260930",
        ]);
      } finally {
        await sql`DELETE FROM product.product_offering WHERE product_offering_id = ${other}`;
      }
    });

    it("R04-T2 — the card name changes over time: CARD_X until 20261020, CARD_Y from 20261021", async () => {
      const cardY = await insertVersion(
        sql,
        "CARD_Y",
        1,
        "ACTIVE",
        "2026-10-01T09:00:00+08:00",
        [
          {
            mno: "MNO1",
            cu: "YYY",
            polygon: "PY_01",
            start: "2026-01-01",
            district: "DISTRICT-Y01",
            serviceCode: "SVCCODEY001",
          },
        ],
      );
      // 20261021 00:00 Asia/Kuala_Lumpur — the end of 20261020, so not yet in force then.
      const price = await insertUsagePrice(
        sql,
        fx.offeringId,
        "CARD_Y",
        "2026-10-21T00:00:00+08:00",
      );
      try {
        const before = lookup("20261020");
        expect(before.outputs).toMatchObject({
          ratecard_card_name: CARD_X,
          ratecard_version_id: fx.versions.v1,
        });
        const after = lookup("20261026");
        expect(after.status, after.stderr).toBe(0);
        expect(after.outputs).toMatchObject({
          ratecard_card_name: "CARD_Y",
          ratecard_version_id: cardY,
          status: "SUCCESS",
        });
        expect(after.files[fileName("20261026")]).toBe(
          "MNO1,YYY,PY_01,20261026,20260101,MNO1_DISTRICT-Y01,SVCCODEY001,750\n",
        );
      } finally {
        await sql`DELETE FROM product.product_offering_price WHERE product_offering_price_id = ${price}`;
      }
      expect(lookup("20261026").outputs.ratecard_card_name).toBe(CARD_X);
    });

    // Mutate V2's rows for one case and put them back.
    async function withV2Rows(update: string, body: () => void): Promise<void> {
      const saved = await sql<
        { id: string; end: string | null; district: string | null }[]
      >`
        SELECT ratecard_ran_usage_lkp_id AS id, polygon_end_date::text AS end, district
        FROM product.ratecard_ran_usage_lkp WHERE ratecard_version_id = ${fx.versions.v2}`;
      await sql.unsafe(
        `UPDATE product.ratecard_ran_usage_lkp SET ${update} WHERE ratecard_version_id = $1`,
        [fx.versions.v2],
      );
      try {
        body();
      } finally {
        for (const row of saved) {
          await sql`
            UPDATE product.ratecard_ran_usage_lkp
            SET polygon_end_date = ${row.end}, district = ${row.district}
            WHERE ratecard_ran_usage_lkp_id = ${row.id}`;
        }
      }
      expect(lookup("20261026").files[fileName("20261026")]).toBe(
        EXPECTED_20261026,
      );
    }

    it("P-T8 — all polygons ended fails NO_ELIGIBLE_POLYGONS; nothing written", async () => {
      await withV2Rows("polygon_end_date = '2026-10-01'", () =>
        expectFailed(lookup("20261026"), "NO_ELIGIBLE_POLYGONS 20261026"),
      );
    });

    it("D6 — every eligible row skipped fails ALL_POLYGONS_EXCEPTED, after logging each SKIPPED line", async () => {
      await withV2Rows("district = NULL", () => {
        const r = lookup("20261026");
        expect(r.status).not.toBe(0);
        expect(errors(r)).toEqual(["ALL_POLYGONS_EXCEPTED"]);
        expect(warnings(r)).toHaveLength(8);
        expect(
          warnings(r).every((w) => /^SKIPPED \S+ DISTRICT_MISSING$/.test(w)),
        ).toBe(true);
        expect(r.files).toEqual({});
      });
    });

    it("P-T14 (runtime) — deliver() writes the day's file once, leaves no .tmp, and a second delivery fails FILE_ALREADY_EXISTS leaving it byte-identical", () => {
      const root = mkdtempSync(join(tmpdir(), "rpt04-outbound-"));
      const generated = join(main.outDir, fileName("20261026"));
      const deliver = () =>
        runReportingPython([
          "-c",
          `import sys
from pathlib import Path
from runtime.reporting.common import delivery
delivery.OUTBOUND_ROOT = Path(sys.argv[1])
delivery._mounted = lambda path: True  # a temp dir stands in for the mount
sys.exit(delivery.main(["--outbound-dir", str(Path(sys.argv[1]) / "polygon-capacity"), sys.argv[2]]))`,
          root,
          generated,
        ]);
      const outbound = join(root, "polygon-capacity");
      mkdirSync(outbound);

      const first = deliver();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(readdirSync(outbound)).toEqual([fileName("20261026")]);
      const delivered = readFileSync(join(outbound, fileName("20261026")));
      expect(delivered.toString("utf8")).toBe(EXPECTED_20261026);

      const second = deliver();
      expect(second.status).not.toBe(0);
      expect(parseKestraLines(second.stdout).logs).toEqual([
        {
          level: "ERROR",
          message: `FILE_ALREADY_EXISTS ${fileName("20261026")}`,
        },
      ]);
      expect(readdirSync(outbound)).toEqual([fileName("20261026")]);
      expect(
        readFileSync(join(outbound, fileName("20261026"))).equals(delivered),
      ).toBe(true);
    });
  },
);
