// Bill Run domain unions + read models (bm02-spec §3, code-standards §2.1).
// `as const` string-literal unions — never a TS `enum`, never re-declared;
// the same members appear inline in the `bill_run` CHECK constraints
// (db/schema/billing/bill-run.ts). Composed here in `types/` and returned by
// the service so the page never re-derives operability (code-standards §2.7).

import type { billRunAccount } from "@/db/schema/billing/bill-run-account";
import type { billTemplateFamily } from "@/db/schema/billing/bill-template-family";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import type { ConfigStatus } from "@/types/system-config";

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

// The Workflow tab's per-account GRID columns (2026-09-18). `distribution` is
// deliberately NOT one of them: `bill_run_distribution` keys on `artifact_ref`,
// not on a billing account, and its `REPORT` artifact is run-level and belongs
// to no account at all — so a per-account distribution cell cannot be derived
// honestly. Distribution is represented once, at the run level, on the flow
// progress bar (which links to the Distribution tab where the real per-artifact
// delivery log lives). `STAGES` itself is unchanged: it still mirrors the
// `bill_run_account_stage.stage` CHECK exactly, and the M2M ingest still accepts
// every value in it.
export const TIMELINE_STAGES = STAGES.filter(
  (s): s is Exclude<Stage, "distribution"> => s !== "distribution",
);
export type TimelineStage = Exclude<Stage, "distribution">;

// The human label for each pipeline stage — the SINGLE source shared by the
// per-account grid header (`StageTimeline`, over the `TIMELINE_STAGES` subset)
// and the run-level flow bar (`RunFlowProgressBar`, over the full `Stage` set
// incl. `distribution`), so a rename can never make the two surfaces disagree.
export const STAGE_LABELS: Record<Stage, string> = {
  scoping: "Scoping",
  validation: "Validation",
  collection: "Collection",
  aggregation: "Aggregation",
  taxation: "Taxation",
  verification: "Verification",
  posting: "Posting",
  rendering: "Rendering",
  distribution: "Distribution",
};

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

// The flow progress bar's full state: the nine ordered steps, plus which one is
// current so the view can anchor the "go to the Distribution tab" hint without
// re-deriving it.
export interface RunFlowProgress {
  steps: RunFlowStep[];
  currentStage: Stage | null;
}

// The Workflow tab's mid-flight summary — always derived from
// `bill_run_account`, never the optional cache (architecture Inv. #12).
//
// `isMidFlight` (2026-09-18) gates whether the counts are worth showing at all.
// They describe the PROCESSING phase, and once posting starts moving accounts
// `PROCESSED → INVOICED`/`SKIPPED` they all read zero — so a finished run
// rendered "0 processed, 0 processing failed of 6" directly beneath a fully
// green flow bar. Derived from the run's status, not from the counts, so an
// in-flight run that genuinely has nothing processed yet still shows "0 of N".
export interface StageTimelineSummary {
  total: number;
  processed: number;
  processingFailed: number;
  excluded: number;
  isMidFlight: boolean;
}

// The run-level flow progress bar (2026-09-18) — one step per `Stage`, in flow
// order, summarising where the WHOLE run has got to. Derived on every read from
// the same account/stage data as the grid plus `bill_run.status`; never stored
// (architecture Inv. #12).
//
// `done`    — every eligible account cleared this step
// `current` — the run is here now (the first step not yet done)
// `failed`  — this step failed for at least one account, or the run is in that
//             step's terminal failure state
// `pending` — not reached yet
// `skipped` — the whole step was bypassed (no eligible account)
export const FLOW_STEP_STATES = [
  "pending",
  "current",
  "done",
  "failed",
  "skipped",
] as const;
export type FlowStepState = (typeof FLOW_STEP_STATES)[number];

export interface RunFlowStep {
  stage: Stage;
  state: FlowStepState;
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
  // bm28-spec §Implementation §4/§5 — the bill's `customer_bill_line` rows
  // (the invoice's face), ordered by `lineNo`. Replaces bm05's synthetic
  // "Stub charges (fixture)" line; an empty array means Aggregation wrote no
  // usage line for this account (a zero-usage bill this phase).
  lines: BillLineRow[];
  invoiceId: string | null;
  // bm19-spec §Implementation §5 — true once the posted INV's final artifact
  // is rendered + stored. `invoiceId` set but this `false` is the tolerated
  // render-pending state (D10); the tab must not offer `StoredInvoiceModal`
  // then (it would 404) — retry lives on the Posting progress view.
  hasStoredInvoice: boolean;
}

// bm28-spec §Design/§Implementation §4, code-standards §2.1. The phase-3
// `customer_bill_line` domain unions — the typed mirror of the schema CHECKs
// (db/migrations/0039), and the FIRST consumer of `customer_bill_line`. Every
// line bm28 produces is `USAGE`/`charge`; `RECURRING` (bm29) and the reserved
// `OCC` (unbuilt, Inv #16/D30), plus `discount`/`adjustment`, exist so a later
// source or a bundle-level discount lands without a migration against a posted
// table. The `ChargeSourceBadge` that renders `ChargeSource` first distinguishes
// something in bm29 — bm28 introduces the union, not the badge.
export const CHARGE_SOURCES = ["USAGE", "RECURRING", "OCC"] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

export const LINE_TYPES = ["charge", "discount", "adjustment"] as const;
export type LineType = (typeof LINE_TYPES)[number];

// bm28-spec §Design/§Implementation §4, extended by bm29 §Implementation §5,
// code-standards §2.8. One `customer_bill_line` row — the invoice's face
// (`CustomerBillView` now composes these, not `rating.udr_rated` rows; the
// `udr_rated` per-record drill-down is reached by `groupingKey` on demand). Money
// fields are `string` (code-standards §2.3); `udrType` is set for `USAGE` lines
// and `null` for `RECURRING`; `quantity`/`unit`/`udrCount`/`description` are
// nullable to admit both sources. A `RECURRING` line carries its price snapshot
// (`snapshot*`, D19/Inv #20) — the reviewer's evidence in place of a `udr_rated`
// drill-down (a derived recurring charge has no per-record source); all four
// snapshot fields are `null` for `USAGE`. bm44 (Target Capacity Pricing update,
// Unit 4): a capacity `USAGE` line is the exception to the plain-USAGE shape —
// it carries a non-null `ratedAmount`/`additionalInfo` pair (see below), unlike
// an ordinary USAGE line which has no `additionalInfo`. Ordered by `lineNo`
// (deterministic, Inv #21).
export interface BillLineRow {
  customerBillLineId: string;
  lineNo: number;
  source: ChargeSource;
  lineType: LineType;
  refProductOfferingId: string;
  udrType: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  udrCount: number | null;
  groupingKey: string;
  currency: string;
  snapshotPriceRef: string | null;
  snapshotUnitPrice: string | null;
  snapshotQuantity: string | null;
  snapshotEffectiveDate: string | null;
  // bm41-spec §Implementation §3 (Target Capacity Pricing update, Unit 1).
  // `ratedAmount` is the rated side of the reconciliation: NULL for RECURRING,
  // `= grossAmount` on non-capacity USAGE, the sum of the rated rows on a
  // capacity line. `additionalInfo` is the versioned calc trace, set on
  // capacity lines only (NULL elsewhere this phase) — opaque to the checksum
  // (Inv #35). Both land NULL until bm42 writes capacity lines.
  ratedAmount: string | null;
  additionalInfo: CapacityCalcTrace | null;
}

