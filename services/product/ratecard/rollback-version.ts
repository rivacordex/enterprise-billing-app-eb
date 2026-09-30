import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { ratecardRepository } from "@/db/repositories/ratecard";
import { isUniqueViolation } from "@/lib/db-errors";
import { diffAgainstActive } from "@/services/product/ratecard/diff-versions";
import type { RateCardVersionStatus } from "@/types/product";

// pm64-spec — return a SUPERSEDED version to ACTIVE and demote the card's
// current ACTIVE (if any), under one lock and in one transaction. This is the
// SAME SHAPE as pm63's activation (D2): two status flips, and NO row writes to
// RATECARD_RAN_USAGE_LKP anywhere in this file — a version's rows are exactly
// its uploaded file (D1/D-A7/Inv. #46). A rollback is a STATUS CHANGE, not an
// edit: a superseded version's rows are already exactly as they were when it
// was live, so restoring it needs no reconstruction — flipping two statuses
// puts the card back where it was. There is NO `INSERT … SELECT` here; if this
// file grew one it would have misunderstood the model (D2, workflow §5.7).
// Nothing here calls insertLookupRows/insertVersion.
//
// Honest consequence, stated rather than hidden (D2): rolling back LOSES the
// keys the superseded version never had — that is what rolling back MEANS. The
// way to keep them is to upload a corrected version, not to make rollback
// merge (recorded in pm00-build-plan.md's Part 5 hand-off register).
//
// D3 — same lock, same `tx` read, same TOCTOU discipline as pm63 (§1.13,
// §1.37). BOTH the target SUPERSEDED version and the card's current ACTIVE are
// locked `FOR UPDATE` and re-read on `tx` immediately before the decision:
//   - The target is locked FIRST, via pm60's findVersionForUpdate — the same
//     by-id lock a concurrent re-upload's replace-draft delete (pm61 D12) and
//     an activation (pm63) take, and the only way to learn its `card_name`
//     before the ACTIVE lookup can be issued.
//   - The outgoing ACTIVE is then locked via pm60's findActiveForUpdate. `null`
//     is the ordinary "no current ACTIVE" case (I4.9), not an error — the
//     target simply becomes ACTIVE with nothing to demote.
//
// `superseded_by_version_id` is the ONE field where rollback is not symmetric
// with activation (D3): the outgoing version being demoted gains
// `superseded_by_version_id = <the target>`, while the TARGET's own
// `superseded_by_version_id` — which pointed at the version that originally
// replaced it — is CLEARED, because it is no longer superseded. Lineage is a
// statement about the PRESENT, not a log; the log is the audit trail. Leaving a
// stale pointer on a live version would make the version list render a lie.
//
// The target's `activated_by` / `activated_at` are re-stamped to THIS rollback
// (actor + instant): those columns record when a version is currently active,
// and after a rollback the target is active as of now. The original activation
// survives only in the audit trail (the log), consistent with the lineage rule
// above.
//
// D4 — the audit payload carries the same change counts as activation,
// COMPUTED IN THE OTHER DIRECTION: the target against the current ACTIVE rather
// than incoming against outgoing. pm62's diffAgainstActive does this WITHOUT
// modification (pm62 D6) — it compares two row sets and treats the version id
// it is handed as the "new" side, so passing the TARGET's id yields exactly
// this direction. Computed INSIDE the transaction against the locked versions,
// never from a count a client supplied (the same rule pm63 D8 sets, D4).
//
// D5 — a second ACTIVE is still refused by the partial unique index (Inv. #45),
// which does not care which direction the transition came from; the service's
// own NOT_SUPERSEDED check stays too (§6.30) — the index changes the failure
// mode, it does not replace the check.
//
// Framework-agnostic: no `next/*` import (§7.2). Typed result union, never a
// throw (general §2.9).

export interface RatecardRollbackDiffCounts {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
}

export type RollbackRatecardVersionResult =
  | {
      ok: true;
      versionId: string;
      supersededVersionId: string | null;
      diff: RatecardRollbackDiffCounts;
    }
  | { ok: false; code: "VERSION_NOT_FOUND" }
  | { ok: false; code: "NOT_SUPERSEDED"; status: RateCardVersionStatus }
  // D5 — the activate-vs-rollback race outcome. The loser's promote can hit
  // the partial unique index (Inv. #45) after the winner committed a different
  // ACTIVE for the card; surface that as a typed refusal, not a raw throw — the
  // same treatment pm61's upload gives its own one-draft-per-card conflict.
  | { ok: false; code: "CONCURRENT_ACTIVATION_CONFLICT" };

