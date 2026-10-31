// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
  runFlow,
  sha256,
} from "@/tests/helpers/reporting-kestra-live";

// rpt05-spec Tests MO-T14 and the WARNING path — `report-mno-outstanding` end
// to end on a live engine, with the `reporting` flows and contracts deployed,
// and the engine's REPORTING_DB_* pointing at a database seeded with the Part A
// fixture as extended for Part C (tests/fixtures/reporting/settlement-seed.ts).
// Skipped unless the engine's URL and Basic Auth credential are set (the same
// variables as rpt02's live suite):
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//
// The output-check case uploads a deliberately wrong
// contracts/mno_outstanding.yaml for one run and restores the committed one
// afterwards.

const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/mno_outstanding.yaml",
);
const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/mno-outstanding/expected/Reporting_dnb_settlement_mno_20261027.csv",
);
const FLOW_ID = "report-mno-outstanding";

const run = (inputs: Record<string, string>): Promise<Execution> =>
  runFlow(FLOW_ID, inputs);

const putContract = (content: string) =>
  putNamespaceFile("/contracts/mno_outstanding.yaml", content);

describe.skipIf(!kestraConfigured)(
  "rpt05 report-mno-outstanding on a live engine",
  { timeout: 180_000 },
  () => {
    it("WARNING path: the default date (yesterday) skips MNO-C, ends WARNING, publishes one file with its DELIVERED line, and labels the run", async () => {
      const e = await run({});
      expect(e.state.current).toBe("WARNING");
      expect(await messages(e, "WARN")).toContainEqual(
        expect.stringMatching(/^SKIPPED \S+ MNO_PUBLIC_KEY_MISSING$/),
      );
      const day = klDate(-1);
      expect(label(e, "report")).toBe("mno_outstanding");
      expect(label(e, "outstanding_date")).toBe(day);
      expect(label(e, "skipped_mnos")).toBe("1");
      expect(label(e, "flow_revision")).toMatch(/^\d+$/);

      const files = published(e);
      const name = `Reporting_dnb_settlement_mno_${day}.csv`;
      expect(Object.keys(files)).toEqual([name]);
      const text = await download(e, files[name]!);
      expect(await delivered(e)).toEqual([
        `DELIVERED ${name} sha256=${sha256(text)} rev=${label(e, "flow_revision")}`,
      ]);
    });

    it("an explicit past date publishes the fixture's expected file", async () => {
      const e = await run({ outstanding_date: "20261027" });
      expect(e.state.current).toBe("WARNING");
      const files = published(e);
      const name = "Reporting_dnb_settlement_mno_20261027.csv";
      expect(Object.keys(files)).toEqual([name]);
      expect(await download(e, files[name]!)).toBe(
        readFileSync(EXPECTED, "utf8"),
      );
    });

    describe("MO-T14 — today, tomorrow and 20261332 fail at validate_date with INVALID_OUTSTANDING_DATE; nothing runs after it", () => {
      for (const value of [klDate(0), klDate(1), "20261332"]) {
        it(`${value} → FAILED INVALID_OUTSTANDING_DATE ${value}`, async () => {
          const e = await run({ outstanding_date: value });
          expect(e.state.current).toBe("FAILED");
          expect(await messages(e, "ERROR")).toContain(
            `INVALID_OUTSTANDING_DATE ${value}`,
          );
          expect(ran(e, "generate")).toBe(false);
          await expectNothingPublished(e);
        });
      }
    });

    it("MO13 (output check) — a generated file that fails its column definition stops publish: FAILED OUTPUT_CONTRACT_VIOLATION, no outputs", async () => {
      const committed = readFileSync(CONTRACT, "utf8");
      // The runtime still writes 2 dp amounts; the contract now wants an
      // integer, so the output check (not the writer) must catch it.
      const wrong = committed.replace(
        /(- name: outstanding_amount_myr\n\s+type:) amount/,
        "$1 integer",
      );
      expect(wrong).not.toBe(committed);
      await putContract(wrong);
      try {
        const e = await run({ outstanding_date: "20261027" });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContain(
          "OUTPUT_CONTRACT_VIOLATION Reporting_dnb_settlement_mno_20261027.csv 1 outstanding_amount_myr BAD_INTEGER",
        );
        await expectNothingPublished(e);
      } finally {
        await putContract(committed);
      }
    });
  },
);
