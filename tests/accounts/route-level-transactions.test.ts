import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac07-spec §3.10 — route × level guardrail tests, structural-analysis style
// (route-level-ledger.test.ts precedent — Next.js server components can't be
// rendered in vitest without the full App Router runtime).
const PAGE_PATH = resolve(
  __dirname,
  "../../app/(app)/accounts/transactions/page.tsx",
);
const pageSource = readFileSync(PAGE_PATH, "utf-8");

describe("Transactions page — structural guardrails (ac07-spec §3.10)", () => {
  it('exports dynamic = "force-dynamic" (live balance requirement, code-standards §3.2)', () => {
    expect(pageSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_TRANSACTIONS and READ (view), and checks EDIT before rendering write panels", () => {
    expect(pageSource).toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
    expect(pageSource).toContain("LEVELS.READ");
    expect(pageSource).toContain("requirePermission");
    expect(pageSource).toContain("LEVELS.EDIT");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_VIEW");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_CONFIG");
  });

  it("imports parseAccountsContext (sole context-strip URL parser, code-standards §3.1)", () => {
    expect(pageSource).toContain("parseAccountsContext");
  });

  it("has no direct pgledger references (repository-only access, module inv. #4)", () => {
    expect(pageSource).not.toContain("pgledger_");
  });

  it("imports TransactionsActionBar (ten create-panels moved behind action launcher, ac19)", () => {
    // ac19 moved the ten create-panels into TransactionsActionBar; the page no
    // longer imports them individually. ReversalsPanel, ClosurePanel, and
    // PendingApprovalsList stay directly in the page (retired by ac22/D1/ac20).
    expect(pageSource).toContain("TransactionsActionBar");
    expect(pageSource).not.toContain("CapturePaymentPanel");
    expect(pageSource).not.toContain("CaptureDepositPanel");
    expect(pageSource).not.toContain("WriteOffPanel");
  });

  it("still imports PendingApprovalsList directly (to be absorbed by ac20)", () => {
    expect(pageSource).toContain("PendingApprovalsList");
  });

  it("imports the Reversals panel (ac11-spec §3.5 — retained until ac22)", () => {
    expect(pageSource).toContain("ReversalsPanel");
  });

  it("imports the Closure panel (ac16-spec §3.5 — deferred per D1)", () => {
    expect(pageSource).toContain("ClosurePanel");
  });
});

describe("Transactions shared components exist", () => {
  const componentRoot = resolve(__dirname, "../../components/accounts");

  it.each([
    ["doc-state-badge.tsx", "DocStateBadge"],
    ["transactions-action-bar.tsx", "TransactionsActionBar"],
    ["capture-payment-panel.tsx", "CapturePaymentPanel"],
    ["allocate-payment-panel.tsx", "AllocatePaymentPanel"],
    ["payment-refund-panel.tsx", "PaymentRefundPanel"],
    ["pending-approvals-list.tsx", "PendingApprovalsList"],
    ["capture-deposit-panel.tsx", "CaptureDepositPanel"],
    ["reverse-deposit-panel.tsx", "ReverseDepositPanel"],
    ["refund-deposit-panel.tsx", "RefundDepositPanel"],
    ["raise-debit-note-panel.tsx", "RaiseDebitNotePanel"],
    ["raise-credit-note-panel.tsx", "RaiseCreditNotePanel"],
    ["write-off-panel.tsx", "WriteOffPanel"],
    ["rounding-adjustment-panel.tsx", "RoundingAdjustmentPanel"],
    ["reversals-panel.tsx", "ReversalsPanel"],
    ["closure-panel.tsx", "ClosurePanel"],
  ])("%s exists and exports %s", (filename, exportName) => {
    const src = readFileSync(resolve(componentRoot, filename), "utf-8");
    expect(src).toContain(`export function ${exportName}`);
  });
});

describe("post-document.ts is the only pgledger_create_transfer(s) caller (code-standards §1.1, ac17 grep-gate)", () => {
  it("no service outside post-document.ts / ledger.repository.ts calls pgledger_create_transfer(s)", () => {
    const servicesToCheck = [
      "capture-payment.ts",
      "allocate-payment.ts",
      "refund-payment.ts",
      "document-state-machine.ts",
      "leg-templates.ts",
      "capture-deposit.ts",
      "reverse-deposit.ts",
      "refund-deposit.ts",
      "raise-debit-note.ts",
      "raise-credit-note.ts",
      "write-off.ts",
      "rounding-adjustment.ts",
      "reverse-document.ts",
      "reverse-line.ts",
      "get-reversal-preview.ts",
      "closure-eligibility.ts",
      "close-billing-account.ts",
      "close-financial-account.ts",
    ];
    for (const filename of servicesToCheck) {
      const src = readFileSync(
        resolve(__dirname, "../../services/accounts", filename),
        "utf-8",
      );
      expect(src).not.toContain("pgledger_create_transfer");
    }
  });
});

describe("no parseFloat/Number() on an amount outside money.ts (code-standards §2.2, ac17 grep-gate)", () => {
  it("post-document.ts and the PAY/DEP services never call parseFloat/Number on amounts", () => {
    const filesToCheck = [
      "post-document.ts",
      "capture-payment.ts",
      "allocate-payment.ts",
      "refund-payment.ts",
      "document-state-machine.ts",
      "capture-deposit.ts",
      "reverse-deposit.ts",
      "refund-deposit.ts",
      "raise-debit-note.ts",
      "raise-credit-note.ts",
      "write-off.ts",
      "rounding-adjustment.ts",
      "reverse-document.ts",
      "reverse-line.ts",
      "closure-eligibility.ts",
      "close-billing-account.ts",
      "close-financial-account.ts",
    ];
    for (const filename of filesToCheck) {
      const src = readFileSync(
        resolve(__dirname, "../../services/accounts", filename),
        "utf-8",
      );
      expect(src).not.toContain("parseFloat(");
      expect(src).not.toMatch(/(?<![.\w])Number\(/);
    }
  });
});
