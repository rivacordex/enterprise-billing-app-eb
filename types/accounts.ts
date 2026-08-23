// `Document` and `DocumentLine` are imported here so they refer to the schema
// types throughout this file. Without this import, TypeScript resolves
// `Document` to the DOM global from lib.dom.d.ts, since `export type { X }
// from "..."` re-exports don't bring identifiers into the file's own scope.
import type { Document, DocumentLine } from "@/db/schema";

// Domain unions verbatim from acctmgmt-code-standards.md §2.1 — the module's
// one source of truth; every CHECK constraint that guards one of these
// columns lists the same members inline in its schema file (ac02-spec §2.1).
// 'INV' added by bm09 (Accounts-side INV & posting enablement) — the sixth
// document type, created and auto-posted only by bm11's per-account billing
// posting; not offered by any operator-facing Accounts creation panel.
export const DOC_TYPES = ["PAY", "DEP", "CRN", "DBN", "ADJ", "INV"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATES = [
  "draft",
  "pending_approval",
  "posted",
  "reversed",
  "cancelled",
] as const;
export type DocState = (typeof DOC_STATES)[number];

// Forward transitions only (ac07-spec §2.2) — `reversed` is entered only by
// ac11's reversal, never by a transition listed here.
export const DOC_TRANSITIONS: Record<DocState, readonly DocState[]> = {
  draft: ["pending_approval", "posted", "cancelled"],
  pending_approval: ["posted"],
  posted: [],
  reversed: [],
  cancelled: [],
};

export const LINE_KINDS = [
  "capture",
  "allocation",
  "charge",
  "release",
  "refund",
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const LEDGER_ROLES = [
  "receivables",
  "unapplied_cash",
  "deposits",
] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

export const POSTING_NATURES = [
  "revenue",
  "revenue_adj",
  "write_off",
  "rounding",
  "cash",
  "deposit_movement",
] as const;
export type PostingNature = (typeof POSTING_NATURES)[number];

export const PAYMENT_MODES = ["bank_transfer", "cash", "cheque"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const ACCOUNT_STATES = ["active", "suspended", "closed"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

// overdue is derived, never stored (Q8).
export const PAYMENT_STATUSES = ["paid", "due", "in_dispute"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// TMF composition types (code-standards §2.6) — produced only by
// `account-view.repository.ts` (Q28); no page assembles this shape ad hoc.
export type TmfRelatedParty = {
  id: string; // PTRL… (party_role_id)
  role: "customer";
  name: string; // resolved organization name
  "@referredType": "Customer";
};

export type TmfAccountRef = {
  accountId: string; // FIN… or BAN…
  accountType: "FinancialAccount" | "BillingAccount";
  name: string;
  description: string | null;
  state: AccountState;
  currency: string;
  relatedParty: TmfRelatedParty[];
};

// Ledger Explorer types (ac06-spec §2.5) — components may only depend on
// `types/**`, never `services/**` (boundaries/dependencies), so these live
// here; `services/accounts/ledger-explorer.ts` is still their sole producer.
export type LedgerAccountKind = "ban" | "fa" | "sys";

export type LedgerAccountLabel = {
  kind: LedgerAccountKind;
  ownerId: string | null;
  ownerLabel: string | null;
};

export type LedgerAccountSearchResult = {
  id: string;
  name: string;
  currency: string;
  balance: string;
  label: LedgerAccountLabel;
};

export type LedgerAccountSummary = {
  id: string;
  name: string;
  currency: string;
  label: LedgerAccountLabel;
};

export type LedgerTransferListItem = {
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  fromLabel: LedgerAccountLabel;
  toAccountId: string;
  toAccountName: string;
  toLabel: LedgerAccountLabel;
  amount: string;
  eventAt: Date;
  createdAt: Date;
  metadataDoc: string | null;
};

export type LedgerTransferLeg = {
  accountId: string;
  accountName: string;
  label: LedgerAccountLabel;
  amount: string;
  accountPreviousBalance: string;
  accountCurrentBalance: string;
};

export type LedgerTransferDetail = {
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  toAccountId: string;
  toAccountName: string;
  amount: string;
  eventAt: Date;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
  legs: LedgerTransferLeg[];
};

export type ZeroSumRow = { currency: string; total: string; ok: boolean };

// Closure gate status (ac16-spec §2.1/§3.5) — the flattened shape
// `components/accounts/closure-panel.tsx` renders; the page maps the
// discriminated `services/accounts/closure-eligibility.ts` result onto this
// so the component depends only on `types/**` (boundaries/dependencies).
export type BillingAccountClosureStatus = {
  eligible: boolean;
  openReceivable: string;
};

export type FinancialAccountClosureStatus = {
  eligible: boolean;
  unappliedCash: string;
  deposits: string;
  openBillingAccountIds: string[];
};

// Refund workbench read-side shape (ac07-spec §2.4b) — the "assigned items"
// picker shared by both entry modes. Lives here (not the service file) so
// `components/accounts/payment-refund-panel.tsx` can depend on it without
// violating the `components → services` boundaries rule.
export type AssignedItem = {
  allocationLineId: string;
  paymentDocumentId: string;
  refSettledDocumentId: string | null;
  amount: string;
  eventAt: Date;
};

// Onboarding wizard read-side shapes (ac04-spec §3.5) — the options the
// customer onboarding wizard renders and the prior-accounts summary it lists.
// Live here (not the service files) so `components/customers/onboard-accounts-
// wizard.tsx` can depend on them without violating the components → services
// boundaries rule; `services/accounts/get-wizard-options.ts` and
// `list-prior-accounts.ts` remain their sole producers.
export type PriorAccountSummary = {
  financialAccountId: string;
  name: string;
  state: string;
};

export type WizardOptions = {
  activeCycles: { billCycleId: string; name: string; paymentDueDays: number }[];
  defaults: {
    currency: string;
    defaultBillCycleId: string | null;
    defaultCreditLimit: string | null;
  };
  priorAccounts: PriorAccountSummary[];
};

// Document list types (ac20-spec §2.4/§3.1) — repository raw row + service
// enriched row. Live in types/** so components depend only on types/**, not
// services/** (boundary rule). `list-transaction-documents.ts` is the sole
// producer of TransactionDocumentRow.
export type DocumentListRow = {
  documentId: string;
  docType: DocType;
  state: DocState;
  refFinancialAccountId: string;
  refBillingAccountId: string | null;
  reasonCode: string;
  currency: string;
  totalAmount: string;
  createdBy: string;
  approvedBy: string | null;
  eventAt: Date;
  // Needed for the inline approve stopgap (ac20) and the ac21 drawer CAS.
  lastModified: Date;
  unreversedLineCount: number;
  totalLineCount: number;
};

export type TransactionDocumentRow = DocumentListRow & {
  // Derived by list-transaction-documents.ts (§2.3) — components never compute
  // these. Mirror of reverse-document.ts's eligibility check (inv. #18).
  partiallyReversed: boolean;
  reversible: boolean;
  // Human-readable label: docType + reasonCode (§2.4, inv. #19).
  actionLabel: string;
};

// Document detail types (ac21-spec §3.1) — produced by
// get-transaction-document-detail.ts; components depend only on types/**,
// never services/** (boundaries rule).
export type DocumentLineWithTransfer = {
  line: DocumentLine;
  // null when pgledgerTransferId is unset (not yet posted) or when the
  // transfer row is not resolvable — renders an em-dash in the drawer (§2.3).
  transfer: {
    id: string;
    fromAccountId: string;
    fromAccountName: string;
    toAccountId: string;
    toAccountName: string;
    amount: string;
    eventAt: Date;
  } | null;
};

export type TransactionDocumentDetail = {
  document: Document;
  lines: DocumentLineWithTransfer[];
  // Mirror of list-transaction-documents derivation (inv. #18).
  partiallyReversed: boolean;
  // Cross-link: ID of the document that reverses this one, if any.
  reversedByDocumentId: string | null;
};

export type {
  FinancialAccount,
  FinancialAccountInsert,
  BillingAccount,
  BillingAccountInsert,
  BillCycle,
  BillCycleInsert,
  ReasonCode,
  ReasonCodeInsert,
  GlAccount,
  GlAccountInsert,
  GlMapping,
  GlMappingInsert,
  Document,
  DocumentInsert,
  DocumentLine,
  DocumentLineInsert,
  LedgerBinding,
  LedgerBindingInsert,
  AccountingPeriod,
  AccountingPeriodInsert,
} from "@/db/schema";
