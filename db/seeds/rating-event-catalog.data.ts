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
  "LOAD_BLOCKED_INFLIGHT",
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
  // rm18-spec §Implementation §1. PER_UNIT RAN-usage identity-lock,
  // resolution and completeness failures — all integrity problems, never
  // auto-clearing (a later clean batch does not make the earlier one true).
  "UNKNOWN_SUBSCRIBER",
  "SUBSCRIBER_REF_MISMATCH",
  "PRODUCT_PIN_MISMATCH",
  "SERVICE_CODE_MISMATCH",
  "RATECARD_COVERAGE_GAP",
  "RATECARD_COVERAGE_GAP_WARN",
  "INPUT_UNMAPPED",
  "UDRTYPE_MISMATCH",
  "CARD_DRIVEN_RATING_UNSUPPORTED",
  "MNO_KEY_NOT_UNIQUE",
  "BATCH_COMPLETE",
  "CLEARED",
] as const;
export type RatingEventCode = (typeof RATING_EVENT_CODES)[number];

// Every row is `is_active: true` and `is_auto_clearing` is derived from
// whether a `clearEventCode` was given (rm02-spec D6a) — the one piece of
// de-duplication this table's shape allows without hiding the per-row
// severity/cause/description that SonarQube's CPD otherwise flags as
// near-identical boilerplate across ~28 entries.
interface EventDefinition {
  eventCode: RatingEventCode;
  component: string | null;
  defaultSeverity: string | null;
  eventType: string | null;
  probableCause: string | null;
  description: string;
  clearEventCode?: RatingEventCode | null;
}

function event(def: EventDefinition): EventCatalogInsert {
  const clearEventCode = def.clearEventCode ?? null;
  return {
    eventCode: def.eventCode,
    component: def.component,
    defaultSeverity: def.defaultSeverity,
    eventType: def.eventType,
    probableCause: def.probableCause,
    description: def.description,
    isAutoClearing: clearEventCode !== null,
    clearEventCode,
    isActive: true,
  };
}

