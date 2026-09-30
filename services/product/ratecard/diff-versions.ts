import type { Database } from "@/db/client";
import { ratecardRepository } from "@/db/repositories/ratecard";
import type { RatecardRanUsageLkp } from "@/db/schema/product";
import { rateCardRowKey } from "@/validation/product/ratecard.schema";

// pm62-spec — read-only. Compares a selected rate-card version against the
// card's current ACTIVE version and buckets every distinct row key into
// exactly one of `added` / `changed` / `removed`, rendered in that order by
// both this file and the UI (D1, code-standards §2.28/§4.24 — the rendering
// order is a property of the contract, not a decision pm66 re-makes).
//
// D2 — ONE BUCKET PER KEY. For each key (mno_public_key,
// commercial_unit_public_key, polygon_id): absent→present is `added`;
// present→absent is `removed` (carries the outgoing row only, D3); present in
// both with any payload difference is `changed` exactly once (carries both
// rows); present in both and identical is reported in NO bucket. A key can
// never land in two buckets, so the bucket counts always sum to the number of
// distinct changed/added/removed keys.
//
// WHICH COLUMNS COUNT AS "changed" — a doc-vs-doc conflict, resolved, not
// silently picked. pm62-diff.md D2's own sentence names only
// `lkp_subscriber_ref_id` and `service_code` as the compared non-key columns.
// code-standards §6.29 says more broadly that `polygon_end_date`, `state`,
// `district` and `rate_per_unit` are "likewise compared as the row's
// payload", and that a `polygon_start_date` change is a `changed` row, "not a
// remove + add". This file implements the code-standards §6.29 reading (the
// broader one, confirmed with the user 2026-09-28): EVERY non-key column —
// `lkp_subscriber_ref_id`, `service_code`, `polygon_start_date`,
// `polygon_end_date`, `state`, `district`, `rate_per_unit` — is compared.
// pm62-diff.md's narrower D2 sentence should be corrected to match; flagged
// here rather than edited silently (workflow §7.10/§3 "doc-vs-doc conflicts").
//
// D3 — "removed" means exactly that. A key present in the outgoing ACTIVE
// version and absent from the incoming one is `removed`: it is not in the new
// version and stays readable in the superseded one (D-A7). The bucket carries
// the OUTGOING row only — no date, no carry-forward copy, no outcome copy.
//
// D4 — keyed in memory on the SAME delimiter pm58's duplicate-key check uses.
// `rateCardRowKey` (validation/product/ratecard.schema.ts) is imported and
// reused verbatim rather than re-implemented, so there is exactly one place a
// key is ever joined from its three columns — two different delimiters in two
// files would be the beginning of two different answers.
//
// D5 — the query budget is exactly TWO reads, nothing per row and nothing per
// bucket (code-standards §3.23). Both reads are full and unpaged
// (getAllRowsForVersion / getCurrentActiveRows, added to
// db/repositories/ratecard.ts for this unit — pm62's own boundary lists only
// this file, but the two-query budget this very spec sets cannot be hit by
// composing pm60's existing paged/header reads, each of which issues its own
// COUNT; raised as a small, read-only, additive repository extension rather
// than silently working around it). `getAllRowsForVersion` reads the selected
// version's rows BY ID — a display path, not a resolution path (pm60 D5,
// §6.35): a SUPERSEDED version is diffable by design. `getCurrentActiveRows`
// resolves and reads the card's current ACTIVE version's rows in one
// statement, the same `card_name` + `status = 'ACTIVE'` definition
// `getCurrentActive` uses.
//
// D6 — the degenerate cases fall out of the bucketing itself, with NO
// special-casing and NO throw:
//   - No ACTIVE version exists → getCurrentActiveRows returns [] → every
//     incoming key is `added`; `changed`/`removed` are empty.
//   - The selected version IS the current ACTIVE → both reads return the
//     same rows → every key matches its own row → no bucket for any key.
//   - The selected version is SUPERSEDED → diffs against the current ACTIVE
//     in the same direction as any other version; pm64's rollback direction
//     is pm64's own concern, not a flag on this function.
//
// D7 — this file computes nothing about activation. It writes nothing, locks
// nothing and opens no transaction; it performs no resolution — no as-of
// window, no `polygon_start_date <= event_time` logic, no effectivity
// (§1.35). Framework-agnostic: no `next/*` import (§7.2).

