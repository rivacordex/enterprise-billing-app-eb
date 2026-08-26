import {
  check,
  date,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { rating } from "@/db/schema/rating/pg-schema";

// rm01-spec §Implementation §4. PHYSICAL DDL OF RECORD: db/migrations/0034_rating.sql
// Partitioned monthly on partition_period, derived from log_datetime — see
// udr-rated.ts's header for the partitioning/typing-only caveats, which apply
// identically here.
//
// event_code deliberately has no FK to event_catalog (rm01-spec D6): an
// unrecognised code must resolve to INDETERMINATE and still load, so it can
// be counted as the hygiene metric.
export const processLog = rating.table(
  "process_log",
  {
    // ULID generated db-side by core.generate_ulid().
    logId: uuid("log_id")
      .notNull()
      .default(sql`core.generate_ulid()`),
    partitionPeriod: date("partition_period", { mode: "string" }).notNull(),
    logDatetime: timestamp("log_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    component: text("component").notNull(),
    logLevel: text("log_level").notNull(),
    // Nullable — set only on alarm-worthy rows (§7.1).
    perceivedSeverity: text("perceived_severity"),
    eventCode: text("event_code").notNull(),
    eventType: text("event_type"),
    probableCause: text("probable_cause"),
    specificProblem: text("specific_problem"),
    managedObject: text("managed_object"),
    alarmKey: text("alarm_key"),
    sourceFile: text("source_file"),
    batchId: text("batch_id"),
    workflowExecutionId: text("workflow_execution_id"),
    // Zod-validated at the write boundary (§7.7).
    additionalInfo: jsonb("additional_info"),
    insertDatetime: timestamp("insert_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({
      name: "process_log_pk",
      columns: [t.partitionPeriod, t.logId],
    }),
    check(
      "process_log_period_matches_check",
      sql`partition_period = rating.period_of(log_datetime)`,
    ),
    check(
      "process_log_component_check",
      sql`component IN ('PRP','RP','RL','LOG_SWEEP','SCHEDULER')`,
    ),
    check(
      "process_log_level_check",
      sql`log_level IN ('DEBUG','INFO','WARN','ERROR')`,
    ),
    check(
      "process_log_severity_check",
      sql`perceived_severity IS NULL OR perceived_severity IN ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED')`,
    ),
    index("process_log_alarm_idx")
      .on(t.perceivedSeverity, t.logDatetime)
      .where(sql`perceived_severity IS NOT NULL`),
    index("process_log_alarm_key_idx")
      .on(t.alarmKey)
      .where(sql`alarm_key IS NOT NULL`),
    index("process_log_batch_idx").on(t.batchId),
    index("process_log_event_code_idx").on(t.eventCode),
  ],
);

export type ProcessLog = typeof processLog.$inferSelect;
export type ProcessLogInsert = typeof processLog.$inferInsert;
