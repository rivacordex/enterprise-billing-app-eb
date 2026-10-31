// @vitest-environment node
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CARD_X,
  EXPECTED_20261026,
  SKIPPED_20261026,
} from "@/tests/fixtures/reporting/polygon-capacity-seed";
import {
  api,
  delivered,
  download,
  type Execution,
  expectNothingPublished,
  kestraConfigured,
  klDate,
  label,
  messages,
  published,
  putNamespaceFile,
  ran,
  request,
  runFlow,
  sha256,
  startForm,
} from "@/tests/helpers/reporting-kestra-live";

// rpt04-spec Tests — `report-polygon-capacity-lookup` end to end on a live
// engine: R04-T7 (the committed flow is disabled and can't be started),
// P-T14 (delivery to the outbound folder and the re-run that fails
// FILE_ALREADY_EXISTS), P-T10 (today / tomorrow / a malformed date), P-T5
// through the flow, the PC15 default, and Inv 5 (an output-check failure
// delivers and publishes nothing). The flow is run by temporarily deploying an
// ENABLED copy to this engine's `reporting` namespace — the local test engine
// only — and putting the committed (disabled) flow back afterwards; the
// fixture capacity file is uploaded as the namespace file the flow's
// `capacity_fixture` names, and removed afterwards.
//
// Needs, besides the engine (the same variables as rpt02/rpt03's live suites):
//   - the `reporting` flows and contracts deployed, and the engine's
//     REPORTING_DB_* pointing at a database seeded with
//     tests/fixtures/reporting/polygon-capacity-seed.ts;
//   - RPT04_OUTBOUND_HOST_DIR: the host folder bound at the engine's
//     /data/outbound (holding `polygon-capacity/`). The suite removes earlier
//     Polygon_capacity_lookup_*.csv files from it first.
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//   RPT04_OUTBOUND_HOST_DIR=…/workflow-management/dev/outbound

const OUTBOUND_HOST_DIR = process.env.RPT04_OUTBOUND_HOST_DIR;
const live = kestraConfigured && Boolean(OUTBOUND_HOST_DIR);

const FLOW_ID = "report-polygon-capacity-lookup";
const FLOW_FILE = join(
  process.cwd(),
  "workflow-management/flows/reporting",
  `${FLOW_ID}.yaml`,
);
const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/polygon_capacity.yaml",
);
const CAPACITY_FIXTURE = join(
  process.cwd(),
  "tests/fixtures/reporting/polygon_capacity/capacity.csv",
);
const FIXTURE_PATH = "/fixtures/polygon_capacity.csv"; // the flow's vars.capacity_fixture
const fileName = (day: string) => `Polygon_capacity_lookup_${day}.csv`;
const outbound = () => join(OUTBOUND_HOST_DIR!, "polygon-capacity");

