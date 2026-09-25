"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface StepRow {
  // Client-only React key, generated fresh per row (never derived from
  // server data) so focus survives commitOrder's reordering on blur.
  // Stripped before the server payload is built (toInsertPriceInput).
  id: string;
  aboveQuantity: string;
  ratePerUnit: string;
}

let stepRowSeq = 0;
export function createStepRowId(): string {
  stepRowSeq += 1;
  return `step-${stepRowSeq}`;
}

export const EMPTY_STEP_ROW: StepRow = {
  id: "step-0",
  aboveQuantity: "",
  ratePerUnit: "",
};

export interface StepRowFieldErrors {
  aboveQuantity?: { message?: string };
  ratePerUnit?: { message?: string };
}

export interface CapacityMotivationStepsEditorProps {
  value: StepRow[];
  onChange: (rows: StepRow[]) => void;
  disabled?: boolean;
  // pm55-spec CodeRabbit fix — per-row RHF field errors (steps.N.*) and the
  // steps-array-level error (steps.root), passed through from price-form so
  // this leaf renders the same messages the schema already computes.
  rowErrors?: (StepRowFieldErrors | undefined)[];
  listError?: { message?: string } | undefined;
}

const TOUCH_ICON = "[@media(pointer:coarse)]:size-11";

// A plain positive decimal — the shape the quantity/money fields accept
// (price-form's `MONEY_REGEX`). Exponent/hex forms are excluded.
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

// A well-formed, finite positive threshold: `POSITIVE_DECIMAL` bounds the shape
// and `Number.isFinite` bounds the magnitude (a long-enough digit string parses
// to `Infinity`). Both the reorder and the duplicate check below use this so the
// live editor agrees with the submit-time schema (price-form's
// `isPositiveFiniteNumber`) on what counts as a valid threshold — an exponent/hex
// or overflowing value is a *format* error there, never a reorder or a duplicate.
function isFiniteThreshold(raw: string): boolean {
  return POSITIVE_DECIMAL.test(raw) && Number.isFinite(Number(raw));
}

// pm55-spec D2. Reorders on commit of the edited row (blur), not on every
// keystroke — a row with an empty/unparseable threshold is left where it is,
// never reordered on a partial entry.
function commitOrder(rows: StepRow[]): StepRow[] {
  const parsed = rows.map((row) => {
    const trimmed = row.aboveQuantity.trim();
    const n = Number(trimmed);
    return { row, valid: isFiniteThreshold(trimmed), n };
  });
  if (parsed.some((entry) => !entry.valid)) return rows;
  return parsed.sort((a, b) => a.n - b.n).map((entry) => entry.row);
}

// A duplicate threshold, refused client-side (D2's one allowed pre-check —
// VI1 is a within-component rule, reading nothing but this component's own
// rows). Named by the duplicated value, on the later (offending) row only —
// an earlier row that already held the value first is never itself flagged.
function duplicateMessage(rows: StepRow[], index: number): string | null {
  const raw = rows[index]!.aboveQuantity.trim();
  // Only a valid positive decimal participates in duplicate detection. An
  // exponent/hex form (e.g. "1e3", "0x10") is an invalid threshold the form
  // schema rejects as a *format* error first (price-form's steps superRefine,
  // via `isPositiveFiniteNumber`), before it ever computes its duplicate key —
  // so treating such a value as a numeric duplicate here would both mask that
  // format error and disagree with the schema. Apply the same rule to earlier
  // rows so only well-formed thresholds are compared.
  if (!isFiniteThreshold(raw)) return null;
  const current = Number(raw);
  const isDuplicate = rows.slice(0, index).some((row) => {
    const other = row.aboveQuantity.trim();
    return isFiniteThreshold(other) && Number(other) === current;
  });
  return isDuplicate
    ? `Duplicate threshold — a step already exists for ${current}.`
    : null;
}

// pm55-spec I1 (new, client leaf). An add/remove row list — never a
// free-text JSON field (D2). Removing the last row is refused with a
// field-level message, not by disabling the control silently.
export function CapacityMotivationStepsEditor({
  value,
  onChange,
  disabled,
  rowErrors,
  listError,
}: CapacityMotivationStepsEditorProps): React.JSX.Element {
  // pm55-spec CodeRabbit fix — the "at least one step" alert only fires once
  // the user actually tries to remove the last row, not merely because the
  // list happens to be down to one (e.g. right after a fresh mount).
  const [removeRefused, setRemoveRefused] = useState(false);

  function updateRow(index: number, patch: Partial<StepRow>): void {
    // Editing any row clears the transient "at least one step" notice — it
    // belongs to the moment of a refused removal, not to every render where
    // the list happens to hold one row.
    setRemoveRefused(false);
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function commitRowOrder(): void {
    onChange(commitOrder(value));
  }

  function removeRow(index: number): void {
    if (value.length === 1) {
      setRemoveRefused(true);
      return;
    }
    onChange(value.filter((_, i) => i !== index));
  }

  const minRowsMessage =
    removeRefused && value.length === 1
      ? "At least one step is required."
      : null;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-sm font-medium text-foreground">
        Steps
      </legend>
      {value.map((row, index) => {
        const duplicate = duplicateMessage(value, index);
        const aboveQuantityError = rowErrors?.[index]?.aboveQuantity;
        const ratePerUnitError = rowErrors?.[index]?.ratePerUnit;
        return (
          <div key={row.id} className="flex items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`step-above-${row.id}`}>
                Above quantity
              </FieldLabel>
              <Input
                id={`step-above-${row.id}`}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                aria-invalid={duplicate !== null || !!aboveQuantityError}
                disabled={disabled}
                value={row.aboveQuantity}
                onChange={(e) =>
                  updateRow(index, { aboveQuantity: e.target.value })
                }
                onBlur={commitRowOrder}
              />
              <FieldError
                errors={[
                  duplicate ? { message: duplicate } : undefined,
                  aboveQuantityError,
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`step-rate-${row.id}`}>
                Rate per unit
              </FieldLabel>
              <Input
                id={`step-rate-${row.id}`}
                type="text"
                aria-invalid={!!ratePerUnitError}
                value={row.ratePerUnit}
                disabled={disabled}
                onChange={(e) =>
                  updateRow(index, { ratePerUnit: e.target.value })
                }
              />
              <FieldError errors={[ratePerUnitError]} />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TOUCH_ICON}
              aria-label={`Remove step ${index + 1}`}
              disabled={disabled}
              onClick={() => removeRow(index)}
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setRemoveRefused(false);
          onChange([...value, { ...EMPTY_STEP_ROW, id: createStepRowId() }]);
        }}
      >
        <Plus size={14} aria-hidden />
        Add step
      </Button>
      <FieldError
        errors={[
          minRowsMessage ? { message: minRowsMessage } : undefined,
          listError,
        ]}
      />
    </fieldset>
  );
}
