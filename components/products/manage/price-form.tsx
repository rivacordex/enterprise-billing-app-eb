"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  PRICE_TYPES,
  PRICING_MODELS,
  RECURRING_PERIOD_LENGTHS,
  UNITS_OF_MEASURE,
  type PriceCard,
  type RecurringPeriodLength,
  type UnitOfMeasure,
} from "@/types/product";
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

// pm38-spec I6 — helper text for each charge period, so the user sees the cycle
// a length maps onto (prodmgmt-architecture §3.2: (1, months) → monthly,
// (3, months) → quarterly, (12, months) → annually).
const PERIOD_LENGTH_HELP: Record<RecurringPeriodLength, string> = {
  1: "1 month — bills on a monthly cycle",
  3: "3 months — bills on a quarterly cycle",
  12: "12 months — bills on an annual cycle",
};

const RECURRING_PERIOD_LENGTH_STRINGS: readonly string[] =
  RECURRING_PERIOD_LENGTHS.map((length) => String(length));

const MONEY_REGEX = /^\d+(\.\d+)?$/;

// Local calendar date (not UTC — `toISOString()` can land on the wrong day
// near midnight local time when local and UTC dates differ), matching the
// local-midnight parse the backdating validation/warning below already use.
function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// A stored `start_date_time` rendered back into the `<input type="date">`'s
// yyyy-mm-dd value, in local parts (the same local-calendar basis todayLocalDate
// and the backdating checks use, so an edit that leaves the date untouched
// round-trips to the same day it was displayed).
function dateToLocalInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// pm22-spec §2.4, extended by pm38-spec I6. Validates only the checks meaningful
// on this flat, pre-assembly shape — the per-price-type completeness rules
// (charge period for recurring, unit for usage) and the flat/tiered money
// checks. Tier contiguity and the open-ended-only-on-last rule stay defined
// exactly once, in tieredPricingCharacteristicsSchema (reused, not re-declared,
// by the Server Action's own insertPriceSchema/updatePriceSchema round-trip at
// submit time).
const priceFormObjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Price name is required")
    .max(200, "Price name must be 200 characters or fewer"),
  priceType: z.enum(PRICE_TYPES),
  recurringChargePeriodLength: z.string(),
  unitOfMeasure: z.string(),
  currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
  glCode: z.string().trim().max(50, "GL code must be 50 characters or fewer"),
  startDateTime: z.string().min(1, "Start date is required"),
  pricingModel: z.enum(PRICING_MODELS),
  amount: z.string(),
  tiers: z.array(
    z.object({ from: z.string(), to: z.string(), rate: z.string() }),
  ),
});

type PriceFormValues = z.infer<typeof priceFormObjectSchema>;

// pm22-spec §2.4, extended by pm38-spec I6, amended pm41 review #1. The backdating
// tolerance is applied only when the start date actually changes from
// `baselineStartDate` (the edit's pre-filled original). Re-saving a row without
// touching its start — e.g. correcting an amount on a draft branched from a
// long-live version — is not a new backdate and must not be blocked; the add
// flow passes no baseline, so any past start beyond tolerance is still caught.
// Mirrors the authoritative service-layer rule in services/product/update-price.ts.
function makePriceFormSchema(baselineStartDate?: string) {
  return priceFormObjectSchema.superRefine((value, ctx) => {
    if (
      value.priceType === "recurring" &&
      !RECURRING_PERIOD_LENGTH_STRINGS.includes(
        value.recurringChargePeriodLength,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Charge period must be 1, 3 or 12 months",
        path: ["recurringChargePeriodLength"],
      });
    }
    if (
      value.priceType === "usage" &&
      !(UNITS_OF_MEASURE as readonly string[]).includes(value.unitOfMeasure)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose a unit of measure for a usage price",
        path: ["unitOfMeasure"],
      });
    }

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
        const trimmedTo = tier.to.trim();
        if (trimmedTo !== "" && !MONEY_REGEX.test(trimmedTo)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid number.",
            path: ["tiers", index, "to"],
          });
        }
      });
    }

    // Duplicated tolerance check (Design §2.5) — a fast, live, field-level
    // check; the Server Action's own schema round-trip (§3.2) is the
    // authoritative one. Gated on a changed start date (pm41 review #1).
    if (value.startDateTime !== baselineStartDate) {
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
    }
  });
}

