import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm35-spec §Implementation §2 — the phase-3 ship gate ASSEMBLES the phase-3
// guardrail suite (code-standards §9 items 19–32, plus the cross-cutting checks)
// rather than rebuilding it (the bm21/bm13 "audit, don't rebuild" discipline).
// Each correctness guardrail already shipped WITH the unit that introduced its
// behaviour (bm23–bm34); this static, DB-free manifest verifies that every one
// is still PRESENT on disk and CI-WIRED — so a rename, move, or accidental
// deletion of a phase-3 guardrail fails the build here instead of silently
// dropping coverage. It asserts nothing about the guardrails' own logic (that is
// each file's job); it is the assembly-completeness check the gate owns.
const REPO_ROOT = path.resolve(__dirname, "../..");

function exists(rel: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

interface PackageJson {
  scripts: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

// The phase-3 guardrail manifest. Each entry names a code-standards §9 phase-3
// item (or a cross-cutting gate) and the test file(s) that ship it. A file is
// CI-wired iff its name routes it into one of the two Vitest projects the `test`
// script runs: `*.integration.test.ts` / `*.property.test.ts` → the integration
// project (vitest.integration.config.ts); anything else under `tests/` ending in
// `.test.ts`/`.test.tsx` → the default DB-free project (vitest.config.ts).
interface GuardrailEntry {
  item: string;
  files: readonly string[];
}

const PHASE3_GUARDRAILS: readonly GuardrailEntry[] = [
  {
    item: "§9.19 [CRITICAL] Correlation (D1) + no product_inventory.billing_account_id write",
    files: [
      "tests/db/billrun-collection-correlation.integration.test.ts",
      "tests/guardrails/billrun-inventory-write-boundary.test.ts",
    ],
  },
  {
    item: "§9.20 [CRITICAL] Line grain + totals (D5)",
    files: ["tests/db/billrun-aggregation.integration.test.ts"],
  },
  {
    item: "§9.21 [CRITICAL] Checksum re-anchor on customer_bill_line (D7/D20)",
    files: ["tests/db/customer-bill-line-checksum.integration.test.ts"],
  },
  {
    item: "§9.22 [CRITICAL] Recurring exactly-once + whole-account replace (D22)",
    files: [
      "tests/db/billrun-recurring-aggregation.integration.test.ts",
      "tests/guardrails/billing-customer-bill-line-replace-boundary.test.ts",
    ],
  },
  {
    item: "§9.23 [CRITICAL] No claim survives an abandoned attempt (D21)",
    files: ["tests/db/billrun-claim-release.integration.test.ts"],
  },
  {
    item: "§9.24 [CRITICAL] Rating may not supersede a claimed row — LOAD_BLOCKED_INFLIGHT + trigger (D3)",
    files: [
      "tests/rating/rm09-rl-guarded-transactional-load.integration.test.ts",
      "tests/rating/rm10-supersession-reprocessing.integration.test.ts",
    ],
  },
  {
    item: "§9.25 Price snapshot authority on rerun (D19)",
    files: [
      "tests/rating/rm08-rp-price-resolution-snapshot.integration.test.ts",
      "tests/db/billrun-recurring-aggregation.integration.test.ts",
    ],
  },
  {
    item: "§9.26 Grants, phase-3 additions (two-writer boundary + cross-schema reads)",
    files: ["tests/db/billrun-db-roles.integration.test.ts"],
  },
  {
    item: "§9.27 Multi-target distribution + outcome identity (D25)",
    files: [
      "tests/services/billing/distribute-run.service.test.ts",
      "tests/app/api/billrun-distribution-outcome.test.ts",
    ],
  },
  {
    // §9.28's app-observable half — per-artifact DELIVERED/FAILED, the
    // "outcome POST is the deliverable not the upload" invariant, and
    // rerun-failed-only — ships here. The real-SFTP endpoint transport
    // (host-key verification, key from a Kestra Secret, the SSH upload/retry)
    // lives in the distributor flow YAML and is the deferred live smoke
    // (bm22's environment), not an app-repo test.
    item: "§9.28 SFTP transport — app-side outcome/rerun semantics (real-SFTP transport is the deferred live smoke)",
    files: ["tests/services/billing/distribute-run.service.test.ts"],
  },
  {
    item: "§9.29/§9.32 Uncharged semantics + per-record exception policies (D14/D32/D33)",
    files: [
      "tests/db/billrun-uncharged-exceptions.integration.test.ts",
      "tests/services/billing/list-uncharged.test.ts",
      "tests/services/billing/list-exceptions.test.ts",
      "tests/services/billing/pre-approval-checks.test.ts",
    ],
  },
  {
    item: "§9.30 Partition registration for customer_bill_line",
    files: ["tests/db/billing-partman-setup.integration.test.ts"],
  },
  {
    item: "§9.31 volume profile — Aggregation is set-based (this unit, bm35)",
    files: ["tests/db/billrun-volume-aggregation.integration.test.ts"],
  },
];

// Cross-cutting gates the phase-3 ship gate also assembles (§9 framing + the
// three §0 reversals + seed integrity + the full journey).
const CROSS_CUTTING: readonly GuardrailEntry[] = [
  {
    item: "compute boundary — no charge-derivation under services/billing (reversal #2, Inv #17)",
    files: ["tests/guardrails/billing-trial-bill-compute-boundary.test.ts"],
  },
  {
    item: "rating write boundary — the app's only rating.* write is udr-status.repository.ts (Inv #2)",
    files: ["tests/guardrails/billing-rating-write-boundary.test.ts"],
  },
  {
    item: "reversal #3 — the retired placeholder-mode flag has no surviving citation (D31)",
    files: ["tests/guardrails/billrun-placeholder-retirement.test.ts"],
  },
  {
    item: "seed integrity — every seeded row _SAMPLE_-marked + unclaimed; prod-guarded, absent from db:setup (§9.16)",
    files: [
      "tests/guardrails/billing-sample-seed-marker.test.ts",
      "tests/guardrails/billing-sample-seed-boundary.test.ts",
    ],
  },
  {
    item: "full journey E2E — the phase-1/2 shape (bm13/bm21) and the phase-3 real-aggregation journey (this unit)",
    files: [
      "tests/db/billing-e2e-happy-path.integration.test.ts",
      "tests/db/billrun-phase3-journey.integration.test.ts",
    ],
  },
  {
    item: "M2M surface — exactly three POST handlers, record-only, auth/state gated",
    files: [
      "tests/app/api/billrun-route-inventory.test.ts",
      "tests/app/api/billrun-stage-complete.test.ts",
      "tests/app/api/billrun-status.test.ts",
    ],
  },
];

const ALL_ENTRIES = [...PHASE3_GUARDRAILS, ...CROSS_CUTTING];

function isCiWired(rel: string): boolean {
  const underTests = rel.startsWith("tests/");
  const isTestFile =
    rel.endsWith(".integration.test.ts") ||
    rel.endsWith(".property.test.ts") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx");
  return underTests && isTestFile;
}

describe("bm35 phase-3 ship gate — the §9 guardrail suite is assembled and CI-wired", () => {
  it.each(ALL_ENTRIES)(
    "$item — every guardrail file is present on disk",
    (entry) => {
      const missing = entry.files.filter((f) => !exists(f));
      expect(missing).toEqual([]);
    },
  );

  it.each(ALL_ENTRIES)(
    "$item — every guardrail file is CI-wired into a Vitest project",
    (entry) => {
      const unwired = entry.files.filter((f) => !isCiWired(f));
      expect(unwired).toEqual([]);
    },
  );

  it("the `test` script runs BOTH the DB-free and the DB-gated Vitest projects", () => {
    const { scripts } = readPackageJson();
    const test = scripts["test"];
    expect(test).toBeDefined();
    // The default (DB-free) project + the integration project — the DB-gated
    // guardrails above (and this unit's volume/journey suites) only run when the
    // second invocation fires against a live DATABASE_URL.
    expect(test).toContain("vitest run");
    expect(test).toContain("--config vitest.integration.config.ts");
  });

  it("every distinct referenced guardrail file resolves and the manifest is non-trivial", () => {
    // Some files legitimately back more than one §9 item (e.g. the recurring
    // aggregation suite serves §9.22 and §9.25), so duplicate references across
    // entries are expected and fine — assert every DISTINCT referenced file
    // resolves, and that the manifest covers a non-trivial slice.
    const distinct = new Set(ALL_ENTRIES.flatMap((e) => e.files));
    for (const f of distinct) {
      expect(exists(f), `manifest references a missing file: ${f}`).toBe(true);
    }
    expect(distinct.size).toBeGreaterThan(15);
  });
});

// bm35-spec §Implementation §1 — the `volume` seed profile is a source-level
// artifact of this unit (a seed script, not a test), so assert it statically
// here: the profile exists, is wired into the switch, and reuses the SAME
// _SAMPLE_ factory as `ci` (no new factory shape — code-standards §9.16 extends
// the marker assertions to BOTH profiles, and both flow through
// buildSampleUdrRatedRow, whose output shape is proven by
// billing-sample-seed-marker.test.ts).
describe("bm35 phase-3 ship gate — the `volume` seed profile is wired (bm35-spec §1)", () => {
  const seedSrc = fs.readFileSync(
    path.join(REPO_ROOT, "db/seeds/sample/seed-billrun-sample.ts"),
    "utf8",
  );

  it("the SeedProfile union includes both `ci` and `volume`", () => {
    // Order-insensitive: capture the union RHS and assert both members are
    // present, so a benign reorder/reflow of the union doesn't break the gate.
    const union = seedSrc.match(/type SeedProfile\s*=\s*([^;]+);/);
    expect(union).not.toBeNull();
    expect(union![1]).toContain('"ci"');
    expect(union![1]).toContain('"volume"');
  });

  it("resolveProfile handles the `volume` case", () => {
    expect(seedSrc).toMatch(/case "volume":/);
    expect(seedSrc).toContain("VOLUME_SCENARIOS");
  });

  it("a profile switch selects the profile (SAMPLE_SEED_PROFILE), defaulting to `ci`", () => {
    expect(seedSrc).toContain("SAMPLE_SEED_PROFILE");
    expect(seedSrc).toContain("resolveSelectedProfile");
    // Tolerate an annotation change (e.g. `= "ci" satisfies SeedProfile`) — the
    // point is that the default profile is `ci`, not one exact syntactic form.
    expect(seedSrc).toMatch(/DEFAULT_PROFILE[^=\n]*=\s*"ci"/);
  });

  it("the `volume` load reuses the shared _SAMPLE_ factory, not a new shape", () => {
    // Only udr-rated-sample.ts's buildSampleUdrRatedRow builds seeded rows; the
    // volume scenarios drive the SAME seedSampleCharges path (no bespoke row
    // builder), so the _SAMPLE_/RAN_USAGE/unclaimed marker holds for both.
    expect(seedSrc).toContain("buildSampleUdrRatedRow");
    expect(seedSrc).not.toMatch(/buildVolumeUdrRatedRow|VolumeChargeSpec/);
  });
});
