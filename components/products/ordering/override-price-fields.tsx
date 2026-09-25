"use client";

import { useFormContext, useWatch } from "react-hook-form";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/formatters";
import type { PriceCard } from "@/types/product";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";
import {
  overrideLaneOf,
  overrideListAmount,
  overridableLanes,
} from "@/components/products/ordering/price-override";

export interface OverridePriceFieldsProps {
  prices: PriceCard[];
  currency: string;
  locale: string;
  isSubmitting: boolean;
}

// pm29-spec §Implementation-2 (pm56b envelope re-key). One row per
// **overridable** price — `usage_rate` + `flat_fee` — showing its list amount
// (struck when overridden) + an optional negotiated input; capacity components
// render read-only ("not overridable" — they carry a quantity/step shape with
// no scalar amount to negotiate against, and Inv. #16 only ever resolves an
// override against a scalar catalog row). `overrides` in `WizardFormValues` is
// pre-seeded one entry per overridable price, keyed by its `OverridePriceType`
// lane (`overrideLaneOf`), whenever the selected offer changes
// (`WizardStepOffer`'s effect) — a fixed-size list, not user-add/removable, so
// this component reads/writes it by index, no `useFieldArray` needed.
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
  const overridable = overridableLanes(prices);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-sm font-medium text-foreground">
        Prices
      </legend>

      {prices.map((price) => {
        const lane = overrideLaneOf(price);
        // Not overridable when the component has no lane (capacity), or when the
        // lane is shared by more than one current price (ambiguous, pm56b D2.1).
        if (lane === null || !overridable.has(lane)) {
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

        const index = overrides.findIndex((o) => o.priceType === lane);
        const listAmount = overrideListAmount(price);
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
                {listAmount !== null
                  ? formatCurrency(listAmount, price.currency, locale)
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
