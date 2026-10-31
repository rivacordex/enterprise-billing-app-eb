import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  expectFlowRevisionTrace,
  expectRuntimeTasks,
  expectValidateDate,
  expectValidateOutput,
  type FlowTask,
  GENERATED_FILE,
  loadReportFlow,
  loadReportingContract,
} from "@/tests/helpers/reporting-flow-shape";
import {
  parseKestraLines,
  REPORTING_CONTRACTS_DIR,
  REPORTING_WORKER_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt04-spec Tests, database-free: R04-T5 (no overwrite — guardrail 8), R04-T6
// (interrupted write), the static halves of R04-T7 (deployed disabled) and
// R04-T8 (share isolation: its own share, storage definition and mount), and
// the pieces the live suites rely on — the contract (D8), the builder's
// rounding, skips and sort (D4–D6, P-T13), the capacity source (D5) and the
// flow's shape (D8). The live-database cases are
// rpt04-polygon-capacity.integration.test.ts; the Kestra cases are
// rpt04-polygon-capacity-flow.live.test.ts.

const ROOT = process.cwd();
const FLOWS = join(ROOT, "workflow-management", "flows", "reporting");
const FLOW = join(FLOWS, "report-polygon-capacity-lookup.yaml");
const RUNTIME = join(REPORTING_WORKER_DIR, "runtime", "reporting");
const read = (path: string) => readFileSync(path, "utf8");

const ready = reportingRuntimeReady();

// Runs `delivery.deliver()` against a temporary root standing in for
// /data/outbound (its mount check stubbed), with an optional injected failure.
// The root is also the working directory, where `src` must be.
function deliverInto(
  root: string,
  src: string,
  name: string,
  inject = "",
): ReturnType<typeof runReportingPython> {
  return runReportingPython(
    [
      "-c",
      `import json, sys
from pathlib import Path
from runtime.reporting.common import delivery
delivery.OUTBOUND_ROOT = Path(sys.argv[1])
delivery._mounted = lambda path: True
${inject}
try:
    delivery.deliver(Path(sys.argv[2]), Path(sys.argv[1]) / "polygon-capacity", sys.argv[3])
    print(json.dumps({"ok": True}))
except delivery.DeliveryFailed as exc:
    print(json.dumps({"failed": exc.reason}))`,
      root,
      src,
      name,
    ],
    { cwd: root },
  );
}

function outboundFixture(): { root: string; outbound: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), "rpt04-delivery-"));
  const outbound = join(root, "polygon-capacity");
  mkdirSync(outbound);
  const src = join(root, "generated.csv");
  writeFileSync(src, "MNO1,AAA,PAAA_01,20261026,20260101,MNO1_D,SVC,1000\n");
  return { root, outbound, src };
}

