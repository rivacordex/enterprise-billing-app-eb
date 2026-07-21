"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";

import { updateOrganizationAction } from "@/actions/customer/update-organization";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OptimisticLockConflictBanner } from "@/components/customers/optimistic-lock-conflict-banner";
import { StatusTransitionControl } from "@/components/customers/status-transition-control";
import { transitionOrganizationStatusAction } from "@/actions/customer/transition-organization-status";
import { ORGANIZATION_TYPES } from "@/types/customer";
import type { OrganizationDetail } from "@/types/customer";
import { ORGANIZATION_TRANSITIONS } from "@/validation/customer/transitions";
import {
  organizationFieldsSchema,
  organizationIdSchema,
} from "@/validation/customer/organization.schema";
import { partyRoleIdSchema } from "@/validation/customer/party-role.schema";

const ORGANIZATION_TYPE_LABELS = {
  COMPANY: "Company",
  GOVERNMENT: "Government",
} as const;

// Fields identical to NewCustomerForm's organization fields (cm07) minus the
// specification/locked-status parts — those belong to CustomerRoleForm
// (cm10). `lastModifiedDatetime` is deliberately not part of this
// RHF-validated shape (cm08-spec §3.7): it's never user-editable, so it's
// tracked as component state and merged into the submitted payload, the
// same way cm07's NewCustomerForm keeps `confirmed` outside its schema.
const organizationFormSchema = organizationFieldsSchema.extend({
  organizationId: organizationIdSchema,
  partyRoleId: partyRoleIdSchema,
});

type OrganizationFormValues = z.input<typeof organizationFormSchema>;
type OrganizationFormOutput = z.output<typeof organizationFormSchema>;

// Converts a blank text input to `null` before Zod validation runs —
// `organizationFieldsSchema`'s optional fields are `nullable()`, not
// `""`-tolerant.
function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

export interface OrganizationFormProps {
  organization: OrganizationDetail;
  partyRoleId: string;
  lastModifiedDatetime: Date;
}

