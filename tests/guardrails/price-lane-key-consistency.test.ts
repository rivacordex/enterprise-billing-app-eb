import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// Product guardrail 41 — the price lane key is the same everywhere
// (PM-ISS-004, option B; DB-free).
//
// A price row's lane is (product_offering_id, component_type, unit_of_measure,
// price_type) — plain columns since pm70 (0056) and pm71. Before Part 6 the
// last term was the expression CASE WHEN component_type = 'flat_fee' THEN
// price_component ->> 'priceType' END (pm46, extended by pm46a); `price_type`
// equals it (a constant per non-flat_fee type, the envelope's priceType for
// flat_fee). Within a lane a newer row supersedes the older one; rows in
// different lanes never touch. The key is written out by hand in the unique
// index (re-created by 0056 under the 0049 name), its Drizzle mirror, the
// repository's `lead()` window and the runtime readers (bill-run flow,
// rating). pm46a's defect was exactly one such copy missing a term, so this
// test:
//   1. asserts the three definition sites carry the column lane term and none
//      still spells the CASE … price_component term;
//   2. finds EVERY `PARTITION BY … component_type …` window in the app,
//      worker and flow sources and accepts it only if its keys are the lane
//      key, or a form provably equal to it for the component types that
//      window scans, or a documented exception;
//   3. asserts the CASE … price_component term is gone from every scanned
//      source (migrations before 0056 are history and are skipped); and
//   4. pins the inventory of such windows, so a new reader is reviewed here.
// It is a text heuristic, not a SQL parser: comments are blanked first, and
// any window it cannot classify fails loudly rather than passing.
//
// RED FROM pm71 TO pm74, BY DESIGN (G-N5 window): the bill-run flow yml still
// partitions on the CASE … price_component term until pm74 rewrites its
// readers onto product.offering_price_v (pm74 I3 also makes `scannedTypes`'
// FROM detection accept the view). Do NOT "fix" this by widening EXCEPTIONS or
// re-admitting the CASE term — the failure is pm74's unfinished work and it
// closes there.

const REPO_ROOT = path.resolve(__dirname, "../..");

// The lane's priceType term, normalized (see `normalizeSql`): the plain
// `price_type` column since pm71.
const LANE_TERM = "price_type";

// The pre-Part-6 term, normalized. It must appear nowhere any more.
const RETIRED_CASE_TERM =
  "case when component_type = 'flat_fee' then price_component ->> 'pricetype' end";

const ALL_COMPONENT_TYPES = [
  "usage_rate",
  "flat_fee",
  "capacity_commitment",
  "capacity_motivation",
] as const;