async function putFlow(source: string): Promise<void> {
  await api(`/flows/reporting/${FLOW_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/x-yaml" },
    body: source,
  });
}

const run = (inputs: Record<string, string>): Promise<Execution> =>
  runFlow(FLOW_ID, inputs);

async function expectNothingDeliveredOrPublished(
  e: Execution,
  day: string,
): Promise<void> {
  expect(ran(e, "deliver")).toBe(false);
  await expectNothingPublished(e);
  expect(existsSync(join(outbound(), fileName(day)))).toBe(false);
}

describe.skipIf(!live)(
  "rpt04 report-polygon-capacity-lookup on a live engine",
  { timeout: 180_000 },
  () => {
    const committed = live ? readFileSync(FLOW_FILE, "utf8") : "";

    beforeAll(async () => {
      for (const name of readdirSync(outbound()))
        if (/^\.?Polygon_capacity_lookup_\d{8}\.csv(\.tmp)?$/.test(name))
          unlinkSync(join(outbound(), name));
      await putFlow(committed);
    });

    afterAll(async () => {
      await putFlow(committed); // deployed disabled again
      await request(
        `/namespaces/reporting/files?path=${encodeURIComponent(FIXTURE_PATH)}`,
        {
          method: "DELETE",
        },
      );
    });

    it("R04-T7 — the committed flow is deployed disabled and can't be started", async () => {
      const flow = (await (
        await api(`/flows/reporting/${FLOW_ID}`)
      ).json()) as { disabled: boolean };
      expect(flow.disabled).toBe(true);
      const res = await request(`/executions/reporting/${FLOW_ID}`, {
        method: "POST",
        body: startForm({ report_date: "20261026" }),
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("disabled");
    });

    describe("enabled in the local test namespace only", () => {
      beforeAll(async () => {
        const enabled = committed.replace(
          /^disabled: true$/m,
          "disabled: false",
        );
        expect(enabled).not.toBe(committed);
        await putFlow(enabled);
        await putNamespaceFile(
          FIXTURE_PATH,
          readFileSync(CAPACITY_FIXTURE, "utf8"),
        );
      });

      it("P-T14 — the first run delivers Polygon_capacity_lookup_20261026.csv to the outbound folder and to Kestra outputs, no .tmp left; WARNING with its labels", async () => {
        const e = await run({ report_date: "20261026" });
        expect(e.state.current).toBe("WARNING");
        expect(label(e, "report")).toBe("polygon_capacity");
        expect(label(e, "report_date")).toBe("20261026");
        expect(label(e, "ratecard_card_name")).toBe(CARD_X);
        expect(label(e, "ratecard_version_id")).toMatch(/^RCV\d{8}$/);
        expect(label(e, "skipped_polygons")).toBe("3");
        expect(label(e, "flow_revision")).toMatch(/^\d+$/);
        expect((await messages(e, "WARN")).sort()).toEqual(SKIPPED_20261026);

        const files = published(e);
        expect(Object.keys(files)).toEqual([fileName("20261026")]);
        const content = await download(e, files[fileName("20261026")]!);
        expect(content).toBe(EXPECTED_20261026);
        expect(await delivered(e)).toEqual([
          `DELIVERED ${fileName("20261026")} sha256=${sha256(content)} rev=${label(e, "flow_revision")}`,
        ]);
        expect(
          readdirSync(outbound()).filter((n) => n.includes("Polygon")),
        ).toEqual([fileName("20261026")]);
        expect(
          readFileSync(join(outbound(), fileName("20261026")), "utf8"),
        ).toBe(EXPECTED_20261026);
      });

      it("P-T14 — a second run for the same date fails FILE_ALREADY_EXISTS at deliver; the delivered file is unchanged and nothing is published", async () => {
        const before = readFileSync(join(outbound(), fileName("20261026")));
        const e = await run({ report_date: "20261026" });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContain(
          `FILE_ALREADY_EXISTS ${fileName("20261026")}`,
        );
        expect(ran(e, "deliver")).toBe(true);
        expect(ran(e, "publish")).toBe(false);
        expect(published(e)).toEqual({});
        expect(
          readFileSync(join(outbound(), fileName("20261026"))).equals(before),
        ).toBe(true);
        expect(
          readdirSync(outbound()).filter((n) => n.includes("Polygon")),
        ).toEqual([fileName("20261026")]);
      });

      it("P-T5 (flow) — 20261020 reads V1 and ends SUCCESS with its own file name", async () => {
        const e = await run({ report_date: "20261020" });
        expect(e.state.current).toBe("SUCCESS");
        expect(label(e, "skipped_polygons")).toBe("0");
        expect(Object.keys(published(e))).toEqual([fileName("20261020")]);
        expect(existsSync(join(outbound(), fileName("20261020")))).toBe(true);
      });

      it("PC15 — an empty report_date is yesterday in Asia/Kuala_Lumpur", async () => {
        const e = await run({});
        expect(label(e, "report_date")).toBe(klDate(-1));
        expect(Object.keys(published(e))).toEqual([fileName(klDate(-1))]);
      });

      describe("P-T10 — today, tomorrow and a malformed date fail INVALID_REPORT_DATE at validate_date", () => {
        for (const value of [klDate(0), klDate(1), "20261332"]) {
          it(`${value} → FAILED INVALID_REPORT_DATE ${value}`, async () => {
            const e = await run({ report_date: value });
            expect(e.state.current).toBe("FAILED");
            expect(await messages(e, "ERROR")).toContain(
              `INVALID_REPORT_DATE ${value}`,
            );
            expect(ran(e, "generate")).toBe(false);
            await expectNothingDeliveredOrPublished(e, value);
          });
        }
      });

      it("P-T9 (flow) — no version for the date fails at generate; nothing delivered or published", async () => {
        const e = await run({ report_date: "20260930" });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContain(
          "NO_ACTIVE_RATECARD_VERSION 20260930",
        );
        await expectNothingDeliveredOrPublished(e, "20260930");
      });

      it("Inv 5 — a file that fails its column definition is neither delivered nor published", async () => {
        const contract = readFileSync(CONTRACT, "utf8");
        const wrong = contract.replace(
          /(- name: polygon_coverage_capacity_mbps\n\s+type:) integer/,
          "$1 date",
        );
        expect(wrong).not.toBe(contract);
        await putNamespaceFile("/contracts/polygon_capacity.yaml", wrong);
        try {
          const e = await run({ report_date: "20261024" });
          expect(e.state.current).toBe("FAILED");
          expect(await messages(e, "ERROR")).toContain(
            `OUTPUT_CONTRACT_VIOLATION ${fileName("20261024")} 1 polygon_coverage_capacity_mbps BAD_DATE`,
          );
          await expectNothingDeliveredOrPublished(e, "20261024");
        } finally {
          await putNamespaceFile("/contracts/polygon_capacity.yaml", contract);
        }
      });
    });
  },
);
