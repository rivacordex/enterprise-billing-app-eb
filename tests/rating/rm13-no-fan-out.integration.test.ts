import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { productOffering } from "@/db/schema/product";
import type { Database } from "@/db/client";
import type { RanLkpRow } from "@/db/seeds/sample/sample-5g-fixture";
import { SAMPLE_5G_COMMERCIAL_UNIT } from "@/db/seeds/sample/sample-5g-fixture";
import { seedSample5gRatingGraph } from "@/tests/helpers/rating-ran-harness";

// rm13-spec §D2/§10.15 — Test #15, the ONE guardrail test rm13 itself owns
// (every other guardrail test ships with its owning unit, code-standards
// §10). "Settle the mechanism: after an end-to-end run of a large fixture,
// query the Kestra execution's task-run count and assert it is bounded by
// chunk count — fixed_flow_tasks + ceil(records / chunk_size) — not one task
// per record." A design guard (Inv #10), not a release blocker (D2's own
// words) — it proves the pipeline never fans out per record, not that a
// specific throughput number is met.
//
// MECHANISM: the Kestra REST API's execution detail endpoint
// (`GET /api/v1/executions/{id}`), whose `taskRunList` has one entry per task
// run — Kestra's documented public surface, not its internal tables.
//
// This is the one guardrail test that cannot be proven by shelling out to
// `python3 -m runtime.*` (every rm07–rm12 suite black-box-tests the
// processors that way): what is measured is Kestra's OWN task-run bookkeeping,
// which only exists when Kestra orchestrates the run via the landing/ trigger.
//
// REWRITTEN 2026-10-19 for the rm21 PER_UNIT feed (the old version dropped a
// 50,000-row 5-column CSV for a dummy key, which the `.udr` trigger never
// fires on, and which rm21's whole-batch UNKNOWN_SUBSCRIBER refusal would fail
// anyway). A successful run now needs a real, rateable graph, so the live
// block:
//   * seeds (idempotently, into the database the deployed engine uses —
//     RATING_FANOUT_DATABASE_URL, an admin URL) its own `_SAMPLE_-RM13`
//     customer, MNO, product and a 25,000-cell ratecard (one live row per cell
//     per billing month, so 25,000 records need 25,000 cells). 25,000 records
//     span three chunks at the default chunk size of 10,000, so the run
//     exercises the in-process chunking past the first chunk. The names carry
//     "-25K": the earlier 10,000-cell fixture stays in that database, and the
//     seed must not mistake it for this one;
//   * REQUIRES the deployed flow's `subscription_product_name` to be that
//     product (and coverage HARD_STOP or WARN): the flow rates one pinned
//     product, and HARD_STOP needs every cell of that product's whole card in
//     the file. The operator repoints the deployed flow for the run and
//     restores it after; the test checks the pin and fails fast otherwise;
//   * drops `rating-input-file-202606150000_v<N>.udr` (June 2026, a past month)
//     by writing a non-matching temp name in landing/ and renaming it, so the
//     trigger never sees a half-written file. Each run uses a new `_vN` and new
//     bytes, so it is never a duplicate and supersedes the previous run's rows.
// The rated rows stay in that database under the `_SAMPLE_-RM13` customer
// (owner decision, 2026-10-19). Skipped loudly unless every env var is set.
const KESTRA_URL = process.env.KESTRA_URL;
const KESTRA_USER = process.env.KESTRA_BASIC_AUTH_USER;
const KESTRA_PASSWORD = process.env.KESTRA_BASIC_AUTH_PASSWORD;
// The HOST-side path bind-mounted to the engine container's landing/ volume
// (rm04 D9's dev compose): a file written here is the file the container's
// fs.local.Trigger sees.
const LANDING_HOST_DIR = process.env.RATING_LANDING_HOST_DIR;
// Admin URL of the database the deployed engine rates into (for the fixture).
const FANOUT_DATABASE_URL = process.env.RATING_FANOUT_DATABASE_URL;
const CHUNK_SIZE = Number(process.env.RATING_RAN_USAGE_CHUNK_SIZE ?? 10_000);
const RECORD_COUNT = 25_000;
const NAMESPACE = "rating";
const FLOW_ID = "rating-engine-ran-usage";

