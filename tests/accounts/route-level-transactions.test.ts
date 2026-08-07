import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac07-spec §3.10 + ac20-spec §3.7 — route × level guardrail tests,
// structural-analysis style (route-level-ledger.test.ts precedent — Next.js
// server components can't be rendered in vitest without the full App Router
// runtime).
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
    // ac19 moved the ten create-panels into TransactionsActionBar.
    expect(pageSource).toContain("TransactionsActionBar");
    expect(pageSource).not.toContain("CapturePaymentPanel");
    expect(pageSource).not.toContain("CaptureDepositPanel");
    expect(pageSource).not.toContain("WriteOffPanel");
  });

  it("imports DocumentsTable and ApprovalBanner (ac20 — PendingApprovalsList absorbed)", () => {
    expect(pageSource).toContain("DocumentsTable");
    expect(pageSource).toContain("ApprovalBanner");
    // PendingApprovalsList retired by ac20.
    expect(pageSource).not.toContain("PendingApprovalsList");
  });

  it("imports DocumentDetailDrawer (ac21 — drawer replaces inline approve stopgap)", () => {
    expect(pageSource).toContain("DocumentDetailDrawer");
    expect(pageSource).toContain("getTransactionDocumentDetail");
  });

  it("SC11 — approve is reached from the drawer, not from a table row", () => {
    // Page wires the drawer; it no longer passes canEdit/currentUserId to
    // DocumentsTable (stopgap removed by ac21).
    expect(pageSource).toContain("DocumentDetailDrawer");
    expect(pageSource).not.toContain("InlineApproveButton");
  });

  it("imports listTransactionDocuments service (ac20 read path, inv. #15)", () => {
    expect(pageSource).toContain("listTransactionDocuments");
  });

  it("imports transactionsSearchParamsSchema (ac20 URL filter state, inv. #17)", () => {
    expect(pageSource).toContain("transactionsSearchParamsSchema");
  });

  it("SC11 — passes pending approval count to ApprovalBanner (banner above filters)", () => {
    expect(pageSource).toContain("ApprovalBanner");
    expect(pageSource).toContain("pendingApprovals.length");
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
    ["documents-table.tsx", "DocumentsTable"],
    ["approval-banner.tsx", "ApprovalBanner"],
    ["capture-deposit-panel.tsx", "CaptureDepositPanel"],
    ["reverse-deposit-panel.tsx", "ReverseDepositPanel"],
    ["refund-deposit-panel.tsx", "RefundDepositPanel"],
    ["raise-debit-note-panel.tsx", "RaiseDebitNotePanel"],
    ["raise-credit-note-panel.tsx", "RaiseCreditNotePanel"],
    ["write-off-panel.tsx", "WriteOffPanel"],
    ["rounding-adjustment-panel.tsx", "RoundingAdjustmentPanel"],
    ["reversals-panel.tsx", "ReversalsPanel"],
    ["closure-panel.tsx", "ClosurePanel"],
    // ac21 — document detail drawer
    ["document-detail-drawer.tsx", "DocumentDetailDrawer"],
    ["document-approval-actions.tsx", "DocumentApprovalActions"],
  ])("%s exists and exports %s", (filename, exportName) => {
    const src = readFileSync(resolve(componentRoot, filename), "utf-8");
    expect(src).toContain(`export function ${exportName}`);
  });

  it("pending-approvals-list.tsx is deleted (absorbed by ac20 documents table)", () => {
    expect(
      existsSync(resolve(componentRoot, "pending-approvals-list.tsx")),
    ).toBe(false);
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
      "list-transaction-documents.ts",
      "get-transaction-document-detail.ts",
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
      "list-transaction-documents.ts",
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

describe("inv. #15 — list-transaction-documents.ts read path never writes", () => {
  it("service contains no INSERT/UPDATE/DELETE/transaction and no pgledger call", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../services/accounts/list-transaction-documents.ts",
      ),
      "utf-8",
    );
    expect(src).not.toContain("insert");
    expect(src).not.toContain("update");
    expect(src).not.toContain("delete");
    expect(src).not.toContain("pgledger_");
    expect(src).not.toContain("db.transaction");
  });
});

describe("inv. #15 — get-transaction-document-detail.ts read path never writes (ac21)", () => {
  it("service contains no INSERT/UPDATE/DELETE/transaction and no pgledger base-table access", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../services/accounts/get-transaction-document-detail.ts",
      ),
      "utf-8",
    );
    // No write operations.
    expect(src).not.toContain(".insert(");
    expect(src).not.toContain(".update(");
    expect(src).not.toContain("delete(");
    expect(src).not.toContain("db.transaction");
    // pgledger access via repository only — no raw billing.pgledger_ reference.
    expect(src).not.toMatch(/\bbilling\.pgledger_/);
  });
});

describe("inv. #19 — exactly five document types offered (documents-table.tsx)", () => {
  it("DOC_TYPES has exactly five members and documents-table imports them for the type filter", () => {
    const src = readFileSync(
      resolve(__dirname, "../../components/accounts/documents-table.tsx"),
      "utf-8",
    );
    expect(src).toContain("DOC_TYPES");
    // Ensure no sixth type appears in the filter options.
    expect(src).not.toContain('"reversal"');
    expect(src).not.toContain('"refund"');
    expect(src).not.toContain('"write_off"');
  });
});