// The diff VIEW types are defined once in `@/types/product` (re-homed there at
// pm66 so the diff PANEL — a component — can type its props without a
// `components → services` import, forbidden by the boundaries rule). Imported
// and re-exported here so every existing importer of these names from this
// module keeps working and there is exactly one definition.
import type {
  RateCardDiffAddedEntry,
  RateCardDiffChangedEntry,
  RateCardDiffKey,
  RateCardDiffRemovedEntry,
  RateCardVersionDiff,
} from "@/types/product";

export type {
  RateCardDiffAddedEntry,
  RateCardDiffBucket,
  RateCardDiffChangedEntry,
  RateCardDiffKey,
  RateCardDiffRemovedEntry,
  RateCardVersionDiff,
} from "@/types/product";

// The non-key payload comparison (§6.29's broader reading — see the file
// banner above). `polygon_start_date` is out of the ROW KEY (D-A9) but is
// compared here as payload, exactly like every other descriptive column.
function payloadDiffers(
  outgoing: RatecardRanUsageLkp,
  incoming: RatecardRanUsageLkp,
): boolean {
  return (
    outgoing.lkpSubscriberRefId !== incoming.lkpSubscriberRefId ||
    outgoing.serviceCode !== incoming.serviceCode ||
    outgoing.polygonStartDate !== incoming.polygonStartDate ||
    outgoing.polygonEndDate !== incoming.polygonEndDate ||
    outgoing.state !== incoming.state ||
    outgoing.district !== incoming.district ||
    outgoing.ratePerUnit !== incoming.ratePerUnit
  );
}

function keyOf(row: RatecardRanUsageLkp): string {
  return rateCardRowKey(
    row.mnoPublicKey,
    row.commercialUnitPublicKey,
    row.polygonId,
  );
}

function keyFieldsOf(row: RatecardRanUsageLkp): RateCardDiffKey {
  return {
    mnoPublicKey: row.mnoPublicKey,
    commercialUnitPublicKey: row.commercialUnitPublicKey,
    polygonId: row.polygonId,
  };
}

// The one exported function (I1): a version id and the card it belongs to in,
// the three buckets out. `cardName` is taken as an explicit argument (rather
// than looked up from the version row) so this function's own query budget
// stays at exactly two — a caller already holds the version's `card_name`
// from having listed or selected it.
export async function diffAgainstActive(
  db: Database,
  cardName: string,
  versionId: string,
): Promise<RateCardVersionDiff> {
  // D5 — exactly two full reads, issued together; nothing per row, nothing
  // per bucket.
  const [incomingRows, outgoingRows] = await Promise.all([
    ratecardRepository.getAllRowsForVersion(db, versionId),
    ratecardRepository.getCurrentActiveRows(db, cardName),
  ]);

  const outgoingByKey = new Map<string, RatecardRanUsageLkp>();
  for (const row of outgoingRows) {
    outgoingByKey.set(keyOf(row), row);
  }

  const added: RateCardDiffAddedEntry[] = [];
  const changed: RateCardDiffChangedEntry[] = [];
  const seenKeys = new Set<string>();

  for (const incoming of incomingRows) {
    const key = keyOf(incoming);
    seenKeys.add(key);

    const outgoing = outgoingByKey.get(key);
    if (outgoing === undefined) {
      added.push({ ...keyFieldsOf(incoming), incoming });
      continue;
    }
    if (payloadDiffers(outgoing, incoming)) {
      changed.push({ ...keyFieldsOf(incoming), outgoing, incoming });
    }
    // Identical → no bucket (D2).
  }

  const removed: RateCardDiffRemovedEntry[] = [];
  for (const [key, outgoing] of outgoingByKey) {
    if (seenKeys.has(key)) continue;
    removed.push({ ...keyFieldsOf(outgoing), outgoing });
  }

  return {
    added: { count: added.length, rows: added },
    changed: { count: changed.length, rows: changed },
    removed: { count: removed.length, rows: removed },
  };
}
