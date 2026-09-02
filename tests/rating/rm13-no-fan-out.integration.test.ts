import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// rm13-spec §D2/§10.15 — Test #15, the ONE guardrail test rm13 itself owns
// (every other guardrail test ships with its owning unit, code-standards
// §10). "Settle the mechanism: after an end-to-end run of the 50,000-record
// fixture, query the Kestra execution's task-run count and assert it is
// bounded by chunk count — fixed_flow_tasks + ceil(records / chunk_size) —
// not ~50,000." A design guard (Inv #10), not a release blocker (D2's own
// words) — it proves the pipeline never tempts toward per-record Kestra
// tasks, not that a specific throughput number is met.
//
// MECHANISM SETTLED HERE (D2 explicitly leaves this open for rm13 to
// decide): the Kestra REST API's execution detail endpoint
// (`GET /api/v1/executions/{id}`), which returns a `taskRunList` array — one
// entry per task run — is used rather than querying Kestra's own internal
// Postgres tables directly. The REST API is Kestra's documented, stable
// public surface; the internal Flyway-managed table/column names are an
// implementation detail this codebase has repeatedly flagged as
// UNCONFIRMED-against-v1.3.35 for every other Kestra integration point
// (kestra.yml's property names, the kestra CLI's flags, the trigger plugin
// id) — reusing that same guessing game here when a documented API exists
// would be needless risk for a test whose only job is counting task runs.
//
// This is the one guardrail test in the whole suite that cannot be proven
// by shelling out to `python3 -m runtime.*` directly (every rm07-rm12 suite
// black-box-tests the processors that way) — the very thing being measured
// is Kestra's OWN task-run bookkeeping for a real flow EXECUTION, which only
// exists when Kestra itself orchestrates the run via the landing/ file
// trigger. It therefore needs a real, reachable, flows-deployed Kestra
// engine (rm04's local dev stack, or a real deployment) — something no
// session so far has had (rm04 D0's process-runner spike is still open, and
// no session has ever triggered a live flow execution; see
// ratemgmt-progress-tracker.md). Skipped loudly, like every other
// live-infra gate in this suite, rather than silently passing.
const KESTRA_URL = process.env.KESTRA_URL;
const KESTRA_USER = process.env.KESTRA_BASIC_AUTH_USER;
const KESTRA_PASSWORD = process.env.KESTRA_BASIC_AUTH_PASSWORD;
// The HOST-side path bind-mounted to the engine container's landing/ volume
// (rm04 D9's dev compose) — a file written here from this test process must
// be the SAME file the running container's fs.local.Trigger sees. Distinct
// from RATING_LANDING_DIR (used by every rm07-rm12 suite to invoke
// `runtime.prp` directly, in-process, no container/mount involved).
const LANDING_HOST_DIR = process.env.RATING_LANDING_HOST_DIR;
const CHUNK_SIZE = Number(process.env.RATING_RAN_USAGE_CHUNK_SIZE ?? 10_000);
const RECORD_COUNT = 50_000;
const NAMESPACE = "rating";
const FLOW_ID = "ran-usage-rating";

const liveEngineReady = Boolean(
  KESTRA_URL && KESTRA_USER && KESTRA_PASSWORD && LANDING_HOST_DIR,
);

function flowYaml(): string {
  return readFileSync(
    join(process.cwd(), "rating-engine", "flows", "ran-usage-rating.yaml"),
    "utf8",
  );
}

// The flow's own fixed task count for a SUCCESSFUL run — the `tasks:` list
// (prp/rp/rl) plus `finally:` (always runs). `errors:` is deliberately
// excluded: it fires only on failure (code-standards §3.9), and the golden
// path this test exercises never fails. Counted by text slicing (matching
// this suite's existing static-check convention, e.g. rm07/rm10's flow-YAML
// assertions) rather than a real YAML parse — a YAML library is not an
// existing dependency of this repo and rm13-spec's own "Dependencies"
// section states none are added for this unit.
const TOP_LEVEL_TASK_ID = /^ {2}- id: \S+/gm;
function fixedFlowTaskCount(): number {
  const template = flowYaml();
  const tasksBlock = template.slice(
    template.indexOf("\ntasks:"),
    template.indexOf("\nerrors:"),
  );
  const finallyBlock = template.slice(template.indexOf("\nfinally:"));
  const count = (block: string) =>
    (block.match(TOP_LEVEL_TASK_ID) ?? []).length;
  return count(tasksBlock) + count(finallyBlock);
}

// ---------------------------------------------------------------------
// Static — no live engine needed. Computes the bound's fixed term from the
// real flow file, and sanity-checks the formula never degenerates to
// "roughly one task per record" for a realistic chunk size.
// ---------------------------------------------------------------------
describe("no-per-record-fan-out bound (rm13-spec D2 — static)", () => {
  it("the flow's fixed task count is small and independent of record count", () => {
    const fixed = fixedFlowTaskCount();
    // Three pipeline sections + one finally handler, generously bounded —
    // if this ever creeps toward hundreds, someone added per-something
    // tasks to the flow itself, which Inv #10 forbids at the flow level too.
    expect(fixed).toBeGreaterThan(0);
    expect(fixed).toBeLessThan(20);
  });

  it("the bound formula stays far below record count for the 50,000-record fixture", () => {
    const fixed = fixedFlowTaskCount();
    const bound = fixed + Math.ceil(RECORD_COUNT / CHUNK_SIZE);
    // The whole point of Inv #10 (code-standards §3.2): chunking happens
    // INSIDE the Python process, never as separate Kestra tasks, so the
    // real task-run count for any file size is just `fixed` — this bound is
    // deliberately generous (it would still pass a hypothetical per-chunk
    // Kestra fan-out) but must never approach per-record.
    expect(bound).toBeLessThan(RECORD_COUNT / 10);
  });
});

