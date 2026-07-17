"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { transitionCustomerStatusAction } from "@/actions/customer/transition-customer-status";
import { updatePartyRoleSpecificationAction } from "@/actions/customer/update-party-role-specification";
import { Button } from "@/components/ui/button";
import { OptimisticLockConflictBanner } from "@/components/customers/optimistic-lock-conflict-banner";
import { SpecificationEditor } from "@/components/customers/specification-editor";
import { StatusTransitionControl } from "@/components/customers/status-transition-control";
import { formatDatetime } from "@/lib/formatters";
import type { CustomerRoleDetail } from "@/types/customer";
import { CUSTOMER_TRANSITIONS } from "@/validation/customer/transitions";

export interface CustomerRoleFormProps {
  customerRole: CustomerRoleDetail;
  locale: string;
  timezone: string;
}

function ReadOnlyField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-body text-foreground">{children}</dd>
    </div>
  );
}

// The second section added to cm08's edit-page container (cm10-spec §2.1) —
// two independently submitted mini-forms sharing one card. Each area tracks
// its own `lastModifiedDatetime` state, seeded from the same page-loaded
// `customerRole.lastModifiedDatetime`: a save in one area doesn't require
// the other to be untouched, but if one lands first, the other's next
// attempt correctly sees its own now-stale value and gets CONFLICT (Module
// Inv. #6 — one shared lock column serializing all edits in the customer's
// scope).
export function CustomerRoleForm({
  customerRole,
  locale,
  timezone,
}: CustomerRoleFormProps): React.JSX.Element {
  const router = useRouter();

  const [statusLock, setStatusLock] = useState(
    customerRole.lastModifiedDatetime,
  );

  const [specText, setSpecText] = useState(
    JSON.stringify(customerRole.specification, null, 2),
  );
  const [specLock, setSpecLock] = useState(customerRole.lastModifiedDatetime);
  const [specSubmitting, setSpecSubmitting] = useState(false);
  const [specConflict, setSpecConflict] = useState(false);

  // Adjust state during render (react.dev "you might not need an effect"),
  // mirroring OrganizationForm: a CONFLICT's "Reload" calls `router.refresh()`
  // (below), which re-renders this component with a fresh `customerRole`
  // rather than remounting it, so a latched `specConflict` and the stale
  // locks wouldn't otherwise clear on their own.
  const [prevLastModifiedDatetime, setPrevLastModifiedDatetime] = useState(
    customerRole.lastModifiedDatetime,
  );
  if (
    customerRole.lastModifiedDatetime.getTime() !==
    prevLastModifiedDatetime.getTime()
  ) {
    setPrevLastModifiedDatetime(customerRole.lastModifiedDatetime);
    setStatusLock(customerRole.lastModifiedDatetime);
    setSpecLock(customerRole.lastModifiedDatetime);
    setSpecConflict(false);
  }

  // Wraps transitionCustomerStatusAction to the narrower result shape
  // StatusTransitionControl expects — PARTY_ROLE_NOT_FOUND/FORBIDDEN are
  // defense-in-depth paths the rendered control can never actually trigger,
  // so they collapse into the same generic inline error as
  // VALIDATION_ERROR, mirroring OrganizationForm's handleStatusTransition.
  async function handleStatusTransition(
    targetStatus: string,
    statusReason: string,
  ): Promise<
    | { ok: true; value: { lastModifiedDatetime: Date } }
    | {
        ok: false;
        code: "CONFLICT" | "INVALID_TRANSITION" | "VALIDATION_ERROR";
      }
  > {
    const result = await transitionCustomerStatusAction({
      partyRoleId: customerRole.partyRoleId,
      targetStatus,
      statusReason,
      lastModifiedDatetime: statusLock,
    });

    if (result.ok) {
      setStatusLock(result.value.lastModifiedDatetime);
      return result;
    }

    if (result.code === "CONFLICT" || result.code === "INVALID_TRANSITION") {
      return result;
    }

    return { ok: false, code: "VALIDATION_ERROR" };
  }

  async function handleSaveSpecification(): Promise<void> {
    setSpecSubmitting(true);
    try {
      const result = await updatePartyRoleSpecificationAction({
        partyRoleId: customerRole.partyRoleId,
        specificationRaw: specText,
        lastModifiedDatetime: specLock,
      });

      if (result.ok) {
        setSpecLock(result.value.lastModifiedDatetime);
        toast.success("Specification updated.");
        return;
      }

      if (result.code === "CONFLICT") {
        setSpecConflict(true);
        return;
      }

      if (result.code === "INVALID_SPECIFICATION") {
        toast.error("Specification must be valid, well-formed JSON.");
        return;
      }

      toast.error("Something went wrong. Please try again.");
    } catch {
      // A rejected `updatePartyRoleSpecificationAction` (e.g. a network
      // failure) is otherwise an unhandled rejection with no user-facing
      // feedback.
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSpecSubmitting(false);
    }
  }

  return (
    <section className="max-w-xl space-y-6 rounded-md border border-border bg-[color:var(--surface-card)] p-4">
      <h2 className="text-h3 font-semibold text-foreground">Role – Customer</h2>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <ReadOnlyField label="Customer ID">
          <span className="font-mono">{customerRole.partyRoleId}</span>
        </ReadOnlyField>
        <ReadOnlyField label="Account">
          {customerRole.account ?? "—"}
        </ReadOnlyField>
        <ReadOnlyField label="Last Modified By">
          {customerRole.lastModifiedByName}
        </ReadOnlyField>
        <ReadOnlyField label="Last Modified">
          {formatDatetime(customerRole.lastModifiedDatetime, locale, timezone)}
        </ReadOnlyField>
      </dl>

      <div className="space-y-3">
        <h3 className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
          Status
        </h3>
        <StatusTransitionControl
          key={statusLock.getTime()}
          currentStatus={customerRole.status}
          entityKind="customer"
          nextStates={CUSTOMER_TRANSITIONS[customerRole.status]}
          onTransition={handleStatusTransition}
          onConflict={() => router.refresh()}
        />
      </div>

      <div className="space-y-3">
        <h3 className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
          Specification
        </h3>
        {specConflict ? (
          <OptimisticLockConflictBanner onReload={() => router.refresh()} />
        ) : (
          <>
            <SpecificationEditor value={specText} onChange={setSpecText} />
            <Button
              type="button"
              disabled={specSubmitting}
              onClick={() => void handleSaveSpecification()}
              className="bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90"
            >
              Save specification
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