export async function rollbackRatecardVersion(
  versionId: string,
  actorId: string,
): Promise<RollbackRatecardVersionResult> {
  try {
    return await db.transaction(async (tx) => {
      // D3 step 1a — lock the target version by id and re-read its status on
      // `tx`, immediately before the decision (§1.13). Locked before the outgoing
      // ACTIVE lookup, both because its `card_name` is needed for that lookup and
      // so a concurrent activation / replace-draft delete cannot interleave.
      const target = await ratecardRepository.findVersionForUpdate(
        tx,
        versionId,
      );
      if (!target) {
        return { ok: false, code: "VERSION_NOT_FOUND" };
      }
      if (target.status !== "SUPERSEDED") {
        return { ok: false, code: "NOT_SUPERSEDED", status: target.status };
      }

      // D3 step 1b — lock the card's current ACTIVE version, if any. `null` here
      // is the ordinary "no current ACTIVE" case (I4.9): the target simply
      // becomes ACTIVE with nothing to demote and no null-pointer path.
      const outgoing = await ratecardRepository.findActiveForUpdate(
        tx,
        target.cardName,
      );

      // D4 — the diff's counts, computed INSIDE this transaction against the
      // LOCKED outgoing ACTIVE, in the OTHER direction: the target is the "new"
      // side pm62's diff compares against the current ACTIVE. No client-supplied
      // count ever reaches the payload. Computed BEFORE the flips, while the
      // current ACTIVE is still ACTIVE.
      const diff = await diffAgainstActive(tx, target.cardName, versionId);
      const diffCounts: RatecardRollbackDiffCounts = {
        added: diff.added.count,
        changed: diff.changed.count,
        removed: diff.removed.count,
      };

      // D1/D3 step 2 — demote the outgoing ACTIVE FIRST, then promote the target.
      // Order matters: `ratecard_version_one_active_per_card` is a NON-deferrable
      // partial unique index (Inv. #45), checked per-statement, so promoting the
      // target while the outgoing is still ACTIVE would transiently leave two
      // ACTIVE rows for one card and be rejected immediately (23505). Demoting
      // first means there is never a moment with two ACTIVE — the same
      // supersede-then-activate order pm16's `activateOffering` uses. Status +
      // provenance columns only; no lookup row is inserted, updated or deleted
      // anywhere in this function (D1/D-A7). The target's own
      // `superseded_by_version_id` is CLEARED (it is live again); its
      // `activated_by`/`activated_at` are re-stamped to this rollback.
      if (outgoing) {
        await ratecardRepository.setVersionStatus(
          tx,
          outgoing.ratecardVersionId,
          "SUPERSEDED",
          { supersededByVersionId: versionId },
        );
      }
      const activatedAt = new Date();
      await ratecardRepository.setVersionStatus(tx, versionId, "ACTIVE", {
        activatedBy: actorId,
        activatedAt,
        supersededByVersionId: null,
      });

      // D3 / D7 — exactly one RATECARD_VERSION_ROLLED_BACK audit event, in the
      // same transaction (§1.43), carrying the demoted version id and the three
      // diff counts computed in the other direction. `beforeData` is shaped
      // { supersededVersionId } with the value null on a rollback with no current
      // ACTIVE — the key is always present, matching pm63's payload contract.
      await insertAuditEvent(tx, {
        eventType: "RATECARD_VERSION_ROLLED_BACK",
        actorUserId: actorId,
        targetEntity: "RATECARD_VERSION",
        targetId: versionId,
        beforeData: {
          supersededVersionId: outgoing?.ratecardVersionId ?? null,
        },
        afterData: {
          cardName: target.cardName,
          ...diffCounts,
        },
      });

      return {
        ok: true,
        versionId,
        supersededVersionId: outgoing?.ratecardVersionId ?? null,
        diff: diffCounts,
      };
    });
  } catch (err) {
    // D5 — map ONLY the one-ACTIVE-per-card unique violation (the race loser's
    // promote after a competing activation committed) to the typed refusal;
    // any other error is genuine and rethrows. Caught here, AFTER the
    // transaction, so the rollback rolls back cleanly first.
    if (isUniqueViolation(err, "ratecard_version_one_active_per_card")) {
      return { ok: false, code: "CONCURRENT_ACTIVATION_CONFLICT" };
    }
    throw err;
  }
}
