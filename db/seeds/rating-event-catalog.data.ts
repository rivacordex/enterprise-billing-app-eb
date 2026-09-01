import { sql } from "drizzle-orm";

import { eventCatalog } from "@/db/schema/rating/event-catalog";
import type { EventCatalogInsert } from "@/db/schema/rating/event-catalog";
import type { Database } from "@/db/client";

// rm02-spec §Implementation §2. The single definition of the module's event
// codes, referenced from TypeScript (the log sweep, the tests) and mirrored by
// the seeded rows below. A test asserts this constant and the seeded rows are
// the SAME set in both directions (rm02-spec §Verification 4), so a code added
// to one and not the other fails the build.
//
// `INDETERMINATE` is deliberately NOT a code and never a seeded row — it is the
// severity written when a lookup finds nothing (rm02-spec §A1).
export const RATING_EVENT_CODES = [
  "DB_WRITE_FAILURE",
  "RECON_IMBALANCE",
  "LOAD_BLOCKED_BILLED",
  "SHRINKING_REISSUE",
  "FILE_NOT_RECEIVED",
  "FILE_KEY_UNRESOLVED",
  "PARSE_FAILURE",
  "LOOKUP_MISS",
  "CURRENCY_MISMATCH",
  "BATCH_STRANDED",
  "BATCH_PARTIAL",
  "TASK_RETRY_OK",
  "FILE_LATE",
  "DUPLICATE_BATCH",
  "CROSS_PERIOD_SUPERSEDE",
  "BATCH_COMPLETE",
  "CLEARED",
] as const;
export type RatingEventCode = (typeof RATING_EVENT_CODES)[number];

