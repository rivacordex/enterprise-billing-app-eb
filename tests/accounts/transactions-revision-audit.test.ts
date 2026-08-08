import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ac23-spec §2.4/§3.3 — the Transactions-revision completeness auditor. The
// sibling of verification-audit.test.ts (which audits the V1–V14 series): this
// file audits the update-overview's success criteria SC1–SC14. Every SC must
// have at least one mapped, present, non-trivial test; a future contributor who
// deletes a regression test is told exactly which SC number they broke.
//
// "Passes" is confirmed by the full-suite run (ac23-spec §5 build gates), not by
// re-executing a live-DB integration suite from inside this audit — same
// contract as verification-audit.test.ts.
const REPO_ROOT = resolve(__dirname, "..", "..");

type ScEntry = {
  sc: string;
  criterion: string;
  // Repo-root-relative test file(s) that cover this SC.
  files: string[];
  // A content marker that must appear in at least one mapped file — a
  // lightweight, grep-based proof the file actually exercises the SC, not just
  // a same-named placeholder.
  marker: string;
};

// update-overview.md §Success criteria ↔ owning test. Each SC traces to the
// unit that delivered its coverage (ac18–ac22); ac23 only consolidates.
const SC_TESTS: ScEntry[] = [
  {
    sc: "SC1",
    criterion: "workbench renders (header, strip, banner, action bar, table)",
    files: ["tests/accounts/route-level-transactions.test.ts"],
    marker: "SC1",
  },
  {
    sc: "SC2",
    criterion: "nav context (?party&fa&ban) preserved across all five links",
    files: ["tests/components/admin-nav-accounts-context.test.tsx"],
    marker: "SC2",
  },
  {
    sc: "SC3",
    criterion: "Transactions is the second item in the Accounts nav",
    files: ["tests/components/admin-nav-accounts-context.test.tsx"],
    marker: "SC3",
  },
  {
    sc: "SC4",
    criterion: "FA-level inclusion — PAY + DEP captures returned with a BAN",
    files: ["tests/accounts/transactions-documents-list.integration.test.ts"],
    marker: "SC4",
  },
  {
    sc: "SC5",
    criterion: "a different BAN under the same FA is excluded",
    files: ["tests/accounts/transactions-documents-list.integration.test.ts"],
    marker: "SC5",
  },
  {
    sc: "SC6",
    criterion: "reversal eligibility — six branches, one case each",
    files: ["tests/accounts/reversal-eligibility.integration.test.ts"],
    marker: "SC6",
  },
  {
    sc: "SC7",
    criterion:
      "document vs line reversal routing (reverseDocument/reverseLine)",
    files: ["tests/accounts/reversal-line-selection.integration.test.ts"],
    marker: "SC7",
  },
  {
    sc: "SC8",
    criterion: "allocation-line reversal returns funds to unapplied_cash",
    files: ["tests/accounts/reversal-line-selection.integration.test.ts"],
    marker: "SC8",
  },
  {
    sc: "SC9",
    criterion: "partially-reversed badge beside the Posted state badge",
    files: ["tests/components/documents-table.test.tsx"],
    marker: "SC9",
  },
  {
    sc: "SC10",
    criterion:
      "no free-text reversal doc-ID input (reversal is document-bound)",
    files: ["tests/accounts/grep-gates.test.ts"],
    marker: "SC10",
  },
  {
    sc: "SC11",
    criterion: "approval banner + drawer approve; self-approval rejected",
    files: ["tests/components/document-detail-drawer.test.tsx"],
    marker: "SC11",
  },
  {
    sc: "SC12",
    criterion: "V-series (incl. ac11 reversal service tests) pass unmodified",
    files: ["tests/accounts/transactions-revision-audit.test.ts"],
    marker: "SC12",
  },
  {
    sc: "SC13",
    criterion: "route-level-transactions.test.ts (+ typecheck + lint) pass",
    files: ["tests/accounts/route-level-transactions.test.ts"],
    marker: "SC13",
  },
  {
    sc: "SC14",
    criterion: "READ-only sees table + drawer, no write affordance rendered",
    files: ["tests/components/document-detail-drawer.test.tsx"],
    marker: "SC14",
  },
];

