// Domain unions (acctmgmt-code-standards.md §2.1, verbatim list) — every
// status/type/nature/kind column in `billing.*` is `text` + a CHECK listing
// these same members (ac02-spec §2.1), so a new value only ever needs
// changing here + the one CHECK, never a second pg-enum migration path.
export const DOC_TYPES = ["PAY", "DEP", "CRN", "DBN", "ADJ"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATES = [
  "draft",
  "pending_approval",
  "posted",
  "reversed",
  "cancelled",
] as const;
export type DocState = (typeof DOC_STATES)[number];

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
// `account-view.repository.ts`'s mapper (Q28); no page assembles a TMF shape
// ad hoc.
export type TmfRelatedParty = {
  id: string;
  role: "customer";
  name: string;
  "@referredType": "Customer";
};

export type TmfAccountRef = {
  id: string;
  accountType: "FinancialAccount" | "BillingAccount";
  name: string;
  description: string | null;
  state: AccountState;
  currency: string;
  relatedParty: TmfRelatedParty[];
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
