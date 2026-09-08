// Bill Run domain unions + read models (bm02-spec §3, code-standards §2.1).
// `as const` string-literal unions — never a TS `enum`, never re-declared;
// the same members appear inline in the `bill_run` CHECK constraints
// (db/schema/billing/bill-run.ts). Composed here in `types/` and returned by
// the service so the page never re-derives operability (code-standards §2.7).

export const RUN_STATUSES = [
  "SCHEDULED",
  "PROCESSING",
  "PROCESSED",
  "APPROVED",
  "POSTING",
  "INVOICED",
  "DISTRIBUTING",
  "COMPLETED",
  "PROCESSING_FAILED",
  "DISTRIBUTION_FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TYPES = ["onCycle", "offCycle"] as const;
export type RunType = (typeof RUN_TYPES)[number];

// bm03-spec §Design/§1. `EXCLUDED` is a bm03 addition to the plan's 9-member
// AccountStatus union (code-standards §2.1) — a scoping-time partial-period
// exclusion, never written by anything downstream of the trigger.
export const ACCOUNT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "PROCESSED",
  "INVOICED",
  "DISTRIBUTING",
  "COMPLETED",
  "PROCESSING_FAILED",
  "DISTRIBUTION_FAILED",
  "SKIPPED",
  "EXCLUDED",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// The two terminal history states (bm02-spec Design §Structural): Historical
// lists these read-only. Everything else lives in Current & Upcoming — a
// `*_FAILED` run is operable-again, not history.
export const TERMINAL_RUN_STATUSES = ["COMPLETED", "CANCELLED"] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

// One list row, fully derived by the read service (bm02-spec §3). `operable`
// is the single operable run per cycle (oldest `status < APPROVED`,
// `scheduled_run_date <= today`); `pastDue` marks a run whose period already
// closed (`scheduled_run_date <= today`). Period columns are calendar-date
// strings (`YYYY-MM-DD`); no money is shown in bm02.
export interface RunListRow {
  billRunId: string;
  cycleId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
  status: RunStatus;
  runType: RunType;
  operable: boolean;
  pastDue: boolean;
}

// The paginated run-list read model returned by the list service (bm02-spec
// §3/§4). Lives in `types/` so both the service and the UI can reference it
// without crossing the component → service boundary.
export interface RunListPage {
  tab: "current" | "historical";
  rows: RunListRow[];
  total: number;
  page: number;
  pageSize: number;
}

// bm04-spec §Design/§1, code-standards §2.1. The six pipeline stages built
// this release plus the three deferred ones (`posting`/`rendering`/
// `distribution`) modelled for state-machine completeness — matches the
// `bill_run_account_stage.stage` CHECK exactly.
export const STAGES = [
  "scoping",
  "validation",
  "collection",
  "aggregation",
  "taxation",
  "verification",
  "posting",
  "rendering",
  "distribution",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_STATUSES = [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "SKIPPED",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const ERROR_CLASSES = ["HARD", "SOFT", "INFRA"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

// bm04-spec §Implementation §9. The run-detail header read model — the
// Workflow tab (and the later tabs) compose around this. `lastProgressAt`
// (bm12-spec §Implementation §3) feeds the derived `isStalled` check and the
// `StallBanner`'s "no heartbeat since" display — never a stored `STALLED`
// value (architecture Inv. #10).
export interface RunDetail {
  billRunId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
  status: RunStatus;
  lastProgressAt: Date | null;
}

// One stage cell in the `StageTimeline` grid — `null` status means no signal
// has landed for this (account, stage) pair yet (rendered as the neutral
// `PENDING` badge, never a stored row).
export interface StageTimelineCell {
  stage: Stage;
  status: StageStatus | null;
  errorClass: ErrorClass | null;
}

export interface StageTimelineRow {
  billingAccountId: string;
  accountStatus: AccountStatus;
  cells: StageTimelineCell[];
}

// The Workflow tab's mid-flight summary — always derived from
// `bill_run_account`, never the optional cache (architecture Inv. #12).
export interface StageTimelineSummary {
  total: number;
  processed: number;
  processingFailed: number;
  excluded: number;
}

// bm05-spec §Design/§Implementation §2, code-standards §2.1. `customer_bill`
// domain unions — v1 only ever writes `category: 'trial'` / `state: 'new'`;
// `normal`/`last` and `validated`/`sent` are modelled for state-machine
// completeness (posting/taxation land in later units).
export const BILL_CATEGORIES = ["trial", "normal", "last"] as const;
export type BillCategory = (typeof BILL_CATEGORIES)[number];

export const BILL_STATES = ["new", "validated", "sent"] as const;
export type BillState = (typeof BILL_STATES)[number];

// bm06-spec §Implementation §4. One tax line on a bill — the GST category, the
// applied rate, and the SQL-computed amount (all `string`, code-standards
// §2.3). v1 writes a single GST line per bill; the shape supports more.
export interface CustomerBillTaxItemRow {
  category: string;
  rate: string;
  amount: string;
}

// bm05-spec §Implementation §2/§5, extended by bm06 §Implementation §4. The
// Customers & Bills tab's read model — one row per trial `customer_bill`,
// joined to the account name and its tax items. Money fields are `string`
// (code-standards §2.3); `subtotal` in v1 is a deterministic synthetic stub
// (`services/billing/aggregate-bill.ts`), `taxTotal` is the SQL SUM of the tax
// items (`services/billing/taxation.ts`), and `totalAmount = subtotal +
// taxTotal`.
// bm19-spec §Implementation §5 — `invoiceId` is `null` until the account
// posts (`category` flips `trial` → `normal` at the same moment, bm11); once
// set, the Customers & Bills tab swaps `InvoicePreviewModal` (draft) for
// `StoredInvoiceModal` (the issued, immutable record).
export interface CustomerBillRow {
  customerBillId: string;
  billingAccountId: string;
  accountName: string;
  category: BillCategory;
  currency: string;
  subtotal: string;
  taxTotal: string;
  totalAmount: string;
  paymentDueDate: string;
  taxItems: CustomerBillTaxItemRow[];
  invoiceId: string | null;
  // bm19-spec §Implementation §5 — true once the posted INV's final artifact
  // is rendered + stored. `invoiceId` set but this `false` is the tolerated
  // render-pending state (D10); the tab must not offer `StoredInvoiceModal`
  // then (it would 404) — retry lives on the Posting progress view.
  hasStoredInvoice: boolean;
}

// bm07-spec §Design/§2. The Uncharged tab's read model — one row per
// deliberately-not-billed account (`bill_run_account.status = 'EXCLUDED'`, a
// scoping-time partial-period exclusion). `reason` is the `error_code`
// (`PARTIAL_PERIOD` in v1); the uncharged window is the run period;
// `indicativeValue` has no source in v1 (no rating) — always `null`, rendered
// as "—". `financialAccountId` carries the account context for the deep link to
// Accounts → Transactions.
export interface UnchargedRow {
  billingAccountId: string;
  financialAccountId: string;
  accountName: string;
  reason: string;
  windowStart: string;
  windowEnd: string;
  indicativeValue: string | null;
}

// bm07-spec §Design/§2. The Errors tab's read model — one row per blocking
// `bill_run_account.status = 'PROCESSING_FAILED'` account, joined to its
// latest-attempt `HARD` `bill_run_account_stage` row. `errorClass` is always
// `HARD` here (the blocking class); `stage`/`errorCode`/`errorDetail` come from
// the failed stage row.
export interface ErrorRow {
  billingAccountId: string;
  accountName: string;
  stage: Stage;
  errorClass: ErrorClass;
  errorCode: string | null;
  errorDetail: string | null;
}

// bm11-spec §Visual. `PostingProgressView`'s read model — the DERIVED display
// status (never a stored column, same idiom as `StallState`): `PROCESSED`
// accounts carrying no `errorCode` are `pending`; `INVOICED` accounts are
// `invoiced`; a parked `PROCESSED` account (a tolerated per-account posting
// failure, Design "PERIOD_CLOSED handling") is `PERIOD_CLOSED` or `failed`
// depending on its `errorCode`.
export const POSTING_ACCOUNT_STATUSES = [
  "pending",
  "invoiced",
  "PERIOD_CLOSED",
  "failed",
] as const;
export type PostingAccountStatus = (typeof POSTING_ACCOUNT_STATUSES)[number];

// bm19-spec §Implementation §5 — `true` once the account's final invoice PDF
// is rendered and stored (`bill_run_invoices` row exists); `false` for an
// `invoiced` account still `pending`/render-pending (D10's tolerated,
// retryable state) and for every non-`invoiced` row (draws no meaning there).
export interface PostingProgressRow {
  billingAccountId: string;
  accountName: string;
  status: PostingAccountStatus;
  invoiceId: string | null;
  errorDetail: string | null;
  hasStoredInvoice: boolean;
}

export interface PostingProgress {
  billRunId: string;
  runStatus: RunStatus;
  rows: PostingProgressRow[];
  postedCount: number;
  totalCount: number;
}

// bm10-spec §Design/§Visual. The public Approve & Post view contracts. They
// live here (not in `services/**`) so the client components that render them
// (`ApproveAndPostPanel`, `PreApprovalChecks`) can import them without crossing
// the `components → services` boundary (eslint `boundaries/dependencies`); the
// approve service + read model import the same shapes.
export const PRE_APPROVAL_CHECKS = [
  "period_open",
  "gl_mappings",
  "positive_totals",
  "four_eyes",
  "accounts_terminal",
  "no_rejected_pending",
] as const;
export type PreApprovalCheckKey = (typeof PRE_APPROVAL_CHECKS)[number];

export interface PreApprovalCheck {
  check: PreApprovalCheckKey;
  pass: boolean;
  remediation: string | null;
}

// bm10 — the audit event types that record a run being (re)triggered. The
// four-eyes gate (`checkFourEyes`) bars every actor in these events from
// approving, and the Approve preview names the most-recent such actor — both
// must read the SAME set, so it lives here as one source of truth.
export const TRIGGER_EVENT_TYPES = [
  "BILL_RUN_TRIGGERED",
  "BILL_RUN_RERUN",
] as const;

// The Approve & Post page's read model (`getApprovePreview`) — the run header,
// the final trigger actor, the postable/skipped counts, and the live
// pre-approval checks for the current viewer.
export interface ApprovePreview {
  billRunId: string;
  cycleName: string;
  status: RunStatus;
  periodStart: string;
  periodEnd: string;
  triggeredByName: string | null;
  triggeredAt: Date | null;
  postableCount: number;
  skippedCount: number;
  currency: string | null;
  totalAmount: string;
  checks: PreApprovalCheck[];
}

// bm17-spec §Design "Reject model (b)". The marker stamped on a rejected
// account's latest (current-attempt) `bill_run_account_stage.error_code` —
// the account stays `PROCESSED` (no new `AccountStatus` member), so this is
// the only signal that it is not currently approvable. Shared by the reject
// service (the write), the `no_rejected_pending` pre-approval check, and the
// Errors tab's "Rejected — pending reprocess" read, so all three can never
// drift on the literal string.
export const REJECTED_PENDING_REPROCESS = "REJECTED_PENDING_REPROCESS";

// bm17-spec §Implementation §5. The Errors tab's "Rejected — pending
// reprocess" read model — one row per account currently carrying the marker.
export interface RejectedPendingRow {
  billingAccountId: string;
  accountName: string;
  errorDetail: string | null;
}