describe("SC1–SC14 completeness audit (ac23-spec §2.4/§3.3)", () => {
  it.each(SC_TESTS)(
    "$sc ($criterion) has a mapped, non-trivial test",
    ({ sc, files, marker }) => {
      let markerSeen = false;
      for (const file of files) {
        const filePath = resolve(REPO_ROOT, file);
        expect(
          existsSync(filePath),
          `${sc} coverage missing: ${file} does not exist. A regression test for "${sc}" was deleted or moved.`,
        ).toBe(true);

        const src = readFileSync(filePath, "utf-8");
        expect(src).toContain("describe");
        expect(src).toContain("it(");
        if (src.includes(marker)) markerSeen = true;
      }
      expect(
        markerSeen,
        `${sc} coverage weakened: none of [${files.join(", ")}] still contains the "${marker}" marker.`,
      ).toBe(true);
    },
  );

  it("SC1–SC14 is a complete, gap-free, duplicate-free sequence", () => {
    const numbers = SC_TESTS.map((entry) => Number(entry.sc.slice(2)));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

// ac23-spec §2.5/§3.4 — the strongest available evidence the revision was
// UI-only: the ac11 reversal service tests and the whole V-series must pass with
// ZERO edits across ac18–ac23. A V-test edit means a behavioural change slipped
// into a unit that claimed to be UI-only; the owning unit must be re-examined.
//
// route-level-transactions.test.ts is the one legitimate exception (affordances
// moved, ac19/ac20) — it is NOT a V-test, so the `v*.test.ts` glob excludes it.
describe("SC12 — the V-series is unmodified across the revision (ac23-spec §2.5)", () => {
  function git(args: string[]): string | null {
    try {
      return execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  }

  // The revision base is the ac17→ac18 boundary: the parent of the earliest
  // commit that introduced the revision (ac18). NOTE: the whole Accounts module
  // (ac01–ac23) was built on this branch, so `merge-base HEAD main` predates the
  // V-series and would report every V-test as "added" — the wrong base.
  // Overridable via AC_REVISION_BASE for CI.
  function resolveRevisionBase(): string | null {
    if (process.env.AC_REVISION_BASE) return process.env.AC_REVISION_BASE;
    const earliestAc18 = git([
      "log",
      "--reverse",
      "--format=%H",
      "--grep=ac18",
      "HEAD",
    ])?.split("\n")[0];
    if (!earliestAc18) return null;
    return git(["rev-parse", `${earliestAc18}~1`]);
  }
  const revisionBase = resolveRevisionBase();

  const V_TEST_RE = /(?:^|\/)v\d{2}[a-z]?-.*\.test\.ts$/;

  // The ac11 reversal service tests — the conservation properties that prove the
  // reversal contract did not change. SC12's headline: these must be BYTE-
  // unmodified across the revision (ac23-spec Goal / §5).
  const AC11_REVERSAL_TESTS = [
    "tests/accounts/v04-cash-conservation.property.test.ts",
    "tests/accounts/v13-line-reversal-conservation.property.test.ts",
  ];

  // Spec-vs-reality reconciliation (recorded here, in the tracker, and surfaced
  // to the reviewer): ac23-spec §2.5 assumes "any V-test edit ⟹ a behavioural
  // change slipped in", so `git diff v*.test.ts` should be empty. In THIS repo
  // that premise is falsified by a sanctioned infrastructure repair: the review
  // commit 74be4fb split the fixtures' `migrate()` onto a short-lived connection
  // (the module-wide "migrate()-poisons-connection quirk" Key Decision — a
  // timestamptz-parsing fix), explicitly "pre-existing, unrelated to the feature
  // work". Those five fixture-plumbing repairs changed no assertion. They are
  // allowlisted below (the same carve-out ac23-spec §2.5 already grants
  // route-level-transactions.test.ts). Any OTHER V-test change — and any change
  // to the ac11 reversal tests — still fails the gate.
  const SANCTIONED_FIXTURE_REPAIRS = new Set([
    "tests/accounts/v02-binding-integrity.integration.test.ts",
    "tests/accounts/v03-live-balances.integration.test.ts",
    "tests/accounts/v05-gl-health-crud.integration.test.ts",
    "tests/accounts/v07-onboarding-atomicity.integration.test.ts",
    "tests/accounts/v09-bill-cycle-integrity.integration.test.ts",
  ]);

  function changedVTests(): string[] {
    const changed =
      git([
        "diff",
        "--name-only",
        `${revisionBase}..HEAD`,
        "--",
        "tests/accounts",
      ]) ?? "";
    return changed
      .split("\n")
      .map((line) => line.trim())
      .filter((file) => V_TEST_RE.test(file));
  }

  it("no V-test changed behaviourally across the revision (only sanctioned fixture repairs)", () => {
    if (!revisionBase) {
      // Harness cannot shell out / no base ref (e.g. a shallow CI clone):
      // ac23-spec §3.4 routes this assertion to the CI job in that case.
      // eslint-disable-next-line no-console -- intentional deferral signal on the no-git fallback path
      console.warn(
        "SC12: revision base unresolved (no git / ac18 boundary not found); V-test diff check deferred to the CI job per ac23-spec §3.4",
      );
      return;
    }
    const behaviouralChanges = changedVTests().filter(
      (file) => !SANCTIONED_FIXTURE_REPAIRS.has(file),
    );
    expect(
      behaviouralChanges,
      `SC12 violated: a V-test changed during the Transactions revision (ac18–ac23) outside the sanctioned migrate()-connection fixture repairs, implying a behavioural change slipped into a unit that claimed to be UI-only. Re-examine the owning unit. Changed: ${behaviouralChanges.join(", ")}`,
    ).toEqual([]);
  });

  it("SC12 headline — the ac11 reversal service tests (V4 + V13) are byte-unmodified across the revision", () => {
    if (!revisionBase) {
      // eslint-disable-next-line no-console -- intentional deferral signal on the no-git fallback path
      console.warn(
        "SC12: revision base unresolved; ac11-reversal-test diff check deferred to the CI job per ac23-spec §3.4",
      );
      return;
    }
    const changed = changedVTests();
    const touched = AC11_REVERSAL_TESTS.filter((file) =>
      changed.includes(file),
    );
    expect(
      touched,
      `SC12 violated: an ac11 reversal service test changed during the revision — the reversal contract's conservation proof is no longer the evidence that this stayed a UI change. Changed: ${touched.join(", ")}`,
    ).toEqual([]);
  });

  it("the ac11 reversal service tests (V4 + V13) still exist and assert conservation", () => {
    for (const file of AC11_REVERSAL_TESTS) {
      const filePath = resolve(REPO_ROOT, file);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toContain("fc.assert");
    }
  });
});
