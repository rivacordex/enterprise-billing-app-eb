"use client";

import { rollbackRatecardVersionAction } from "@/actions/product/rollback-ratecard-version.action";
import {
  VersionActionDialog,
  type RateCardChangeCounts,
} from "@/components/products/rate-card/version-action-dialog";

// pm66-spec D7 — a PLAIN confirmation, NOT danger: versions are immutable, so
// nothing is lost and the move is itself reversible (ui-context §10.6). It names
// the version being demoted and repeats the same counts COMPUTED IN THE OTHER
// DIRECTION (target against current ACTIVE — pm62 D6, pm64 D4). Confirm in
// `--action-cta-bg` inside the dialog; Activate and Roll back never co-render (a
// version cannot be both DRAFT and SUPERSEDED), so the one-accent-per-view rule
// holds (D7). Every refusal renders from the typed result (D10). Thin wrapper
// over the shared `VersionActionDialog` shell (the activate dialog is its twin).

export interface RollbackVersionDialogProps {
  trigger: React.ReactNode;
  versionId: string;
  versionNum: number;
  // The current ACTIVE version this rollback would demote (null when the card
  // has no active version — the rollback simply promotes the target).
  demotedVersionId: string | null;
  counts: RateCardChangeCounts;
}

export function RollbackVersionDialog({
  trigger,
  versionId,
  versionNum,
  demotedVersionId,
  counts,
}: RollbackVersionDialogProps): React.JSX.Element {
  return (
    <VersionActionDialog
      trigger={trigger}
      title="Roll back to this version"
      confirmLabel="Roll back"
      counts={counts}
      action={() => rollbackRatecardVersionAction(versionId)}
      successMessage={(superseded) =>
        superseded
          ? "Rolled back — the current version is now superseded."
          : "Rolled back."
      }
      staleCodes={["NOT_SUPERSEDED", "VERSION_NOT_FOUND"]}
      staleMessage="This version can no longer be rolled back. Refreshing…"
      body={
        <>
          <span className="font-mono text-mono">{versionId}</span> (v
          {versionNum}) becomes the live version again.{" "}
          {demotedVersionId ? (
            <>
              The version currently active,{" "}
              <span className="font-mono text-mono">{demotedVersionId}</span>,
              becomes superseded — nothing is lost, and this move is itself
              reversible.
            </>
          ) : (
            <>This card has no active version to demote.</>
          )}
        </>
      }
    />
  );
}

export type { RateCardChangeCounts };
