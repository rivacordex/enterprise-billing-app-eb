"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Checkbox } from "@/components/ui/checkbox";
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

type OfferingFormCreateProps = {
  mode: "create";
  onSubmit: (values: CreateOfferingInput) => Promise<void>;
  isSubmitting: boolean;
};

// pm20 (Edit offering) adds an `OfferingFormEditProps` variant and unions it
// here, mirroring RoleForm/UserForm's own two-mode shape — not built in this
// unit, since pm99's contract for pm19 is explicitly "create mode only."
export type OfferingFormProps = OfferingFormCreateProps;

export function OfferingForm(props: OfferingFormProps): React.JSX.Element {
  return <CreateOfferingForm {...props} />;
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
