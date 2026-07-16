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
  USER_UPDATED: "Change",
  ROLE_UPDATED: "Change",
  PERMISSION_MAPPING_CHANGED: "Change",
  SYSTEM_CONFIG_CHANGED: "Change",
  USER_AUTH_METHOD_CHANGED: "Change",
  USER_DISABLED: "Removal",
  USER_DELETED: "Removal",
  ROLE_DELETED: "Removal",
  ROLE_REVOKED: "Removal",
  SSO_LOGIN: "Session",
  LOCAL_LOGIN: "Session",
  USER_FIRST_LOGIN: "Session",
  USER_LOCKED: "Security",
  USER_UNLOCKED: "Security",
  USER_PASSWORD_RESET: "Security",
  USER_PASSWORD_CHANGED: "Security",
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
