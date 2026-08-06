import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac17-spec §2.2 / §3.2, code-standards §7.1 — the V1-V14 completeness
// audit: every verification test from the plan's Part A §4 exists, is named
// per convention (`tests/accounts/v01…v14`), and is mapped to its owning
// unit and invariant. This test's job is presence, naming, and mapping —
// "passes" is confirmed by the full-suite run (ac17-spec §3.7 / §5 "Build
// gates"), not by re-executing a live-DB integration suite from inside a
// unit test.
const TESTS_ACCOUNTS_DIR = resolve(__dirname, "..", "accounts");

type VTestEntry = {
  v: string;
  property: string;
  owner: string;
  files: string[];
  // Content markers that must all appear (anywhere across the mapped
  // file(s)) — a lightweight, grep-based proof the file actually exercises
  // the claimed property, not just a same-named placeholder.
  markers: string[];
};

// architecture.md §6 (Module invariants) ↔ plan §4 (V-test) cross-reference,
// reproduced verbatim from ac17-spec §2.2's table.
const V_TESTS: VTestEntry[] = [
  {
    v: "V1",
    property: "zero-sum per currency after every posting",
    owner: "ac01 (+ re-run everywhere)",
    files: ["v01-zero-sum.integration.test.ts"],
    markers: ["zero-sum"],
  },
  {
    v: "V2",
    property: "binding integrity (3 per customer, currency match)",
    owner: "ac04",
    files: ["v02-binding-integrity.integration.test.ts"],
    markers: ["binding"],
  },
  {
    v: "V3",
    property: "API/UI balance = ledger balance",
    owner: "ac05/ac07",
    files: [
      "v03-balance-equals-ledger.integration.test.ts",
      "v03-live-balances.integration.test.ts",
    ],
    markers: [],
  },
  {
    v: "V4",
    property: "cash-application conservation (property)",
    owner: "ac11",
    files: ["v04-cash-conservation.property.test.ts"],
    markers: ["fc.assert"],
  },
  {
    v: "V5",
    property: "GL resolution completeness (0 unmapped)",
    owner: "ac03/ac12",
    files: [
      "v05-gl-resolution.integration.test.ts",
      "v05-gl-health-crud.integration.test.ts",
    ],
    markers: [],
  },
  {
    v: "V6",
    property: "GL journal balance (Σ debit = Σ credit)",
    owner: "ac13/ac14",
    files: [
      "v06-journal-balance.integration.test.ts",
      "v06b-period-close-export.integration.test.ts",
    ],
    markers: [],
  },
  {
    v: "V7",
    property: "onboarding atomicity (rollback, 0 orphans)",
    owner: "ac04",
    files: ["v07-onboarding-atomicity.integration.test.ts"],
    markers: [],
  },
  {
    v: "V8",
    property: "payment_status derivation",
    owner: "ac07",
    files: ["v08-payment-status.integration.test.ts"],
    markers: [],
  },
  {
    v: "V9",
    property: "bill-cycle catalog integrity",
    owner: "ac15",
    files: ["v09-bill-cycle-integrity.integration.test.ts"],
    markers: [],
  },
  {
    v: "V10",
    property: "term resolution + freeze",
    owner: "ac04/ac15",
    files: ["v10-term-resolution.test.ts"],
    markers: ["resolveTerm"],
  },
  {
    v: "V11",
    property:
      "document state machine (threshold, approver≠creator, atomic, unbalanced, closed-period)",
    owner: "ac07",
    files: ["v11-document-state-machine.integration.test.ts"],
    markers: [],
  },
  {
    v: "V12",
    property: "posting-nature steering (revenue_adj/write_off → 4090/6100)",
    owner: "ac09/ac10",
    files: ["v12-posting-nature-steering.integration.test.ts"],
    markers: [],
  },
  {
    v: "V13",
    property: "line-level reversal conservation (property)",
    owner: "ac11",
    files: ["v13-line-reversal-conservation.property.test.ts"],
    markers: ["fc.assert"],
  },
  {
    v: "V14",
    property: "deposit lifecycle → zero + closure eligibility",
    owner: "ac08/ac16",
    files: ["v14-deposit-lifecycle.integration.test.ts"],
    markers: [],
  },
];

