"use client";

import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";

// pm21-spec §2.6. UI-only — never imported by an action or service. Shape
// differs deliberately from createSpecificationSchema/updateSpecificationSchema
// (array of key/value pairs vs. a Record), because useFieldArray needs an
// array to manage add/remove rows.
const specificationFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Specification name is required")
    .max(200, "Specification name must be 200 characters or fewer"),
  isMandatory: z.boolean(),
  isDefault: z.boolean(),
  defaultValue: z
    .string()
    .trim()
    .max(500, "Default value must be 500 characters or fewer"),
  characteristicsList: z
    .array(
      z.object({
        key: z.string().trim().min(1, "Key is required"),
        value: z.string().trim().min(1, "Value is required"),
      }),
    )
    .refine(
      (list) => new Set(list.map((item) => item.key)).size === list.length,
      { message: "Characteristic keys must be unique" },
    ),
});
type SpecificationFormValues = z.infer<typeof specificationFormSchema>;

function recordToList(
  record: ProductSpecCharacteristics,
): { key: string; value: string }[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function listToRecord(
  list: { key: string; value: string }[],
): ProductSpecCharacteristics {
  return Object.fromEntries(list.map(({ key, value }) => [key, value]));
}

// pm21-spec §3.3. Translates the form's own shape to the wire shape
// (CreateSpecificationInput === UpdateSpecificationInput, field-identical
// per pm14-spec §3.1/§3.2) at the one boundary where the two diverge.
function toWireInput(
  values: SpecificationFormValues,
): CreateSpecificationInput {
  return {
    name: values.name,
    isMandatory: values.isMandatory,
    isDefault: values.isDefault,
    defaultValue:
      values.defaultValue.trim() === "" ? null : values.defaultValue.trim(),
    productSpecCharacteristics: listToRecord(values.characteristicsList),
  };
}

export interface SpecificationFormDefaultValues {
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: ProductSpecCharacteristics;
}

export interface SpecificationFormProps {
  mode: "create" | "edit";
  defaultValues?: SpecificationFormDefaultValues;
  onSubmit: (values: CreateSpecificationInput) => Promise<void>;
  isSubmitting: boolean;
  formId: string;
}

export function SpecificationForm({
  defaultValues,
  onSubmit,
  isSubmitting,
  formId,
}: SpecificationFormProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<SpecificationFormValues>({
    resolver: zodResolver(specificationFormSchema),
    defaultValues: {
      name: defaultValues?.name ?? "",
      isMandatory: defaultValues?.isMandatory ?? false,
      isDefault: defaultValues?.isDefault ?? false,
      defaultValue: defaultValues?.defaultValue ?? "",
      characteristicsList: defaultValues
        ? recordToList(defaultValues.characteristics)
        : [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "characteristicsList",
  });

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(e) =>
        void handleSubmit((values) => onSubmit(toWireInput(values)))(e)
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="spec-name">Name</FieldLabel>
          <Input
            id="spec-name"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="spec-default-value">Default value</FieldLabel>
          <Input
            id="spec-default-value"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.defaultValue}
            disabled={isSubmitting}
            {...register("defaultValue")}
          />
          <FieldError errors={[errors.defaultValue]} />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Options
          </legend>

          <Controller
            control={control}
            name="isMandatory"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Mandatory
              </label>
            )}
          />

          <Controller
            control={control}
            name="isDefault"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Default
              </label>
            )}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Characteristics
          </legend>

          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2">
              <Field className="flex-1">
                <Input
                  aria-label={`Characteristic ${index + 1} key`}
                  placeholder="Key"
                  disabled={isSubmitting}
                  {...register(`characteristicsList.${index}.key` as const)}
                />
                <FieldError
                  errors={[errors.characteristicsList?.[index]?.key]}
                />
              </Field>
              <Field className="flex-1">
                <Input
                  aria-label={`Characteristic ${index + 1} value`}
                  placeholder="Value"
                  disabled={isSubmitting}
                  {...register(`characteristicsList.${index}.value` as const)}
                />
                <FieldError
                  errors={[errors.characteristicsList?.[index]?.value]}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove characteristic ${index + 1}`}
                disabled={isSubmitting}
                onClick={() => remove(index)}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
          ))}

          {errors.characteristicsList?.root && (
            <p className="text-body-sm text-[color:var(--text-danger)]">
              {errors.characteristicsList.root.message}
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
            onClick={() => append({ key: "", value: "" })}
          >
            <Plus size={14} aria-hidden />
            Add characteristic
          </Button>
        </fieldset>
      </FieldGroup>
    </form>
  );
}