// Every column the table declares appears here; `description` is NOT NULL and
// its text is given by the spec, not left to the implementer. Descriptions
// state the CONDITION, never the remediation (rm02-spec §Implementation §1).
//
// `default_severity` is bound as an explicit nullable value on every row, not
// omitted (rm02-spec §Implementation §3): an omitted column in a multi-row
// insert is a type error, and `DO UPDATE` must be able to set a severity back
// to NULL when a code is downgraded out of the alarm stream.
//
// Clearing follows the two shapes of rm02-spec D5: `is_auto_clearing = true`
// carries a `clear_event_code` that exists in the catalog; `false` carries
// NULL. Exactly eight rows name `BATCH_COMPLETE` as their clearer
// (rm02-spec §Verification 11 — rm11 added BATCH_STRANDED as the eighth).
export const EVENT_CATALOG_SEED: readonly EventCatalogInsert[] = [
  // CRITICAL — the pipeline cannot proceed, or financial integrity is at risk.
  {
    eventCode: "DB_WRITE_FAILURE",
    component: "RL",
    defaultSeverity: "CRITICAL",
    eventType: "processingErrorAlarm",
    probableCause: "underlyingResourceUnavailable",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "The rating loader could not write to the database and the batch transaction was rolled back.",
  },
  {
    eventCode: "RECON_IMBALANCE",
    component: "RL",
    defaultSeverity: "CRITICAL",
    eventType: "processingErrorAlarm",
    probableCause: "corruptData",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A batch failed the arithmetic check `parsed = rated + rejected + discarded`, so records are unaccounted for.",
  },
  // MAJOR — an isolated unit failed completely.
  {
    eventCode: "LOAD_BLOCKED_BILLED",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "billedRecordCollision",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A batch was refused whole because one or more incoming records collide with a live row already on an approved invoice.",
  },
  {
    eventCode: "SHRINKING_REISSUE",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "incompleteRedelivery",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A reissued file carried fewer records than the run it supersedes, so records were retired with nothing replacing them.",
  },
  {
    eventCode: "FILE_NOT_RECEIVED",
    component: "SCHEDULER",
    defaultSeverity: "MAJOR",
    eventType: "qualityOfServiceAlarm",
    probableCause: "expectedFileAbsent",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A usage file the configured cadence expected has not arrived within its window.",
  },
  {
    eventCode: "FILE_KEY_UNRESOLVED",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "configurationOrCustomizationError",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "The configured derivation rule could not extract a `file_key` from the filename, so the file's logical delivery identity is unknown.",
  },
  {
    eventCode: "PARSE_FAILURE",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "corruptData",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A usage file could not be parsed at all, or its reject count exceeded the configured threshold for its `udr_type`.",
  },
  {
    eventCode: "LOOKUP_MISS",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "underlyingResourceUnavailable",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A price, offering, subscription or inventory lookup returned no row for a record that requires one.",
  },
  {
    eventCode: "CURRENCY_MISMATCH",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "configurationOrCustomizationError",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "The currency on the resolved price does not match the billing account's currency.",
  },
  {
    eventCode: "BATCH_STRANDED",
    component: "SCHEDULER",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "abandonedClaim",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A udr_batch row stuck at PROCESSING beyond the configured threshold — a worker was killed mid-load — was resolved (FAILED) by the stranded-batch reconcile, releasing the file's claim for reprocessing.",
  },
  // MINOR — degraded, but the unit completed.
  {
    eventCode: "BATCH_PARTIAL",
    component: "RL",
    defaultSeverity: "MINOR",
    eventType: "qualityOfServiceAlarm",
    probableCause: "thresholdCrossed",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A batch completed with some records rejected, below the configured threshold; the reject file names them.",
  },
  {
    eventCode: "TASK_RETRY_OK",
    component: null,
    defaultSeverity: "MINOR",
    eventType: "processingErrorAlarm",
    probableCause: "retrySucceeded",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A task failed and succeeded on a later attempt; the work completed but the underlying instability did not.",
  },
  // WARNING — nothing failed, but someone should know.
  {
    eventCode: "FILE_LATE",
    component: "SCHEDULER",
    defaultSeverity: "WARNING",
    eventType: "qualityOfServiceAlarm",
    probableCause: "deliveryWindowMissed",
    isAutoClearing: true,
    clearEventCode: "BATCH_COMPLETE",
    isActive: true,
    description:
      "A usage file arrived outside the window its configured cadence expects.",
  },
  {
    eventCode: "DUPLICATE_BATCH",
    component: "PRP",
    defaultSeverity: "WARNING",
    eventType: "qualityOfServiceAlarm",
    probableCause: "duplicateDelivery",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A byte-identical redelivery of an already-processed file was discarded before parsing.",
  },
  {
    eventCode: "CROSS_PERIOD_SUPERSEDE",
    component: "RL",
    defaultSeverity: "WARNING",
    eventType: "processingErrorAlarm",
    probableCause: "crossPeriodCorrection",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "Supersession retired a predecessor row in a different monthly partition, meaning a corrected timestamp moved the record across a period boundary.",
  },
  // No severity — logged, never alarmed (rm02-spec §A). BATCH_COMPLETE is the
  // clear_event_code for seven other codes (D6) yet carries NULL severity of
  // its own: a clean run is not an alarm.
  {
    eventCode: "BATCH_COMPLETE",
    component: "RL",
    defaultSeverity: null,
    eventType: "processingErrorAlarm",
    probableCause: "normalCompletion",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A batch completed cleanly with counts that reconcile and the source file archived.",
  },
  // The clearing event itself (rm02-spec D6a). Carries default_severity
  // 'CLEARED' — the X.733 value that exists for precisely this — so a clear IS
  // an alarm-stream event, not a NULL-severity routine row. It is never itself
  // cleared.
  {
    eventCode: "CLEARED",
    component: null,
    defaultSeverity: "CLEARED",
    eventType: "processingErrorAlarm",
    probableCause: "normalCompletion",
    isAutoClearing: false,
    clearEventCode: null,
    isActive: true,
    description:
      "A previously raised alarm condition on this `alarm_key` no longer holds.",
  },
];

// rm02-spec §Implementation §3. Idempotent as ON CONFLICT DO UPDATE, not
// DO NOTHING — the seed is how a severity re-tune reaches an existing
// environment (rm02-spec D7), so a re-run must UPDATE the stored row, including
// setting a severity back to NULL. It never DELETEs or deactivates a code
// absent from this list (rm02-spec §Verification 20); retirement is a later
// migration setting is_active = false.
export async function seedEventCatalog(db: Database): Promise<void> {
  await db
    .insert(eventCatalog)
    .values([...EVENT_CATALOG_SEED])
    .onConflictDoUpdate({
      target: eventCatalog.eventCode,
      set: {
        component: sql`excluded.component`,
        defaultSeverity: sql`excluded.default_severity`,
        eventType: sql`excluded.event_type`,
        probableCause: sql`excluded.probable_cause`,
        description: sql`excluded.description`,
        isAutoClearing: sql`excluded.is_auto_clearing`,
        clearEventCode: sql`excluded.clear_event_code`,
        isActive: sql`excluded.is_active`,
      },
    });
}