// bm41-spec §Implementation §3 / billmgmt-code-standards.md §"TypeScript
// conventions" — the versioned shape of `customer_bill_line.additional_info`.
// Typing only here; bm42 is the writer. bm68 (D31) removed bm45's per-polygon
// `appendix` key: the trace is `pricing`, `calc[]` and `summary[]` only.
//
// bm42a — money-as-text contract: every monetary amount, rate and decimal
// quantity inside this trace (`pricing.*`, `calc[*]`) is a JSON
// STRING at its canonical scale (money 2dp, quantities and rates 6dp, e.g.
// "100000.00", "400.000000"), matching TS rule 3. Integers that are not money
// (`v`, `calc[*].udrCount`, `calc[*].band`) stay numbers, and
// `pricing.motivation.steps` is a verbatim copy of the catalog component.
// `calc`/`pricing` stay `unknown`-typed: nothing in the app reads them (the
// trace is database-only, TC26). The flow's verification reads them with
// `->>` + a numeric cast.
export interface CapacityCalcTrace {
  v: number;
  productInventoryId: string;
  pricing: Record<string, unknown>;
  calc: unknown[];
  summary: unknown[];
}

// bm28-spec §Design "the udr_rated drill-down". One claimed `rating.udr_rated`
// record behind a USAGE line's lazily-fetched `<details>` disclosure — the
// per-record drill-down (`ratedLinesRepository.listClaimedForAccount`), fetched
// on expand only (the bm18 fetch-on-open pattern), never eager: a volume account
// can sit behind thousands of records. Timeline fields are ISO strings over the
// server-action wire (a plain object, not a `Date` — it crosses to the client).
export interface RatedLineRow {
  udrId: string;
  udrType: string;
  startDatetime: string;
  endDatetime: string;
  udrUsageQuantity: string;
  udrUsageUnit: string;
  udrRatedPrice: string;
  udrCurrency: string;
}

// bm07-spec §Design/§2, REDEFINED by bm32 §Design (Inv #22). The Uncharged
// tab's read model — one row per scoped, non-`EXCLUDED` account that produced
// **no `customer_bill_line`** (or whose lines net to zero) this run. The shape
// is unchanged from bm07, but `reason` no longer carries the scoping
// `error_code`: it is now a billing-outcome label — `NO_CHARGE_LINES` (no line
// at all) or `NETS_TO_ZERO` (lines summing to zero). `EXCLUDED` accounts (a
// scoping-time partial-period exclusion) belong to **neither** Uncharged nor
// the exception surface (Inv #26) — they never reached a stage that could
// produce a line, and stay visible only via their `AccountStatusBadge` on the
// Workflow timeline. `indicativeValue` still has no source (always `null`,
// rendered "—"); `financialAccountId` carries the account context for the deep
// link to Accounts → Transactions.
export interface UnchargedRow {
  billingAccountId: string;
  financialAccountId: string;
  accountName: string;
  reason: string;
  windowStart: string;
  windowEnd: string;
  indicativeValue: string | null;
}