// pm41 D6 — a stored PriceCard mapped back into the flat form shape, so the
// inline editor pre-fills the same fields the add flow starts empty. Each
// branch of the discriminated read model fills exactly the fields its
// `priceType` carries; the hidden groups keep the add flow's benign defaults
// (period "1", unit "") so a later type-switch has something valid to show.
export function priceCardToFormValues(price: PriceCard): PriceFormValues {
  return {
    name: price.name,
    priceType: price.priceType,
    recurringChargePeriodLength:
      price.recurringChargePeriodLength !== null
        ? String(price.recurringChargePeriodLength)
        : "1",
    unitOfMeasure: price.unitOfMeasure ?? "",
    currency: price.currency,
    glCode: price.glCode ?? "",
    startDateTime: dateToLocalInput(price.startDateTime),
    pricingModel: price.pricingModel,
    amount: price.amount ?? "",
    tiers:
      price.pricingModel === "tiered" && price.pricingCharacteristics
        ? price.pricingCharacteristics.tiers.map((tier) => ({
            from: String(tier.from),
            to: tier.to === null ? "" : String(tier.to),
            rate: tier.rate,
          }))
        : [{ from: "0", to: "", rate: "" }],
  };
}

export interface PriceFormProps {
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  onSubmit: (values: InsertPriceInput) => Promise<void>;
  isSubmitting: boolean;
  // pm41 D6 — the DOM id of the <form>, so more than one PriceForm can coexist
  // on the page (an inline editor per row plus the add form) without colliding
  // ids or cross-wiring their external Save buttons. Defaults to the add flow's
  // original id.
  formId?: string;
  // pm41 D6 — pre-filled values for the inline edit flow; the add flow omits it
  // and starts from the empty defaults.
  defaultValues?: PriceFormValues;
  // pm41 D2 — reports RHF dirtiness up so the panel can prompt-to-discard when a
  // second row is activated mid-edit.
  onDirtyChange?: (dirty: boolean) => void;
  // pm41 review #7 — server-returned field errors (a VALIDATION_ERROR's
  // fieldErrors, or a synthesised { startDateTime } for DUPLICATE_START /
  // BACKDATED_START_TOO_FAR). Keyed messages are attached to their field via
  // RHF setError (aria-invalid + FieldError), meeting spec I3's "field error on
  // the row/start date"; any key with no matching field renders in a residual
  // list so nothing is dropped.
  serverFieldErrors?: Record<string, string[]> | null;
}

// The form fields a server error key can be attached to (pm41 review #7). A key
// outside this set (e.g. a nested priceCharacteristics path) has no input to
// mark, so it falls through to the residual list.
const PRICE_SERVER_FIELDS: readonly (keyof PriceFormValues)[] = [
  "name",
  "priceType",
  "recurringChargePeriodLength",
  "unitOfMeasure",
  "currency",
  "glCode",
  "amount",
  "startDateTime",
  "tiers",
];

// pm22-spec §3.3, extended by pm38-spec I6. Assembles the flat form shape into
// the discriminated InsertPriceInput — the one place the two representations
// meet. Each branch carries exactly the completeness columns its `priceType`
// allows: recurring gets its charge period (type fixed to `months`), usage its
// unit, `once` neither.
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

  const core = {
    name: values.name,
    currency: values.currency.toUpperCase(),
    glCode: values.glCode.trim() === "" ? null : values.glCode.trim(),
    startDateTime: new Date(`${values.startDateTime}T00:00:00`),
    priceCharacteristics,
  };

  if (values.priceType === "recurring") {
    return {
      priceType: "recurring",
      recurringChargePeriodLength: Number(
        values.recurringChargePeriodLength,
      ) as RecurringPeriodLength,
      recurringChargePeriodType: "months",
      ...core,
    };
  }
  if (values.priceType === "usage") {
    return {
      priceType: "usage",
      unitOfMeasure: values.unitOfMeasure as UnitOfMeasure,
      ...core,
    };
  }
  return { priceType: "once", ...core };
}

