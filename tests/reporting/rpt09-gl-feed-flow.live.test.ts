// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runReportingPython } from "@/tests/helpers/reporting-harness";
import {
  delivered,
  downloadBytes,
  type Execution,
  kestraConfigured,
  klDate,
  label,
  messages,
  putNamespaceFile,
  ran,
  runFlow,
} from "@/tests/helpers/reporting-kestra-live";

// rpt09-spec verification 1 — `report-gl-feed` end to end on a live engine:
// the WARNING path (G-T11) with the zip decrypted and compared with the
// expected CSV (G-T15), the empty default day (G-T13), the posting_date rule
// (G-T19's date half), the output check (Inv 5) and guardrail 7 (no CSV among
// any run's outputs), with the `reporting` flows and contracts deployed and the
// engine's REPORTING_DB_* pointing at a database seeded with the Part E fixture
// (tests/fixtures/reporting/gl-feed-seed.ts). Skipped unless the engine's URL
// and Basic Auth credential are set (the same variables as rpt02's live
// suite):
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//   RPT09_ZIP_PASSWORD=<the engine's GL feed zip password, decoded>
//
// G-T14 needs an engine started WITHOUT SECRET_GLFEED_ZIP_PASSWORD: set
// RPT09_SECRET_MISSING=1 to run that case (and only that one) against it.
//
// The output-check case uploads a deliberately wrong contracts/gl_feed.yaml for
// one run and restores the committed one afterwards.

const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/gl_feed.yaml",
);
const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/gl-feed/expected",
);
const FLOW_ID = "report-gl-feed";
const DAY = "20261026";
const zipName = (day: string) => `GLFEED_ORAFIN_${day}.zip`;
const csvName = (day: string) => `GLFEED_ORAFIN_${day}.csv`;

const secretMissing = process.env.RPT09_SECRET_MISSING === "1";
const password = process.env.RPT09_ZIP_PASSWORD ?? "";

const run = (inputs: Record<string, string>): Promise<Execution> =>
  runFlow(FLOW_ID, inputs);

const putContract = (content: string) =>
  putNamespaceFile("/contracts/gl_feed.yaml", content);

// Every output file of every task run, by name.
const allOutputFiles = (e: Execution): string[] =>
  (e.taskRunList ?? []).flatMap((t) =>
    Object.keys(t.outputs?.outputFiles ?? {}),
  );

const published = (e: Execution): Record<string, string> =>
  e.taskRunList?.find((t) => t.taskId === "publish")?.outputs?.outputFiles ??
  {};

// [guardrail 7] after any run, success or failure, no CSV is an output.
function expectNoCsv(e: Execution): void {
  expect(allOutputFiles(e).filter((name) => name.endsWith(".csv"))).toEqual([]);
}

async function expectNothingPublished(e: Execution): Promise<void> {
  expect(ran(e, "publish")).toBe(false);
  expect(published(e)).toEqual({});
  expect(await delivered(e)).toEqual([]);
  expectNoCsv(e);
}

// The zip's entries, and the CSV opened with the password (pyzipper).
function openZip(bytes: Buffer): { names: string[]; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "rpt09-zip-"));
  const path = join(dir, "feed.zip");
  writeFileSync(path, bytes);
  const py = runReportingPython(
    [
      "-c",
      `import json, os, sys, pyzipper
with pyzipper.AESZipFile(sys.argv[1]) as z:
    z.setpassword(os.environ["ZIP_PASSWORD"].encode())
    names = z.namelist()
    print(json.dumps({"names": names, "text": z.read(names[0]).decode("utf-8")}))`,
      path,
    ],
    { env: { ZIP_PASSWORD: password } },
  );
  expect(py.status, py.stderr).toBe(0);
  return JSON.parse(py.stdout) as { names: string[]; text: string };
}