// ---------------------------------------------------------------------
// Live engine — an end-to-end run of the 50,000-record fixture through a
// REAL Kestra execution, asserting its task-run count via the REST API.
// ---------------------------------------------------------------------
describe.skipIf(!liveEngineReady)(
  "no-per-record-fan-out (rm13-spec D2/Implementation §2, requires a live deployed Kestra engine)",
  () => {
    function assertSecureKestraUrl(url: string): void {
      const { protocol, hostname } = new URL(url);
      const isLoopback = hostname === "localhost" || hostname === "127.0.0.1";
      if (protocol !== "https:" && !isLoopback) {
        throw new Error(
          `Refusing to send Basic Auth credentials to "${url}" over a non-HTTPS, ` +
            "non-loopback connection — set KESTRA_URL to an https:// origin " +
            "(or localhost/127.0.0.1 for local dev) to avoid leaking credentials on the wire.",
        );
      }
    }

    function authHeader(): string {
      assertSecureKestraUrl(KESTRA_URL as string);
      return (
        "Basic " +
        Buffer.from(`${KESTRA_USER}:${KESTRA_PASSWORD}`).toString("base64")
      );
    }

    async function findLatestExecution(after: number): Promise<string> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const res = await fetch(
          `${KESTRA_URL}/api/v1/executions/search?namespace=${NAMESPACE}&flowId=${FLOW_ID}&sort=state.startDate:desc&size=1`,
          { headers: { Authorization: authHeader() } },
        );
        if (res.ok) {
          const body = (await res.json()) as {
            results?: { id: string; state: { startDate: string } }[];
          };
          const exec = body.results?.[0];
          if (exec && new Date(exec.state.startDate).getTime() >= after) {
            return exec.id;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(
        "no execution of rating.ran-usage-rating appeared within 60s of the fixture landing",
      );
    }

    async function waitForTerminal(
      executionId: string,
    ): Promise<{ taskRunList?: { id: string }[] }> {
      const deadline = Date.now() + 300_000;
      const terminal = new Set(["SUCCESS", "FAILED", "WARNING", "KILLED"]);
      for (;;) {
        const res = await fetch(
          `${KESTRA_URL}/api/v1/executions/${executionId}`,
          { headers: { Authorization: authHeader() } },
        );
        const body = (await res.json()) as {
          state: { current: string };
          taskRunList?: { id: string }[];
        };
        if (terminal.has(body.state.current)) {
          if (body.state.current !== "SUCCESS") {
            throw new Error(
              `execution ${executionId} ended in ${body.state.current}, not SUCCESS — task-run count is not meaningful for a non-successful run`,
            );
          }
          return body;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `execution ${executionId} did not reach a terminal state within 5 minutes (last state: ${body.state.current})`,
          );
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    it("a 50,000-record file's execution task-run count is bounded by chunk count, not record count", async () => {
      // A dummy PUBLIC_KEY that resolves no product_inventory row — every
      // record becomes LOOKUP_MISS (rm08 D3), which is irrelevant here:
      // Kestra's task-run count is driven by the FLOW's task graph, never
      // by how many records get priced, so no product/order/inventory
      // fixture is needed for this test's actual assertion.
      const rows = Array.from(
        { length: RECORD_COUNT },
        (_, i) => `2026-05-04T00:00:00Z,NO-SUCH-KEY,CU,SITE,${(i % 9) + 0.5}`,
      );
      const before = Date.now();
      const dir = mkdtempSync(join(tmpdir(), "rm13-fanout-"));
      const path = join(dir, "RAN_USAGE_20260504.csv");
      writeFileSync(
        path,
        ["DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS", ...rows].join(
          "\n",
        ) + "\n",
        "utf8",
      );
      mkdirSync(LANDING_HOST_DIR as string, { recursive: true });
      writeFileSync(
        join(LANDING_HOST_DIR as string, "RAN_USAGE_20260504.csv"),
        readFileSync(path),
      );

      const executionId = await findLatestExecution(before);
      const execution = await waitForTerminal(executionId);
      const taskRunCount = execution.taskRunList?.length ?? 0;

      const bound = fixedFlowTaskCount() + Math.ceil(RECORD_COUNT / CHUNK_SIZE);
      expect(taskRunCount).toBeGreaterThan(0);
      expect(taskRunCount).toBeLessThanOrEqual(bound);
      // Not ~50,000 (D2's literal wording) — a wide margin, since the real
      // count should be single digits (Inv #10: chunking is in-process).
      expect(taskRunCount).toBeLessThan(RECORD_COUNT / 100);
    }, 360_000);
  },
);
