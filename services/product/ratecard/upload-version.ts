import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  ratecardRepository,
  type LookupRowInput,
} from "@/db/repositories/ratecard";
import { isUniqueViolation } from "@/lib/db-errors";
import { todayInZone } from "@/lib/timezone";
import { parseRateCardCsv } from "@/services/product/ratecard/parse-csv";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import {
  validateRateCardFile,
  type RateCardIssue,
  type RateCardUploadViolation,
} from "@/validation/product/ratecard.schema";

// pm61-spec I1 — the whole pipeline from the parse onward (D1), one
// transaction. Framework-agnostic (no `next/*` import, §7.2): the action
// (`actions/product/upload-ratecard-version.action.ts`) owns `requirePermission`,
// the FormData/pre-read checks and `revalidatePath`; this file owns parse,
// structural validation (D3 — no referential check, no read of `inventory` or
// `ordering/**`), the replace-open-draft step (D12) and the one write
// transaction (D5/D7). `parseRateCardCsv` is left uncaught here on purpose — a
// malformed CSV's throw propagates to the action, which is the layer that
// "wraps this call" (pm59-spec's own words) and turns it into a file-level
// refusal distinct from the three closed structural violations.

export interface UploadRatecardVersionInput {
  cardName: string;
  bytes: Buffer;
  sourceFile: string;
  uploadedBy: string;
  // The upload instant (D4) — the action passes `new Date()` once; tests pass
  // a fixed instant (I5.11). Both `uploaded_at` and `snapshot_date` are
  // derived from this ONE value so the two can never disagree across
  // midnight.
  uploadedAt: Date;
}

// D3's one non-structural signal. Deliberately NOT `RateCardIssue` (whose
// `violation` is the closed, 3-member `RateCardUploadViolation` — a checksum
// match is not one of those three and must never be shoehorned into one,
// workflow §5.4). Same line/column/value/reason shape so pm66 can render it
// in the same table; carries no `violation` because it isn't one.
export interface RateCardUploadWarning {
  readonly line: number;
  readonly column: string | null;
  readonly value: string | null;
  readonly reason: string;
}

export type UploadRatecardVersionResult =
  | {
      ok: true;
      versionId: string;
      rowCount: number;
      warnings: RateCardUploadWarning[];
    }
  | {
      ok: false;
      code: RateCardUploadViolation;
      issues: readonly RateCardIssue[];
    }
  // Not one of the three closed structural violations (workflow §5.4) — a
  // concurrency conflict, not a content defect. Two uploads racing for the
  // same card_name with no open draft yet both see "no draft" and both try to
  // insert one; the loser hits `ratecard_version_one_draft_per_card` and gets
  // this typed refusal instead of a raw 23505 (I5.8).
  | { ok: false; code: "CONCURRENT_UPLOAD_CONFLICT" };

