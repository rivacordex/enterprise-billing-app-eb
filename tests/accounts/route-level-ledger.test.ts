import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac06-spec §3.6 — route × level guardrail tests, structural-analysis style
// (route-level-overview.test.ts precedent — Next.js server components can't
// be rendered in vitest without the full App Router runtime).
const PAGE_PATH = resolve(
  __dirname,
  "../../app/(app)/accounts/ledger/page.tsx",
);
const pageSource = readFileSync(PAGE_PATH, "utf-8");

describe("Ledger Explorer page — structural guardrails (ac06-spec §3.6)", () => {
  it('exports dynamic = "force-dynamic" (live balance requirement, code-standards §3.2)', () => {
    expect(pageSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_VIEW and READ, and no other permission", () => {
    expect(pageSource).toContain("PERMISSIONS.ACCOUNTS_VIEW");
    expect(pageSource).toContain("LEVELS.READ");
    expect(pageSource).toContain("requirePermission");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_CONFIG");
  });

  it("imports parseAccountsContext (sole context-strip URL parser, code-standards §3.1)", () => {
    expect(pageSource).toContain("parseAccountsContext");
  });

  it("has no server action declarations (read-only page, no write affordance)", () => {
    expect(pageSource).not.toContain('"use server"');
    expect(pageSource).not.toContain("'use server'");
  });

  it("has no form submissions with POST method (read-only page)", () => {
    expect(pageSource).not.toMatch(/method\s*=\s*["']post["']/i);
  });

  it("imports the balance-check strip, context strip, picker, grid, and drawer", () => {
    expect(pageSource).toContain("BalanceCheckStrip");
    expect(pageSource).toContain("ContextStrip");
    expect(pageSource).toContain("LedgerAccountPicker");
    expect(pageSource).toContain("LedgerTransfersGrid");
    expect(pageSource).toContain("TransferDetailDrawer");
  });

  it("never calls pgledger functions/views directly (repository-only access, module inv. #4)", () => {
    expect(pageSource).not.toContain("pgledger_");
  });
});

describe("Ledger Explorer shared components exist", () => {
  const componentRoot = resolve(__dirname, "../../components/accounts");

  it.each([
    ["balance-check-strip.tsx", "BalanceCheckStrip"],
    ["ledger-kind-chip.tsx", "LedgerKindChip"],
    ["ledger-account-picker.tsx", "LedgerAccountPicker"],
    ["ledger-transfers-grid.tsx", "LedgerTransfersGrid"],
    ["transfer-detail-drawer.tsx", "TransferDetailDrawer"],
  ])("%s exists and exports %s", (filename, exportName) => {
    const src = readFileSync(resolve(componentRoot, filename), "utf-8");
    expect(src).toContain(`export function ${exportName}`);
  });

  it("balance-check-strip never does a raw `< 0` comparison (signed-balance helpers only)", () => {
    const src = readFileSync(
      resolve(componentRoot, "balance-check-strip.tsx"),
      "utf-8",
    );
    expect(src).not.toContain("< 0");
  });
});

describe("ledger.repository.ts is the only pgledger_*_view caller for the new readers", () => {
  it("services/accounts/ledger-explorer.ts never queries pgledger views directly", () => {
    const src = readFileSync(
      resolve(__dirname, "../../services/accounts/ledger-explorer.ts"),
      "utf-8",
    );
    expect(src).not.toContain("pgledger_accounts_view");
    expect(src).not.toContain("pgledger_transfers_view");
    expect(src).not.toContain("pgledger_entries_view");
  });
});
