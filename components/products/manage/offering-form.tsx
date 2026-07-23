"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  createOfferingSchema,
  type CreateOfferingInput,
} from "@/validation/product/create-offering.schema";
import {
  editOfferingFieldsSchema,
  type EditOfferingFields,
  type UpdateOfferingInput,
} from "@/validation/product/update-offering.schema";

type OfferingFormCreateProps = {
  mode: "create";
  onSubmit: (values: CreateOfferingInput) => Promise<void>;
  isSubmitting: boolean;
};

// pm20-spec §3.5. currentStatus is the narrow union, never the full
// LifecycleStatus (Design §2.8) — RETIRED rows never reach this component
// via any shipped Edit seam.
type OfferingFormEditProps = {
  mode: "edit";
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  defaultValues: { name: string; isSellable: boolean; billingOnly: boolean };
  onSubmit: (values: UpdateOfferingInput) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
};

export type OfferingFormProps = OfferingFormCreateProps | OfferingFormEditProps;

export function OfferingForm(props: OfferingFormProps): React.JSX.Element {
  if (props.mode === "edit") {
    return <EditOfferingForm {...props} />;
  }
  return <CreateOfferingForm {...props} />;
}

// pm20-spec §2.5–§2.7. Two independent `handleSubmit` calls, one per save
// outcome, instead of one native form submit disambiguated after the fact
// — see Design §2.5 for why. Renders its own DialogFooter (Design §2.6),
// unlike CreateOfferingForm, whose footer lives one file over in
// CreateOfferingDialog.
function EditOfferingForm({
  offeringName,
  currentStatus,
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: OfferingFormEditProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<EditOfferingFields>({
    resolver: zodResolver(editOfferingFieldsSchema),
    defaultValues,
  });

  // Keeps the form in sync if a different row is opened into this same
  // dialog instance while it's mounted — mirrors RoleForm/UserForm's own
  // edit-mode effect.
  useEffect(() => {
    reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.name, defaultValues.isSellable, defaultValues.billingOnly]);

  const submitInPlace = handleSubmit((values) =>
    onSubmit({ ...values, saveAsNew: false }),
  );
  const submitAsNewDraft = handleSubmit((values) =>
    onSubmit({ ...values, saveAsNew: true }),
  );

  return (
    <form
      id="offering-form-edit"
      noValidate
      onSubmit={(e) => e.preventDefault()} // Design §2.5 — no single default submit
    >
      {currentStatus === "ACTIVE" && (
        <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          {offeringName} is active. Saving will not change it — a new draft
          version is created instead.
        </div>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-name">Name</FieldLabel>
          <Input
            id="edit-name"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        {/* No isBundle control here, ever — code-standards-phase2 §1 rule 9. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Options
          </legend>

          <Controller
            control={control}
            name="isSellable"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Sellable
              </label>
            )}
          />

          <Controller
            control={control}
            name="billingOnly"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Billing only
              </label>
            )}
          />
        </fieldset>
      </FieldGroup>

      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          Cancel
        </Button>

        {currentStatus === "DRAFT" && (
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => void submitAsNewDraft()}
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Save as new draft
          </Button>
        )}

        <Button
          type="button"
          disabled={isSubmitting}
          onClick={() =>
            void (currentStatus === "ACTIVE"
              ? submitAsNewDraft()
              : submitInPlace())
          }
        >
          {isSubmitting && <Loader2 className="animate-spin" />}
          {currentStatus === "ACTIVE" ? "Create new draft" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreateOfferingForm({
  onSubmit,
  isSubmitting,
}: OfferingFormCreateProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CreateOfferingInput>({
    resolver: zodResolver(createOfferingSchema),
    // Matches the mockup's create-modal defaults exactly: Sellable checked,
    // Billing only unchecked (pm19-spec §2.2).
    defaultValues: { name: "", isSellable: true, billingOnly: false },
  });

  return (
    <form
      id="offering-form-create"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="Offering name"
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        {/* No isBundle control here, ever — code-standards-phase2 §1 rule 9. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Options
          </legend>

          <Controller
            control={control}
            name="isSellable"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Sellable
              </label>
            )}
          />

          <Controller
            control={control}
            name="billingOnly"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Billing only
              </label>
            )}
          />
        </fieldset>
      </FieldGroup>
    </form>
  );
}