export function PriceForm({
  offeringName,
  currentStatus,
  onSubmit,
  isSubmitting,
  formId = "price-form-add",
  defaultValues,
  onDirtyChange,
  serverFieldErrors,
}: PriceFormProps): React.JSX.Element {
  // Backdating is gated on a change from the pre-filled start (pm41 review #1);
  // memoised so the resolver identity is stable across renders.
  const resolver = useMemo(
    () => zodResolver(makePriceFormSchema(defaultValues?.startDateTime)),
    [defaultValues?.startDateTime],
  );

  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<PriceFormValues>({
    resolver,
    defaultValues: defaultValues ?? {
      name: "",
      priceType: "recurring",
      recurringChargePeriodLength: "1",
      unitOfMeasure: "",
      currency: "",
      glCode: "",
      startDateTime: todayLocalDate(),
      pricingModel: "flat",
      amount: "",
      tiers: [{ from: "0", to: "", rate: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "tiers",
  });

  const priceType = useWatch({ control, name: "priceType" });
  const pricingModel = useWatch({ control, name: "pricingModel" });
  const recurringChargePeriodLength = useWatch({
    control,
    name: "recurringChargePeriodLength",
  });
  const startDateTime = useWatch({ control, name: "startDateTime" });

  // pm38-spec I6 — clear and hide the type-specific groups when the type
  // changes, so a switched type can never submit a stale unit or period.
  // Idempotent, so running on mount (recurring default) is harmless.
  useEffect(() => {
    if (priceType !== "usage") setValue("unitOfMeasure", "");
    if (priceType !== "recurring") setValue("recurringChargePeriodLength", "1");
  }, [priceType, setValue]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // pm41 review #7 — attach server field errors to their inputs (aria-invalid +
  // FieldError) via setError; keys with no matching field become residual
  // messages so none are dropped. RHF clears these on the next submit's
  // re-validation, so a corrected field stops showing the stale server error.
  const [residualServerMessages, setResidualServerMessages] = useState<
    string[]
  >([]);
  useEffect(() => {
    if (!serverFieldErrors) {
      setResidualServerMessages([]);
      return;
    }
    const residual: string[] = [];
    for (const [key, messages] of Object.entries(serverFieldErrors)) {
      const message = messages.join(" ");
      if (!message) continue;
      if ((PRICE_SERVER_FIELDS as readonly string[]).includes(key)) {
        setError(key as keyof PriceFormValues, { type: "server", message });
      } else {
        residual.push(message);
      }
    }
    setResidualServerMessages(residual);
  }, [serverFieldErrors, setError]);

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

  // pm38-spec D5 / ui-context §4 — the two unbillable-but-legal shapes save with
  // a warning, never a block (§1.19). Nothing downstream bills a tiered
  // recurring price (bm29 fails the account), and rating v1 is FLAT-only.
  const unbillableWarning =
    pricingModel === "tiered" && priceType === "recurring"
      ? "Nothing bills a tiered recurring price yet — this version will fail its bill run."
      : pricingModel === "tiered" && priceType === "usage"
        ? "Usage rating charges a flat amount today; tiers are stored but not applied."
        : null;

  const periodHelp = RECURRING_PERIOD_LENGTH_STRINGS.includes(
    recurringChargePeriodLength ?? "",
  )
    ? PERIOD_LENGTH_HELP[
        Number(recurringChargePeriodLength) as RecurringPeriodLength
      ]
    : null;

  return (
    <form
      id={formId}
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

        {priceType === "recurring" && (
          <Field orientation="responsive">
            <Field>
              <FieldLabel htmlFor="price-period-length">
                Charge period
              </FieldLabel>
              <select
                id="price-period-length"
                aria-invalid={!!errors.recurringChargePeriodLength}
                disabled={isSubmitting}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm tabular-nums"
                {...register("recurringChargePeriodLength")}
              >
                {RECURRING_PERIOD_LENGTHS.map((length) => (
                  <option key={length} value={String(length)}>
                    {length}
                  </option>
                ))}
              </select>
              {periodHelp && (
                <p className="text-caption text-[color:var(--text-muted)]">
                  {periodHelp}
                </p>
              )}
              <FieldError errors={[errors.recurringChargePeriodLength]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="price-period-type">Period unit</FieldLabel>
              {/* Fixed to `months` (the only mapped period type, O1 resolved);
                  rendered read-only until a second value exists. */}
              <Input
                id="price-period-type"
                type="text"
                value="months"
                readOnly
                tabIndex={-1}
                aria-label="Period unit (fixed to months)"
              />
            </Field>
          </Field>
        )}

        {priceType === "usage" && (
          <Field>
            <FieldLabel htmlFor="price-unit">Unit of measure</FieldLabel>
            <select
              id="price-unit"
              aria-invalid={!!errors.unitOfMeasure}
              disabled={isSubmitting}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              {...register("unitOfMeasure")}
            >
              <option value="">Select a unit…</option>
              {UNITS_OF_MEASURE.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
            <FieldError errors={[errors.unitOfMeasure]} />
          </Field>
        )}

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
              aria-invalid={!!errors.glCode}
              disabled={isSubmitting}
              {...register("glCode")}
            />
            <FieldError errors={[errors.glCode]} />
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

        {unbillableWarning && (
          <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
            {unbillableWarning}
          </div>
        )}

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
                    aria-invalid={!!errors.tiers?.[index]?.from}
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.from`)}
                  />
                  <FieldError errors={[errors.tiers?.[index]?.from]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-to-${index}`}>To</FieldLabel>
                  <Input
                    id={`tier-to-${index}`}
                    type="text"
                    placeholder="Open-ended"
                    aria-invalid={!!errors.tiers?.[index]?.to}
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.to`)}
                  />
                  <FieldError errors={[errors.tiers?.[index]?.to]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-rate-${index}`}>Rate</FieldLabel>
                  <Input
                    id={`tier-rate-${index}`}
                    type="text"
                    aria-invalid={!!errors.tiers?.[index]?.rate}
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.rate`)}
                  />
                  <FieldError errors={[errors.tiers?.[index]?.rate]} />
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

        {residualServerMessages.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {residualServerMessages.map((message, index) => (
              <li
                key={index}
                className="text-body-sm text-[color:var(--text-danger)]"
              >
                {message}
              </li>
            ))}
          </ul>
        )}
      </FieldGroup>
    </form>
  );
}