// bm32-spec §Design/§Implementation §2. The per-record exception surface — the
// two "things not on the bill" that are records, not accounts (Info family,
// never blocking): a `BILL_NOTUSED` rated usage row, or an `ORPHAN` (an
// unclaimed live `RATED` `RAN_USAGE` row Collection left behind, Inv #25/D32).
// A resolvable orphan shows its `accountName` (via `udr_subscription_ref_id →
// inventory.product_inventory → billing_account`); an **unresolvable** one (no
// `product_inventory`) shows a `null` account and is identified by
// `subscriberRef` — it is never dropped (revenue leakage). Money/usage fields
// are `string` (code-standards §2.3).
//
// known-issues §28 option 1 (owner decision, 2026-10-19) adds `PRIOR_PERIOD`:
// a run account's unclaimed live `RATED` `RAN_USAGE` usage dated BEFORE the
// run's period (rated late, released at approval for a SKIPPED account, or a
// partial-period exclusion). No run bills it any more, so it is surfaced, never
// dropped. One row per (account, subscriber, usage type, unit, currency,
// billing period): `usagePeriodStart`/`usagePeriodEnd` bound that period (the
// cycle's, `YYYY-MM-DD`; a calendar month when cycle_day = 1) and
// `recordCount` the records it sums. `BILL_NOTUSED`/`ORPHAN` rows are one
// record each (both period fields null, `recordCount` 1).
export const EXCEPTION_KINDS = [
  "BILL_NOTUSED",
  "ORPHAN",
  "PRIOR_PERIOD",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export interface ExceptionRow {
  kind: ExceptionKind;
  subscriberRef: string;
  accountName: string | null;
  udrType: string;
  quantity: string;
  unit: string;
  ratedPrice: string;
  currency: string;
  usagePeriodStart: string | null;
  usagePeriodEnd: string | null;
  recordCount: number;
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
// depending on its `errorCode`. Review fix (2026-10-16) — an account that
// posting itself skipped (no INV issued) is `skipped`, shown with its reason.
export const POSTING_ACCOUNT_STATUSES = [
  "pending",
  "invoiced",
  "PERIOD_CLOSED",
  "failed",
  "skipped",
] as const;
export type PostingAccountStatus = (typeof POSTING_ACCOUNT_STATUSES)[number];

// The `error_code`s `postAccount` writes when it skips an account without an
// invoice: the zero-total suppression and the D58 NULL-template skip. An
// account SKIPPED at approval (it was PROCESSING_FAILED/EXCLUDED, never
// postable) carries neither and stays off the posting view.
export const POSTING_SKIP_CODES = [
  "ZERO_TOTAL_NOT_INVOICED",
  "TEMPLATE_VERSION_NOT_FOUND",
] as const;

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
  // Postable accounts, excluding the ones posting skipped.
  totalCount: number;
  skippedCount: number;
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
  // bm65–bm67 review fix (2026-10-16, owner decision; amends D58) — BLOCKING:
  // every PROCESSED account must carry a captured generated template version.
  // A NULL or missing capture (D55) would otherwise be skipped at posting,
  // after approval, when the account can no longer be rerun.
  "template_versions_captured",
  // bm32-spec §Design/§Implementation §3 — the orphaned-usage-record count.
  // INFORMATIONAL, never blocking (D32/Inv #25): it always `pass`es and is
  // excluded from `approveRun`'s blocking gate.
  "orphan_count",
  // 2026-09-17 (owner decision) — the zero-total-bill count. INFORMATIONAL,
  // never blocking, same contract as `orphan_count`. The visible half of the
  // sign-based rule: `positive_totals` blocks only a NEGATIVE total, a zero bill
  // is simply not posted (`post-run.ts`), so the zero totals still have to be
  // reported — just not gated.
  "zero_total_bills",
  // known-issues §28 option 1 (owner decision, 2026-10-19) — the count of the
  // run accounts' unbilled usage from EARLIER periods (the `PRIOR_PERIOD`
  // exception rows). INFORMATIONAL, never blocking, same contract as
  // `orphan_count`: no run bills that usage, so the approver must see it and
  // billing raises an adjustment.
  "prior_period_usage",
] as const;
export type PreApprovalCheckKey = (typeof PRE_APPROVAL_CHECKS)[number];

// bm32 adds `informational` (default false/undefined). An informational check
// ALWAYS `pass`es and never contributes to `approveRun`'s `CHECKS_FAILED` gate;
// the checklist renders it as an Info line (no blocking remediation).
export interface PreApprovalCheck {
  check: PreApprovalCheckKey;
  pass: boolean;
  remediation: string | null;
  informational?: boolean;
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

// bm20-spec §Design/§1. `bill_run_distribution` domain unions — the
// distributor's per-artifact-per-target outcome record. `artifactType`
// distinguishes a per-account invoice PDF from the one transient per-run
// report CSV (D21 — the report gets no `bill_run_output` row, only a
// delivery-log entry here).
export const DISTRIBUTION_ARTIFACT_TYPES = [
  "invoice_pdf",
  "report_csv",
] as const;
export type DistributionArtifactType =
  (typeof DISTRIBUTION_ARTIFACT_TYPES)[number];

export const DISTRIBUTION_OUTCOMES = ["DELIVERED", "FAILED"] as const;
export type DistributionOutcome = (typeof DISTRIBUTION_OUTCOMES)[number];

// bm20-spec §Visual/§Implementation §6. One delivery-log row — a single
// `bill_run_distribution` outcome, joined to nothing else (the row is already
// self-describing). `DistributionTab` renders these grouped by target.
export interface DistributionRow {
  billRunDistributionId: string;
  target: string;
  artifactRef: string;
  artifactType: DistributionArtifactType;
  isMandatory: boolean;
  outcome: DistributionOutcome;
  at: Date;
  distributionAttempt: number;
}

// bm20-spec §Visual/D-T3. The Distribution tab's read model — the four
// state-dependent views (INVOICED-pending / DISTRIBUTING / COMPLETED /
// DISTRIBUTION_FAILED) all share this one shape; the component branches on
// `runStatus` (never a separate prop per state).
export interface DistributionView {
  billRunId: string;
  runStatus: RunStatus;
  hasExecution: boolean;
  targets: { name: string; isMandatory: boolean }[];
  rows: DistributionRow[];
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

// ============================================================================
// bm47 — Invoice binder (Invoice Template update, Part 4). `InvoiceRenderInput`
// is the Handlebars bind target produced by `services/billing/invoice-template/
// bind.ts` from `customer_bill_line` + `customer_bill_tax_item` +
// `billing.document` + `customer.organization`/`contact_medium` (Inv #39).
// Every optional key is present with `null`, never `undefined` — Handlebars
// `strict: true` throws on a missing property, a present `null` is falsy for
// `{{#if}}` and does not throw (D4). `company`/`payment` stay `null` until a
// profile exists (G15 interim; bm53/bm61 fill them).
// ============================================================================

export interface InvoiceAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  country: string | null;
}

// bm53-spec §Design D3 — populated from the ACTIVE (or stamped) `invoice.profile`
// version; the field names are the D3 placeholder names (catalog §A). `state`/
// `country` are labels derived from the codes (`lib/myinvois-states.ts`).
// `logoUrl` is the checksum-verified logo as a `data:` URI (D4), or `null` when
// the profile carries no logo (the header then hides it).
export interface InvoiceCompany {
  name: string;
  registrationNo: string;
  tin: string;
  sstRegNo: string | null;
  addressLine1: string;
  addressLine2: string | null;
  postcode: string;
  city: string;
  stateCode: string;
  state: string;
  countryCode: string;
  country: string;
  phone: string;
  email: string;
  website: string | null;
  brandColor: string;
  accentColor: string;
  logoUrl: string | null;
}

export interface InvoicePayment {
  bankName: string;
  accountName: string;
  accountNo: string;
  swift: string;
  jomPayBillerCode: string | null;
  remittanceEmail: string;
}

// bm62 D2 — one CSV row (one `customer_bill_line`), the `line.*` scope of the
// CSV column map. `periodStart`/`periodEnd` come from the bill header (lines
// carry no own period); `unitPrice` is the RECURRING price snapshot (NULL for
// USAGE). bm71 retired the PDF line table that first used this shape; the CSV
// builds it straight from the bill's lines.
export interface InvoiceLine {
  lineNo: number;
  source: ChargeSource;
  description: string;
  productOfferingId: string;
  udrType: string | null;
  udrCount: number | null;
  periodStart: string;
  periodEnd: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  discountNote: string | null;
}

// bm49-spec §Design D3 — the billed-usage-row bound, a named constant equal to
// bm45's former appendix bound (the load-tested bound; that flow guard was
// removed by bm68, so this is now the only per-account row bound). bm71 (D37)
// applies it to the capacity detail rows. Over this, the bind fails
// `INVOICE_USAGE_OVER_LIMIT` and the account parks; the repository selects no
// rows. Changing it is a spec change, not a config value.
export const INVOICE_USAGE_ROW_LIMIT = 10_000;

// D9 — read from the layout manifest, validated by
// `validation/billing/layout-page-setup.schema.ts`.
export interface LayoutPageSetup {
  format: "A4";
  orientation: "portrait" | "landscape";
  margin: { top: string; bottom: string; left: string; right: string };
  displayHeaderFooter: boolean;
  printBackground: boolean;
}

// bm70-spec §Design (D28/D30/D47) — one page-1 type-of-service block. Every
// figure is a SQL `numeric(18,2)::text`: Unutilised = Σ(gross − rated),
// Utilised = Σ net − Unutilised, Total = Σ net. Utilised is never negative
// once bound (`INVOICE_NEGATIVE_UTILISED`, Inv #55). bm71 adds `regions`, the
// type's detail pages (`[]` when no usage row was claimed, e.g. 0 Mbps).
export interface InvoiceServiceType {
  offeringId: string;
  label: string;
  utilised: string;
  unutilised: string;
  total: string;
  regions: InvoiceCapacityRegion[];
}

// bm71-spec §Design "Bind shape" (D21, Inv #56) — one State-District group of
// a type's detail pages. `label` is `STATE - DISTRICT`, the one part present,
// or "Unassigned region" (sorted last); `subTotal` is the SQL Σ of the group's
// row amounts.
export interface InvoiceCapacityRegion {
  label: string;
  rows: InvoiceCapacityDetailRow[];
  subTotal: string;
}

// bm71 — one detail row: one polygon of one type of service.
// `polygonStartDate` is the ISO date from `udr_resource` (printed by `date`);
// `polygonName` the `polygon_id=` value of `udr_key`; `capacityMbps` the
// monthly peak; `ratePerMbps` the base rate stamped at rating; `amount` the
// row's `numeric(18,2)` rated price.
export interface InvoiceCapacityDetailRow {
  polygonStartDate: string;
  polygonName: string;
  capacityMbps: string;
  ratePerMbps: string;
  amount: string;
}

// D4 — keys mirror the placeholder roots in
// `invoice-template/placeholder-catalog.md`. `poRef`/`contractRef`/`sstRegNo`
// are always `null` this unit (G9 interim — no source before a profile
// exists); their fragments are wrapped in `{{#if}}` in the layout and never
// render a blank label.
export interface InvoiceRenderInput {
  // bm53-spec §Design D5 — the resolved layout's code/version_no and the
  // resolved generated version's version_no.
  template: {
    layoutCode: string;
    layoutVersion: number;
    version: number;
  };
  company: InvoiceCompany | null;
  payment: InvoicePayment | null;
  invoice: {
    number: string | null;
    isDraft: boolean;
    date: string | null;
    periodStart: string;
    periodEnd: string;
    dueDate: string | null;
    // bm53-spec §Design D5 — the profile's `payment_terms_days`, or `null`
    // when no profile resolves (G15 A).
    paymentTermsDays: number | null;
    currency: string;
    billRunId: string;
    cycleName: string;
    billRef: string;
    poRef: null;
    contractRef: null;
  };
  customer: {
    billingAccountId: string;
    // bm70 (D16) — the bill-to recipient line; `null` (line omitted) when the
    // preferred (or fallback first) contact has a blank name.
    recipientName: string | null;
    name: string;
    tradingName: string | null;
    registrationNo: string | null;
    tin: string | null;
    sstRegNo: null;
    address: InvoiceAddress | null;
    email: string | null;
    phone: string | null;
  };
  totals: {
    grossTotal: string;
    discountTotal: string;
    subtotalExclTax: string;
    taxTotal: string;
    // bm72 (D22, D30) — the last page's "Total Amount": Σ per-type Utilised,
    // summed in SQL. Never the amount due (P10); that is `amountDue`.
    totalAmount: string;
    amountDue: string;
    // bm70 (D14/D60) — page 1: "Total charges" (= `customer_bill.subtotal`),
    // "Adjustments" (always shown, `0.00` this phase) and the "Other charges"
    // Sub Total. SQL sums, never a JS reduce.
    totalCharges: string;
    adjustments: string;
    otherChargesSubTotal: string;
  };
  taxes: { category: string; rate: string; amount: string }[];
  // bm70 (D15) — the "Tax @ x%" rate: `taxes[0]?.rate ?? "0"`, printed by the
  // layout as `{{taxRateLabel}}%`.
  taxRateLabel: string;
  // bm70 (D28/D60) — one Utilised / Unutilised / Total block per capacity type
  // of service, sorted by label; bm71 — each with its detail `regions`.
  serviceTypes: InvoiceServiceType[];
  // bm70 (D60) — the non-capacity charge lines; the block is absent when empty.
  otherCharges: { description: string; amount: string }[];
  // bm72 (D19, D20) — the footnote of the structure in use (the editor's
  // unsaved one in a preview, else the resolved generated version's): one
  // plain-text paragraph per line after Total Amount.
  footnote: string[];
  isDraft: boolean;
  locale: string;
  timezone: string;
}

// ============================================================================
// bm50 — Invoice template catalog (Invoice Template update, Part 4). Unions +
// the admin structure shape backing `billing.bill_template_version`. Schema in
// `db/schema/billing/{bill-format,bill-template-version,bill-asset}.ts`.
// ============================================================================

export const BILL_FORMAT_CODES = ["INVOICE"] as const;
export type BillFormatCode = (typeof BILL_FORMAT_CODES)[number];

// No `xml` kind in v1 (R3).
export const TEMPLATE_KINDS = ["layout", "generated", "csv"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

// DRAFT → ACTIVE → RETIRED — the same three values as `core.system_config.status`
// (reused, never a second copy — code-standards Part 2 TS rule 1).
export type TemplateVersionStatus = ConfigStatus;

export const BILL_ASSET_KINDS = ["logo"] as const;
export type BillAssetKind = (typeof BILL_ASSET_KINDS)[number];

// The invoice's section keys (header/pageTwoHeader/footer are fixed layout
// parts, not section keys; accountSummary dropped, R2; bm71 (D56) retired
// `usageAnnex` with the old annex; bm72 (D56 part 2) retired `notes` — the
// footnote after Total Amount, inside `chargeDetails`, replaces it).
export const INVOICE_SECTION_KEYS = [
  "billTo",
  "identification",
  "amountDue",
  "chargeSummary",
  "taxSummary",
  "payment",
  "chargeDetails",
] as const;
export type InvoiceSectionKey = (typeof INVOICE_SECTION_KEYS)[number];

// The sections an admin may hide; every other section is mandatory-on and is
// not stored in the structure (bm71, D56; bm72 removed `notes`).
export const INVOICE_OPTIONAL_SECTION_KEYS = ["payment"] as const;
export type InvoiceOptionalSectionKey =
  (typeof INVOICE_OPTIONAL_SECTION_KEYS)[number];

// bm55-spec §Design D2 — `InvoiceSectionKey` minus `InvoiceOptionalSectionKey`:
// the sections that are locked on (the structure schema refuses `false`).
export type InvoiceMandatorySectionKey = Exclude<
  InvoiceSectionKey,
  InvoiceOptionalSectionKey
>;
export const MANDATORY_SECTION_KEYS = INVOICE_SECTION_KEYS.filter(
  (key): key is InvoiceMandatorySectionKey =>
    !(INVOICE_OPTIONAL_SECTION_KEYS as readonly string[]).includes(key),
);

// The admin structure stored in `bill_template_version.structure` (the bm55 Zod
// schema validates it; typed here so bm50's Drizzle mirror and repositories
// have a shape before that schema exists). bm71 (D56): only the optional
// sections are stored, and `columns` is always `{}` (the layout has no admin
// column toggles). bm72 (D20, Inv #46 amended): `footnote` is 1–5 plain-text
// lines of at most 200 characters, printed after Total Amount.
export interface InvoiceTemplateStructure {
  sections: Record<InvoiceOptionalSectionKey, boolean>;
  columns: Record<string, never>;
  footnote: string[];
}

// bm64-spec §Design — one `bill_template_family` row (general §2.7). The
// seeded Standard family (`BTF00000001`) is the default; read by bm65 capture.
export type BillTemplateFamily = typeof billTemplateFamily.$inferSelect;

// bm55-spec §Design D4 — Version history read model (one row per generated
// version, newest first). `usedByCount` counts `customer_bill` rows stamped
// with the version (SQL count, `listForKind`). `createdBy` is the stored
// appuser id (names are not resolved — the rate-card precedent).
export interface TemplateVersionHistoryRow {
  billTemplateVersionId: string;
  versionNo: number;
  status: TemplateVersionStatus;
  isDefault: boolean;
  layoutLabel: string;
  createdBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  changeNote: string | null;
  usedByCount: number;
}

// bm55-spec §Design D4 — a posted bill offered as a live-preview source
// (only to `billrun_view : READ` holders).
export interface RecentPostedBill {
  customerBillId: string;
  invoiceNumber: string;
  billingAccountId: string;
  accountName: string;
}

// ============================================================================
// bm53 — Template and profile resolution (Invoice Template update, Part 4).
// `services/billing/invoice-template/resolve-template.ts` + `load.ts`.
// ============================================================================

// The `customer_bill` template stamp columns (bm50 D5; the family, bm67). All
// `null` on a bill posted before bm54, which introduces the stamping; the
// family is `null` on a bill posted before bm67. Resolution never reads the
// family: the version id already pins the layout.
export interface PostedBillStamps {
  refBillTemplateFamilyId: string | null;
  refBillTemplateVersionId: string | null;
  refInvoiceProfileVersion: number | null;
  refCsvTemplateVersionId: string | null;
}

// bm65-spec §2 (Inv #51/#52) — the run-start template stamps on one
// `bill_run_account` row (read by bm66 drafts and bm67 posting). All nullable:
// EXCLUDED rows are never captured, and a family with no ACTIVE or default
// generated version captures a NULL version (D55, Inv #58).
export type RunTemplateStamps = Pick<
  typeof billRunAccount.$inferSelect,
  | "refBillTemplateFamilyId"
  | "refBillTemplateVersionId"
  | "refInvoiceProfileVersion"
  | "refCsvTemplateVersionId"
>;

// bm67-spec §2 — the template stamps `stampPosted` writes, derived from the
// run stamps (code-standards Phase 3 TS rule 2: one stamp shape, never
// hand-written). Posting skips a NULL captured version first (D58), so the
// family, generated and CSV ids are non-null here; the profile may be null
// (G15 A).
export type PostingTemplateStamps = {
  refBillFormatId: "INVOICE";
  refInvoiceProfileVersion: RunTemplateStamps["refInvoiceProfileVersion"];
} & {
  [K in
    | "refBillTemplateFamilyId"
    | "refBillTemplateVersionId"
    | "refCsvTemplateVersionId"]: NonNullable<RunTemplateStamps[K]>;
};

// bm65-spec §Design — one captured BAN, as listed in the BILL_RUN_TRIGGERED /
// BILL_RUN_RERUN audit `afterData.templateStamps`. `versionId` may be null (D55);
// `familyId` is null only when the BAN's family cannot be resolved (a corrupted
// catalog, or a reference to a non-generated version — review fix §24e).
export type CapturedTemplateStamp = {
  banId: string;
  familyId: string | null;
  versionId: string | null;
};

// bm66-spec §Design (D33, Inv #42/#51/#53) — which versions a render uses.
//   run             → a draft PRO-FORMA inside a run: the BAN's captured
//                     `bill_run_account` stamps (bm65). Never live.
//   final           → the bill's stamps (Inv #42 — never the current ACTIVE).
//   preview-posted  → the editor preview of a posted bill: the bill's stamps.
//   preview-family  → the Invoice Settings preview: the family's live, current
//                     versions — the only live render mode.
export type RenderMode =
  // `banId` rides along for the error detail (code-standards Phase 3 TS
  // rule 8: `{ reason, familyId, banId }`).
  | { kind: "run"; stamps: RunTemplateStamps; banId: string }
  | { kind: "final"; bill: PostedBillStamps }
  | { kind: "preview-posted"; bill: PostedBillStamps }
  // bm79 review fix — `draft`: the editor previews its working DRAFT (EDIT
  // only, decided by the preview action): the settings DRAFT and the layout it
  // points at, which may itself be a DRAFT (an uploaded pair).
  | { kind: "preview-family"; familyId: string; draft?: true };

// D1 — never cached (workflow rules §3.9): every render queries the rows.
export interface ResolvedTemplate {
  // kind = 'generated'; a DRAFT only in the editor's draft preview (bm79)
  generated: BillTemplateVersion;
  // generated.ref_layout_version_id (page_setup); a DRAFT only in that preview
  layout: BillTemplateVersion;
  profileVersion: number | null; // G15 A: null when none ACTIVE / none stamped
  csv: BillTemplateVersion; // kind = 'csv'
}

// D3 — the parsed `invoice.profile` version (`invoiceProfileSchema`). The
// logo is carried as its asset-version id; `company.logoUrl` holds the
// verified `data:` URI once D4 inlines it (`null` before, or without a logo).
export interface InvoiceProfile {
  configVersion: number;
  company: InvoiceCompany;
  payment: InvoicePayment;
  paymentTermsDays: number;
  logoAssetVersionId: string | null;
}

// bm47-spec §Implementation §2 — binding names (code-standards TS rule 7).
export const INVOICE_ERROR_CODES = [
  "INVOICE_RECONCILIATION_FAILED",
  "TEMPLATE_COMPILE_FAILED",
  "INVOICE_DOCUMENT_MISMATCH",
  // bm49-spec §Design D3 — the usage annex exceeds the 10,000-row bound; the
  // bind fails loud and the account parks (no truncation, no partial annex).
  "INVOICE_USAGE_OVER_LIMIT",
  // bm53-spec §Design D2/D4 — a stored template file (or its `checksums.json`
  // index) or a logo's bytes do not match the recorded SHA-256 (Inv #45).
  "TEMPLATE_CHECKSUM_MISMATCH",
  "ASSET_CHECKSUM_MISMATCH",
  // bm53-spec §Design D1 — a stamped version id that does not exist / is a
  // DRAFT / is the wrong kind, or a missing default row (corrupted DB).
  "TEMPLATE_VERSION_NOT_FOUND",
  // bm53-spec §Design D3 — the profile version's rows fail
  // `invoiceProfileSchema` (never a partial profile, TS rule 5).
  "INVOICE_PROFILE_INVALID",
  // bm55-spec §Design D1 — the generator met an unknown directive or key, a
  // `[[body]]` count ≠ 1, an unbalanced or nested `[[if]]`, or left a `[[`/`]]`
  // in its output; `detail: { directive, file }`.
  "TEMPLATE_GENERATION_FAILED",
  // bm55-spec §Design D1/D2 — a structure hides a mandatory section. The Zod
  // schema rejects it first; `generate` re-asserts it.
  "MANDATORY_SECTION_HIDDEN",
  // bm70-spec §Design (D42, Inv #55) — a capacity type of service's Utilised
  // came out negative (only reachable with `capacity_rate_matching` OFF); the
  // bind fails loud and the account parks, it never prints;
  // `detail: { banId, offeringId, utilised }`.
  "INVOICE_NEGATIVE_UTILISED",
  // bm71-spec §Design "Guards" (D29/D54, Inv #56) — a billed capacity row has
  // no `polygon_id=` segment in `udr_key`, or a NULL or malformed
  // `udr_resource`; the bind fails loud (nothing is printed blank) and the
  // account parks; `detail: { banId, udrRatedId, missing }`.
  "INVOICE_POLYGON_DATA_MISSING",
] as const;
export type InvoiceErrorCode = (typeof INVOICE_ERROR_CODES)[number];

// The binder/compiler's one typed failure shape (D2/D6/D10) — any thrown
// error on the render path is wrapped as one of these so `post-run.ts`'s
// catch block can log a stable `renderErrorCode` (Inv #40, D10).
export class InvoiceRenderError extends Error {
  readonly code: InvoiceErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: InvoiceErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InvoiceRenderError";
    this.code = code;
    this.detail = detail;
  }
}

// bm18-spec §Design, moved here (bm47-spec §Implementation §3) so
// `render-invoice-template.ts`'s binder entry point can throw the mode-
// appropriate not-found error without an import cycle back to
// `render-invoice.ts` (which imports the entry point). Re-exported from
// `services/billing/render-invoice.ts` unchanged for existing callers/tests.
export class DraftInvoiceNotFoundError extends Error {
  constructor(runId: string, banId: string) {
    super(`No draft bill found for run ${runId} / account ${banId}.`);
    this.name = "DraftInvoiceNotFoundError";
  }
}

// bm19-spec §Implementation §3, moved here (bm47-spec §Implementation §3) —
// see `DraftInvoiceNotFoundError` above for why.
export class FinalInvoiceNotFoundError extends Error {
  constructor(runId: string, banId: string) {
    super(`No posted bill found for run ${runId} / account ${banId}.`);
    this.name = "FinalInvoiceNotFoundError";
  }
}

// ============================================================================
// bm51 — Generalized write-once blob store (Invoice Template update, Part 4).
// `services/billing/blob-store.ts` serves three containers; `putInvoice`/
// `getInvoice`/`putReport` are thin wrappers over it. No consumer of the two
// new containers exists until bm53.
// ============================================================================

// The three blob containers, all in the same storage account (D3 — no new env
// var). `invoices` keeps md5 as built; the template/asset containers use
// SHA-256 (C4/G6). `createIfNotExists` runs per container on the connection-
// string path only.
export const BLOB_CONTAINERS = [
  "invoices",
  "invoice-templates",
  "invoice-assets",
] as const;
export type BlobContainer = (typeof BLOB_CONTAINERS)[number];

// The checksum algorithm is recorded with every stored object (G6). Both values
// are valid `node:crypto` hash names, so `createHash(algorithm)` is direct.
export const CHECKSUM_ALGORITHMS = ["md5", "sha256"] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export function isChecksumAlgorithm(value: string): value is ChecksumAlgorithm {
  return (CHECKSUM_ALGORITHMS as readonly string[]).includes(value);
}

// The blob store's typed failures (code-standards Part 2 TS rule 7). A
// dedicated class rather than `AppError` because these codes live here with the
// other billing codes (not in `lib/errors.ts`'s closed HTTP-mapped union) and
// carry a structured `detail` (e.g. the conflicting `blobRef`) — the same
// pattern as `InvoiceRenderError` above.
export const BLOB_STORE_ERROR_CODES = [
  "BLOB_ALREADY_EXISTS",
  "INVALID_BLOB_PATH",
] as const;
export type BlobStoreErrorCode = (typeof BLOB_STORE_ERROR_CODES)[number];

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: BlobStoreErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
    this.detail = detail;
  }
}

