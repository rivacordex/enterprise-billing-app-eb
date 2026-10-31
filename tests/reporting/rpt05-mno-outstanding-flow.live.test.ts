// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

const KESTRA_URL = process.env.KESTRA_URL;
const KESTRA_USER = process.env.KESTRA_BASIC_AUTH_USER;
const KESTRA_PASSWORD = process.env.KESTRA_BASIC_AUTH_PASSWORD;
const live = Boolean(KESTRA_URL && KESTRA_USER && KESTRA_PASSWORD);

const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/mno_outstanding.yaml",
);
const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/mno-outstanding/expected/Reporting_dnb_settlement_mno_20261027.csv",
);
const FLOW_ID = "report-mno-outstanding";

interface TaskRun {
  taskId: string;
  state: { current: string };
  outputs?: {
    executionId?: string;
    outputFiles?: Record<string, string>;
    [key: string]: unknown;
  };
}
interface Execution {
  id: string;
  state: { current: string };
  labels?: { key: string; value: string }[];
  taskRunList?: TaskRun[];
}
interface Log {
  level: string;
  message: string;
}

function authHeader(): string {
  const { protocol, hostname } = new URL(KESTRA_URL!);
  if (
    protocol !== "https:" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    throw new Error(
      `Refusing to send Basic Auth to ${KESTRA_URL} over plain HTTP`,
    );
  }
  return (
    "Basic " +
    Buffer.from(`${KESTRA_USER}:${KESTRA_PASSWORD}`).toString("base64")
  );
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${KESTRA_URL}/api/v1/main${path}`, {
    ...init,
    headers: { Authorization: authHeader(), ...init.headers },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  return res;
}

async function run(inputs: Record<string, string>): Promise<Execution> {
  const form = new FormData();
  for (const [key, value] of Object.entries(inputs)) form.append(key, value);
  const res = await api(`/executions/reporting/${FLOW_ID}?wait=true`, {
    method: "POST",
    body: form,
  });
  const { id } = (await res.json()) as Execution;
  // Re-read: the wait=true response can precede the final labels.
  return (await (await api(`/executions/${id}`)).json()) as Execution;
}

// Logs of an execution and of every subflow execution it started.
async function logs(execution: Execution): Promise<Log[]> {
  const own = (await (await api(`/logs/${execution.id}`)).json()) as Log[];
  const children: Log[] = [];
  for (const taskRun of execution.taskRunList ?? []) {
    const childId = taskRun.outputs?.executionId;
    if (childId) {
      const child = (await (
        await api(`/executions/${childId}`)
      ).json()) as Execution;
      children.push(...(await logs(child)));
    }
  }
  return [...own, ...children];
}

const messages = async (e: Execution, level: string) =>
  (await logs(e)).filter((l) => l.level === level).map((l) => l.message);

const label = (e: Execution, key: string) =>
  e.labels?.find((l) => l.key === key)?.value;

const ran = (e: Execution, taskId: string) =>
  (e.taskRunList ?? []).some((t) => t.taskId === taskId);

// The published files: the publish task's output files, by name.
const published = (e: Execution): Record<string, string> =>
  e.taskRunList?.find((t) => t.taskId === "publish")?.outputs?.outputFiles ??
  {};

async function download(e: Execution, uri: string): Promise<string> {
  return (
    await api(`/executions/${e.id}/file?path=${encodeURIComponent(uri)}`)
  ).text();
}

function klDate(days = 0): string {
  const kl = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000);
  return kl.toISOString().slice(0, 10).replaceAll("-", "");
}

async function putContract(content: string): Promise<void> {
  const form = new FormData();
  form.append("fileContent", new Blob([content]));
  await api(
    `/namespaces/reporting/files?path=${encodeURIComponent("/contracts/mno_outstanding.yaml")}`,
    { method: "POST", body: form },
  );
}

async function expectNothingPublished(e: Execution): Promise<void> {
  expect(ran(e, "publish")).toBe(false);
  expect(published(e)).toEqual({});
  expect(
    (await messages(e, "INFO")).filter((m) => m.startsWith("DELIVERED")),
  ).toEqual([]);
}

describe.skipIf(!live)(
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
      const sha = createHash("sha256").update(text, "utf8").digest("hex");
      expect(
        (await messages(e, "INFO")).filter((m) => m.startsWith("DELIVERED")),
      ).toEqual([
        `DELIVERED ${name} sha256=${sha} rev=${label(e, "flow_revision")}`,
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
