import type { AuditEventType } from "@/types/audit";

export type AuditEventCategory =
  | "Additive"
  | "Change"
  | "Removal"
  | "Session"
  | "Security";

// Maps every `AuditEventType` to its color-coded family (um24-spec §"Event
// category color-coding" / ui-context §3.7). Drives both the table's
// left-border accent strip and `AuditEventCategoryBadge`.
export const AUDIT_EVENT_CATEGORY_MAP: Record<
  AuditEventType,
  AuditEventCategory
> = {
  USER_CREATED: "Additive",
  USER_ENABLED: "Additive",
  ROLE_CREATED: "Additive",
  ROLE_ASSIGNED: "Additive",
  ORGANIZATION_CREATED: "Additive",
  CUSTOMER_CREATED: "Additive",
  CONTACT_CREATED: "Additive",
  PRODUCT_OFFERING_CREATED: "Additive",
  PRODUCT_OFFERING_BRANCHED: "Additive",
  PRODUCT_SPECIFICATION_CREATED: "Additive",
  PRODUCT_PRICE_ADDED: "Additive",
  PRODUCT_OFFERING_ACTIVATED: "Additive",
  PRODUCT_ORDER_CREATED: "Additive",
  PRODUCT_INVENTORY_CREATED: "Additive",
  USER_UPDATED: "Change",
  ROLE_UPDATED: "Change",
  PRODUCT_OFFERING_UPDATED: "Change",
  PRODUCT_ORDER_PENDING_APPROVAL: "Change",
  PRODUCT_ORDER_APPROVED: "Change",
  PRODUCT_ORDER_COMPLETED: "Change",
  PRODUCT_INVENTORY_CHARACTERISTICS_UPDATED: "Change",
  PRODUCT_INVENTORY_SUSPENDED: "Change",
  PRODUCT_INVENTORY_RESUMED: "Change",
  PRODUCT_SPECIFICATION_UPDATED: "Change",
  ORGANIZATION_UPDATED: "Change",
  ORGANIZATION_STATUS_CHANGED: "Change",
  CUSTOMER_STATUS_CHANGED: "Change",
  PARTY_ROLE_SPECIFICATION_UPDATED: "Change",
  CONTACT_UPDATED: "Change",
  PREFERRED_CONTACT_CHANGED: "Change",
  PREFERRED_METHOD_CHANGED: "Change",
  PERMISSION_MAPPING_CHANGED: "Change",
  SYSTEM_CONFIG_CHANGED: "Change",
  USER_AUTH_METHOD_CHANGED: "Change",
  USER_DISABLED: "Removal",
  USER_DELETED: "Removal",
  ROLE_DELETED: "Removal",
  ROLE_REVOKED: "Removal",
  CONTACT_DELETED: "Removal",
  PRODUCT_SPECIFICATION_DELETED: "Removal",
  PRODUCT_OFFERING_SUPERSEDED: "Removal",
  PRODUCT_OFFERING_RETIRED: "Removal",
  PRODUCT_OFFERING_DISCARDED: "Removal",
  PRODUCT_ORDER_REJECTED: "Removal",
  PRODUCT_ORDER_FAILED: "Removal",
  PRODUCT_INVENTORY_TERMINATED: "Removal",
  SSO_LOGIN: "Session",
  LOCAL_LOGIN: "Session",
  USER_FIRST_LOGIN: "Session",
  USER_LOCKED: "Security",
  USER_UNLOCKED: "Security",
  USER_PASSWORD_RESET: "Security",
  USER_PASSWORD_CHANGED: "Security",
  ACCOUNTS_ONBOARDED: "Additive",
  DOCUMENT_POSTED: "Additive",
  PERIOD_CLOSED: "Change",
  JOURNAL_EXPORTED: "Additive",
  REASON_CODE_CHANGED: "Change",
  BILL_CYCLE_CHANGED: "Change",
  WIZARD_DEFAULTS_CHANGED: "Change",
  ACCOUNT_CLOSED: "Change",
  // bm02 — a bill_run row lazily created on list-page render. Additive: it
  // brings a new run into existence (one row per period actually inserted).
  BILL_RUN_MATERIALIZED: "Additive",
  // bm03 — SCHEDULED → PROCESSING is a state transition, not a new entity.
  BILL_RUN_TRIGGERED: "Change",
  // bm08 — a pre-approval rerun (PROCESSED/PROCESSING_FAILED → PROCESSING): a
  // state transition carrying prior totals + the operator's reason.
  BILL_RUN_RERUN: "Change",
  // bm10 — PROCESSED → APPROVED, the four-eyes money gate: a state
  // transition, not a new entity.
  BILL_RUN_APPROVED: "Change",
  // bm11 — marks the run reaching the INVOICED milestone (money in the
  // ledger): Additive, like BILL_RUN_MATERIALIZED — new INV documents now
  // exist, not merely a status flip.
  BILL_RUN_POSTED: "Additive",
  // bm12 — Cancel run: PROCESSING → CANCELLED, a state transition (the
  // Layer-3 escape hatch for a wedged execution).
  BILL_RUN_CANCELLED: "Change",
  // bm12 — Check status: the engine reconcile, which may bump the heartbeat
  // only or also push the run to a corrected status — a state-change surface
  // either way.
  BILL_RUN_RECONCILED: "Change",
};

// Shape returned by the repository join (audit_log + appuser for the
// actor's display name). `actorUserId` mirrors the column's actual
// nullability (`onDelete: "set null"` on the FK) even though every current
// write path supplies a real actor.
export interface AuditLogRow {
  auditId: string;
  eventType: AuditEventType;
  category: AuditEventCategory;
  actorUserId: string | null;
  actorUserName: string | null;
  actorDeleted: boolean;
  targetEntity: string | null;
  targetId: string | null;
  beforeData: unknown;
  afterData: unknown;
  createdDatetime: Date;
}

export interface AuditLogFiltersInput {
  eventType: AuditEventType | null;
  actorUserId: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLogActorOption {
  userId: string;
  userName: string | null;
  isDeleted: boolean;
}
