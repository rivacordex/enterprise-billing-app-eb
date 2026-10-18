import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The prp → rp → rl manifest hand-off (DB-free).
//
// storage.hand_off prints a Kestra output line `::{"outputs":{"uri":...}}::`,
// which Kestra exposes ONLY as `outputs.<task>.vars.uri`. A bare print (or a
// flow reading `outputs.<task>.uri`) failed the first live run (2026-10-18)
// with "Unable to find `uri`". The integration harness reads the plain last
// stdout line instead, so nothing else pins this contract.

const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const STORAGE = read(
  "workflow-management/worker/workflow-engine/runtime/storage.py",
);
const FLOW = read(
  "workflow-management/flows/rating-engine/rating-engine-ran-usage.yaml",
);

describe("rating flow manifest hand-off", () => {
  it("hand_off prints the Kestra outputs line with the `uri` key, then the plain URI", () => {
    const body =
      /def hand_off\(uri: str\) -> None:[\s\S]*?(?=\n\S|\n\ndef )/.exec(
        STORAGE,
      )?.[0];
    expect(body).toBeDefined();
    expect(body).toContain(
      'print("::" + json.dumps({"outputs": {"uri": uri}}) + "::")',
    );
    // The plain line stays last (the harness reads the last stdout line).
    expect(body!.trimEnd().endsWith("print(uri)")).toBe(true);
  });

  it("the flow reads each hand-off as outputs.<task>.vars.uri", () => {
    const refs = [...FLOW.matchAll(/outputs\.(\w+)\.([\w.]+)/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(refs).toEqual(
      expect.arrayContaining(["prp.vars.uri", "rp.vars.uri"]),
    );
    for (const ref of refs) expect(ref).toMatch(/^\w+\.vars\.uri$/);
  });
});
