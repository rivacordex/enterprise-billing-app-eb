import {
  bigint,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { rating } from "@/db/schema/rating/pg-schema";

// rm01-spec §Implementation §3. PHYSICAL DDL OF RECORD: db/migrations/0034_rating.sql
// Not partitioned — files are low-volume. `batch_id` uses the prefix +
// 8-digit sequence convention (ratemgmt-code-standards.md §5.5).
export const udrBatchSeq = rating.sequence("udr_batch_seq", {
  startWith: 1,
});

export const udrBatch = rating.table(
  "udr_batch",
  {
    batchId: text("batch_id")
      .primaryKey()
      .default(
        sql`'UDRBAT' || lpad(nextval('rating.udr_batch_seq')::text, 8, '0')`,
      ),
    // The logical delivery identity, extracted by PRP from the filename
    // (rm01-spec D12) — groups reissues of the same delivery. Never
    // source_file.
    fileKey: text("file_key").notNull(),
    // The physical filename as delivered — forensics only, never a grouping key.
    sourceFile: text("source_file").notNull(),
    fileKeyRule: text("file_key_rule").notNull(),
    udrType: text("udr_type").notNull(),
    // Assigned as max+1 within file_key (rm01-spec D12).
    batchRunNum: integer("batch_run_num").notNull().default(1),
    fileChecksum: text("file_checksum"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    status: text("status").notNull().default("RECEIVED"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    declaredRecordCount: integer("declared_record_count"),
    parsedCount: integer("parsed_count"),
    ratedCount: integer("rated_count"),
    rejectedCount: integer("rejected_count"),
    discardedCount: integer("discarded_count"),
    supersededCount: integer("superseded_count"),
    rejectFilePath: text("reject_file_path"),
    archiveFilePath: text("archive_file_path"),
    workflowExecutionId: text("workflow_execution_id"),
    workflowFlowRevision: integer("workflow_flow_revision"),
    ratingEngineVersion: text("rating_engine_version"),
    // The batch that retired this batch's rows (rm01-spec D11).
    supersededByBatchId: text("superseded_by_batch_id"),
    supersedeReason: text("supersede_reason"),
    errorSummary: text("error_summary"),
  },
  (t) => [
    // The file claim (Inv #7) — scoped to file_key, not source_file
    // (rm01-spec D12). Do not weaken it.
    unique("udr_batch_file_key_run_uq").on(t.fileKey, t.batchRunNum),
    check(
      "udr_batch_status_check",
      sql`status IN ('RECEIVED','PROCESSING','COMPLETE','PARTIAL','FAILED','REFUSED')`,
    ),
    check("udr_batch_run_num_positive_check", sql`batch_run_num >= 1`),
    index("udr_batch_file_key_idx").on(t.fileKey, t.batchRunNum.desc()),
  ],
);

export type UdrBatch = typeof udrBatch.$inferSelect;
export type UdrBatchInsert = typeof udrBatch.$inferInsert;
