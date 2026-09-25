"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { ComponentTypePicker } from "@/components/products/manage/component-type-picker";
import {
  CapacityMotivationStepsEditor,
  createStepRowId,
  type StepRow,
} from "@/components/products/manage/capacity-motivation-steps-editor";
import { PRICING_COMPONENT_BADGE_VARIANTS } from "@/components/products/pricing-component-badge";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  COMPONENT_TYPES,
  RECURRING_PERIOD_LENGTHS,
  UNITS_OF_MEASURE,
  type ComponentType,
  type PriceCard,
  type RecurringPeriodLength,
  type UnitOfMeasure,
} from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Same tolerance value as insert-price.schema.ts's and insert-price.ts's own
// copies — a third independent copy, consistent with pm15-spec's own
// "small, multi-caller constant, not worth a shared module" call (Design §2.5).
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// pm54-spec I6 — helper text for each charge period, so the user sees the cycle
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

function isPositiveFiniteNumber(raw: string): boolean {
  const trimmed = raw.trim();
  // A plain positive decimal — the same shape the money fields accept, so a
  // quantity field never silently swallows hex/exponent forms the decimal
  // input never intends (Number("0x10") → 16, Number("1e3") → 1000).
  if (!MONEY_REGEX.test(trimmed)) return false;
  // `MONEY_REGEX` bounds the shape but not the magnitude — a long enough digit
  // string still parses to `Infinity` (`Number("9".repeat(400))`), which would
  // slip past a bare `> 0`. Require a finite value so the name's promise holds.
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0;
}

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

// pm54-spec I2, extended by pm55-spec I2. Validates only the checks meaningful
// on this flat, pre-assembly shape — the per-component-type completeness rules
// (D1's field-visibility table) and the money/quantity checks. The server's
// own `insertPriceSchema`/`updatePriceSchema` round-trip at submit time
// (pm47's price-input.schema.ts union) is the authoritative check — this is a
// fast, live, field-level mirror of it (Design §2.5).
const priceFormObjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Price name is required")
    .max(200, "Price name must be 200 characters or fewer"),
  currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
  glCode: z.string().trim().max(50, "GL code must be 50 characters or fewer"),
  componentType: z.enum(COMPONENT_TYPES),
  priceType: z.enum(["recurring", "oneTime"]),
  unitOfMeasure: z.string(),
  ratePerUnit: z.string(),
  rateCardLookUp: z.string(),
  amount: z.string(),
  recurringChargePeriodLength: z.string(),
  committedQuantity: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      aboveQuantity: z.string(),
      ratePerUnit: z.string(),
    }),
  ),
  startDateTime: z.string().min(1, "Start date is required"),
});

type PriceFormValues = z.infer<typeof priceFormObjectSchema>;

