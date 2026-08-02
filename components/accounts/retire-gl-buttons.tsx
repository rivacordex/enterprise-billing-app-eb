"use client";

import { useState } from "react";

import {
  retireGlCodeAction,
  type RetireGlCodeActionResult,
} from "@/actions/accounts/retire-gl-code";
import {
  retireGlMappingAction,
  type RetireGlMappingActionResult,
} from "@/actions/accounts/retire-gl-mapping";

// ── Retire GL Code ───────────────────────────────────────────────────────────

function describeRetireCodeError(result: RetireGlCodeActionResult): string {
  if (!result.ok) {
    if (result.code === "CONFLICT")
      return "This code was edited concurrently. Reload and try again.";
    if (result.code === "ALREADY_RETIRED") return "Already retired.";
    if (result.code === "NOT_FOUND") return "GL code not found.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to retire GL codes.";
  }
  return "";
}

interface RetireGlCodeButtonProps {
  glCode: string;
  lastModified: string;
}

export function RetireGlCodeButton({
  glCode,
  lastModified,
}: RetireGlCodeButtonProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  async function handleRetire() {
    setBusy(true);
    setError("");
    try {
      const result = await retireGlCodeAction({ glCode, lastModified });
      if (!result.ok) {
        setError(describeRetireCodeError(result));
        setConfirming(false);
      }
      // On success Next.js revalidates the path and re-renders the page.
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <span role="alert" className="text-body-sm text-destructive">
        {error}
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-7 rounded-md border border-[color:var(--border-default)] px-2 text-body-sm text-muted-foreground hover:border-destructive hover:text-destructive"
      >
        Retire
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <span className="text-body-sm text-muted-foreground">Confirm?</span>
      <button
        type="button"
        disabled={busy}
        onClick={handleRetire}
        className="h-7 rounded-md bg-destructive px-2 text-body-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "…" : "Yes, retire"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="h-7 rounded-md border border-[color:var(--border-default)] px-2 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
      >
        Cancel
      </button>
    </span>
  );
}

// ── Retire GL Mapping ────────────────────────────────────────────────────────

function describeRetireMappingError(
  result: RetireGlMappingActionResult,
): string {
  if (!result.ok) {
    if (result.code === "ORPHAN_BLOCK")
      return `Blocked — would orphan: ${result.affectedAccounts.join(", ")}`;
    if (result.code === "CONFLICT")
      return "Edited concurrently. Reload and try again.";
    if (result.code === "ALREADY_RETIRED") return "Already retired.";
    if (result.code === "NOT_FOUND") return "Mapping not found.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to retire mappings.";
  }
  return "";
}

interface RetireGlMappingButtonProps {
  glMappingId: string;
  lastModified: string;
}

export function RetireGlMappingButton({
  glMappingId,
  lastModified,
}: RetireGlMappingButtonProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  async function handleRetire() {
    setBusy(true);
    setError("");
    try {
      const result = await retireGlMappingAction({ glMappingId, lastModified });
      if (!result.ok) {
        setError(describeRetireMappingError(result));
        setConfirming(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <span role="alert" className="text-body-sm text-destructive">
        {error}
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-7 rounded-md border border-[color:var(--border-default)] px-2 text-body-sm text-muted-foreground hover:border-destructive hover:text-destructive"
      >
        Retire
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <span className="text-body-sm text-muted-foreground">Confirm?</span>
      <button
        type="button"
        disabled={busy}
        onClick={handleRetire}
        className="h-7 rounded-md bg-destructive px-2 text-body-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "…" : "Yes, retire"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="h-7 rounded-md border border-[color:var(--border-default)] px-2 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
      >
        Cancel
      </button>
    </span>
  );
}