// bm56-spec §Design D2/D4 — the company profile's `core.system_config` group
// (defined once; the generic System Config exclusion and the profile
// repository both import it) and the reserved per-version metadata keys that
// ride alongside a version's field keys (bm59/bm61 write them; the strict
// profile schema excludes them).
export const INVOICE_PROFILE_CONFIG_GROUP = "invoice.profile";

export const INVOICE_PROFILE_META_KEYS = [
  "meta.change_note",
  "meta.activated_by",
  "meta.activated_at",
  "meta.retired_at",
] as const;
export type InvoiceProfileMetaKey = (typeof INVOICE_PROFILE_META_KEYS)[number];

export const INVOICE_PROFILE_META_PREFIX = "meta.";

// One row of the company profile's version history (bm56 D1). `createdBy` is
// the stored appuser id of the version's most recently modified row (names are
// not resolved — the template history precedent). Dates come from the `meta.*`
// keys (ISO-8601 UTC), `null` while unset or unparseable.
export interface ProfileHistoryRow {
  versionNo: number;
  status: TemplateVersionStatus;
  createdBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  changeNote: string | null;
  usedByCount: number;
}

// bm56-spec §Design D2 — the company-profile page view-model. `fields` is the
// UNPARSED string map rendered as text: a DRAFT may be incomplete and must
// still show, so the strict `invoiceProfileSchema` parse is not applied here.
export type InvoiceProfileView = Readonly<Record<string, string | null>>;