// Lower-cases, drops identifier quotes, resolves Drizzle `${t.camelCase}` /
// `${table.camelCase}` interpolations to their snake_case column, strips a
// table alias (`pop.`, `popp.`), and collapses whitespace.
function normalizeSql(text: string): string {
  return text
    .replace(/"/g, "")
    .replace(/\$\{\s*\w+\.(\w+)\s*\}/g, (_m, camel: string) =>
      camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    )
    .replace(/\b[a-z_]\w*\.(?=[a-z_])/gi, (m) =>
      // keep schema-qualified table names (product.x) out of key text only
      // where they are aliases; window keys never carry a schema prefix.
      m.toLowerCase() === "product." ? m : "",
    )
    .replace(/\s*->>\s*/g, " ->> ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Blanks `--` comments and `#` comment lines (YAML / Python), keeping offsets
// and newlines so reported line numbers stay right.
function blankComments(text: string, filePath: string): string {
  let out = text.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
  if (/\.(ya?ml|py)$/.test(filePath)) {
    out = out.replace(/^[ \t]*#[^\n]*/gm, (m) => " ".repeat(m.length));
  }
  if (/\.tsx?$/.test(filePath)) {
    out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  }
  return out;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

type KeyToken =
  | "product_offering_id"
  | "component_type"
  | "unit_of_measure"
  | "LANE_TERM"
  | string;

function classifyKey(raw: string): KeyToken {
  let key = normalizeSql(raw);
  while (key.startsWith("(") && key.endsWith(")"))
    key = key.slice(1, -1).trim();
  if (key === LANE_TERM) return "LANE_TERM";
  return key;
}

interface WindowSite {
  file: string;
  line: number;
  keys: KeyToken[];
  // Component types the window's query scans; null = no component_type
  // filter found (scans every type).
  scans: string[] | null;
}

interface Verdict {
  ok: boolean;
  reason: string;
}

// Documented exceptions: a window allowed to use a narrower key than the lane.
const EXCEPTIONS: Array<{
  file: string;
  keys: KeyToken[];
  scans: string[];
  why: string;
}> = [
  {
    file: "workflow-management/worker/workflow-engine/runtime/rp.py",
    keys: ["product_offering_id", "component_type"],
    scans: ["usage_rate"],
    why:
      "rm20 deliberate deviation (owner-confirmed 2026-10-04): single usage_rate " +
      "unit per offering assumed; unit_of_measure omitted. See the comment in rp.py.",
  },
];

const eq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function judgeWindow(site: WindowSite): Verdict {
  const base = ["product_offering_id", "component_type", "unit_of_measure"];
  const scans = site.scans ?? [...ALL_COMPONENT_TYPES];
  if (eq(site.keys, [...base, "LANE_TERM"])) {
    return { ok: true, reason: "full lane key" };
  }
  // pm71: the raw `price_component ->> 'priceType'` form (once proven equal on
  // a flat_fee-only scan) is gone with the jsonb column, so its acceptance
  // branch is deleted. `price_type` is a constant per non-flat_fee type.
  if (eq(site.keys, base)) {
    return scans.includes("flat_fee")
      ? {
          ok: false,
          reason:
            "missing the lane's priceType term on a scan that includes flat_fee " +
            "(a one-time fee would supersede a recurring one)",
        }
      : { ok: true, reason: "no priceType term needed on a non-flat_fee scan" };
  }
  const exception = EXCEPTIONS.find(
    (e) =>
      e.file === site.file &&
      eq(e.keys, site.keys) &&
      eq([...e.scans].sort(), [...scans].sort()),
  );
  if (exception) return { ok: true, reason: `exception: ${exception.why}` };
  return {
    ok: false,
    reason: `keys (${site.keys.join(", ")}) on a scan of [${scans.join(", ")}] are not the lane key`,
  };
}

const SOURCE_ROOTS = ["db", "services", "lib", "app", "workflow-management"];
const SOURCE_EXT = /\.(ts|tsx|ya?ml|py|sql)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
]);

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectFiles(entryPath));
    } else if (SOURCE_EXT.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function scannedTypes(
  afterWindow: string,
  isSqlFile: boolean,
): string[] | null {
  if (!isSqlFile) return null; // Drizzle query: no component_type filter
  const from = /from\s+product\.product_offering_price\b/i.exec(afterWindow);
  if (!from) return null;
  const tail = afterWindow.slice(from.index, from.index + 800);
  const pred = /component_type\s*(?:=\s*'(\w+)'|in\s*\(([^)]*)\))/i.exec(tail);
  if (!pred) return null;
  if (pred[1]) return [pred[1]];
  return [...pred[2]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
}

function findLaneWindows(file: string, source: string): WindowSite[] {
  const isSqlFile = !/\.tsx?$/.test(file);
  let text = blankComments(source, file);
  // Resolve `${name}` interpolations of a local `const name = sql`…`` so a
  // Drizzle window that names a shared lane-term constant is judged on its
  // SQL.
  if (!isSqlFile) {
    for (const m of text.matchAll(/const\s+(\w+)\s*=\s*sql`([^`]*)`/g)) {
      text = text.split(`\${${m[1]}}`).join(m[2]!);
    }
  }
  const sites: WindowSite[] = [];
  for (const m of text.matchAll(
    /partition\s+by\s+([\s\S]*?)\border\s+by\b/gi,
  )) {
    const keys = splitTopLevel(m[1]!).map(classifyKey);
    if (!keys.includes("component_type")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    sites.push({
      file,
      line,
      keys,
      scans: scannedTypes(text.slice(m.index! + m[0].length), isSqlFile),
    });
  }
  return sites;
}

function rel(p: string): string {
  return path.relative(REPO_ROOT, p).split(path.sep).join("/");
}

describe("guardrail 41 — judgeWindow (self-tests)", () => {
  const site = (keys: KeyToken[], scans: string[] | null): WindowSite => ({
    file: "x.sql",
    line: 1,
    keys,
    scans,
  });
  const base = ["product_offering_id", "component_type", "unit_of_measure"];

  it("accepts the full lane key on any scan", () => {
    expect(judgeWindow(site([...base, "LANE_TERM"], null)).ok).toBe(true);
  });

  it("rejects the retired CASE and raw price_component terms on any scan (pm71)", () => {
    expect(
      judgeWindow(site([...base, classifyKey(RETIRED_CASE_TERM)], null)).ok,
    ).toBe(false);
    expect(
      judgeWindow(
        site(
          [...base, classifyKey("price_component ->> 'priceType'")],
          ["flat_fee"],
        ),
      ).ok,
    ).toBe(false);
  });

  it("accepts no priceType term only when the scan excludes flat_fee", () => {
    expect(
      judgeWindow(site(base, ["usage_rate", "capacity_motivation"])).ok,
    ).toBe(true);
    // pm46a's defect shape: flat fees in a lane with no priceType term.
    expect(judgeWindow(site(base, ["flat_fee"])).ok).toBe(false);
    expect(judgeWindow(site(base, null)).ok).toBe(false);
  });

  it("rejects any other key list unless it is a documented exception", () => {
    expect(
      judgeWindow(
        site(["product_offering_id", "component_type"], ["usage_rate"]),
      ).ok,
    ).toBe(false);
    expect(
      judgeWindow({
        file: "workflow-management/worker/workflow-engine/runtime/rp.py",
        line: 1,
        keys: ["product_offering_id", "component_type"],
        scans: ["usage_rate"],
      }).ok,
    ).toBe(true);
  });

  it("finds a window, ignores one in a comment, and reads its scan filter", () => {
    const sql = [
      "-- PARTITION BY pop.product_offering_id, pop.component_type ORDER BY x",
      "SELECT lead(x) OVER (PARTITION BY pop.product_offering_id, pop.component_type,",
      "  pop.unit_of_measure ORDER BY pop.start_date_time)",
      "FROM product.product_offering_price pop",
      "WHERE pop.component_type IN ('usage_rate', 'capacity_commitment')",
    ].join("\n");
    const found = findLaneWindows("x.yml", sql);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.keys).toEqual(base);
    expect(found[0]!.scans).toEqual(["usage_rate", "capacity_commitment"]);
  });
});

describe("guardrail 41 — the price lane key is the same everywhere (PM-ISS-004)", () => {
  // 0049 is history and no longer defines anything: 0056 re-creates the index
  // under the same name on the plain columns.
  it("the three definition sites carry the column lane term, not the CASE term", () => {
    for (const file of [
      "db/migrations/0056_product_normalize_spec_price.sql",
      "db/schema/product.ts",
      "db/repositories/product-offering-price.ts",
    ]) {
      const source = normalizeSql(
        blankComments(
          fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
          file,
        ),
      );
      expect(source, file).toContain(LANE_TERM);
      expect(source, file).not.toContain(RETIRED_CASE_TERM);
    }
    const migration = normalizeSql(
      blankComments(
        fs.readFileSync(
          path.join(
            REPO_ROOT,
            "db/migrations/0056_product_normalize_spec_price.sql",
          ),
          "utf8",
        ),
        "0056.sql",
      ),
    );
    expect(migration).toContain(
      "(product_offering_id, component_type, unit_of_measure, price_type, start_date_time) nulls not distinct",
    );
  });

  const sites = SOURCE_ROOTS.flatMap((root) =>
    collectFiles(path.join(REPO_ROOT, root)),
  ).flatMap((file) =>
    findLaneWindows(rel(file), fs.readFileSync(file, "utf8")),
  );

  it("every lane window partitions on the lane key (or a proven-equal form)", () => {
    const failures = sites
      .map((s) => ({ s, v: judgeWindow(s) }))
      .filter(({ v }) => !v.ok)
      .map(({ s, v }) => `${s.file}:${s.line} — ${v.reason}`);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  // Migrations before 0056 are immutable history (0049 defined the CASE index).
  const isHistoricMigration = (file: string) => {
    const m = /^db\/migrations\/(\d{4})_/.exec(file);
    return m !== null && Number(m[1]) < 56;
  };

  it("the CASE … price_component lane term appears nowhere under the scanned roots (pm71)", () => {
    const offenders = SOURCE_ROOTS.flatMap((root) =>
      collectFiles(path.join(REPO_ROOT, root)),
    )
      .map((file) => rel(file))
      .filter((file) => !isHistoricMigration(file))
      .filter((file) =>
        normalizeSql(
          blankComments(
            fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
            file,
          ),
        ).includes(RETIRED_CASE_TERM),
      );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // §1.49 / Inv. #61: the envelope is assembled and disassembled in exactly one
  // place. Outside the price repository only `tests/**` may name either
  // function (comments stripped).
  it("toEnvelope / fromEnvelope are referenced only by the price repository and tests", () => {
    const roots = [
      "app",
      "actions",
      "services",
      "components",
      "db/seeds",
      "db/repositories",
      "workflow-management",
    ];
    const offenders = roots
      .flatMap((root) => collectFiles(path.join(REPO_ROOT, root)))
      .map((file) => rel(file))
      .filter((file) => file !== "db/repositories/product-offering-price.ts")
      .filter((file) => {
        const raw = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
        const code = /\.tsx?$/.test(file)
          ? stripComments(raw)
          : blankComments(raw, file);
        return /\b(toEnvelope|fromEnvelope)\b/.test(code);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // Every reader that derives effectivity from product_offering_price. A new
  // one changes this count: review it against the lane key, then update here.
  it("the inventory of lane windows is the reviewed one", () => {
    const counts: Record<string, number> = {};
    for (const s of sites) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual({
      "db/repositories/product-offering-price.ts": 1,
      "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml": 3,
      "workflow-management/worker/workflow-engine/runtime/rp.py": 1,
    });
  });
});
