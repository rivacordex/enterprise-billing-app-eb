"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { z } from "zod";

import { createCustomerAction } from "@/actions/customer/create-customer";
import { cn } from "@/lib/utils";
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
import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { OrganizationStatusBadge } from "@/components/customers/organization-status-badge";
import { SpecificationEditor } from "@/components/customers/specification-editor";
import { ORGANIZATION_TYPES } from "@/types/customer";
import { createCustomerSchema } from "@/validation/customer/create-customer.schema";

const ORGANIZATION_TYPE_LABELS = {
  COMPANY: "Company",
  GOVERNMENT: "Government",
} as const;

// `confirmed` is managed as local component state, not a form field the
// user fills in (cm07-spec §3.7).
const newCustomerFormSchema = createCustomerSchema.omit({ confirmed: true });

type NewCustomerFormValues = z.input<typeof newCustomerFormSchema>;
type NewCustomerFormOutput = z.output<typeof newCustomerFormSchema>;

// Converts a blank text input to `null` before Zod validation runs —
// `organizationFieldsSchema`'s optional fields are `nullable()`, not
// `""`-tolerant, so an untouched optional field must resolve to `null`, not
// fail its own `min(1)` check.
function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

export function NewCustomerForm(): React.JSX.Element {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [similarNames, setSimilarNames] = useState<string[] | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [specServerError, setSpecServerError] = useState<string | null>(null);
  const lastCheckedNameRef = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setError,
    watch,
    formState: { errors },
  } = useForm<NewCustomerFormValues, unknown, NewCustomerFormOutput>({
    resolver: zodResolver(newCustomerFormSchema),
    defaultValues: {
      name: "",
      tradingName: "",
      organizationType: "COMPANY",
      registrationNumber: "",
      taxId: "",
      industry: "",
      specificationRaw: "{}",
    },
  });

  const nameValue = watch("name");

  // Editing the name after a warning was shown invalidates the prior
  // similar-name check — resets `confirmed` so the next submit re-triggers
  // it (cm07-spec §3.7).
  useEffect(() => {
    if (similarNames !== null && nameValue !== lastCheckedNameRef.current) {
      setSimilarNames(null);
      setWarningDismissed(false);
      setConfirmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameValue]);

  async function onSubmit(values: NewCustomerFormOutput): Promise<void> {
    setIsSubmitting(true);
    setSpecServerError(null);

    try {
      const result = await createCustomerAction({ ...values, confirmed });

      if (result.ok) {
        router.push(`/customers/manage/${result.value.partyRoleId}`);
        return;
      }

      if (result.code === "SIMILAR_NAMES_FOUND") {
        lastCheckedNameRef.current = values.name;
        setSimilarNames(result.similarNames);
        setWarningDismissed(false);
        setConfirmed(true); // next submit skips the check
        return;
      }

      if (result.code === "DUPLICATE_REGISTRATION_NUMBER") {
        setError("registrationNumber", {
          message: "This registration number is already in use.",
        });
        return;
      }

      if (result.code === "INVALID_SPECIFICATION") {
        setSpecServerError("Specification must be valid JSON.");
        return;
      }

      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const hasWarning = !!similarNames && similarNames.length > 0;

  return (
    <form
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="max-w-xl space-y-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
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
            disabled={isSubmitting}
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
                disabled={isSubmitting}
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
            disabled={isSubmitting}
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
            disabled={isSubmitting}
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
            disabled={isSubmitting}
            {...register("industry", { setValueAs: emptyToNull })}
          />
          <FieldError errors={[errors.industry]} />
        </Field>

        <Field>
          <span className="text-body-sm font-medium text-foreground">
            Initial Status
          </span>
          <div className="flex items-center gap-2">
            <OrganizationStatusBadge status="REGISTERED" />
            <CustomerStatusBadge status="INITIALIZED" />
          </div>
          <p className="text-caption text-muted-foreground">
            New customers always start here.
          </p>
        </Field>

        <Field>
          <FieldLabel htmlFor="specificationRaw">Specification</FieldLabel>
          <Controller
            control={control}
            name="specificationRaw"
            render={({ field }) => (
              <SpecificationEditor
                value={field.value ?? "{}"}
                onChange={field.onChange}
              />
            )}
          />
          {specServerError && (
            <p className="text-body-sm text-destructive">{specServerError}</p>
          )}
        </Field>
      </FieldGroup>

      {hasWarning && !warningDismissed && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-[color:var(--color-warning-500)] bg-[color:var(--color-warning-50)] p-3">
          <div>
            <p className="text-body-sm font-medium text-[color:var(--color-warning-700)]">
              Similar customers already exist:
            </p>
            <ul className="mt-1 list-disc pl-4 text-body-sm text-[color:var(--color-warning-700)]">
              {similarNames?.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            aria-label="Dismiss warning"
            onClick={() => setWarningDismissed(true)}
            className="text-[color:var(--color-warning-700)]"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <Button
        type="submit"
        disabled={isSubmitting}
        className={cn(
          "bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90",
          hasWarning &&
            "ring-2 ring-[color:var(--color-warning-500)] ring-offset-2",
        )}
      >
        {hasWarning ? "Create anyway" : "Create customer"}
      </Button>
    </form>
  );
}