export interface CompanyProfileShownVersion {
  version: number;
  status: TemplateVersionStatus;
  fields: InvoiceProfileView;
  meta: Partial<Record<InvoiceProfileMetaKey, string>>;
  // Display name for `meta.activated_by` (the raw id when it cannot be
  // resolved); `null` when the version was never activated.
  activatedByName: string | null;
  logoAssetVersionId: string | null;
}

// bm59-spec §Design D1/D3 — the working DRAFT profile version an EDIT user
// edits. `token` is `max(last_modified_datetime)` of the draft's rows at
// microsecond precision (the bm57 token form); `savedBy` is the actor on the
// most recently modified row.
export interface ProfileDraftInfo {
  version: number;
  token: string;
  savedAt: Date;
  savedBy: string | null;
}

export interface CompanyProfilePageModel {
  shown: CompanyProfileShownVersion | null;
  history: ProfileHistoryRow[];
  // bm59 — EDIT users only; always `null` for READ users.
  draft: ProfileDraftInfo | null;
  // bm60 D8 — whether the logo asset exists (the "Use the current app logo"
  // import is offered only before it does). Always `true` for READ users.
  hasLogoAsset: boolean;
  // bm61 D5 — the ACTIVE version's field map, for the activate dialog's diff
  // and bank warning. EDIT users only; `null` for READ users or when no
  // version is ACTIVE.
  activeFields: InvoiceProfileView | null;
}

