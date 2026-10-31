// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  delivered,
  download,
  type Execution,
  kestraConfigured,
  klDate,
  label,
  messages,
  putNamespaceFile,
  ran,
  runFlow,
  sha256,
} from "@/tests/helpers/reporting-kestra-live";

// rpt08-spec verification 1 — `report-invoice-csv` end to end on a live
// engine: the WARNING path, the empty day (no files: the two ForEach tasks run
// over an empty list), the invoice_date rule (IC14, R-T7) and the output check
// (Inv 5), with the `reporting` flows and contracts deployed and the engine's
// REPORTING_DB_* pointing at a database seeded with the Part D fixture
// (tests/fixtures/reporting/invoice-csv-seed.ts). Skipped unless the engine's
// URL and Basic Auth credential are set (the same variables as rpt02's live
// suite):
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//
// The output-check case uploads a deliberately wrong contracts/invoice_csv.yaml
// for one run and restores the committed one afterwards.

const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/invoice_csv.yaml",
);
const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/invoice-csv/expected",
);
const FLOW_ID = "report-invoice-csv";
const DAY = "20261005";
const FILES = [`RMNO-P${DAY}.csv`, `RMNO-Q${DAY}.csv`];

const run = (inputs: Record<string, string>): Promise<Execution> =>
  runFlow(FLOW_ID, inputs);

const putContract = (content: string) =>
  putNamespaceFile("/contracts/invoice_csv.yaml", content);

// The published files: each `publish_file` iteration's output file, by name.
const published = (e: Execution): Record<string, string> =>
  Object.assign(
    {},
    ...(e.taskRunList ?? [])
      .filter((t) => t.taskId === "publish_file")
      .map((t) => t.outputs?.outputFiles ?? {}),
  ) as Record<string, string>;

async function expectNothingPublished(e: Execution): Promise<void> {
  expect(ran(e, "publish_file")).toBe(false);
  expect(published(e)).toEqual({});
  expect(await delivered(e)).toEqual([]);
}

describe.skipIf(!kestraConfigured)(
  "rpt08 report-invoice-csv on a live engine",
  { timeout: 180_000 },
  () => {
    it("WARNING path: 20261005 skips four invoices, ends WARNING, publishes one file per MNO with its DELIVERED line, and labels the run", async () => {
      const e = await run({ invoice_date: DAY });
      expect(e.state.current).toBe("WARNING");
      const skipped = (await messages(e, "WARN")).filter((m) =>
        m.startsWith("SKIPPED"),
      );
      expect(skipped).toHaveLength(4);
      expect(label(e, "report")).toBe("invoice_csv");
      expect(label(e, "invoice_date")).toBe(DAY);
      expect(label(e, "skipped_invoices")).toBe("4");
      expect(label(e, "files_written")).toBe("2");
      expect(label(e, "flow_revision")).toMatch(/^\d+$/);

      const files = published(e);
      expect(Object.keys(files).sort()).toEqual(FILES);
      const lines: string[] = [];
      for (const name of FILES) {
        const text = await download(e, files[name]!);
        expect(text, name).toBe(readFileSync(join(EXPECTED, name), "utf8"));
        lines.push(
          `DELIVERED ${name} sha256=${sha256(text)} rev=${label(e, "flow_revision")}`,
        );
      }
      expect((await delivered(e)).sort()).toEqual(lines.sort());
    });

    it("IC17 — the default date (yesterday) has no invoices: SUCCESS, NO_INVOICES_ON, files_written 0, nothing published", async () => {
      const e = await run({});
      expect(e.state.current).toBe("SUCCESS");
      const day = klDate(-1);
      expect(label(e, "invoice_date")).toBe(day);
      expect(label(e, "files_written")).toBe("0");
      expect(label(e, "skipped_invoices")).toBe("0");
      expect(await messages(e, "INFO")).toContain(`NO_INVOICES_ON ${day}`);
      await expectNothingPublished(e);
    });

    it("IC14 — today is allowed (not_future)", async () => {
      const e = await run({ invoice_date: klDate(0) });
      expect(e.state.current).toBe("SUCCESS");
      expect(ran(e, "generate")).toBe(true);
    });

    describe("R-T7 — tomorrow and 20261332 fail at validate_date with INVALID_INVOICE_DATE; nothing runs after it", () => {
      for (const value of [klDate(1), "20261332"]) {
        it(`${value} → FAILED INVALID_INVOICE_DATE ${value}`, async () => {
          const e = await run({ invoice_date: value });
          expect(e.state.current).toBe("FAILED");
          expect(await messages(e, "ERROR")).toContain(
            `INVALID_INVOICE_DATE ${value}`,
          );
          expect(ran(e, "generate")).toBe(false);
          await expectNothingPublished(e);
        });
      }
    });

    it("Inv 5 (output check) — a generated file that fails its column definition stops publish: FAILED OUTPUT_CONTRACT_VIOLATION, nothing published", async () => {
      const committed = readFileSync(CONTRACT, "utf8");
      // The runtime still writes 2 dp amounts; the contract now wants an
      // integer, so the output check (not the writer) must catch it.
      const wrong = committed.replace(
        /(- name: Invoice Amount\r?\n\s+type:) amount/,
        "$1 integer",
      );
      expect(wrong).not.toBe(committed);
      await putContract(wrong);
      try {
        const e = await run({ invoice_date: DAY });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContain(
          `OUTPUT_CONTRACT_VIOLATION ${FILES[0]} 2 Invoice Amount BAD_INTEGER`,
        );
        await expectNothingPublished(e);
      } finally {
        await putContract(committed);
      }
    });
  },
);
