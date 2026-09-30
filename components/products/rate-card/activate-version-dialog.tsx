"use client";

import { activateRatecardVersionAction } from "@/actions/product/activate-ratecard-version.action";
import {
  VersionActionDialog,
  type RateCardChangeCounts,
} from "@/components/products/rate-card/version-action-dialog";

// pm66-spec D6 — the page's ONE `--action-cta-bg` (C10, settled: the CTA is
// "Activate version", not "Upload new version" — activation is the single act
// with billing consequence; record creation takes `--action-primary-bg`).
// A PLAIN confirmation, not danger (§7's Activate-confirmation construction),
// and not a bare "Are you sure": above the confirm control it names the version
// being superseded and shows the added/changed/removed counts.
//
// There is NO carry-forward summary (D-A7): activation is two status flips and
// writes no rows, so the counts are the whole consequence. The counts SHOWN
// come from pm62 via the server (the page); the counts RECORDED come from pm63
// inside the transaction — they can differ if the card changed between render
// and click, which is exactly why the audit records its own (D6). Every refusal
// renders from the typed result (D10). This is a thin wrapper over the shared
// `VersionActionDialog` shell (the rollback dialog is its twin).

export interface ActivateVersionDialogProps {
  trigger: React.ReactNode;
  versionId: string;
  versionNum: number;
  // The current ACTIVE version this activation would supersede (null on the
  // card's first-ever activation).
  supersededVersionId: string | null;
  counts: RateCardChangeCounts;
}

export function ActivateVersionDialog({
  trigger,
  versionId,
  versionNum,
  supersededVersionId,
  counts,
}: ActivateVersionDialogProps): React.JSX.Element {
  return (
    <VersionActionDialog
      trigger={trigger}
      title="Activate version"
      confirmLabel="Activate"
      counts={counts}
      action={() => activateRatecardVersionAction(versionId)}
      successMessage={(superseded) =>
        superseded
          ? "Version activated — the previous version is now superseded."
          : "Version activated."
      }
      staleCodes={["NOT_DRAFT", "VERSION_NOT_FOUND"]}
      staleMessage="This version can no longer be activated. Refreshing…"
      body={
        <>
          <span className="font-mono text-mono">{versionId}</span> (v
          {versionNum}) becomes the live version for this card.{" "}
          {supersededVersionId ? (
            <>
              The version currently active,{" "}
              <span className="font-mono text-mono">{supersededVersionId}</span>
              , becomes superseded — its rows stay readable for rollback.
            </>
          ) : (
            <>This card has no active version yet.</>
          )}
        </>
      }
    />
  );
}