export function OrganizationForm({
  organization,
  partyRoleId,
  lastModifiedDatetime,
}: OrganizationFormProps): React.JSX.Element {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [currentLastModifiedDatetime, setCurrentLastModifiedDatetime] =
    useState(lastModifiedDatetime);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors },
  } = useForm<OrganizationFormValues, unknown, OrganizationFormOutput>({
    resolver: zodResolver(organizationFormSchema),
    defaultValues: {
      organizationId: organization.organizationId,
      partyRoleId,
      name: organization.name,
      tradingName: organization.tradingName,
      organizationType: organization.organizationType,
      registrationNumber: organization.registrationNumber,
      taxId: organization.taxId,
      industry: organization.industry,
    },
  });

  // Keeps the form in sync if `lastModifiedDatetime` changes while the page
  // is open: `router.refresh()` (the CONFLICT banner's "Reload") re-renders
  // this component with a fresh value from the server rather than
  // remounting it, so the stale `conflict`/`currentLastModifiedDatetime`
  // state and form values wouldn't otherwise clear on their own. Must run in
  // an effect, not during render (mirrors `UserForm`/`RoleForm`'s edit-mode
  // effect) — `reset()` updates `Controller`'s internal subscription state,
  // and doing that synchronously while `OrganizationForm` itself is still
  // rendering is exactly the "Cannot update a component while rendering a
  // different component" violation React warns about.
  useEffect(() => {
    setCurrentLastModifiedDatetime(lastModifiedDatetime);
    setConflict(false);
    reset({
      organizationId: organization.organizationId,
      partyRoleId,
      name: organization.name,
      tradingName: organization.tradingName,
      organizationType: organization.organizationType,
      registrationNumber: organization.registrationNumber,
      taxId: organization.taxId,
      industry: organization.industry,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastModifiedDatetime.getTime()]);

  async function onSubmit(values: OrganizationFormOutput): Promise<void> {
    setIsSubmitting(true);

    try {
      const result = await updateOrganizationAction({
        ...values,
        lastModifiedDatetime: currentLastModifiedDatetime,
      });

      if (result.ok) {
        // Threads the bumped lock back into local state so a same-session
        // second save doesn't flash CONFLICT against its own just-completed
        // write (cm08-spec §3.7) — `router.refresh()`'s eventual RSC
        // re-render supplies the authoritative value regardless.
        setCurrentLastModifiedDatetime(result.value.lastModifiedDatetime);
        toast.success("Organization updated.");
        return;
      }

      if (result.code === "CONFLICT") {
        setConflict(true);
        return;
      }

      if (result.code === "DUPLICATE_REGISTRATION_NUMBER") {
        setError("registrationNumber", {
          message: "This registration number is already in use.",
        });
        return;
      }

      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Wraps transitionOrganizationStatusAction to the narrower result shape
  // StatusTransitionControl expects — ORGANIZATION_NOT_FOUND/FORBIDDEN are
  // defense-in-depth paths the rendered control can never actually trigger,
  // so they collapse into the same generic inline error as
  // VALIDATION_ERROR (cm09-spec §3.5).
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
    const result = await transitionOrganizationStatusAction({
      organizationId: organization.organizationId,
      partyRoleId,
      targetStatus,
      statusReason,
      lastModifiedDatetime: currentLastModifiedDatetime,
    });

    if (result.ok) {
      setCurrentLastModifiedDatetime(result.value.lastModifiedDatetime);
      return result;
    }

    if (result.code === "CONFLICT" || result.code === "INVALID_TRANSITION") {
      return result;
    }

    return { ok: false, code: "VALIDATION_ERROR" };
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="max-w-xl space-y-6"
    >
      <input type="hidden" {...register("organizationId")} />
      <input type="hidden" {...register("partyRoleId")} />

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.name}
            disabled={isSubmitting || conflict}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="tradingName">Trading Name</FieldLabel>
          <Input
            id="tradingName"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.tradingName}
            disabled={isSubmitting || conflict}
            {...register("tradingName", { setValueAs: emptyToNull })}
          />
          <FieldError errors={[errors.tradingName]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="organizationType">Organization Type</FieldLabel>
          <Controller
            control={control}
            name="organizationType"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isSubmitting || conflict}
              >
                <SelectTrigger id="organizationType" className="w-full">
                  <SelectValue placeholder="Select an organization type" />
                </SelectTrigger>
                <SelectContent>
                  {ORGANIZATION_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {ORGANIZATION_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError errors={[errors.organizationType]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="registrationNumber">
            Registration Number
          </FieldLabel>
          <Input
            id="registrationNumber"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.registrationNumber}
            disabled={isSubmitting || conflict}
            {...register("registrationNumber", { setValueAs: emptyToNull })}
          />
          <FieldError errors={[errors.registrationNumber]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="taxId">Tax ID</FieldLabel>
          <Input
            id="taxId"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.taxId}
            disabled={isSubmitting || conflict}
            {...register("taxId", { setValueAs: emptyToNull })}
          />
          <FieldError errors={[errors.taxId]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="industry">Industry</FieldLabel>
          <Input
            id="industry"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.industry}
            disabled={isSubmitting || conflict}
            {...register("industry", { setValueAs: emptyToNull })}
          />
          <FieldError errors={[errors.industry]} />
        </Field>
      </FieldGroup>

      {conflict && (
        <OptimisticLockConflictBanner
          entityLabel="organization"
          onReload={() => router.refresh()}
        />
      )}

      <Button
        type="submit"
        disabled={isSubmitting || conflict}
        className="bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90"
      >
        Save changes
      </Button>

      {!conflict && (
        <StatusTransitionControl
          key={currentLastModifiedDatetime.getTime()}
          currentStatus={organization.status}
          entityKind="organization"
          nextStates={ORGANIZATION_TRANSITIONS[organization.status]}
          onTransition={handleStatusTransition}
          onConflict={() => router.refresh()}
        />
      )}
    </form>
  );
}