// pm54-spec I2, extended pm55-spec I2. The backdating tolerance is applied
// only when the start date actually changes from `baselineStartDate` (the
// edit's pre-filled original) — pm41 review #1's rule, unchanged by this
// unit. Mirrors the authoritative service-layer rule in
// services/product/update-price.ts.
function makePriceFormSchema(baselineStartDate?: string) {
  return priceFormObjectSchema.superRefine((value, ctx) => {
    if (value.componentType === "usage_rate") {
      if (
        !(UNITS_OF_MEASURE as readonly string[]).includes(value.unitOfMeasure)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Choose a unit of measure for this price",
          path: ["unitOfMeasure"],
        });
      }
      if (!MONEY_REGEX.test(value.ratePerUnit)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid rate.",
          path: ["ratePerUnit"],
        });
      }
    }

    if (value.componentType === "flat_fee") {
      if (!MONEY_REGEX.test(value.amount)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid amount.",
          path: ["amount"],
        });
      }
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
    }

    if (value.componentType === "capacity_commitment") {
      if (
        !(UNITS_OF_MEASURE as readonly string[]).includes(value.unitOfMeasure)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Choose a unit of measure for this price",
          path: ["unitOfMeasure"],
        });
      }
      if (!isPositiveFiniteNumber(value.committedQuantity)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a quantity greater than 0.",
          path: ["committedQuantity"],
        });
      }
    }

    if (value.componentType === "capacity_motivation") {
      if (
        !(UNITS_OF_MEASURE as readonly string[]).includes(value.unitOfMeasure)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Choose a unit of measure for this price",
          path: ["unitOfMeasure"],
        });
      }
      if (value.steps.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Add at least one step.",
          path: ["steps"],
        });
      }
      const seen = new Set<string>();
      value.steps.forEach((step, index) => {
        if (!isPositiveFiniteNumber(step.aboveQuantity)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a quantity greater than 0.",
            path: ["steps", index, "aboveQuantity"],
          });
        } else {
          const key = String(Number(step.aboveQuantity));
          if (seen.has(key)) {
            ctx.addIssue({
              code: "custom",
              message: `Duplicate threshold — a step already exists for ${key}.`,
              path: ["steps", index, "aboveQuantity"],
            });
          }
          seen.add(key);
        }
        if (!MONEY_REGEX.test(step.ratePerUnit)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid rate.",
            path: ["steps", index, "ratePerUnit"],
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

function emptyStepRow(): StepRow {
  return { id: createStepRowId(), aboveQuantity: "", ratePerUnit: "" };
}

function defaultFormValues(): PriceFormValues {
  return {
    name: "",
    currency: "",
    glCode: "",
    componentType: "usage_rate",
    priceType: "recurring",
    unitOfMeasure: "",
    ratePerUnit: "",
    rateCardLookUp: "",
    amount: "",
    recurringChargePeriodLength: "1",
    committedQuantity: "",
    steps: [emptyStepRow()],
    startDateTime: todayLocalDate(),
  };
}

// pm54-spec D9 / pm55-spec §4.21 — a stored PriceCard mapped back into the
// flat form shape, so the inline editor pre-fills the same fields the add
// flow starts empty. Only the fields the component's own `@type` carries are
// filled; envelope-derived fields (specVersion, plaSpecId, appliesAt, basis,
// boundTo) are never collected, displayed or echoed anywhere in this form.
export function priceCardToFormValues(price: PriceCard): PriceFormValues {
  const base: PriceFormValues = {
    ...defaultFormValues(),
    name: price.name,
    currency: price.currency,
    glCode: price.glCode ?? "",
    componentType: price.componentType,
    startDateTime: dateToLocalInput(price.startDateTime),
    unitOfMeasure: price.unitOfMeasure ?? "",
    recurringChargePeriodLength:
      price.recurringChargePeriodLength !== null
        ? String(price.recurringChargePeriodLength)
        : "1",
  };

  switch (price.component["@type"]) {
    case "usage_rate":
      return {
        ...base,
        ratePerUnit: price.component.params.ratePerUnit,
        rateCardLookUp: price.component.params.rateCardLookUp ?? "",
      };
    case "flat_fee":
      return {
        ...base,
        priceType: price.component.priceType,
        amount: price.component.params.amount,
      };
    case "capacity_commitment":
      return {
        ...base,
        committedQuantity: String(price.component.params.committedQuantity),
      };
    case "capacity_motivation":
      return {
        ...base,
        steps: price.component.params.steps.map((step) => ({
          id: createStepRowId(),
          aboveQuantity: String(step.aboveQuantity),
          ratePerUnit: step.ratePerUnit,
        })),
      };
    // Never reaches this table (Inv. #39) — kept for exhaustiveness only.
    case "negotiated_override":
      return base;
  }
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
  // pm41 review #3 — the edit flow's original stored start Date. Used to
  // round-trip a non-midnight start unchanged (the day-only input would
  // otherwise flatten it to local midnight). Absent for the add flow.
  baselineStartDateTime?: Date;
  // pm41 D2 — reports RHF dirtiness up so the panel can prompt-to-discard when a
  // second row is activated mid-edit.
  onDirtyChange?: (dirty: boolean) => void;
  // pm54-spec D4 — bubbles every field change up so the panel can clear a
  // stale offering-level banner as soon as the user starts correcting the
  // form, without this module re-evaluating VI3–VI5 itself.
  onValuesChange?: () => void;
  // pm41 review #7 — server-returned field errors (a VALIDATION_ERROR's
  // fieldErrors, or a synthesised { startDateTime } for DUPLICATE_START /
  // BACKDATED_START_TOO_FAR). Keyed messages are attached to their field via
  // RHF setError (aria-invalid + FieldError); any key with no matching field
  // renders in a residual list so nothing is dropped.
  serverFieldErrors?: Record<string, string[]> | null;
}

// The form fields a server error key can be attached to (pm41 review #7). A key
// outside this set (e.g. a nested `params.*` path) has no input to mark, so it
// falls through to the residual list.
const PRICE_SERVER_FIELDS: readonly (keyof PriceFormValues)[] = [
  "name",
  "currency",
  "glCode",
  "componentType",
  "priceType",
  "unitOfMeasure",
  "recurringChargePeriodLength",
  "startDateTime",
];

// pm54-spec I2. Assembles the flat form shape into the discriminated
// InsertPriceInput — the one place the two representations meet. Each branch
// carries exactly the row columns and `params` its `componentType` allows
// (pm47's price-input.schema.ts union), so an impossible combination is
// untypeable on the server side too.
//
// pm41 review #3 — when editing, the date input is day-only, so a stored start
// with a time-of-day component would be silently flattened to local midnight on
// an amount-only save (and then read as a *changed* start, tripping backdating).
// If the day is unchanged from `baselineStartDateTime`, re-emit the original
// Date verbatim so the instant round-trips exactly; a real day change still
// reconstructs local midnight of the chosen day.
function toInsertPriceInput(
  values: PriceFormValues,
  baselineStartDateTime?: Date,
): InsertPriceInput {
  const startDateTime =
    baselineStartDateTime &&
    values.startDateTime === dateToLocalInput(baselineStartDateTime)
      ? baselineStartDateTime
      : new Date(`${values.startDateTime}T00:00:00`);

  const core = {
    name: values.name,
    currency: values.currency.toUpperCase(),
    glCode: values.glCode.trim() === "" ? null : values.glCode.trim(),
    startDateTime,
  };

  switch (values.componentType) {
    case "usage_rate":
      return {
        componentType: "usage_rate",
        unitOfMeasure: values.unitOfMeasure as UnitOfMeasure,
        params: {
          ratePerUnit: values.ratePerUnit,
          rateCardLookUp:
            values.rateCardLookUp.trim() === ""
              ? null
              : values.rateCardLookUp.trim(),
        },
        ...core,
      };
    case "flat_fee":
      if (values.priceType === "recurring") {
        return {
          componentType: "flat_fee",
          priceType: "recurring",
          recurringChargePeriodLength: Number(
            values.recurringChargePeriodLength,
          ) as RecurringPeriodLength,
          recurringChargePeriodType: "months",
          params: { amount: values.amount },
          ...core,
        };
      }
      return {
        componentType: "flat_fee",
        priceType: "oneTime",
        params: { amount: values.amount },
        ...core,
      };
    case "capacity_commitment":
      return {
        componentType: "capacity_commitment",
        unitOfMeasure: values.unitOfMeasure as UnitOfMeasure,
        params: { committedQuantity: Number(values.committedQuantity) },
        ...core,
      };
    case "capacity_motivation":
      return {
        componentType: "capacity_motivation",
        unitOfMeasure: values.unitOfMeasure as UnitOfMeasure,
        params: {
          // pm55 D2 — the form keeps the steps ascending, never left for the
          // server. The editor reorders on blur, but a save that bypasses the
          // final blur (Cmd/Ctrl+Enter from within a step field) could submit
          // an unsorted list; sorting here guarantees the ascending order the
          // server's stepsSchema requires. Validation has already refused any
          // non-positive or duplicate threshold, so this sort is total.
          steps: values.steps
            .map((step) => ({
              aboveQuantity: Number(step.aboveQuantity),
              ratePerUnit: step.ratePerUnit,
            }))
            .sort((a, b) => a.aboveQuantity - b.aboveQuantity),
        },
        ...core,
      };
  }
}

// pm54-spec D1: which row-level fields a branch shows. A field that's NULL
// for a branch is hidden, not disabled (§4.11) — the same rule the read-only
// panels follow.
function showsUnitOfMeasure(componentType: ComponentType): boolean {
  return componentType !== "flat_fee";
}

function showsRecurringPeriod(
  componentType: ComponentType,
  priceType: PriceFormValues["priceType"],
): boolean {
  return componentType === "flat_fee" && priceType === "recurring";
}

export function PriceForm({
  offeringName,
  currentStatus,
  onSubmit,
  isSubmitting,
  formId = "price-form-add",
  defaultValues,
  baselineStartDateTime,
  onDirtyChange,
  onValuesChange,
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
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<PriceFormValues>({
    resolver,
    defaultValues: defaultValues ?? defaultFormValues(),
  });

  const componentType = useWatch({ control, name: "componentType" });
  const priceType = useWatch({ control, name: "priceType" });
  const recurringChargePeriodLength = useWatch({
    control,
    name: "recurringChargePeriodLength",
  });
  const startDateTime = useWatch({ control, name: "startDateTime" });

  // pm54-spec D1/I2 — clear and hide the branch-specific fields when the
  // component type (or, for flat_fee, the charge type) changes, so a
  // switched branch can never submit a stale, mismatched value. Idempotent,
  // so running on mount is harmless.
  useEffect(() => {
    if (componentType !== "usage_rate") {
      setValue("ratePerUnit", "");
      setValue("rateCardLookUp", "");
    }
    if (componentType !== "flat_fee") {
      setValue("amount", "");
      setValue("priceType", "recurring");
      setValue("recurringChargePeriodLength", "1");
    }
    if (componentType !== "capacity_commitment") {
      setValue("committedQuantity", "");
    }
    if (componentType !== "capacity_motivation") {
      setValue("steps", [emptyStepRow()]);
    }
    if (!showsUnitOfMeasure(componentType)) {
      setValue("unitOfMeasure", "");
    }
  }, [componentType, setValue]);

  useEffect(() => {
    if (componentType === "flat_fee" && priceType !== "recurring") {
      setValue("recurringChargePeriodLength", "1");
    }
  }, [componentType, priceType, setValue]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // pm54-spec D4 — every field change (including a radio-driven picker or
  // charge-type switch, which fires no native DOM "change" event) clears a
  // stale offering-level banner in the parent. `useWatch({ control })` with
  // no `name` subscribes to the whole form, so this fires on any field.
  const allValues = useWatch({ control });
  const skipFirstValuesChange = useRef(true);
  // `onValuesChange` is a fresh closure on every parent render (it typically
  // closes over `setViolation`), so it must not sit in this effect's own
  // dependency array — that would re-fire on a prop-identity change alone,
  // immediately clearing a violation the parent just set in response to
  // *this* form's own submit. A ref holds the latest callback instead, so
  // the effect only reacts to an actual value change.
  const onValuesChangeRef = useRef(onValuesChange);
  useEffect(() => {
    onValuesChangeRef.current = onValuesChange;
  });
  useEffect(() => {
    if (skipFirstValuesChange.current) {
      skipFirstValuesChange.current = false;
      return;
    }
    onValuesChangeRef.current?.();
  }, [allValues]);

  // pm41 review #7 — attach server field errors to their inputs (aria-invalid +
  // FieldError) via setError. RHF clears these on the next submit's
  // re-validation, so a corrected field stops showing the stale server error.
  // This is the one side effect; the residual list below is a pure derivation.
  useEffect(() => {
    if (!serverFieldErrors) return;
    for (const [key, messages] of Object.entries(serverFieldErrors)) {
      const message = messages.join(" ");
      if (message && (PRICE_SERVER_FIELDS as readonly string[]).includes(key)) {
        setError(key as keyof PriceFormValues, { type: "server", message });
      }
    }
  }, [serverFieldErrors, setError]);

  // Keys with no matching field become residual messages so none are dropped —
  // derived during render (pm41 review follow-up), never via setState in an
  // effect, so it stays in sync with serverFieldErrors with no extra render.
  const residualServerMessages = serverFieldErrors
    ? Object.entries(serverFieldErrors)
        .filter(
          ([key]) => !(PRICE_SERVER_FIELDS as readonly string[]).includes(key),
        )
        .map(([, messages]) => messages.join(" "))
        .filter((message) => message.length > 0)
    : [];

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
        void handleSubmit((values) =>
          onSubmit(toInsertPriceInput(values, baselineStartDateTime)),
        )(e)
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
          <FieldLabel>Component type</FieldLabel>
          <Controller
            control={control}
            name="componentType"
            render={({ field }) => (
              <ComponentTypePicker
                value={field.value}
                onChange={field.onChange}
                disabled={isSubmitting}
              />
            )}
          />
        </Field>

        {componentType === "usage_rate" && (
          <>
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

            <Field>
              <FieldLabel htmlFor="price-rate">Rate per unit</FieldLabel>
              <Input
                id="price-rate"
                type="text"
                placeholder="0.05"
                aria-invalid={!!errors.ratePerUnit}
                disabled={isSubmitting}
                {...register("ratePerUnit")}
              />
              <FieldError errors={[errors.ratePerUnit]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="price-rate-card">Rate card name</FieldLabel>
              <Input
                id="price-rate-card"
                type="text"
                autoComplete="off"
                placeholder="Optional"
                className="font-mono"
                aria-invalid={!!errors.rateCardLookUp}
                disabled={isSubmitting}
                {...register("rateCardLookUp")}
              />
              <p className="text-caption text-[color:var(--text-muted)]">
                The rate card isn&apos;t built yet — leaving this blank means
                the rate per unit above applies.
              </p>
              <FieldError errors={[errors.rateCardLookUp]} />
            </Field>
          </>
        )}

        {componentType === "flat_fee" && (
          <>
            <Field>
              <FieldLabel>Charge type</FieldLabel>
              <Controller
                control={control}
                name="priceType"
                render={({ field }) => (
                  <RadioGroup
                    className="grid-flow-col justify-start gap-4"
                    value={field.value}
                    disabled={isSubmitting}
                    onValueChange={field.onChange}
                  >
                    <label className="flex items-center gap-2 text-body-sm">
                      <RadioGroupItem value="recurring" />
                      {
                        PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.recurring
                          .label
                      }
                    </label>
                    <label className="flex items-center gap-2 text-body-sm">
                      <RadioGroupItem value="oneTime" />
                      {PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.oneTime.label}
                    </label>
                  </RadioGroup>
                )}
              />
            </Field>

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

            {showsRecurringPeriod(componentType, priceType) && (
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
                  <FieldLabel htmlFor="price-period-type">
                    Period unit
                  </FieldLabel>
                  {/* Fixed to `months` (the only mapped period type, O1
                      resolved); rendered read-only until a second value
                      exists. */}
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
          </>
        )}

        {componentType === "capacity_commitment" && (
          <>
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

            <Field>
              <FieldLabel htmlFor="price-committed-quantity">
                Committed quantity
              </FieldLabel>
              <Input
                id="price-committed-quantity"
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                aria-invalid={!!errors.committedQuantity}
                disabled={isSubmitting}
                {...register("committedQuantity")}
              />
              <p className="text-caption text-[color:var(--text-muted)]">
                The customer is billed for at least this quantity, even when
                they use less.
              </p>
              <FieldError errors={[errors.committedQuantity]} />
            </Field>
          </>
        )}

        {componentType === "capacity_motivation" && (
          <>
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

            <Controller
              control={control}
              name="steps"
              render={({ field }) => (
                <CapacityMotivationStepsEditor
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isSubmitting}
                  rowErrors={field.value.map(
                    (_, index) => errors.steps?.[index],
                  )}
                  // `steps` is a Controller field (not useFieldArray), so a
                  // schema issue at path ["steps"] — the "add at least one
                  // step" case — lands on `errors.steps` itself, never on
                  // `errors.steps.root` (@hookform/resolvers toNestErrors only
                  // nests under `.root` when a `steps.<n>` field is
                  // registered). Read it where it actually lands.
                  listError={errors.steps as { message?: string } | undefined}
                />
              )}
            />
          </>
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
