"use client";

import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface StepRow {
  aboveQuantity: string;
  ratePerUnit: string;
}

export const EMPTY_STEP_ROW: StepRow = { aboveQuantity: "", ratePerUnit: "" };

export interface CapacityMotivationStepsEditorProps {
  value: StepRow[];
  onChange: (rows: StepRow[]) => void;
  disabled?: boolean;
}

const TOUCH_ICON = "[@media(pointer:coarse)]:size-11";

// pm55-spec D2. Reorders on commit of the edited row (blur), not on every
// keystroke — a row with an empty/unparseable threshold is left where it is,
// never reordered on a partial entry.
function commitOrder(rows: StepRow[]): StepRow[] {
  const parsed = rows.map((row) => {
    const trimmed = row.aboveQuantity.trim();
    const n = Number(trimmed);
    return { row, valid: trimmed !== "" && Number.isFinite(n), n };
  });
  if (parsed.some((entry) => !entry.valid)) return rows;
  return parsed.sort((a, b) => a.n - b.n).map((entry) => entry.row);
}

// A duplicate threshold, refused client-side (D2's one allowed pre-check —
// VI1 is a within-component rule, reading nothing but this component's own
// rows). Named by the duplicated value, on the later (offending) row only —
// an earlier row that already held the value first is never itself flagged.
function duplicateMessage(rows: StepRow[], index: number): string | null {
  const current = rows[index]!.aboveQuantity.trim();
  if (current === "") return null;
  const isDuplicate = rows
    .slice(0, index)
    .some((row) => row.aboveQuantity.trim() === current);
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
}: CapacityMotivationStepsEditorProps): React.JSX.Element {
  function updateRow(index: number, patch: Partial<StepRow>): void {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function commitRowOrder(): void {
    onChange(commitOrder(value));
  }

  function removeRow(index: number): void {
    if (value.length === 1) return;
    onChange(value.filter((_, i) => i !== index));
  }

  const minRowsMessage =
    value.length === 1 ? "At least one step is required." : null;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-sm font-medium text-foreground">
        Steps
      </legend>
      {value.map((row, index) => {
        const duplicate = duplicateMessage(value, index);
        return (
          <div key={index} className="flex items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`step-above-${index}`}>
                Above quantity
              </FieldLabel>
              <Input
                id={`step-above-${index}`}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                aria-invalid={duplicate !== null}
                disabled={disabled}
                value={row.aboveQuantity}
                onChange={(e) =>
                  updateRow(index, { aboveQuantity: e.target.value })
                }
                onBlur={commitRowOrder}
              />
              <FieldError errors={duplicate ? [{ message: duplicate }] : []} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`step-rate-${index}`}>
                Rate per unit
              </FieldLabel>
              <Input
                id={`step-rate-${index}`}
                type="text"
                value={row.ratePerUnit}
                disabled={disabled}
                onChange={(e) =>
                  updateRow(index, { ratePerUnit: e.target.value })
                }
              />
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
        onClick={() => onChange([...value, { ...EMPTY_STEP_ROW }])}
      >
        <Plus size={14} aria-hidden />
        Add step
      </Button>
      <FieldError
        errors={minRowsMessage ? [{ message: minRowsMessage }] : []}
      />
    </fieldset>
  );
}