const FIXTURE = {
  tag: "rm13-fanout-25k",
  mno: "_SAMPLE_-RM13-25K-MNO",
  productName: "_SAMPLE_-RM13 Fan-out Product 25K",
  priceName: "_SAMPLE_-RM13 Fan-out Usage 25K",
  cardName: "_SAMPLE_-RM13-FANOUT-CARD-25K",
} as const;
const FILE_KEY = "rating-input-file-202606150000";
const USAGE_AT = "2026-06-15T10:00:00"; // KL wall time (the feed's assumed zone)
const UDR_HEADER =
  "mno_public_id,commercial_unit,polygon_id,datetime_YYYYMMDDHHMI,usage_volume,district_name,service_code";

const liveEngineReady = Boolean(
  KESTRA_URL &&
  KESTRA_USER &&
  KESTRA_PASSWORD &&
  LANDING_HOST_DIR &&
  FANOUT_DATABASE_URL,
);

function flowYaml(): string {
  return readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "flows",
      "rating-engine",
      "rating-engine-ran-usage.yaml",
    ),
    "utf8",
  );
}

// The flow's own fixed task count for a SUCCESSFUL run — the `tasks:` list
// (prp/rp/rl) plus `finally:` (always runs). `errors:` is deliberately
// excluded: it fires only on failure (code-standards §3.9), and the golden
// path this test exercises never fails. Counted by text slicing (matching
// this suite's existing static-check convention, e.g. rm07/rm10's flow-YAML
// assertions) rather than a real YAML parse.
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

