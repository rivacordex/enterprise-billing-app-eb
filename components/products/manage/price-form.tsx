"use client";

import { useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PRICE_TYPES, PRICING_MODELS } from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Same tolerance value as insert-price.schema.ts's and insert-price.ts's own
// copies — a third independent copy, consistent with pm15-spec's own
// "small, multi-caller constant, not worth a shared module" call (Design §2.5).
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const PRICE_TYPE_LABELS: Record<(typeof PRICE_TYPES)[number], string> = {
  recurring: "Recurring",
  usage: "Usage",
  once: "Once",
};

const MONEY_REGEX = /^\d+(\.\d+)?$/;

// pm22-spec §2.4. Validates only the checks meaningful on this flat,
// pre-assembly shape — NOT tier contiguity or the open-ended-only-on-last
// rule, which stay defined exactly once, in tieredPricingCharacteristicsSchema
// (reused, not re-declared, by the Server Action's own insertPriceSchema
// round-trip at submit time).
const priceFormSchema = z
  .object({
    name: z.string().trim().min(1, "Price name is required"),
    priceType: z.enum(PRICE_TYPES),
    currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
    glCode: z.string().trim(),
    startDateTime: z.string().min(1, "Start date is required"),
    pricingModel: z.enum(PRICING_MODELS),
    amount: z.string(),
    tiers: z.array(
      z.object({ from: z.string(), to: z.string(), rate: z.string() }),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.pricingModel === "flat" && !MONEY_REGEX.test(value.amount)) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid amount.",
        path: ["amount"],
      });
    }
    if (value.pricingModel === "tiered") {
      if (value.tiers.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Add at least one tier.",
          path: ["tiers"],
        });
      }
      value.tiers.forEach((tier, index) => {
        if (!MONEY_REGEX.test(tier.from)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid number.",
            path: ["tiers", index, "from"],
          });
        }
        if (!MONEY_REGEX.test(tier.rate)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid rate.",
            path: ["tiers", index, "rate"],
          });
        }
      });
    }

    // Duplicated tolerance check (Design §2.5) — a fast, live, field-level
    // check; the Server Action's own insertPriceSchema round-trip (§3.2) is
    // the authoritative one.
    const start = new Date(`${value.startDateTime}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      const msSinceStart = Date.now() - start.getTime();
      if (msSinceStart > THREE_DAYS_MS) {
        ctx.addIssue({
          code: "custom",
          message: "Start date cannot be more than 3 days in the past.",
          path: ["startDateTime"],
        });
      }
    }
  });

type PriceFormValues = z.infer<typeof priceFormSchema>;

export interface PriceFormProps {
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  onSubmit: (values: InsertPriceInput) => Promise<void>;
  isSubmitting: boolean;
}

// pm22-spec §3.3. Assembles the flat form shape into insertPriceSchema's
// actual nested shape — the one place the two representations meet.
function toInsertPriceInput(values: PriceFormValues): InsertPriceInput {
  const priceCharacteristics =
    values.pricingModel === "flat"
      ? {
          pricing_model: "flat" as const,
          amount: values.amount,
          pricing_characteristics: null,
        }
      : {
          pricing_model: "tiered" as const,
          amount: null,
          pricing_characteristics: {
            tiers: values.tiers.map((tier) => ({
              from: Number(tier.from),
              to: tier.to.trim() === "" ? null : Number(tier.to),
              rate: tier.rate,
            })),
          },
        };

  return {
    name: values.name,
    priceType: values.priceType,
    currency: values.currency.toUpperCase(),
    glCode: values.glCode.trim() === "" ? null : values.glCode.trim(),
    startDateTime: new Date(`${values.startDateTime}T00:00:00`),
    priceCharacteristics,
  };
}

export function PriceForm({
  offeringName,
  currentStatus,
  onSubmit,
  isSubmitting,
}: PriceFormProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    getValues,
    formState: { errors },
  } = useForm<PriceFormValues>({
    resolver: zodResolver(priceFormSchema),
    defaultValues: {
      name: "",
      priceType: "recurring",
      currency: "",
      glCode: "",
      startDateTime: new Date().toISOString().slice(0, 10),
      pricingModel: "flat",
      amount: "",
      tiers: [{ from: "0", to: "", rate: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "tiers",
  });

  const pricingModel = useWatch({ control, name: "pricingModel" });
  const startDateTime = useWatch({ control, name: "startDateTime" });

  // Captured once via a lazy useState initializer, not read directly during
  // render (React's purity rules disallow calling Date.now() in the render
  // body) — the dialog's own lifetime is short enough that a mount-time
  // snapshot is indistinguishable from a live clock for this warning.
  const [nowMs] = useState(() => Date.now());

  // Design §2.5 — live, non-blocking backdating warning, computed from the
  // same threshold the blocking FieldError (via priceFormSchema, above) uses.
  const backdatedWarning = (() => {
    if (!startDateTime) return null;
    const start = new Date(`${startDateTime}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const msSinceStart = nowMs - start.getTime();
    if (msSinceStart > 0 && msSinceStart <= THREE_DAYS_MS) {
      return `This price is backdated to ${startDateTime}; historical bills may be affected.`;
    }
    return null;
  })();

  return (
    <form
      id="price-form-add"
      noValidate
      onSubmit={(e) =>
        void handleSubmit((values) => onSubmit(toInsertPriceInput(values)))(e)
      }
    >
      {currentStatus === "ACTIVE" && (
        <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          {offeringName} is active. Saving will not change it — a new draft
          version is created instead.
        </div>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="price-name">Price name</FieldLabel>
          <Input
            id="price-name"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="Monthly recurring"
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="price-type">Price type</FieldLabel>
          <select
            id="price-type"
            aria-invalid={!!errors.priceType}
            disabled={isSubmitting}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            {...register("priceType")}
          >
            {PRICE_TYPES.map((type) => (
              <option key={type} value={type}>
                {PRICE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <FieldError errors={[errors.priceType]} />
        </Field>

        <Field orientation="responsive">
          <Field>
            <FieldLabel htmlFor="price-currency">Currency</FieldLabel>
            <Input
              id="price-currency"
              type="text"
              maxLength={3}
              placeholder="USD"
              aria-invalid={!!errors.currency}
              disabled={isSubmitting}
              {...register("currency")}
            />
            <FieldError errors={[errors.currency]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="price-gl-code">GL code</FieldLabel>
            <Input
              id="price-gl-code"
              type="text"
              placeholder="Optional"
              disabled={isSubmitting}
              {...register("glCode")}
            />
          </Field>
        </Field>

        <Field>
          <FieldLabel>Pricing model</FieldLabel>
          <Controller
            control={control}
            name="pricingModel"
            render={({ field }) => (
              <RadioGroup
                className="grid-flow-col justify-start gap-4"
                value={field.value}
                disabled={isSubmitting}
                onValueChange={field.onChange}
              >
                <label className="flex items-center gap-2 text-body-sm">
                  <RadioGroupItem value="flat" /> Flat
                </label>
                <label className="flex items-center gap-2 text-body-sm">
                  <RadioGroupItem value="tiered" /> Tiered
                </label>
              </RadioGroup>
            )}
          />
        </Field>

        {pricingModel === "flat" && (
          <Field>
            <FieldLabel htmlFor="price-amount">Amount</FieldLabel>
            <Input
              id="price-amount"
              type="text"
              placeholder="50000.00"
              aria-invalid={!!errors.amount}
              disabled={isSubmitting}
              {...register("amount")}
            />
            <FieldError errors={[errors.amount]} />
          </Field>
        )}

        {pricingModel === "tiered" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-body-sm font-medium text-foreground">
              Tiers
            </legend>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-end gap-2">
                <Field>
                  <FieldLabel htmlFor={`tier-from-${index}`}>From</FieldLabel>
                  <Input
                    id={`tier-from-${index}`}
                    type="text"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.from`)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-to-${index}`}>To</FieldLabel>
                  <Input
                    id={`tier-to-${index}`}
                    type="text"
                    placeholder="Open-ended"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.to`)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-rate-${index}`}>Rate</FieldLabel>
                  <Input
                    id={`tier-rate-${index}`}
                    type="text"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.rate`)}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove tier ${index + 1}`}
                  disabled={isSubmitting || fields.length === 1}
                  onClick={() => remove(index)}
                >
                  <X size={14} aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                // Seed the new row's `from` from the previous row's *current*
                // `to` value when non-empty (Design §2.6) — read via
                // getValues, not the useFieldArray `fields` snapshot, since
                // registered tier inputs are uncontrolled and `fields` only
                // tracks each row's value as of the last append/remove.
                const lastIndex = fields.length - 1;
                const previousTo =
                  lastIndex >= 0
                    ? getValues(`tiers.${lastIndex}.to`)
                    : undefined;
                append({
                  from:
                    previousTo && previousTo.trim() !== "" ? previousTo : "",
                  to: "",
                  rate: "",
                });
              }}
            >
              <Plus size={14} aria-hidden />
              Add tier
            </Button>
            <FieldError errors={[errors.tiers as { message?: string }]} />
          </fieldset>
        )}

        <Field>
          <FieldLabel htmlFor="price-start-date">Start date</FieldLabel>
          <Input
            id="price-start-date"
            type="date"
            aria-invalid={!!errors.startDateTime}
            disabled={isSubmitting}
            {...register("startDateTime")}
          />
          <FieldError errors={[errors.startDateTime]} />
          {backdatedWarning && !errors.startDateTime && (
            <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
              {backdatedWarning}
            </div>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}
