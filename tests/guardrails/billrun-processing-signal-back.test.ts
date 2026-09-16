import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm36-spec §Implementation §1-3 + bm39-spec §1 (guardrail audit) /
// billmgmt-code-standards.md §9 item 34 — the processor signal-back guardrail.
//
// bm36 made the signal-back REAL: `bill_run_processing.yml` POSTs a per-stage
// `DONE` after each of the five contract stages, a per-account HARD `FAILED`
// from the account stage group's `errors` handler, and a run-level terminal
// `PROCESSING_FAILED` for a whole-execution failure (`errors: on_error` on a
// FAILED execution, `afterExecution: on_killed` on a KILL) — all real
// `io.kestra.plugin.core.http.Request` callbacks, replacing the former
// `io.kestra.plugin.core.log.Log` stubs. Without this the run wedges in
// `PROCESSING` (bm39-spec §Framing: the module cannot complete on its own).
//
// bm39 codified item 34 into §9's CI-gate guardrail list; this static, DB-free
// test IS that gate (the sibling of `billing-customer-bill-line-replace-
// boundary.test.ts`, which reads the same flow, and of `billrun-processing-
// force-fail-single-reader.test.ts` for item 35). It locks the signal surface
// so a future edit that reverts a callback to a `Log` stub — silently breaking
// self-driven completion, with no other test failing — fails CI here instead.
describe("bm36 processor signal-back is real (code-standards §9 item 34)", () => {
  const FLOW_YML = resolve(
    process.cwd(),
    "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
  );

  // Strip `#`-prefixed YAML comment lines AND in-line `--` SQL comments (the
  // stage SQL lives in heredocs whose comments use `--`), so the flow's own
  // documentation prose — which freely names `http.Request`, `Log`, `/status`
  // and `PROCESSING_FAILED` while describing the contract — never trips a grep.
  // Symmetric with the replace-boundary test's `executable` derivation.
  const executable = readFileSync(FLOW_YML, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  const count = (re: RegExp): number => (executable.match(re) || []).length;

  const STAGES = [
    "validation",
    "collection",
    "aggregation",
    "taxation",
    "verification",
  ] as const;

  it("[CRITICAL] POSTs a per-stage stage-complete DONE for all five contract stages", () => {
    for (const stage of STAGES) {
      // Each stage's completion is a real http.Request to its own route whose
      // body carries `"status": "DONE"` — asserted TOGETHER, bounded to the
      // same task (the match may not cross a sibling `- id:`), so a stage
      // cannot pass with its route present but a missing or FAILED body. A
      // stage reverted to a `Log` stub loses the URI (Log has no `uri:`); a
      // body corrupted to FAILED/removed loses the paired DONE inside the task.
      // (For `verification` the DONE task precedes the per-account FAILED
      // handler that reuses the same route, so the first match is the DONE.)
      expect(
        executable,
        `stage "${stage}" is missing a DONE stage-complete callback (route present without a "status": "DONE" body in the same task)`,
      ).toMatch(
        new RegExp(
          `/api/billrun/[^"']*/stage/${stage}/complete"(?:(?!- id:)[\\s\\S])*?"status":\\s*"DONE"`,
        ),
      );
    }
  });

  it("[CRITICAL] POSTs a per-account HARD FAILED from the account errors handler to the fixed verification stage", () => {
    // The account_pipeline `errors` handler settles a contained per-account
    // HARD failure via a FAILED stage-complete POST to the FIXED `verification`
    // stage (bm36 §Implementation §2 — always a valid `Stage` enum, never
    // collides with a DONE latch). error_class=HARD is the shape the receiver
    // accepts to mark the account PROCESSING_FAILED.
    expect(executable).toMatch(/"status":\s*"FAILED"/);
    expect(executable).toMatch(/"error_class":\s*"HARD"/);
    expect(executable).toMatch(/uri:\s*"[^"]*\/stage\/verification\/complete"/);
  });

  it("[CRITICAL] POSTs a run-level terminal PROCESSING_FAILED on a FAILED execution and on a KILL", () => {
    // Two terminal /status pushes: `errors: on_error` (FAILED execution) and
    // `afterExecution: on_killed` (runIf execution.state == 'KILLED'). A
    // WARNING run (contained per-account failure) is deliberately NOT pushed —
    // it derives PROCESSED per the tested module contract (bm36 §Implementation
    // §3) — so the kill guard must be `== 'KILLED'`, never `!= 'SUCCESS'`.
    expect(executable).toMatch(/\/api\/billrun\/[^"']*\/status/);
    expect(count(/"status":\s*"PROCESSING_FAILED"/g)).toBe(2);
    expect(executable).toMatch(/execution\.state\s*==\s*'KILLED'/);
    expect(executable).not.toMatch(/execution\.state\s*!=\s*'SUCCESS'/);
  });

  it("[CRITICAL] every signal is a real http.Request — no signal Log stub remains", () => {
    // Eight real callbacks: 5 per-stage DONE + 1 per-account FAILED + on_error
    // + on_killed. The ONLY two `Log` tasks left are non-signals — `start` (a
    // run-start log line) and the `taxation` no-op stage (its DONE is still a
    // real http.Request). Locking both counts encodes the audit claim ("0
    // remaining Log-stub signal tasks"): reverting any callback to a `Log`
    // shifts these numbers and fails here. A future unit that legitimately
    // adds/removes a callback or Log updates these two counts consciously.
    expect(count(/io\.kestra\.plugin\.core\.http\.Request/g)).toBe(8);
    expect(count(/io\.kestra\.plugin\.core\.log\.Log/g)).toBe(2);
  });
});
