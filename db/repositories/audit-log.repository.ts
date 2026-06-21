import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";

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
      .select({
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
      })
      .from(auditLog)
      .leftJoin(appuser, eq(auditLog.actorUserId, appuser.id))
      .where(whereClause)
      .orderBy(desc(auditLog.createdDatetime))
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    return {
      total,
      rows: rows.map((row) => ({
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
      })),
    };
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
      // Postgres's default ASC ordering is NULLS LAST, so tombstoned actors
      // (null `userName` from a left-join miss) sort to the end naturally.
      .orderBy(asc(appuser.userName));

    return rows
      .filter(
        (
          row,
        ): row is {
          userId: string;
          userName: string | null;
          status: string | null;
        } => row.userId !== null,
      )
      .map((row) => ({
        userId: row.userId,
        userName: row.userName,
        isDeleted: row.status === "DELETED",
      }));
  },
};