// bm59-spec §Design D1/D3 — each profile key's label: the form's field label
// and the `description` stored on a draft's rows (bm53 D3 key table).
// THE `#RRGGBB` profile colour format (placeholder-catalog §B), shared by the
// profile schema, the colour swatch and the contrast hint.
export const HEX_COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;

export const INVOICE_PROFILE_FIELD_LABELS: Readonly<Record<string, string>> = {
  company_name: "Legal name",
  registration_no: "SSM registration no.",
  tin: "TIN",
  sst_reg_no: "SST registration no.",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  postcode: "Postcode",
  city: "City",
  state_code: "State",
  country_code: "Country",
  phone: "Phone",
  email: "Email",
  website: "Website",
  brand_color: "Brand colour",
  accent_color: "Accent colour",
  bank_name: "Bank name",
  bank_account_name: "Account name",
  bank_account_no: "Account no.",
  swift: "SWIFT",
  jompay_biller_code: "JomPAY biller code",
  remittance_email: "Remittance email",
  payment_terms_days: "Payment terms (days)",
  logo_asset_version_id: "Logo",
};

// bm57-spec §Design D1/D2 — the save-draft result codes beyond the generic
// action ones. `DRAFT_CONFLICT`: the shared working draft changed since the
// form loaded it (optimistic token mismatch) — never last-writer-wins.
// `MANDATORY_SECTION_HIDDEN` is the structure schema's binding issue code.
// `DRAFT_LAYOUT_REPLACED`: the settings DRAFT's last write was an upload (the
// layout and settings tokens are equal), bm80.
export const TEMPLATE_DRAFT_ERROR_CODES = [
  "DRAFT_CONFLICT",
  "MANDATORY_SECTION_HIDDEN",
  "DRAFT_LAYOUT_REPLACED",
] as const;
export type TemplateDraftErrorCode =
  (typeof TEMPLATE_DRAFT_ERROR_CODES)[number];

