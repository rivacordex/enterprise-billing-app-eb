// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// rpt02-spec T-R02-3, T-R02-4, the Kestra half of T-R02-8 / T-R02-9, and
// T-R02-10 — the three shared subflows run on a live engine with the
// `reporting` flows and contracts deployed (the dev `flow-deploy` service, or
// the CI stage). Skipped unless the engine's URL and Basic Auth credential
// are set (the same variables as rm13's live suite):
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//
// The output-check cases upload the two fixture contracts to
// contracts/rpt02_*.yaml for the run and delete them afterwards.

const KESTRA_URL = process.env.KESTRA_URL;
const KESTRA_USER = process.env.KESTRA_BASIC_AUTH_USER;
const KESTRA_PASSWORD = process.env.KESTRA_BASIC_AUTH_PASSWORD;
const live = Boolean(KESTRA_URL && KESTRA_USER && KESTRA_PASSWORD);

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "tests/fixtures/reporting/rpt02");
const CONTRACTS_DIR = join(
  ROOT,
  "workflow-management/flows/reporting/contracts",
);
const FIXTURE_CONTRACTS = ["rpt02_headed", "rpt02_headerless"];

interface TaskRun {
  taskId: string;
  state: { current: string };
  outputs?: { executionId?: string; [key: string]: unknown };
}
interface Execution {
  id: string;
  state: { current: string };
  outputs?: Record<string, unknown>;
  taskRunList?: TaskRun[];
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

async function run(
  flowId: string,
  inputs: Record<string, string | Blob>,
  fileName?: string,
): Promise<Execution> {
  const form = new FormData();
  for (const [key, value] of Object.entries(inputs)) {
    if (value instanceof Blob) form.append(key, value, fileName);
    else form.append(key, value);
  }
  const res = await api(`/executions/reporting/${flowId}?wait=true`, {
    method: "POST",
    body: form,
  });
  return (await res.json()) as Execution;
}

// ERROR messages of an execution and of every subflow execution it started.
async function errorLogs(execution: Execution): Promise<string[]> {
  const logs = (await (await api(`/logs/${execution.id}`)).json()) as {
    level: string;
    message: string;
  }[];
  const own = logs.filter((l) => l.level === "ERROR").map((l) => l.message);
  const children: string[] = [];
  for (const taskRun of execution.taskRunList ?? []) {
    const childId = taskRun.outputs?.executionId;
    if (childId) {
      const child = (await (
        await api(`/executions/${childId}`)
      ).json()) as Execution;
      children.push(...(await errorLogs(child)));
    }
  }
  return [...own, ...children];
}

async function expectFailedWith(
  execution: Execution,
  message: string,
): Promise<void> {
  expect(execution.state.current).toBe("FAILED");
  expect(await errorLogs(execution)).toContain(message);
}

function klDate(days = 0): string {
  const kl = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000);
  return kl.toISOString().slice(0, 10).replaceAll("-", "");
}

async function putNamespaceFile(path: string, content: Buffer): Promise<void> {
  const form = new FormData();
  form.append("fileContent", new Blob([new Uint8Array(content)]));
  await api(`/namespaces/reporting/files?path=${encodeURIComponent(path)}`, {
    method: "POST",
    body: form,
  });
}