export async function uploadRatecardVersion(
  input: UploadRatecardVersionInput,
): Promise<UploadRatecardVersionResult> {
  // Parse first (D1) — uncaught; see the file banner above.
  const parsed = parseRateCardCsv(input.bytes);

  // D3's adapter: pm59's header-keyed `cells` back to pm58's positional
  // `rows: string[][]`, aligned to `parsed.header` (not to
  // RATE_CARD_FILE_HEADERS' order — validateRateCardFile matches by name, not
  // position). This is safe from the duplicate-header collapse a `Record`
  // lookup would otherwise risk: a duplicate/unknown/missing header always
  // trips HEADER_MISMATCH from `parsed.header` alone (the raw array, which the
  // parser hands over faithfully, duplicates included) and returns before any
  // row is read, so `cells` is only ever consulted once every header is
  // already known to be unique. Every row is carried straight through in
  // file order — no filter, no reorder — so the validator's own `index + 2`
  // line numbers agree with the parser's `line` for the same row by the
  // shared D5 contract, not by accident.
  const positionalRows = parsed.rows.map((row) =>
    parsed.header.map((header) => row.cells[header] ?? ""),
  );
  const fileResult = validateRateCardFile({
    header: parsed.header,
    rows: positionalRows,
  });

  if (!fileResult.ok) {
    // The validator can accumulate a mix of ROW_SCHEMA_INVALID and
    // DUPLICATE_ROW_KEY issues in one pass; `code` is a headline, not a
    // summary — the first issue found, in file order. `issues` (rendered in
    // full by pm66) carries the complete picture regardless of `code`.
    return {
      ok: false,
      code: fileResult.issues[0]!.violation,
      issues: fileResult.issues,
    };
  }

  const snapshotDate = todayInZone(input.uploadedAt, getAppTimezone());

  try {
    return await db.transaction(async (tx) => {
      const existingVersions = await ratecardRepository.listVersions(
        tx,
        input.cardName,
      );
      const existingDraft = existingVersions.find((v) => v.status === "DRAFT");

      if (existingDraft) {
        // D12/D-A11 — a wrong upload's recovery path: replace the open draft
        // rather than refuse. `deleteDraftVersion` re-locks and re-checks
        // status on `tx` itself (TOCTOU-safe); a non-`ok` result here means
        // the draft we just listed no longer matches what we listed (a
        // concurrent writer), which is not one of the three closed
        // violations — surface it as an unexpected server error rather than
        // inventing a fourth code.
        const deleted = await ratecardRepository.deleteDraftVersion(
          tx,
          existingDraft.ratecardVersionId,
        );
        if (!deleted.ok) {
          throw new Error(
            `uploadRatecardVersion: could not replace open draft ${existingDraft.ratecardVersionId} (${deleted.code})`,
          );
        }
      }

      // D12 — `version_num` is read on `tx`, AFTER the delete: the replaced
      // draft's number is what the new version reuses, and reading it before
      // the delete (or outside the transaction) is the TOCTOU class §1.13
      // forbids. Re-querying is skipped when nothing was deleted — the first
      // read already reflects the true current max.
      const versions = existingDraft
        ? await ratecardRepository.listVersions(tx, input.cardName)
        : existingVersions;
      const versionNum =
        versions.reduce((max, v) => Math.max(max, v.versionNum), 0) + 1;

      // Read AFTER the draft-replace delete (when one happened): `versions`
      // no longer contains a just-deleted draft, so a checksum match here can
      // never point the warning at a version this same transaction just
      // removed.
      const duplicateOf = versions.find(
        (v) => v.fileChecksum !== null && v.fileChecksum === parsed.checksum,
      );

      const { versionId } = await ratecardRepository.insertVersion(tx, {
        cardName: input.cardName,
        versionNum,
        status: "DRAFT",
        snapshotDate,
        sourceFile: input.sourceFile,
        fileChecksum: parsed.checksum,
        rowCount: fileResult.rows.length,
        uploadedBy: input.uploadedBy,
        uploadedAt: input.uploadedAt,
      });

      // D0/hand-off (1) — an empty optional date/numeric cell is "" up
      // through the row schema (Inv. #51); the `date`/`numeric` columns
      // reject "", so the "" → NULL conversion happens here, immediately
      // before the insert.
      const lookupRows: LookupRowInput[] = fileResult.rows.map((row) => ({
        mnoPublicKey: row.mno_public_key,
        commercialUnitPublicKey: row.commercial_unit_public_key,
        polygonId: row.polygon_id,
        polygonStartDate: row.polygon_start_date,
        polygonEndDate:
          row.polygon_end_date === "" ? null : row.polygon_end_date,
        state: row.state === "" ? null : row.state,
        district: row.district === "" ? null : row.district,
        lkpSubscriberRefId: row.lkp_subscriber_ref_id,
        serviceCode: row.service_code === "" ? null : row.service_code,
        ratePerUnit: row.rate_per_unit === "" ? null : row.rate_per_unit,
      }));
      await ratecardRepository.insertLookupRows(tx, versionId, lookupRows);

      // D7 — one audit event, same transaction as the data change; a failed
      // upload (returned above, before the transaction opened) writes none.
      await insertAuditEvent(tx, {
        eventType: "RATECARD_VERSION_UPLOADED",
        actorUserId: input.uploadedBy,
        targetEntity: "RATECARD_VERSION",
        targetId: versionId,
        beforeData: existingDraft
          ? { replacedDraftVersionId: existingDraft.ratecardVersionId }
          : null,
        afterData: {
          cardName: input.cardName,
          versionNum,
          rowCount: fileResult.rows.length,
          sourceFile: input.sourceFile,
          fileChecksum: parsed.checksum,
        },
      });

      const warnings: RateCardUploadWarning[] = duplicateOf
        ? [
            {
              line: 1,
              column: null,
              value: parsed.checksum,
              reason: `This file's checksum matches an earlier version (${duplicateOf.ratecardVersionId}) on this card — check you are not re-uploading a version already on file.`,
            },
          ]
        : [];

      return {
        ok: true,
        versionId,
        rowCount: fileResult.rows.length,
        warnings,
      };
    });
  } catch (err) {
    // Two racing uploads for the same card_name can hit EITHER unique index:
    // `ratecard_version_one_draft_per_card` when a draft already exists, or
    // `ratecard_version_card_name_version_num_unique` when neither race
    // participant sees an existing version yet and both compute the same
    // `versionNum` (a brand-new card_name, or two uploads racing right after
    // the last version's status changed). Postgres reports whichever
    // constraint it checks first, so both names are the same conflict from
    // this caller's point of view and both map to the same typed refusal.
    if (
      isUniqueViolation(err, "ratecard_version_one_draft_per_card") ||
      isUniqueViolation(err, "ratecard_version_card_name_version_num_unique")
    ) {
      return { ok: false, code: "CONCURRENT_UPLOAD_CONFLICT" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