// Every column the table declares appears here; `description` is NOT NULL and
// its text is given by the spec, not left to the implementer. Descriptions
// state the CONDITION, never the remediation (rm02-spec §Implementation §1).
//
// Clearing follows the two shapes of rm02-spec D5: a given `clearEventCode`
// (which must exist in the catalog) marks the row auto-clearing; omitting it
// leaves the row non-auto-clearing. Exactly eight rows name `BATCH_COMPLETE`
// as their clearer (rm02-spec §Verification 11 — rm11 added BATCH_STRANDED as
// the eighth).
export const EVENT_CATALOG_SEED: readonly EventCatalogInsert[] = [
  // CRITICAL — the pipeline cannot proceed, or financial integrity is at risk.
  event({
    eventCode: "DB_WRITE_FAILURE",
    component: "RL",
    defaultSeverity: "CRITICAL",
    eventType: "processingErrorAlarm",
    probableCause: "underlyingResourceUnavailable",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "The rating loader could not write to the database and the batch transaction was rolled back.",
  }),
  event({
    eventCode: "RECON_IMBALANCE",
    component: "RL",
    defaultSeverity: "CRITICAL",
    eventType: "processingErrorAlarm",
    probableCause: "corruptData",
    description:
      "A batch failed the arithmetic check `parsed = rated + rejected + discarded`, so records are unaccounted for.",
  }),
  // rm18-spec §Implementation §1 — RP resolved a card-driven `usage_rate`
  // (plaSpecId = 'PLA_USAGE_RATE'); PER_UNIT-from-card is unbuilt
  // (architecture Inv. #24), so the record cannot be rated at all.
  event({
    eventCode: "CARD_DRIVEN_RATING_UNSUPPORTED",
    component: "RP",
    defaultSeverity: "CRITICAL",
    eventType: "processingErrorAlarm",
    probableCause: "unsupportedPricingModel",
    description:
      "The resolved usage_rate price is card-driven (plaSpecId = PLA_USAGE_RATE); PER_UNIT rating from a rate card is not supported.",
  }),
  // MAJOR — an isolated unit failed completely.
  event({
    eventCode: "LOAD_BLOCKED_BILLED",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "billedRecordCollision",
    description:
      "A batch was refused whole because one or more incoming records collide with a live row already on an approved invoice.",
  }),
  event({
    eventCode: "SHRINKING_REISSUE",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "incompleteRedelivery",
    description:
      "A reissued file carried fewer records than the run it supersedes, so records were retired with nothing replacing them.",
  }),
  event({
    eventCode: "FILE_NOT_RECEIVED",
    component: "SCHEDULER",
    defaultSeverity: "MAJOR",
    eventType: "qualityOfServiceAlarm",
    probableCause: "expectedFileAbsent",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A usage file the configured cadence expected has not arrived within its window.",
  }),
  event({
    eventCode: "FILE_KEY_UNRESOLVED",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "configurationOrCustomizationError",
    description:
      "The configured derivation rule could not extract a `file_key` from the filename, so the file's logical delivery identity is unknown.",
  }),
  event({
    eventCode: "PARSE_FAILURE",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "corruptData",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A usage file could not be parsed at all, or its reject count exceeded the configured threshold for its `udr_type`.",
  }),
  event({
    eventCode: "LOOKUP_MISS",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "underlyingResourceUnavailable",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A price, offering, subscription or inventory lookup returned no row for a record that requires one.",
  }),
  event({
    eventCode: "CURRENCY_MISMATCH",
    component: "RL",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "configurationOrCustomizationError",
    description:
      "The currency on the resolved price does not match the billing account's currency.",
  }),
  event({
    eventCode: "BATCH_STRANDED",
    component: "SCHEDULER",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "abandonedClaim",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A udr_batch row stuck at PROCESSING beyond the configured threshold — a worker was killed mid-load — was resolved (FAILED) by the stranded-batch reconcile, releasing the file's claim for reprocessing.",
  }),
  // rm18-spec §Implementation §1 — the PER_UNIT RAN-usage three-factor
  // identity lock (architecture Inv. #20) and resolution failures RP raises.
  // Never auto-clearing: a later clean batch does not make the earlier
  // mismatch untrue (rm12/rm02 D5 rule).
  event({
    eventCode: "UNKNOWN_SUBSCRIBER",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "subscriberUnresolved",
    description:
      "The MNO key resolved to no active RAN_USAGE subscription (including an empty party_role_specification).",
  }),
  event({
    eventCode: "SUBSCRIBER_REF_MISMATCH",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "identityLockMismatch",
    description:
      "The ratecard's lkp_subscriber_ref_id does not equal the party_role_id resolved from the MNO key (identity-lock factor 2).",
  }),
  event({
    eventCode: "PRODUCT_PIN_MISMATCH",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "identityLockMismatch",
    description:
      "The resolved offering family id does not equal the pinned subscription_product_name flow variable (identity-lock factor 3).",
  }),
  event({
    eventCode: "MNO_KEY_NOT_UNIQUE",
    component: "RP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "duplicateSubscriberKey",
    description:
      "One MNO key resolved to more than one customer, violating the subscriber-resolution uniqueness guard.",
  }),
  // rm18-spec §Implementation §1 — the ratecard↔input completeness and
  // mapping hard-stops PRP's validations (rm21) raise. Never auto-clearing.
  event({
    eventCode: "SERVICE_CODE_MISMATCH",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "serviceCodeMismatch",
    description:
      "The input row's service_code does not match the matched ratecard row's service_code.",
  }),
  event({
    eventCode: "RATECARD_COVERAGE_GAP",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "ratecardCoverageGap",
    description:
      "An active ratecard polygon has no corresponding input row, under HARD_STOP coverage enforcement.",
  }),
  event({
    eventCode: "INPUT_UNMAPPED",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "inputUnmapped",
    description: "An input row maps to no ratecard entry.",
  }),
  event({
    eventCode: "UDRTYPE_MISMATCH",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "udrTypeMismatch",
    description:
      "The dataset's udr_type does not match the resolved offering's udrType product specification.",
  }),
  // MINOR — degraded, but the unit completed.
  // bm25-spec §Implementation §4. Mirrors LOAD_BLOCKED_BILLED but MINOR, not
  // MAJOR: an in-flight bill run is recoverable (reject/rerun the run or wait,
  // then reload), where a BILL_APPROVED collision is financial finality.
  // `claimedRecordCollision` is the locally-defined cause (distinct from
  // billed's `billedRecordCollision`); not auto-clearing (a human decides).
  event({
    eventCode: "LOAD_BLOCKED_INFLIGHT",
    component: "RL",
    defaultSeverity: "MINOR",
    eventType: "processingErrorAlarm",
    probableCause: "claimedRecordCollision",
    description:
      "A batch was refused whole because one or more incoming records collide with a live BILL_DRAFT row held by an in-flight bill run.",
  }),
  event({
    eventCode: "BATCH_PARTIAL",
    component: "RL",
    defaultSeverity: "MINOR",
    eventType: "qualityOfServiceAlarm",
    probableCause: "thresholdCrossed",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A batch completed with some records rejected, below the configured threshold; the reject file names them.",
  }),
  event({
    eventCode: "TASK_RETRY_OK",
    component: null,
    defaultSeverity: "MINOR",
    eventType: "processingErrorAlarm",
    probableCause: "retrySucceeded",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A task failed and succeeded on a later attempt; the work completed but the underlying instability did not.",
  }),
  // WARNING — nothing failed, but someone should know.
  event({
    eventCode: "FILE_LATE",
    component: "SCHEDULER",
    defaultSeverity: "WARNING",
    eventType: "qualityOfServiceAlarm",
    probableCause: "deliveryWindowMissed",
    clearEventCode: "BATCH_COMPLETE",
    description:
      "A usage file arrived outside the window its configured cadence expects.",
  }),
  event({
    eventCode: "DUPLICATE_BATCH",
    component: "PRP",
    defaultSeverity: "WARNING",
    eventType: "qualityOfServiceAlarm",
    probableCause: "duplicateDelivery",
    description:
      "A byte-identical redelivery of an already-processed file was discarded before parsing.",
  }),
  event({
    eventCode: "CROSS_PERIOD_SUPERSEDE",
    component: "RL",
    defaultSeverity: "WARNING",
    eventType: "processingErrorAlarm",
    probableCause: "crossPeriodCorrection",
    description:
      "Supersession retired a predecessor row in a different monthly partition, meaning a corrected timestamp moved the record across a period boundary.",
  }),
  // rm18-spec §Implementation §1 — the WARN-mode twin of
  // RATECARD_COVERAGE_GAP: informational, never auto-clearing (not
  // self-clearing — a zero-traffic cell is tolerated, not resolved).
  event({
    eventCode: "RATECARD_COVERAGE_GAP_WARN",
    component: "PRP",
    defaultSeverity: "WARNING",
    eventType: "qualityOfServiceAlarm",
    probableCause: "ratecardCoverageGapTolerated",
    description:
      "An active ratecard polygon has no corresponding input row, tolerated under WARN coverage enforcement.",
  }),
  // No severity — logged, never alarmed (rm02-spec §A). BATCH_COMPLETE is the
  // clear_event_code for seven other codes (D6) yet carries NULL severity of
  // its own: a clean run is not an alarm.
  event({
    eventCode: "BATCH_COMPLETE",
    component: "RL",
    defaultSeverity: null,
    eventType: "processingErrorAlarm",
    probableCause: "normalCompletion",
    description:
      "A batch completed cleanly with counts that reconcile and the source file archived.",
  }),
  // The clearing event itself (rm02-spec D6a). Carries default_severity
  // 'CLEARED' — the X.733 value that exists for precisely this — so a clear IS
  // an alarm-stream event, not a NULL-severity routine row. It is never itself
  // cleared.
  event({
    eventCode: "CLEARED",
    component: null,
    defaultSeverity: "CLEARED",
    eventType: "processingErrorAlarm",
    probableCause: "normalCompletion",
    description:
      "A previously raised alarm condition on this `alarm_key` no longer holds.",
  }),
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