describe.skipIf(!ready)(
  "common/delivery.py — safe write, never overwrite (D7)",
  () => {
    const NAME = "Polygon_capacity_lookup_20261026.csv";

    it("delivers the bytes under the name, leaving no .tmp", () => {
      const { root, outbound, src } = outboundFixture();
      const run = deliverInto(root, src, NAME);
      expect(JSON.parse(run.stdout), run.stderr).toEqual({ ok: true });
      expect(readdirSync(outbound)).toEqual([NAME]);
      expect(read(join(outbound, NAME))).toBe(read(src));
    });

    it("R04-T5 [guardrail 8] — a second delivery of the same name fails FILE_ALREADY_EXISTS; the first file is byte-identical; no .tmp", () => {
      const { root, outbound, src } = outboundFixture();
      expect(JSON.parse(deliverInto(root, src, NAME).stdout)).toEqual({
        ok: true,
      });
      const first = readFileSync(join(outbound, NAME));
      writeFileSync(src, "different bytes\n");
      const again = deliverInto(root, src, NAME);
      expect(JSON.parse(again.stdout)).toEqual({
        failed: `FILE_ALREADY_EXISTS ${NAME}`,
      });
      expect(readFileSync(join(outbound, NAME)).equals(first)).toBe(true);
      expect(readdirSync(outbound)).toEqual([NAME]);
    });

    it("a file that appears between the existence check and the rename is never replaced (FILE_ALREADY_EXISTS, no .tmp)", () => {
      const { root, outbound, src } = outboundFixture();
      // Another run delivers the same name just before this one renames.
      const run = deliverInto(
        root,
        src,
        NAME,
        `_real = delivery._rename_noreplace
def _racing(tmp, target):
    target.write_bytes(b"theirs\\n")
    _real(tmp, target)
delivery._rename_noreplace = _racing`,
      );
      expect(JSON.parse(run.stdout), run.stderr).toEqual({
        failed: `FILE_ALREADY_EXISTS ${NAME}`,
      });
      expect(read(join(outbound, NAME))).toBe("theirs\n");
      expect(readdirSync(outbound)).toEqual([NAME]);
    });

    it("R04-T6 — a failure injected between copy and rename leaves no target file and no temp", () => {
      const { root, outbound, src } = outboundFixture();
      const run = deliverInto(
        root,
        src,
        NAME,
        `def _boom(tmp, target):
    assert tmp.exists() and not target.exists()  # copied, not yet renamed
    raise OSError(5, "injected")
delivery._rename_noreplace = _boom`,
      );
      expect(JSON.parse(run.stdout), run.stderr).toEqual({
        failed: "DELIVERY_FAILED OSError",
      });
      expect(readdirSync(outbound)).toEqual([]);
    });

    it("refuses a folder that isn't one destination directly under the root, a missing folder, and a name that isn't a plain file name", () => {
      const { root, src } = outboundFixture();
      const outside = runReportingPython(
        [
          "-c",
          `import json, sys
from pathlib import Path
from runtime.reporting.common import delivery
delivery.OUTBOUND_ROOT = Path(sys.argv[1])
delivery._mounted = lambda path: True
out = []
for folder, name in [(".", "f.csv"), ("polygon-capacity/nested", "f.csv"), ("..", "f.csv"),
                     ("missing", "f.csv"), ("polygon-capacity", "../f.csv"),
                     ("polygon-capacity", ".f.csv")]:
    try:
        delivery.deliver(Path(sys.argv[2]), Path(sys.argv[1]) / folder, name)
        out.append("DELIVERED")
    except delivery.DeliveryFailed as exc:
        out.append(exc.reason.split(" ")[0])
print(json.dumps(out))`,
          root,
          src,
        ],
        { cwd: root },
      );
      expect(JSON.parse(outside.stdout), outside.stderr).toEqual([
        "OUTBOUND_DIR_INVALID",
        "OUTBOUND_DIR_INVALID",
        "OUTBOUND_DIR_INVALID",
        "OUTBOUND_DIR_NOT_MOUNTED",
        "DELIVERY_FAILED",
        "DELIVERY_FAILED",
      ]);
    });

    it("refuses a source file outside the working directory, touching nothing", () => {
      const { root, outbound } = outboundFixture();
      const elsewhere = mkdtempSync(join(tmpdir(), "rpt04-elsewhere-"));
      const src = join(elsewhere, "generated.csv");
      writeFileSync(src, "x\n");
      for (const given of [
        src,
        join("..", basename(elsewhere), "generated.csv"),
      ]) {
        const run = deliverInto(root, given, NAME);
        expect(JSON.parse(run.stdout), run.stderr).toEqual({
          failed: "DELIVERY_FAILED ValueError",
        });
      }
      expect(readdirSync(outbound)).toEqual([]);
    });

    it("the CLI the deliver task runs logs the reason as one ERROR line and exits non-zero", () => {
      const run = runReportingPython([
        "-m",
        "runtime.reporting.common.delivery",
        "--outbound-dir=/data/outbound/../etc",
        join(tmpdir(), "x.csv"),
      ]);
      expect(run.status).not.toBe(0);
      const logs = parseKestraLines(run.stdout).logs;
      expect(logs).toHaveLength(1);
      expect(logs[0]!.level).toBe("ERROR");
      // The path as given (separators are the host's when run off Linux).
      expect(logs[0]!.message).toMatch(
        /^OUTBOUND_DIR_INVALID [\\/]data[\\/]outbound[\\/]\.\.[\\/]etc$/,
      );
    });

    it("is the one delivery implementation: the platform check calls deliver() and has no rename of its own", () => {
      const check = read(join(RUNTIME, "platform_check", "__main__.py"));
      expect(check).toContain("delivery.deliver(");
      expect(check).not.toMatch(/renameat2|os\.link\(|\.open\("xb"\)/);
      for (const dir of readdirSync(RUNTIME)) {
        if (dir === "common" || dir.startsWith("__")) continue;
        for (const file of readdirSync(join(RUNTIME, dir)).filter((f) =>
          f.endsWith(".py"),
        ))
          expect(read(join(RUNTIME, dir, file)), `${dir}/${file}`).not.toMatch(
            /renameat2|os\.link\(/,
          );
      }
    });
  },
);

describe.skipIf(!ready)("the polygon_capacity contract (§B.1, D8)", () => {
  it("loads: header false, the eight §B.1 columns in order, text/text/text/date/date/text/text/integer, all required", () => {
    expect(loadReportingContract("polygon_capacity")).toEqual({
      file: "Polygon_capacity_lookup_<report_date>.csv",
      header: false,
      columns: [
        ["mno_public_key", "text", true],
        ["commercial_unit_public_key", "text", true],
        ["polygon_public_key", "text", true],
        ["report_date", "date", true],
        ["polygon_start_date", "date", true],
        ["resource_identifier_buffer_usage", "text", true],
        ["service_code_buffer_usage", "text", true],
        ["polygon_coverage_capacity_mbps", "integer", true],
      ],
    });
  });

  it("names Mediation and the CSP as its readers", () => {
    expect(
      read(join(REPORTING_CONTRACTS_DIR, "polygon_capacity.yaml")),
    ).toMatch(/^# .*Mediation and the CSP/m);
  });
});

describe.skipIf(!ready)(
  "builder and capacity source, database-free (D4–D6, P-T13)",
  () => {
    it("rounds half-up to whole Mbps (1000.49 → 1000, 1000.50 → 1001, 999.50 → 1000), joins mno_district with one underscore, sorts by code point, and skips with the first reason", () => {
      const run = runReportingPython([
        "-c",
        `import json
from datetime import date
from decimal import Decimal
from runtime.reporting.polygon_capacity.builder import build
from runtime.reporting.polygon_capacity.extract import LookupRow
d = date(2026, 1, 1)
rows = [
    LookupRow("MNO2", "A", "P1", d, "D-1", "S1"),
    LookupRow("MNO1", "A", "P3", d, "D-3", "S3"),
    LookupRow("MNO10", "A", "P1", d, "D-10", "S10"),
    LookupRow("MNO1", "A", "P2", d, "D-2", "S2"),
    LookupRow("MNO1", "A", "P1", d, "D-1", "S1"),
    LookupRow("MNO3", "A", "BOTH", d, "", None),
    LookupRow("MNO3", "A", "NOSVC", d, "D", ""),
    LookupRow("MNO3", "A", "NOCAP", d, "D", "S"),
]
caps = {("MNO1", "A", "P1"): Decimal("1000.49"), ("MNO1", "A", "P2"): Decimal("1000.50"),
        ("MNO1", "A", "P3"): Decimal("999.50"), ("MNO10", "A", "P1"): Decimal("0.4"),
        ("MNO2", "A", "P1"): Decimal("7"), ("MNO3", "A", "BOTH"): Decimal("1"),
        ("MNO3", "A", "NOSVC"): Decimal("1"), ("MNO3", "A", "NOCAP"): None}
out, skipped = build(rows, caps, date(2026, 10, 26))
print(json.dumps({"rows": [",".join(r) for r in out], "skipped": [s.line for s in skipped]}))`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        rows: [
          "MNO1,A,P1,20261026,20260101,MNO1_D-1,S1,1000",
          "MNO1,A,P2,20261026,20260101,MNO1_D-2,S2,1001",
          "MNO1,A,P3,20261026,20260101,MNO1_D-3,S3,1000",
          "MNO10,A,P1,20261026,20260101,MNO10_D-10,S10,0",
          "MNO2,A,P1,20261026,20260101,MNO2_D-1,S1,7",
        ],
        skipped: [
          "SKIPPED MNO3|A|BOTH DISTRICT_MISSING",
          "SKIPPED MNO3|A|NOCAP CAPACITY_MISSING",
          "SKIPPED MNO3|A|NOSVC SERVICE_CODE_MISSING",
        ],
      });
    });

    it("the fixture source reads Decimal capacities (blank = none); a bad header, a bad number or another source name is CAPACITY_SOURCE_UNAVAILABLE", () => {
      const dir = mkdtempSync(join(tmpdir(), "rpt04-capacity-"));
      const header =
        "mno_public_key,commercial_unit_public_key,polygon_id,capacity_mbps\n";
      writeFileSync(
        join(dir, "ok.csv"),
        header + "M,C,P1,1000.50\r\nM,C,P2,\n",
      );
      writeFileSync(
        join(dir, "header.csv"),
        "mno,cu,polygon,capacity\nM,C,P1,1\n",
      );
      writeFileSync(join(dir, "number.csv"), header + "M,C,P1,1e400x\n");
      writeFileSync(join(dir, "float.csv"), header + "M,C,P1,NaN\n");
      const run = runReportingPython(
        [
          "-c",
          `import json, sys
from datetime import date
from pathlib import Path
from runtime.reporting.polygon_capacity import capacity_source as cs
from runtime.reporting.polygon_capacity.extract import LookupRow
d = Path(sys.argv[1])
rows = [LookupRow("M", "C", p, date(2026, 1, 1), "D", "S") for p in ("P1", "P2", "P3")]
got = cs.source_for("fixture", d / "ok.csv").capacity_for(rows, date(2026, 10, 26))
out = {"ok": {"|".join(k): (None if v is None else str(v)) for k, v in got.items()}}
for case, args in {"header": ("fixture", d / "header.csv"), "number": ("fixture", d / "number.csv"),
                   "float": ("fixture", d / "float.csv"), "missing": ("fixture", d / "nope.csv"),
                   "no_file_arg": ("fixture", None), "other": ("mediation", d / "ok.csv")}.items():
    try:
        cs.source_for(*args)
        out[case] = "LOADED"
    except cs.CapacitySourceUnavailable as exc:
        out[case] = exc.name
print(json.dumps(out))`,
          dir,
        ],
        // The fixture must be inside the working directory, as the flow's
        // namespace file is.
        { cwd: dir },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        ok: { "M|C|P1": "1000.50", "M|C|P2": null, "M|C|P3": null },
        header: "fixture",
        number: "fixture",
        float: "fixture",
        missing: "fixture",
        no_file_arg: "fixture",
        other: "mediation",
      });
    });

    it("D5 — the runtime asks the capacity source once per run, with every eligible row", () => {
      const out = mkdtempSync(join(tmpdir(), "rpt04-once-"));
      const run = runReportingPython([
        "-c",
        `import json, sys
from datetime import date
from decimal import Decimal
from runtime.reporting.polygon_capacity import __main__ as m, capacity_source, extract
rows = tuple(extract.LookupRow("M", "C", f"P{i}", date(2026, 1, 1), "D", "S") for i in range(5))
extract.extract = lambda d: extract.Extract(("CARD_X",), "RCV00000001", rows)
calls = []
class Counting:
    def capacity_for(self, eligible, report_date):
        calls.append(len(eligible))
        return {r.key: Decimal("1") for r in eligible}
capacity_source.source_for = lambda name, fixture: Counting()
status = m.main(["--report-date=20261026", "--capacity-source=fixture",
                 f"--out-dir={sys.argv[1]}", f"--contracts-dir={sys.argv[2]}"])
print(json.dumps({"status": status, "calls": calls}))`,
        out,
        REPORTING_CONTRACTS_DIR,
      ]);
      expect(run.status, run.stderr).toBe(0);
      const lines = run.stdout.trim().split(/\r?\n/);
      expect(JSON.parse(lines.at(-1)!)).toEqual({ status: 0, calls: [5] });
    });
  },
);

describe("report-polygon-capacity-lookup — static shape (D8, PC21, PC22, PC25)", () => {
  const shape = loadReportFlow(FLOW);
  const { flow, task, command } = shape;

  it("R04-T7 (static) — deployed disabled: `disabled: true`, no triggers", () => {
    expect(flow.disabled).toBe(true);
    expect(flow.triggers).toBeUndefined();
  });

  it("id, namespace, description, one optional report_date input, the report label, the two settings", () => {
    expect(flow.id).toBe("report-polygon-capacity-lookup");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toBe("Polygon capacity lookup");
    expect(flow.inputs.map((i) => [i.id, i.type, i.required])).toEqual([
      ["report_date", "STRING", false],
    ]);
    expect(flow.labels).toEqual({ report: "polygon_capacity" });
    expect(flow.variables).toMatchObject({
      outbound_dir: "/data/outbound/polygon-capacity/",
      capacity_source: "fixture",
    });
  });

  it("tasks run validate_date → generate → validate_output → deliver → publish → set_status", () => {
    expect(flow.tasks.map((t) => t.id)).toEqual([
      "trace",
      "validate_date",
      "inputs_labels",
      "generate",
      "generate_labels",
      "validate_output",
      "deliver",
      "publish",
      "set_status",
    ]);
    expectValidateDate(task("validate_date"), "report_date");
    expectValidateOutput(task("validate_output"), "polygon_capacity");
    expect((task("set_status").then as FlowTask[])[0]!.state).toBe("WARNING");
  });

  it("labels: flow_revision, report_date (effective), ratecard_card_name, ratecard_version_id, skipped_polygons", () => {
    expectFlowRevisionTrace(task("trace"));
    expect(task("inputs_labels").labels).toEqual({
      report_date: "{{ outputs.validate_date.outputs.effective_date }}",
    });
    expect(task("generate_labels").labels).toEqual({
      ratecard_card_name: "{{ outputs.generate.vars.ratecard_card_name }}",
      ratecard_version_id: "{{ outputs.generate.vars.ratecard_version_id }}",
      skipped_polygons: "{{ outputs.generate.vars.skipped_polygons }}",
    });
  });

  it("generate, deliver and publish run the runtime on the Process runner with values as env vars only", () => {
    expectRuntimeTasks(shape, ["generate", "deliver", "publish"]);
    expect(command("generate")).toContain(
      "python3 -m runtime.reporting.polygon_capacity",
    );
    expect(task("generate").env).toMatchObject({
      CAPACITY_SOURCE: "{{ vars.capacity_source }}",
    });
    expect(command("deliver")).toContain(
      "python3 -m runtime.reporting.common.delivery",
    );
    expect(task("deliver").env).toMatchObject({
      OUTBOUND_DIR: "{{ vars.outbound_dir }}",
    });
  });

  it("the published file is the publish task's; deliver publishes nothing; no flow-level outputs (Inv 5)", () => {
    expect(task("deliver").inputFiles).toEqual(GENERATED_FILE);
    expect(task("deliver").outputFiles).toBeUndefined();
    expect(task("publish").inputFiles).toEqual(GENERATED_FILE);
    expect(task("publish").outputFiles).toEqual([
      "Polygon_capacity_lookup_*.csv",
    ]);
    expect(flow.outputs).toBeUndefined();
  });
});

describe("R04-T8 (static) — the polygon-capacity share is its own share, storage definition and mount", () => {
  const storage = read(
    join(ROOT, "infra/bicep/modules/reporting-outbound-storage.bicep"),
  );
  const engine = read(
    join(ROOT, "infra/bicep/modules/workflow-engine-container-app.bicep"),
  );
  const main = read(join(ROOT, "infra/bicep/main.bicep"));

  it("a separate share on the reporting outbound account, with its own environment storage definition", () => {
    expect(storage).toMatch(
      /resource polygonCapacityShare '[^']+fileServices\/shares@[^']+' = \{\n\s+parent: fileService\n\s+name: 'polygon-capacity'/,
    );
    expect(storage).toMatch(
      /name: '\$\{envStorageName\}-polygon-capacity'[\s\S]*?shareName: polygonCapacityShare\.name/,
    );
    expect(storage).toContain(
      "output polygonCapacityEnvStorageName string = polygonCapacityEnvStorage.name",
    );
    // The audience is recorded in the module header.
    expect(storage).toMatch(
      /polygon-capacity\/\s+polygon-capacity\s+Mediation and the CSP\s+rpt04/,
    );
  });

  it("mounted, on its own volume, at the flow's outbound_dir; both engine call sites pass it", () => {
    const outboundDir = (
      parse(read(FLOW)) as { variables: { outbound_dir: string } }
    ).variables.outbound_dir;
    expect(engine).toMatch(
      new RegExp(
        `volumeName: 'reporting-polygon-capacity'\\n\\s+mountPath: '${outboundDir.replace(/\/$/, "")}'`,
      ),
    );
    expect(engine).toMatch(
      /name: 'reporting-polygon-capacity'\n\s+storageType: 'AzureFile'\n\s+storageName: reportingPolygonCapacityEnvStorageName/,
    );
    expect(
      main.match(
        /reportingPolygonCapacityEnvStorageName: enableReporting \? reportingOutboundStorage!\.outputs\.polygonCapacityEnvStorageName : ''/g,
      ),
    ).toHaveLength(2);
  });

  it("the README's Outbound destinations table names its readers, and the dev stand-in folder is committed", () => {
    expect(read(join(FLOWS, "README.md"))).toMatch(
      /\| `polygon-capacity\/` \| `polygon-capacity` \| Mediation and the CSP[^|]*\| `report-polygon-capacity-lookup` \| rpt04 \|/,
    );
    expect(
      readdirSync(
        join(ROOT, "workflow-management/dev/outbound/polygon-capacity"),
      ),
    ).toContain(".gitkeep");
  });
});

// Verified on v1.3.35 (rpt04): `flow namespace update <dir>` recurses, and a
// YAML file that isn't a flow (contracts/*.yaml) refuses the whole namespace.
// Both deploy paths therefore stage each directory's top-level flow files and
// deploy that; the contracts go up as namespace files instead.
describe("flow deploy — top-level flow files only (rpt04 finding)", () => {
  // The staging `find`: top-level files only, flow extensions only.
  const expectStaging = (text: string) => {
    expect(text).toContain(
      "-maxdepth 1 -type f \\( -name '*.yml' -o -name '*.yaml' \\)",
    );
    expect(text).toMatch(/-exec cp \{\} "\$+stage"\/ \\;/);
  };

  it("dev flow-deploy deploys the staged copy, never /flows/<dir> itself", () => {
    const compose = read(
      join(ROOT, "workflow-management/dev/docker-compose.dev.yml"),
    );
    expectStaging(compose);
    expect(compose).toContain(
      '/app/kestra flow namespace update "$$ns" "$$stage" --no-delete',
    );
    expect(compose).not.toMatch(/flow namespace update "\$\$ns" "\/flows/);
  });

  it("CI deploy_fn mounts the staged copy, never the function directory", () => {
    const ci = read(join(ROOT, "infra/azure-pipelines.yml"));
    const fn = ci.slice(
      ci.indexOf("deploy_fn() {"),
      ci.indexOf("deploy_fn rating-engine"),
    );
    expectStaging(fn);
    expect(fn).toContain('docker run --rm -v "${stage}:/flows:ro"');
    expect(fn).not.toContain('-v "${dir}:/flows"');
  });

  it("reporting's only subdirectory is contracts/, which holds no flow", () => {
    const subdirs = readdirSync(FLOWS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(subdirs).toEqual(["contracts"]);
    for (const name of readdirSync(join(FLOWS, "contracts")))
      expect(read(join(FLOWS, "contracts", name))).not.toMatch(/^namespace:/m);
  });
});