describe.skipIf(!kestraConfigured || secretMissing)(
  "rpt09 report-gl-feed on a live engine",
  { timeout: 240_000 },
  () => {
    it("G-T11 / G-T15 — WARNING path: 20261026 publishes one zip with its DELIVERED line; it opens with the password to exactly the expected CSV; labels", async () => {
      expect(password, "set RPT09_ZIP_PASSWORD").not.toBe("");
      const e = await run({ posting_date: DAY });
      expect(e.state.current).toBe("WARNING");
      expect(
        (await messages(e, "WARN")).filter((m) =>
          m.startsWith("GL_CODE_FALLBACK"),
        ),
      ).toHaveLength(1);
      expect(label(e, "report")).toBe("gl_feed");
      expect(label(e, "posting_date")).toBe(DAY);
      expect(label(e, "gl_code_fallbacks")).toBe("1");
      expect(label(e, "flow_revision")).toMatch(/^\d+$/);

      const files = published(e);
      expect(Object.keys(files)).toEqual([zipName(DAY)]);
      const bytes = await downloadBytes(e, files[zipName(DAY)]!);
      const zip = openZip(bytes);
      expect(zip.names).toEqual([csvName(DAY)]);
      const expected = readFileSync(join(EXPECTED, csvName(DAY)), "utf8");
      expect(zip.text).toBe(expected);
      expect(label(e, "rows")).toBe(
        String(expected.trimEnd().split("\n").length - 1),
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(await delivered(e)).toEqual([
        `DELIVERED ${zipName(DAY)} sha256=${hash} rev=${label(e, "flow_revision")}`,
      ]);
      expectNoCsv(e);
    });

    it("G-T13 — the default date (yesterday) has nothing posted: SUCCESS, rows 0, a zip holding a header-only CSV", async () => {
      const e = await run({});
      expect(e.state.current).toBe("SUCCESS");
      const day = klDate(-1);
      expect(label(e, "posting_date")).toBe(day);
      expect(label(e, "rows")).toBe("0");
      expect(label(e, "gl_code_fallbacks")).toBe("0");
      const files = published(e);
      expect(Object.keys(files)).toEqual([zipName(day)]);
      const zip = openZip(await downloadBytes(e, files[zipName(day)]!));
      expect(zip.names).toEqual([csvName(day)]);
      expect(zip.text.split("\n")).toHaveLength(2); // the header and its LF
      expectNoCsv(e);
    });

    describe("G-T19 — today, tomorrow and 20261332 fail at validate_date with INVALID_POSTING_DATE; nothing is built after it", () => {
      for (const value of [klDate(0), klDate(1), "20261332"]) {
        it(`${value} → FAILED INVALID_POSTING_DATE ${value}`, async () => {
          const e = await run({ posting_date: value });
          expect(e.state.current).toBe("FAILED");
          expect(await messages(e, "ERROR")).toContain(
            `INVALID_POSTING_DATE ${value}`,
          );
          expect(ran(e, "generate")).toBe(false);
          await expectNothingPublished(e);
        });
      }
    });

    it("Inv 5 (output check) — a CSV that fails its column definition stops encryption and publish: FAILED OUTPUT_CONTRACT_VIOLATION, no zip, no CSV", async () => {
      const committed = readFileSync(CONTRACT, "utf8");
      // The runtime still writes 2 dp amounts; the contract now wants an
      // integer, so the output check (not the writer) must catch it.
      const wrong = committed.replace(
        /(- name: Amount\r?\n\s+type:) amount/,
        "$1 integer",
      );
      expect(wrong).not.toBe(committed);
      await putContract(wrong);
      try {
        const e = await run({ posting_date: DAY });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContain(
          `OUTPUT_CONTRACT_VIOLATION ${csvName(DAY)} 2 Amount BAD_INTEGER`,
        );
        expect(ran(e, "encrypt")).toBe(false);
        expect(allOutputFiles(e)).toEqual([]);
        await expectNothingPublished(e);
      } finally {
        await putContract(committed);
      }
    });
  },
);

describe.skipIf(!kestraConfigured || !secretMissing)(
  "rpt09 report-gl-feed on a live engine without the zip password",
  { timeout: 120_000 },
  () => {
    it("G-T14 / R09-T7 — FAILED ENCRYPTION_KEY_MISSING at check_secret, before generate: no CSV and no zip anywhere", async () => {
      const e = await run({ posting_date: DAY });
      expect(e.state.current).toBe("FAILED");
      expect(await messages(e, "ERROR")).toContain("ENCRYPTION_KEY_MISSING");
      expect(ran(e, "generate")).toBe(false);
      expect(allOutputFiles(e)).toEqual([]);
      await expectNothingPublished(e);
    });
  },
);
