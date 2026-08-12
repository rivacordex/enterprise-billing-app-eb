"use client";

import { Plus, X } from "lucide-react";
import { useFieldArray, useFormContext } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CharacteristicsRecord } from "@/validation/characteristics.schema";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";

// pm29-spec §Implementation-2. Reuses `specification-form.tsx`'s (pm21)
// record<->list boundary-translation pattern: `useFieldArray` needs an array
// to manage add/remove rows, so the wire shape (`characteristics:
// Record<string,string>`, `createOrderSchema`) is translated to/from a
// `{key,value}[]` UI shape at this component's own boundary — a fresh pair
// of helpers, not an import, since they operate on `CharacteristicsRecord`
// (ordering) rather than `ProductSpecCharacteristics` (catalog), the same
// "independent small helper per caller" call pm22's `PriceForm` made for its
// own tolerance constant.
export function recordToList(
  record: CharacteristicsRecord,
): { key: string; value: string }[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export function listToRecord(
  list: { key: string; value: string }[],
): CharacteristicsRecord {
  return Object.fromEntries(
    list
      .filter(({ key }) => key.trim() !== "")
      .map(({ key, value }) => [key, value]),
  );
}

export interface CharacteristicsEditorProps {
  isSubmitting: boolean;
}

export function CharacteristicsEditor({
  isSubmitting,
}: CharacteristicsEditorProps): React.JSX.Element {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<WizardFormValues>();

  const { fields, append, remove } = useFieldArray({
    control,
    name: "characteristicsList",
  });

  return (
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
            <FieldError errors={[errors.characteristicsList?.[index]?.key]} />
          </Field>
          <Field className="flex-1">
            <Input
              aria-label={`Characteristic ${index + 1} value`}
              placeholder="Value"
              disabled={isSubmitting}
              {...register(`characteristicsList.${index}.value` as const)}
            />
            <FieldError errors={[errors.characteristicsList?.[index]?.value]} />
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
  );
}
