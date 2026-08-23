import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
} from "drizzle-orm";

import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema/audit";
import { appuser } from "@/db/schema/identity";
import {
  AUDIT_EVENT_CATEGORY_MAP,
  type AuditLogActorOption,
  type AuditLogFiltersInput,
  type AuditLogRow,
} from "@/types/audit-log";
import type { AuditEventType } from "@/types/audit";

function buildWhereClause(filters: AuditLogFiltersInput) {
  const conditions = [];
  if (filters.eventType !== null) {
    conditions.push(eq(auditLog.eventType, filters.eventType));
  }
  if (filters.actorUserId !== null) {
    conditions.push(eq(auditLog.actorUserId, filters.actorUserId));
  }
  if (filters.dateFrom !== null) {
    conditions.push(gte(auditLog.createdDatetime, filters.dateFrom));
  }
  if (filters.dateTo !== null) {
    conditions.push(lte(auditLog.createdDatetime, filters.dateTo));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

// The single `AuditLogRow` projection shared by every audit-log read
// (`findFiltered`, `findByTargetId`) — one column set + one row mapper, so the
// platform audit-log page and the bill-run Audit tab can never drift apart.
const AUDIT_ROW_COLUMNS = {
  auditId: auditLog.auditId,
  eventType: auditLog.eventType,
  actorUserId: auditLog.actorUserId,
  actorUserName: appuser.userName,
  actorStatus: appuser.status,
  targetEntity: auditLog.targetEntity,
  targetId: auditLog.targetId,
  beforeData: auditLog.beforeData,
  afterData: auditLog.afterData,
  createdDatetime: auditLog.createdDatetime,
} as const;

type AuditRowSelection = {
  auditId: string;
  eventType: string;
  actorUserId: string | null;
  actorUserName: string | null;
  actorStatus: string | null;
  targetEntity: string | null;
  targetId: string | null;
  beforeData: unknown;
  afterData: unknown;
  createdDatetime: Date;
};

function toAuditLogRow(row: AuditRowSelection): AuditLogRow {
  return {
    auditId: row.auditId,
    eventType: row.eventType as AuditEventType,
    category: AUDIT_EVENT_CATEGORY_MAP[row.eventType as AuditEventType],
    actorUserId: row.actorUserId,
    actorUserName: row.actorUserName,
    actorDeleted: row.actorStatus === "DELETED",
    targetEntity: row.targetEntity,
    targetId: row.targetId,
    beforeData: row.beforeData,
    afterData: row.afterData,
    createdDatetime: row.createdDatetime,
  };
}

export const auditLogRepository = {
  // Backs the `/administration/audit-log` page (um24-spec §24.3). Runs the
  // count and the page-data select as two separate reads (not a
  // transaction — both are read-only) sharing the same WHERE clause.
  async findFiltered(
    db: Database,
    filters: AuditLogFiltersInput,
    page: number,
    pageSize: number,
  ): Promise<{ rows: AuditLogRow[]; total: number }> {
    const whereClause = buildWhereClause(filters);

    const [countRow] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const rows = await db
      .select(AUDIT_ROW_COLUMNS)
      .from(auditLog)
      .leftJoin(appuser, eq(auditLog.actorUserId, appuser.id))
      .where(whereClause)
      .orderBy(desc(auditLog.createdDatetime))
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    return { total, rows: rows.map(toAuditLogRow) };
  },

  // bm07-spec §Design/§2 — the run-detail Audit tab read: every `AUDIT_LOG`
  // event targeting this run (`target_id = runId`), newest first, joined to
  // the actor's display name/tombstone state (same projection as
  // `findFiltered`, via the shared `AUDIT_ROW_COLUMNS`/`toAuditLogRow`). No
  // pagination — a single run's event trail is small.
  async findByTargetId(db: Database, targetId: string): Promise<AuditLogRow[]> {
    const rows = await db
      .select(AUDIT_ROW_COLUMNS)
      .from(auditLog)
      .leftJoin(appuser, eq(auditLog.actorUserId, appuser.id))
      .where(eq(auditLog.targetId, targetId))
      .orderBy(desc(auditLog.createdDatetime));

    return rows.map(toAuditLogRow);
  },

  // bm10 four-eyes — the distinct set of actor ids that performed any of the
  // given event types against a target (e.g. every `BILL_RUN_TRIGGERED`/
  // `BILL_RUN_RERUN` on a run). The approve gate uses this to bar EVERY
  // operator who triggered or reran the run from also approving it, not just
  // the original trigger actor. Null actors (system writes) are dropped.
  async listActorIdsForEvents(
    db: Database,
    targetId: string,
    eventTypes: readonly string[],
  ): Promise<string[]> {
    if (eventTypes.length === 0) return [];
    const rows = await db
      .selectDistinct({ actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, targetId),
          inArray(auditLog.eventType, [...eventTypes]),
          isNotNull(auditLog.actorUserId),
        ),
      );
    return rows.map((r) => r.actorUserId).filter((id): id is string => !!id);
  },

  // Populates the Actor filter dropdown (um24-spec §24.3) — every distinct
  // `actor_user_id` that has ever appeared in `AUDIT_LOG`, resolved to a
  // display name and tombstone state.
  async findActors(db: Database): Promise<AuditLogActorOption[]> {
    const rows = await db
      .selectDistinct({
        userId: auditLog.actorUserId,
        userName: appuser.userName,
        status: appuser.status,
      })
      .from(auditLog)
      .leftJoin(appuser, eq(auditLog.actorUserId, appuser.id))
      .where(isNotNull(auditLog.actorUserId))
      // Postgres's default ASC ordering is NULLS LAST, so tombstoned actors
      // (null `userName` from a left-join miss) sort to the end naturally.
      .orderBy(asc(appuser.userName));

    return rows.map((row) => ({
      userId: row.userId as string,
      userName: row.userName,
      isDeleted: row.status === "DELETED",
    }));
  },
};
