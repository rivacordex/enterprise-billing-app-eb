import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { ratecardRepository } from "@/db/repositories/ratecard";
import { diffAgainstActive } from "@/services/product/ratecard/diff-versions";
import type { RateCardVersionStatus } from "@/types/product";

// pm63-spec — promote a DRAFT to ACTIVE and demote the prior ACTIVE (if any)
// to SUPERSEDED: two status flips, one transaction, one lock read on `tx`
// immediately before the decision, and NO row writes to
// RATECARD_RAN_USAGE_LKP anywhere in this file (D6/D-A7/Inv. #46) — a
// version's rows are exactly its uploaded file, so there is no
// `INSERT … SELECT` carry-forward and nothing here calls
// insertLookupRows/insertVersion. Framework-agnostic: no `next/*` import
// (§7.2). Typed result union, never a throw (general §2.9).
//
// D1 — the TOCTOU fix this module has paid for four times (pm14, pm15, pm16,
// pm20), now covering activation too. BOTH the target DRAFT and the card's
// current ACTIVE version are locked `FOR UPDATE` and re-read on `tx`
// immediately before the decision:
//   - The DRAFT is locked FIRST, via findVersionForUpdate (pm63 addition to
//     db/repositories/ratecard.ts — the only way to learn its `card_name`
//     before the ACTIVE lookup can even be issued, and the same lock a
//     concurrent re-upload's replace-draft delete takes, so the two
//     serialize rather than interleave, pm61 D12).
//   - The outgoing ACTIVE is then locked via pm60's own findActiveForUpdate —
//     this unit supplies the decision, never its own unlocked read (§6.35).
//
// D2 — the three steps, in order, in one transaction: (1) lock both rows and
// re-read their statuses; (2) promote the DRAFT, demote the prior ACTIVE,
// writing `superseded_by_version_id` / `activated_by` / `activated_at`; (3)
// write the ONE audit event, with the diff's counts computed INSIDE the
// transaction against the LOCKED outgoing version — reusing pm62's
// diffAgainstActive on this same `tx`, never a client-supplied count.
//
// D3 — a second ACTIVE is refused by the partial unique index (pm57a), not
// only by this file's own status check; both matter (§6.30) — the index
// guarantees the invariant even against a direct SQL write or a race the lock
// somehow missed.
//
// D6 — versions are immutable; activation changes statuses and provenance
// columns ONLY. There is no `updateLookupRow` on pm60's surface, which is
// what makes this true by construction, not by discipline.

export interface RatecardActivationDiffCounts {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
}

export type ActivateRatecardVersionResult =
  | {
      ok: true;
      versionId: string;
      supersededVersionId: string | null;
      diff: RatecardActivationDiffCounts;
    }
  | { ok: false; code: "VERSION_NOT_FOUND" }
  | { ok: false; code: "NOT_DRAFT"; status: RateCardVersionStatus };

export async function activateRatecardVersion(
  versionId: string,
  actorId: string,
): Promise<ActivateRatecardVersionResult> {
  return db.transaction(async (tx) => {
    // D1 step 1a — lock the target DRAFT and re-read its status on `tx`,
    // immediately before the decision (§1.13). Locked before the outgoing
    // ACTIVE lookup below, both because its `card_name` is needed to make
    // that lookup, and so a concurrent replace-draft delete (pm61 D12)
    // cannot interleave with this activation.
    const draft = await ratecardRepository.findVersionForUpdate(tx, versionId);
    if (!draft) {
      return { ok: false, code: "VERSION_NOT_FOUND" };
    }
    if (draft.status !== "DRAFT") {
      return { ok: false, code: "NOT_DRAFT", status: draft.status };
    }

    // D1 step 1b — lock the card's current ACTIVE version, if any, via pm60's
    // own locked finder. `null` here is the ordinary "first-ever activation
    // for this card" case (pm62 D6), not an error.
    const outgoing = await ratecardRepository.findActiveForUpdate(
      tx,
      draft.cardName,
    );

    // D5 — the diff's counts, computed INSIDE this transaction against the
    // LOCKED outgoing version (reusing pm62's two-query diff on this same
    // `tx`), never from a count a client supplied.
    const diff = await diffAgainstActive(tx, draft.cardName, versionId);
    const diffCounts: RatecardActivationDiffCounts = {
      added: diff.added.count,
      changed: diff.changed.count,
      removed: diff.removed.count,
    };

    // D2 step 2 — demote the outgoing ACTIVE FIRST, then promote the target.
    // Order matters: `ratecard_version_one_active_per_card` is a NON-deferrable
    // partial unique index (Inv. #45), checked per-statement, so promoting the
    // DRAFT while the outgoing is still ACTIVE would transiently leave two
    // ACTIVE rows for one card and be rejected immediately (23505). Demoting
    // first means there is never a moment with two ACTIVE — the same
    // supersede-then-activate order pm16's `activateOffering` uses. Status +
    // provenance columns only; no lookup row is inserted, updated or deleted
    // anywhere in this function (D6/D-A7).
    const activatedAt = new Date();
    if (outgoing) {
      await ratecardRepository.setVersionStatus(
        tx,
        outgoing.ratecardVersionId,
        "SUPERSEDED",
        { supersededByVersionId: versionId },
      );
    }
    await ratecardRepository.setVersionStatus(tx, versionId, "ACTIVE", {
      activatedBy: actorId,
      activatedAt,
    });

    // D2 step 3 / D5 — exactly one audit event, in the same transaction,
    // carrying the superseded version id and the three diff counts. This
    // payload is the durable record of what the activation moved.
    await insertAuditEvent(tx, {
      eventType: "RATECARD_VERSION_ACTIVATED",
      actorUserId: actorId,
      targetEntity: "RATECARD_VERSION",
      targetId: versionId,
      // Code-review fix — always shape beforeData as { supersededVersionId },
      // with the value itself null on a first-ever activation, rather than
      // making the whole object null. This matches the documented payload
      // contract (progress tracker / pm63-spec D5: "beforeData: {
      // supersededVersionId }") and keeps the key present for every
      // RATECARD_VERSION_ACTIVATED event, so a future audit-detail reader
      // never has to branch on beforeData itself being null vs. having no
      // supersededVersionId.
      beforeData: { supersededVersionId: outgoing?.ratecardVersionId ?? null },
      afterData: {
        cardName: draft.cardName,
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
}