// The fixture's 25,000 ratecard cells — one per record.
function fanoutCells(): RanLkpRow[] {
  return Array.from({ length: RECORD_COUNT }, (_, i) => ({
    polygonId: `RM13-P${String(i + 1).padStart(5, "0")}`,
    district: "DIST-RM13",
    serviceCode: "SVL-RM13",
  }));
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

  it("the bound formula stays far below record count for the fixture", () => {
    const fixed = fixedFlowTaskCount();
    const bound = fixed + Math.ceil(RECORD_COUNT / CHUNK_SIZE);
    // Chunking happens INSIDE the Python process (Inv #10, code-standards
    // §3.2), so the real task-run count for any file size is just `fixed`;
    // the bound is generous but must never approach per-record.
    expect(bound).toBeLessThan(RECORD_COUNT / 10);
  });

  it("the fixture spans more than one chunk", () => {
    // One chunk would never exercise the chunking past the first, so a
    // regression there (or a task per chunk) could not show in the count.
    expect(Math.ceil(RECORD_COUNT / CHUNK_SIZE)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------
// Live engine — an end-to-end run of the 25,000-record fixture through a REAL
// Kestra execution, asserting its task-run count via the REST API.
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

    async function kestraGet<T>(path: string): Promise<T> {
      const res = await fetch(`${KESTRA_URL}/api/v1/main${path}`, {
        headers: { Authorization: authHeader() },
      });
      if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
      return (await res.json()) as T;
    }

    // The deployed flow must be pinned to the fixture product (the operator
    // repoints it for this run): fail fast rather than drop a file that the
    // real pinned product would refuse.
    async function assertDeployedPin(): Promise<void> {
      const flow = await kestraGet<{ variables?: Record<string, string> }>(
        `/flows/${NAMESPACE}/${FLOW_ID}`,
      );
      expect(
        flow.variables?.subscription_product_name,
        "repoint the deployed flow's subscription_product_name to the fixture product before this run",
      ).toBe(FIXTURE.productName);
    }

    // Idempotent: the graph is seeded once and reused by later runs. The check
    // and the seed share one transaction, so a failed seed leaves no partial
    // graph (which the check would otherwise take as "already seeded").
    async function seedFixtureOnce(): Promise<void> {
      const client = postgres(FANOUT_DATABASE_URL as string, { max: 1 });
      try {
        const db = drizzle(client, { schema });
        await db.transaction(async (tx) => {
          const existing = await tx
            .select({ id: productOffering.productOfferingId })
            .from(productOffering)
            .where(eq(productOffering.name, FIXTURE.productName));
          if (existing.length > 0) return;
          await seedSample5gRatingGraph(tx as unknown as Database, {
            ...FIXTURE,
            cells: fanoutCells(),
          });
        });
      } finally {
        await client.end();
      }
    }

    // Writes the fixture file under a temp name the trigger ignores, then
    // renames it into place (one step — never a half-written file). The run
    // number makes the name (`_vN`) new, and the first record's volume IS the
    // run number, so two runs never share a checksum (prp discards a
    // byte-identical file of the same file_key as DUPLICATE_BATCH). The other
    // records keep the 1–9 volume pattern.
    function dropFixtureFile(run: number): string {
      const name = `${FILE_KEY}_v${run}.udr`;
      const rows = fanoutCells().map((cell, i) =>
        [
          FIXTURE.mno,
          SAMPLE_5G_COMMERCIAL_UNIT,
          cell.polygonId,
          USAGE_AT,
          i === 0 ? String(run) : String(((i + run) % 9) + 1),
          cell.district ?? "",
          cell.serviceCode ?? "",
        ].join(","),
      );
      const temp = join(LANDING_HOST_DIR as string, `${name}.part`);
      writeFileSync(temp, [UDR_HEADER, ...rows].join("\n") + "\n", "utf8");
      renameSync(temp, join(LANDING_HOST_DIR as string, name));
      return name;
    }

    async function findLatestExecution(after: number): Promise<string> {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const body = await kestraGet<{
          results?: { id: string; state: { startDate: string } }[];
        }>(
          `/executions/search?namespace=${NAMESPACE}&flowId=${FLOW_ID}&sort=state.startDate:desc&size=1`,
        ).catch(() => ({ results: [] }));
        const exec = body.results?.[0];
        if (exec && new Date(exec.state.startDate).getTime() >= after) {
          return exec.id;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error(
        "no execution of rating.rating-engine-ran-usage appeared within 180s of the fixture landing",
      );
    }

    async function waitForTerminal(
      executionId: string,
    ): Promise<{ taskRunList?: { id: string }[] }> {
      const deadline = Date.now() + 300_000;
      const terminal = new Set(["SUCCESS", "FAILED", "WARNING", "KILLED"]);
      for (;;) {
        const body = await kestraGet<{
          state: { current: string };
          taskRunList?: { id: string }[];
        }>(`/executions/${executionId}`);
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

    it("a 25,000-record file's execution task-run count is bounded by chunk count, not record count", async () => {
      await assertDeployedPin();
      await seedFixtureOnce();

      // Minute-resolution run number: unique per run, so the trigger sees a
      // new file and prp a new checksum.
      const run = Math.floor(Date.now() / 60_000);
      const before = Date.now();
      dropFixtureFile(run);

      const executionId = await findLatestExecution(before);
      const execution = await waitForTerminal(executionId);
      const taskRunCount = execution.taskRunList?.length ?? 0;

      const bound = fixedFlowTaskCount() + Math.ceil(RECORD_COUNT / CHUNK_SIZE);
      expect(taskRunCount).toBeGreaterThan(0);
      expect(taskRunCount).toBeLessThanOrEqual(bound);
      // Not ~25,000 — a wide margin, since the real count is single digits
      // (Inv #10: chunking is in-process).
      expect(taskRunCount).toBeLessThan(RECORD_COUNT / 100);
    }, 600_000);
  },
);
