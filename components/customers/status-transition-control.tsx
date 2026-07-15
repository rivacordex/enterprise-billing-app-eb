"use client";

import { useState } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { OptimisticLockConflictBanner } from "@/components/customers/optimistic-lock-conflict-banner";
import { OrganizationStatusBadge } from "@/components/customers/organization-status-badge";
import { cn } from "@/lib/utils";
import type { CustomerStatus, OrganizationStatus } from "@/types/customer";

type AnyStatus = OrganizationStatus | CustomerStatus;

// Swatch color per target status, matching that status's badge family
// (custmgmt-ui-context.md §1-§2) — a leading dot next to the option's own
// label, not the full badge.
const STATUS_SWATCH_COLOR: Record<AnyStatus, string> = {
  REGISTERED: "bg-[color:var(--color-warning-500)]",
  ACTIVE: "bg-[color:var(--color-success-500)]",
  INACTIVE: "bg-[color:var(--color-neutral-500)]",
  SUSPENDED: "bg-[color:var(--color-danger-500)]",
  DISSOLVED: "bg-[color:var(--color-neutral-500)]",
  MERGED: "bg-[color:var(--color-neutral-500)]",
  INITIALIZED: "bg-[color:var(--color-warning-500)]",
  VALIDATED: "bg-[color:var(--color-info-500)]",
  CLOSED: "bg-[color:var(--color-neutral-500)]",
};

function formatStatusLabel(status: AnyStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function CurrentStatusBadge({
  entityKind,
  status,
}: {
  entityKind: "organization" | "customer";
  status: AnyStatus;
}): React.JSX.Element {
  return entityKind === "organization" ? (
    <OrganizationStatusBadge status={status as OrganizationStatus} />
  ) : (
    <CustomerStatusBadge status={status as CustomerStatus} />
  );
}

export interface StatusTransitionControlProps {
  currentStatus: AnyStatus;
  entityKind: "organization" | "customer";
  // Precomputed server-side from the relevant transition map, never
  // imported/derived client-side (cm09-spec §2.1.1) — this component never
  // imports `ORGANIZATION_TRANSITIONS`/`CUSTOMER_TRANSITIONS` itself.
  nextStates: readonly AnyStatus[];
  onTransition: (
    targetStatus: string,
    statusReason: string,
  ) => Promise<
    | { ok: true; value: { lastModifiedDatetime: Date } }
    | {
        ok: false;
        code: "CONFLICT" | "INVALID_TRANSITION" | "VALIDATION_ERROR";
      }
  >;
  onConflict: () => void;
}

// The one component that ever renders a status dropdown in this module
// (code-standards §4.2) — built once here for organizations, reused
// unchanged by cm10 for customers via the `entityKind` prop.
export function StatusTransitionControl({
  currentStatus,
  entityKind,
  nextStates,
  onTransition,
  onConflict,
}: StatusTransitionControlProps): React.JSX.Element {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (conflict) {
    return <OptimisticLockConflictBanner onReload={onConflict} />;
  }

  // `nextStates.length === 0` is the terminal-state signal — no separate
  // `isTerminal` prop (cm09-spec §2.1.2). Nothing further to do here.
  if (nextStates.length === 0) {
    return (
      <CurrentStatusBadge entityKind={entityKind} status={currentStatus} />
    );
  }

  async function handleApply(): Promise<void> {
    if (selectedTarget === null || reason.trim() === "") return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await onTransition(selectedTarget, reason);

      if (result.ok) {
        setSelectedTarget(null);
        setReason("");
        return;
      }

      if (result.code === "CONFLICT") {
        setConflict(true);
        return;
      }

      // INVALID_TRANSITION / VALIDATION_ERROR: defense-in-depth paths the
      // rendered control can never trigger itself (options are always
      // valid edges, Apply is gated on a non-empty reason) — a generic
      // inline error, not a special banner (cm09-spec §2.1.6).
      setError("Unable to apply this status change. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <CurrentStatusBadge entityKind={entityKind} status={currentStatus} />
        <Select
          value={selectedTarget ?? ""}
          onValueChange={(value) => {
            setSelectedTarget(value);
            setReason("");
          }}
          disabled={submitting}
        >
          <SelectTrigger aria-label="Transition to" className="w-48">
            <SelectValue placeholder="Transition to..." />
          </SelectTrigger>
          <SelectContent>
            {nextStates.map((status) => (
              <SelectItem key={status} value={status}>
                <span
                  className={cn(
                    "size-2 rounded-full",
                    STATUS_SWATCH_COLOR[status],
                  )}
                  aria-hidden
                />
                {formatStatusLabel(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedTarget !== null && (
        <>
          <Field>
            <FieldLabel htmlFor="statusReason">Reason</FieldLabel>
            <Textarea
              id="statusReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={2}
            />
          </Field>

          {error && <p className="text-body-sm text-destructive">{error}</p>}

          <Button
            type="button"
            size="sm"
            disabled={submitting || reason.trim() === ""}
            onClick={() => void handleApply()}
          >
            Apply
          </Button>
        </>
      )}
    </div>
  );
}
