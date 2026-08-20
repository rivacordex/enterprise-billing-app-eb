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
// Workflow tab (and the later tabs) compose around this.
export interface RunDetail {
  billRunId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
  status: RunStatus;
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