// bm57-spec §Design D4 — the working DRAFT the Invoice template page opens for
// EDIT users. `token` is the draft's `last_modified_datetime` as a
// microsecond-precision ISO string (a JS `Date` would truncate to ms and never
// match the stored value); `savedBy` is the draft's last writer's name
// (`last_modified_by`, bm81 review fix: a save, an upload or a restore).
export interface TemplateDraftInfo {
  billTemplateVersionId: string;
  versionNo: number;
  token: string;
  savedAt: Date;
  savedBy: string | null;
}

// bm58-spec §Design D2 — the activation result codes beyond the generic ones.
// `CHANGE_NOTE_REQUIRED` (binding): the note is empty after trimming.
// `ACTIVATION_BLOB_CONFLICT`: a different blob already sits at the content-
// addressed target path, so nothing is activated (write-once, never overwritten).
// The generator, loader and test-render failures keep their `InvoiceRenderError`
// codes (`TEMPLATE_GENERATION_FAILED`, `TEMPLATE_CHECKSUM_MISMATCH`,
// `TEMPLATE_COMPILE_FAILED`, `MANDATORY_SECTION_HIDDEN`) and are returned as-is.
export const TEMPLATE_ACTIVATION_ERROR_CODES = [
  "CHANGE_NOTE_REQUIRED",
  "ACTIVATION_BLOB_CONFLICT",
] as const;
export type TemplateActivationErrorCode =
  (typeof TEMPLATE_ACTIVATION_ERROR_CODES)[number];

// bm79 — the template-activation codes beyond TEMPLATE_ACTIVATION_ERROR_CODES,
// which the company-profile activation shares and which is therefore
// unchanged. `LAYOUT_REJECTED`: the pair's layout DRAFT no longer passes the
// compliance check (it carries its problems).
export type TemplatePairActivationErrorCode =
  | "TEMPLATE_TYPE_RETIRED"
  | "LAYOUT_REJECTED";

// bm79 — discard a type's DRAFTs (settings and, if any, layout) → RETIRED.
export type DiscardTemplateDraftResult =
  | { ok: true; discardedVersionIds: string[] }
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "VALIDATION_ERROR"
        | "SERVER_ERROR"
        | "DRAFT_CONFLICT"
        | "TEMPLATE_TYPE_RETIRED";
    };

// bm61-spec §Design D2 — the company-profile activation result codes beyond
// the generic ones (all binding, code-standards TS rule 7; result codes, never
// thrown). `PROFILE_LOGO_REQUIRED`: no logo, or its asset version is missing
// or not ACTIVE. `ASSET_CHECKSUM_MISMATCH`: the logo blob fails its checksum
// (or is missing). No four-eyes code: G14 decided 2026-10-11, no second
// signature on profile activation.
export const PROFILE_ACTIVATION_ERROR_CODES = [
  "CHANGE_NOTE_REQUIRED",
  "DRAFT_CONFLICT",
  "PROFILE_LOGO_REQUIRED",
  "ASSET_CHECKSUM_MISMATCH",
] as const;
export type ProfileActivationErrorCode =
  (typeof PROFILE_ACTIVATION_ERROR_CODES)[number];

// bm61 D5 — the payment fields: a change to any of them shows the bank
// warning and is flagged `bankDetailsChanged` on the activation audit row.
export const INVOICE_PROFILE_PAYMENT_KEYS = [
  "bank_name",
  "bank_account_name",
  "bank_account_no",
  "swift",
  "jompay_biller_code",
  "remittance_email",
] as const;

