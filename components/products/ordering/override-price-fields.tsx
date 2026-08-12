"use client";

import { useFormContext, useWatch } from "react-hook-form";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/formatters";
import type { PriceCard } from "@/types/product";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";

export interface OverridePriceFieldsProps {
  prices: PriceCard[];
  currency: string;
  locale: string;
  isSubmitting: boolean;
}

// pm29-spec §Implementation-2. One row per **flat** price type — list amount
// (struck when overridden) + optional negotiated input; tiered rows render
// read-only ("not overridable" — tiers have no scalar amount to negotiate
// against, architecture Inv. #16 only ever resolves overrides against a flat
// catalog row). `overrides` in `WizardFormValues` is pre-seeded one entry per
// flat price (same order as `prices`) whenever the selected offer changes
// (`WizardStepOffer`'s effect) — a fixed-size list, not user-add/removable,
// so this component reads/writes it by index, no `useFieldArray` needed.
export function OverridePriceFields({
  prices,
  currency,
  locale,
  isSubmitting,
}: OverridePriceFieldsProps): React.JSX.Element {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<WizardFormValues>();

  const overrides = useWatch({ control, name: "overrides" }) ?? [];

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-sm font-medium text-foreground">
        Prices
      </legend>

      {prices.map((price) => {
        if (price.pricingModel === "tiered") {
          return (
            <div
              key={price.productOfferingPriceId}
              className="flex items-center justify-between gap-2 text-body-sm text-muted-foreground"
            >
              <span>{price.name}</span>
              <span>not overridable</span>
            </div>
          );
        }

        const index = overrides.findIndex(
          (o) => o.priceType === price.priceType,
        );
        const overrideValue =
          index >= 0 ? (overrides[index]?.amount ?? "") : "";
        const hasOverride = overrideValue.trim() !== "";

        return (
          <Field key={price.productOfferingPriceId} orientation="responsive">
            <div className="flex flex-1 items-center justify-between gap-2 text-body-sm">
              <span>{price.name}</span>
              <span
                className={
                  hasOverride
                    ? "text-muted-foreground line-through"
                    : "text-foreground"
                }
              >
                {price.amount !== null
                  ? formatCurrency(price.amount, price.currency, locale)
                  : "—"}
              </span>
            </div>
            {index >= 0 && (
              <Field>
                <FieldLabel
                  htmlFor={`override-${price.productOfferingPriceId}`}
                >
                  Negotiated amount ({currency})
                </FieldLabel>
                <Input
                  id={`override-${price.productOfferingPriceId}`}
                  type="text"
                  placeholder="Optional"
                  aria-invalid={!!errors.overrides?.[index]?.amount}
                  disabled={isSubmitting}
                  {...register(`overrides.${index}.amount` as const)}
                />
                <FieldError errors={[errors.overrides?.[index]?.amount]} />
              </Field>
            )}
          </Field>
        );
      })}

      {overrides.some((o) => o.amount.trim() !== "") && (
        <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          A negotiated price requires manager approval — this order will be
          submitted for review.
        </div>
      )}
    </fieldset>
  );
}