describe.skipIf(!live)(
  "rpt02 shared subflows on a live engine",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      for (const id of FIXTURE_CONTRACTS) {
        await putNamespaceFile(
          `/contracts/${id}.yaml`,
          readFileSync(join(FIXTURES, "contracts", `${id}.yaml`)),
        );
      }
    });
    afterAll(async () => {
      for (const id of FIXTURE_CONTRACTS) {
        await api(
          `/namespaces/reporting/files?path=${encodeURIComponent(`/contracts/${id}.yaml`)}`,
          {
            method: "DELETE",
          },
        ).catch(() => undefined);
      }
    });

    describe("T-R02-3 — report-validate-date", () => {
      it("an empty value → effective_date = the default (yesterday / today in Kuala Lumpur)", async () => {
        const yesterday = await run("report-validate-date", {
          name: "report_date",
          rule: "before_today",
          default: "yesterday",
        });
        expect(yesterday.state.current).toBe("SUCCESS");
        expect(yesterday.outputs).toEqual({ effective_date: klDate(-1) });

        const today = await run("report-validate-date", {
          name: "as_of_date",
          rule: "not_future",
          default: "today",
        });
        expect(today.outputs).toEqual({ effective_date: klDate() });
      });

      it("20261332 → FAILED INVALID_REPORT_DATE; the code follows the name input", async () => {
        const report = await run("report-validate-date", {
          name: "report_date",
          value: "20261332",
          rule: "before_today",
          default: "yesterday",
        });
        await expectFailedWith(report, "INVALID_REPORT_DATE 20261332");

        const invoice = await run("report-validate-date", {
          name: "invoice_date",
          value: "20261332",
          rule: "before_today",
          default: "yesterday",
        });
        await expectFailedWith(invoice, "INVALID_INVOICE_DATE 20261332");
      });

      it("a value that looks like shell syntax is data, not a command", async () => {
        const execution = await run("report-validate-date", {
          name: "report_date",
          value: '"; echo injected; "',
          rule: "before_today",
          default: "yesterday",
        });
        await expectFailedWith(
          execution,
          'INVALID_REPORT_DATE "; echo injected; "',
        );
      });
    });

    describe("T-R02-4 — report-validate-period (T17)", () => {
      it("fails with the SR25 code for 202613, 20261332, tomorrow, and 20260815 for 202609", async () => {
        await expectFailedWith(
          await run("report-validate-period", {
            billing_period: "202613",
            as_of_date: "20261031",
          }),
          "INVALID_BILLING_PERIOD 202613",
        );
        await expectFailedWith(
          await run("report-validate-period", {
            billing_period: "202609",
            as_of_date: "20261332",
          }),
          "INVALID_AS_OF_DATE 20261332",
        );
        await expectFailedWith(
          await run("report-validate-period", {
            billing_period: "202609",
            as_of_date: klDate(1),
          }),
          `INVALID_AS_OF_DATE ${klDate(1)}`,
        );
        await expectFailedWith(
          await run("report-validate-period", {
            billing_period: "202609",
            as_of_date: "20260815",
          }),
          "INVALID_AS_OF_DATE 20260815",
        );
      });

      it("a valid pair returns the period bounds; an empty as_of_date defaults to today", async () => {
        const pair = await run("report-validate-period", {
          billing_period: "202602",
          as_of_date: "20260301",
        });
        expect(pair.state.current).toBe("SUCCESS");
        expect(pair.outputs).toEqual({
          period_start: "20260201",
          period_end: "20260228",
          effective_as_of_date: "20260301",
        });

        const defaulted = await run("report-validate-period", {
          billing_period: "202609",
        });
        expect(defaulted.outputs).toEqual({
          period_start: "20260901",
          period_end: "20260930",
          effective_as_of_date: klDate(),
        });
      });
    });

    describe("T-R02-8 / T-R02-9 — report-validate-output", () => {
      const fixture = (name: string) =>
        new Blob([readFileSync(join(FIXTURES, name))]);

      it("the writer's output for each shape passes, with rows = the data-row count", async () => {
        for (const [contract, name] of [
          ["rpt02_headed", "Rpt02_headed_20261029.csv"],
          ["rpt02_headerless", "Rpt02_headerless_20261029.csv"],
        ] as const) {
          const execution = await run(
            "report-validate-output",
            { contract, file: fixture(name) },
            name,
          );
          expect(execution.state.current, name).toBe("SUCCESS");
          expect(execution.outputs).toEqual({ rows: 2 });
        }
      });

      it("a header-only file passes with header: true and rows = 0", async () => {
        const header =
          readFileSync(
            join(FIXTURES, "Rpt02_headed_20261029.csv"),
            "utf8",
          ).split("\n")[0] + "\n";
        const execution = await run(
          "report-validate-output",
          { contract: "rpt02_headed", file: new Blob([header]) },
          "Header_only.csv",
        );
        expect(execution.state.current).toBe("SUCCESS");
        expect(execution.outputs).toEqual({ rows: 0 });
      });

      it("a bad file → FAILED OUTPUT_CONTRACT_VIOLATION naming file, row and column", async () => {
        const lines = readFileSync(
          join(FIXTURES, "Rpt02_headed_20261029.csv"),
          "utf8",
        ).split("\n");
        const badDate = [
          lines[0],
          lines[1]!.replace("20261029", "20261301"),
          lines[2],
          "",
        ].join("\n");
        await expectFailedWith(
          await run(
            "report-validate-output",
            { contract: "rpt02_headed", file: new Blob([badDate]) },
            "Bad_date.csv",
          ),
          "OUTPUT_CONTRACT_VIOLATION Bad_date.csv 2 Invoice Date BAD_DATE",
        );
        await expectFailedWith(
          await run(
            "report-validate-output",
            {
              contract: "rpt02_headed",
              file: new Blob(["﻿" + lines.join("\n")]),
            },
            "Bom.csv",
          ),
          "OUTPUT_CONTRACT_VIOLATION Bom.csv 1 - BOM",
        );
      });

      it("an unknown contract → FAILED CONTRACT_INVALID", async () => {
        await expectFailedWith(
          await run(
            "report-validate-output",
            {
              contract: "rpt02_missing",
              file: fixture("Rpt02_headed_20261029.csv"),
            },
            "x.csv",
          ),
          "CONTRACT_INVALID rpt02_missing unreadable (FileNotFoundError)",
        );
      });
    });

    describe("T-R02-10 — namespace files", () => {
      it("every file in flows/reporting/contracts/ is in namespace reporting at contracts/, byte-identical", async () => {
        for (const name of readdirSync(CONTRACTS_DIR)) {
          const res = await api(
            `/namespaces/reporting/files?path=${encodeURIComponent(`/contracts/${name}`)}`,
          );
          const deployed = Buffer.from(await res.arrayBuffer());
          expect(
            deployed.equals(readFileSync(join(CONTRACTS_DIR, name))),
            name,
          ).toBe(true);
        }
      });
    });
  },
);