describe("V1-V14 completeness audit (ac17-spec §2.2, code-standards §7.1)", () => {
  it.each(V_TESTS)(
    "$v ($property, owner: $owner) exists and is non-trivial",
    ({ files, markers }) => {
      for (const file of files) {
        const filePath = resolve(TESTS_ACCOUNTS_DIR, file);
        expect(existsSync(filePath)).toBe(true);

        const src = readFileSync(filePath, "utf-8");
        expect(src).toContain("describe");
        expect(src).toContain("it(");
        for (const marker of markers) {
          expect(src.toLowerCase()).toContain(marker.toLowerCase());
        }
      }
    },
  );

  it("naming convention: every mapped file matches v(01-14)[a-z]?-<slug>.test.ts (code-standards §7.1)", () => {
    const NAME_PATTERN =
      /^v(0[1-9]|1[0-4])[a-z]?-[a-z0-9-]+\.(?:integration\.)?(?:property\.)?test\.ts$/;
    for (const entry of V_TESTS) {
      for (const file of entry.files) {
        expect(file).toMatch(NAME_PATTERN);
      }
    }
  });

  it("V1-V14 is a complete, gap-free, duplicate-free sequence", () => {
    const numbers = V_TESTS.map((entry) => Number(entry.v.slice(1)));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("every V-prefixed file in tests/accounts/ is accounted for in the map (no orphan V-test)", () => {
    const mappedFileSet = new Set(V_TESTS.flatMap((entry) => entry.files));
    const actualVFiles = readdirSync(TESTS_ACCOUNTS_DIR).filter((f) =>
      /^v\d{2}[a-z]?-.*\.test\.ts$/.test(f),
    );
    for (const file of actualVFiles) {
      expect(mappedFileSet.has(file)).toBe(true);
    }
  });

  // Module Inv. #14 (fork integrity) is the one invariant whose enforcing
  // test does not live under `tests/accounts/` — it is a pure text-transform
  // check beside the vendored pgledger fork itself (ac01-spec §3.7). Audited
  // here rather than renamed into the V-numbered sequence: it was never
  // assigned a V-number by the plan (only V1-V14 were), and moving it would
  // be a structural change this pure-gate unit does not make (§2.5).
  it("Inv. #14 (fork integrity, pgledger:transform in sync) has its own enforcing test", () => {
    const filePath = resolve(__dirname, "..", "pgledger", "transform.test.ts");
    expect(existsSync(filePath)).toBe(true);
    const src = readFileSync(filePath, "utf-8");
    expect(src).toContain(
      "is in sync: re-running on the vendored inputs reproduces the committed generated file byte-for-byte",
    );
  });
});

// architecture.md §6's own invariant ↔ V-test cross-reference (ac17-spec
// §2.4's "Architecture §6 invariants ↔ V-tests cross-reference verified").
describe("Module Inv. #1-14 ↔ V-test cross-reference (architecture.md §6)", () => {
  const INVARIANT_TO_V: { inv: string; v: string | null }[] = [
    { inv: "#1 Zero-sum ledger", v: "V1" },
    { inv: "#2 No stored balances", v: "V3" },
    { inv: "#3 Money moves only through posted documents", v: "V11" },
    { inv: "#4 The ledger is append-only", v: "V13" },
    { inv: "#5 Document posting is atomic", v: "V7" },
    { inv: "#6 Approver ≠ creator, thresholds server-side", v: "V11" },
    { inv: "#7 Closed periods reject postings", v: "V11" },
    { inv: "#8 Posting nature steers the counter-account", v: "V12" },
    { inv: "#9 Binding completeness", v: "V2" },
    { inv: "#10 GL resolution is total and unambiguous", v: "V5/V6" },
    { inv: "#11 Catalogs retire, never delete", v: "V9" },
    { inv: "#12 Closure requires zero", v: "V14" },
    { inv: "#13 Terms freeze at issuance", v: "V10" },
    { inv: "#14 Fork integrity", v: null },
  ];

  it("every one of the 14 module invariants maps to an enforcing V-test (or the fork-integrity transform test)", () => {
    for (const { v } of INVARIANT_TO_V) {
      if (v === null) continue;
      const vNumbers = v.split("/");
      for (const vNumber of vNumbers) {
        expect(V_TESTS.some((entry) => entry.v === vNumber)).toBe(true);
      }
    }
  });

  it("exactly 14 invariants are accounted for (architecture.md §6)", () => {
    expect(INVARIANT_TO_V).toHaveLength(14);
  });
});