// bm60-spec §Design D2 — the logo upload's result codes beyond the generic
// ones. `LOGO_REJECTED` (binding, code-standards TS rule 7) carries a `reason`
// (the first failed check, in data rule 9 order) and a `detail`. A rejection
// writes nothing and is not audited. Never thrown.
export const LOGO_UPLOAD_ERROR_CODES = ["LOGO_REJECTED"] as const;
export type LogoUploadErrorCode = (typeof LOGO_UPLOAD_ERROR_CODES)[number];

export const LOGO_REJECT_REASONS = [
  "size",
  "mime",
  "dimensions",
  "svg_content",
] as const;
export type LogoRejectReason = (typeof LOGO_REJECT_REASONS)[number];

// The three logo MIME types (`bill_asset_version.mime` CHECK, 0046).
export const LOGO_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

// 500 KB on the actual byte length (`byte_size BETWEEN 1 AND 512000`, 0046).
export const LOGO_MAX_BYTES = 512_000;
// The shorter side of the logo, in px.
export const LOGO_MIN_SIDE_PX = 300;
// The longer side of the logo, in px (owner decision 2026-10-11): a small
// file can declare a huge image (a decompression bomb) that the invoice
// renderer would have to draw in full.
export const LOGO_MAX_SIDE_PX = 2_000;

export type LogoRejectDetail = Readonly<Record<string, string | number | null>>;

// bm76 — layout rule results (code-standards › Invoice Template Types, TS rule 2). The upload
// error-code union (LayoutUploadErrorCode) arrives with its first user, bm78.
export const LAYOUT_PROBLEM_CODES = [
  "ZIP_TOO_LARGE",
  "ZIP_TOO_MANY_ENTRIES",
  "ZIP_UNEXPECTED_FILE",
  "ZIP_MISSING_FILE",
  "CHECKSUM_MISMATCH",
  "MANIFEST_INVALID",
  "LAYOUT_CODE_MISMATCH",
  "LAYOUT_VERSION_MISMATCH",
  "SETTINGS_INVALID",
  "LINT_VIOLATION",
  "LAYOUT_MISSING_REQUIRED_BLOCKS",
  "COMPILE_FAILED",
  "LAYOUT_EXTERNAL_FETCH",
] as const;
export type LayoutProblemCode = (typeof LAYOUT_PROBLEM_CODES)[number];

export interface LayoutProblem {
  file: string; // package-relative path, or "(render)" for render-level problems
  code: LayoutProblemCode;
  message: string; // human-readable, shown verbatim in the upload problems list
}

// bm77 — invoice template type status, DERIVED by `deriveTemplateTypeStatus`
// (code-standards › Invoice Template Types, TS rule 4); never stored.
export const TEMPLATE_TYPE_STATUSES = [
  "USABLE",
  "NOT_YET_USABLE",
  "RETIRED",
] as const;
export type TemplateTypeStatus = (typeof TEMPLATE_TYPE_STATUSES)[number];

// code-standards › Invoice Template Types, TS rule 2 (later units add their codes).
export type TemplateTypeErrorCode =
  | "TEMPLATE_TYPE_NAME_TAKEN"
  | "TEMPLATE_TYPE_NAME_INVALID";

export interface TemplateTypeListRow {
  billTemplateFamilyId: string;
  name: string;
  isDefault: boolean;
  status: TemplateTypeStatus;
  activeVersionNo: number | null; // the ACTIVE (or default) settings version
  activeSince: Date | null; // its activated_datetime
  retiredAt: Date | null;
  boundBanCount: number; // bm82 — BANs on this type, every state (NULL → Standard)
}

// bm78 — layout package upload limits and shape (code-standards › Invoice
// Template Types, TS rules 6–7). The partial keys are `["header",
// ...INVOICE_SECTION_KEYS]` — the same expression as LAYOUT_PART_KEYS in
// layout-manifest.schema.ts, which imports this file (so it cannot be imported
// back); a gate test pins the two equal.
// bm81 review fix (owner, #5/#9) — an export's `settings.json` has its own
// budget, outside the layout's entry and byte caps (so a layout at a cap still
// round-trips), and the compressed upload limit gains the same headroom.
export const LAYOUT_PACKAGE_SETTINGS_MAX_BYTES = 64 * 1024;
export const LAYOUT_PACKAGE_MAX_BYTES =
  2 * 1024 * 1024 + LAYOUT_PACKAGE_SETTINGS_MAX_BYTES; // compressed upload
export const LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024; // streamed inflate cap (layout files)
export const LAYOUT_PACKAGE_MAX_ENTRIES = 64; // layout files

export const LAYOUT_PACKAGE_REQUIRED_FILES = [
  "manifest.json",
  "shell.hbs",
  "footer.hbs",
  "sample-data.json",
  "checksums.json",
  ...["header", ...INVOICE_SECTION_KEYS].map((k) => `partials/${k}.hbs`),
] as const;
export const LAYOUT_PACKAGE_FONT_FILE =
  /^fonts\/(?:[A-Za-z0-9._-]{1,64}\.woff2|OFL\.txt)$/;
// bm81 (TS rule 6) — the export's `settings.json`, never listed in
// `checksums.json`. With the required files and the font rule it forms
// LAYOUT_PACKAGE_FILES: the single source of these names for the gate, the
// install, the export and the upload dialog (review fix #15).
export const LAYOUT_PACKAGE_OPTIONAL_FILES = ["settings.json"] as const;
export const LAYOUT_PACKAGE_FILES = {
  required: LAYOUT_PACKAGE_REQUIRED_FILES,
  optional: LAYOUT_PACKAGE_OPTIONAL_FILES,
  settings: LAYOUT_PACKAGE_OPTIONAL_FILES[0],
  font: LAYOUT_PACKAGE_FONT_FILE,
} as const;

// TS rule 3 — the warned-about draft, never a boolean "confirmed" flag.
export type ExpectedDraft =
  | { none: true }
  | { versionId: string; lastModified: string };

// bm80 (code-standards › Invoice Template Types, Next.js rule 5) — the type's
// open layout DRAFT as the page reads it: the overwrite warning's data and the
// expected-draft token the upload sends back. `lastModifiedByName` is "a
// deleted user" for a since-deleted writer, `null` when none was recorded.
export interface OpenLayoutDraftInfo {
  versionId: string;
  versionNo: number;
  token: string;
  lastModifiedDatetime: Date;
  lastModifiedByName: string | null;
}

export type LayoutUploadErrorCode =
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "SERVER_ERROR"
  | "TEMPLATE_TYPE_RETIRED"
  | "DRAFT_CHANGED_SINCE_WARNING"
  | "LAYOUT_REJECTED";

export type UploadLayoutPackageResult =
  | { ok: true; versionId: string; versionNo: number; replaced: boolean }
  | { ok: false; code: LayoutUploadErrorCode; problems: LayoutProblem[] };
