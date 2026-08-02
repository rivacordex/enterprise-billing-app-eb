import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac13-spec §3.6 — route × level guardrail tests, structural-analysis style
// (route-level-chart-of-accounts.test.ts precedent).
const PAGE_PATH = resolve(
  __dirname,
  "../../app/(app)/accounts/gl-journal/page.tsx",
);
const pageSource = readFileSync(PAGE_PATH, "utf-8");

describe("GL Journal page — structural guardrails (ac13-spec §3.6)", () => {
  it('exports dynamic = "force-dynamic" (live read requirement, code-standards §3.2)', () => {
    expect(pageSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_CONFIG and READ (view gate)", () => {
    expect(pageSource).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(pageSource).toContain("LEVELS.READ");
    expect(pageSource).toContain("requirePermission");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_VIEW");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
  });

  it("has no write affordance (read-only — export/close are ac14)", () => {
    expect(pageSource).not.toContain('"use server"');
    expect(pageSource).not.toContain("LEVELS.EDIT");
  });

  it("has no direct pgledger references (repository-only access, module inv. #4)", () => {
    expect(pageSource).not.toContain("pgledger_");
  });

  it("imports getPeriodSummary and getCodeDrilldown from gl-journal service", () => {
    expect(pageSource).toContain("getPeriodSummary");
    expect(pageSource).toContain("getCodeDrilldown");
  });

  it("imports glJournalSearchParamsSchema for URL param validation", () => {
    expect(pageSource).toContain("glJournalSearchParamsSchema");
  });

  it("uses URL params for period, view, sort, and expand (code-standards §4.3)", () => {
    expect(pageSource).toContain("period");
    expect(pageSource).toContain("view");
    expect(pageSource).toContain("sort");
    expect(pageSource).toContain("expand");
  });

  it("renders total row with balanced/broken distinction (V6 — spec §2.2)", () => {
    expect(pageSource).toContain("totals.balanced");
    expect(pageSource).toContain("acct-balance-broken");
    expect(pageSource).toContain("totalDebit");
    expect(pageSource).toContain("totalCredit");
  });

  it("uses AmountCell for all money rendering (code-standards §4.1)", () => {
    expect(pageSource).toContain("AmountCell");
  });

  it("uses LedgerKindChip for drill-down account rendering (ac06 reuse)", () => {
    expect(pageSource).toContain("LedgerKindChip");
  });

  it("has no Number() or parseFloat on amounts (code-standards §2.2)", () => {
    expect(pageSource).not.toMatch(/Number\s*\(\s*[a-zA-Z]*[Aa]mount/);
    expect(pageSource).not.toContain("parseFloat");
  });

  it("has no AI or gradient tokens (architecture §5)", () => {
    expect(pageSource).not.toContain("--ai-");
    expect(pageSource).not.toContain("--gradient-ai");
  });

  it("has no TODO or console.* (diff hygiene, spec §5)", () => {
    expect(pageSource).not.toContain("TODO");
    expect(pageSource).not.toContain("console.");
  });
});

describe("GL Journal — service file exists (ac13-spec §3.2)", () => {
  const serviceRoot = resolve(__dirname, "../../services/accounts");

  it("gl-journal.ts exports getPeriodSummary and getCodeDrilldown", () => {
    const src = readFileSync(resolve(serviceRoot, "gl-journal.ts"), "utf-8");
    expect(src).toContain("getPeriodSummary");
    expect(src).toContain("getCodeDrilldown");
  });

  it("gl-journal.ts uses money.ts for totals (code-standards §2.2)", () => {
    const src = readFileSync(resolve(serviceRoot, "gl-journal.ts"), "utf-8");
    expect(src).toContain("money");
    expect(src).not.toContain("parseFloat");
    expect(src).not.toMatch(/Number\s*\(/);
  });
});

describe("GL Journal — repository file exists (ac13-spec §3.3)", () => {
  const repoRoot = resolve(__dirname, "../../db/repositories/accounts");

  it("gl-journal.repository.ts exports glJournalRepository with listSummary and listDrilldown", () => {
    const src = readFileSync(
      resolve(repoRoot, "gl-journal.repository.ts"),
      "utf-8",
    );
    expect(src).toContain("glJournalRepository");
    expect(src).toContain("listSummary");
    expect(src).toContain("listDrilldown");
  });

  it("gl-journal.repository.ts has no delete function (read-only, Module Inv. #3)", () => {
    const src = readFileSync(
      resolve(repoRoot, "gl-journal.repository.ts"),
      "utf-8",
    );
    expect(src).not.toContain(".delete(");
  });

  it("gl-journal.repository.ts only accesses pgledger views (Module Inv. #4)", () => {
    const src = readFileSync(
      resolve(repoRoot, "gl-journal.repository.ts"),
      "utf-8",
    );
    // Must use views (gl_journal_view, gl_resolution_view, pgledger_*_view)
    expect(src).toContain("gl_journal_view");
    expect(src).toContain("pgledger_entries_view");
    // Must NOT INSERT/UPDATE/DELETE on any table
    expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(src).not.toMatch(/\bUPDATE\b/i);
    expect(src).not.toMatch(/\bDELETE\b/i);
  });
});

describe("GL Journal — no write path (ac13-spec §3.7)", () => {
  it("has no action file (export/close are ac14, not ac13)", () => {
    const actionRoot = resolve(__dirname, "../../actions/accounts");
    // There must be no gl-journal action file in this unit
    expect(existsSync(resolve(actionRoot, "gl-journal.ts"))).toBe(false);
    expect(existsSync(resolve(actionRoot, "gl-journal-export.ts"))).toBe(false);
  });
});
