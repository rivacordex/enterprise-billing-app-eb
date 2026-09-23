"use client";

import { PRICING_COMPONENT_BADGE_VARIANTS } from "@/components/products/pricing-component-badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { COMPONENT_TYPES, type ComponentType } from "@/types/product";

export interface ComponentTypePickerProps {
  value: ComponentType;
  onChange: (value: ComponentType) => void;
  disabled?: boolean;
}

interface ComponentTypeOption {
  label: string;
  help: string;
}

// pm54-spec D1/I1. The four persistable types only — `negotiated_override`
// cannot be written to this table (Inv. #39) and never appears here, not even
// disabled (a disabled option would imply it someday could). A total
// `Record<ComponentType, …>` so a fifth `ComponentType` member is a compile
// error, never a default branch. `flat_fee`'s label is the umbrella name —
// its `recurring`/`oneTime` split (and their own §2 badge labels) is a choice
// made *inside* the branch (pm54-spec D1), not at the picker.
const COMPONENT_TYPE_OPTIONS: Record<ComponentType, ComponentTypeOption> = {
  usage_rate: {
    label: PRICING_COMPONENT_BADGE_VARIANTS.usage_rate.label,
    help: "A per-unit rate applied to metered usage.",
  },
  flat_fee: {
    label: "Flat fee",
    help: "A fixed charge, billed once or on a recurring period.",
  },
  capacity_commitment: {
    label: PRICING_COMPONENT_BADGE_VARIANTS.capacity_commitment.label,
    help: "A billed quantity floor — the customer is billed for at least this quantity, even when they use less.",
  },
  capacity_motivation: {
    label: PRICING_COMPONENT_BADGE_VARIANTS.capacity_motivation.label,
    help: "A graduated per-unit discount schedule above a target quantity.",
  },
};

// pm54-spec I1 (new, client leaf). No accent-filled treatment (§4.9) — a
// plain radio list, badge label + one line of help per option.
export function ComponentTypePicker({
  value,
  onChange,
  disabled,
}: ComponentTypePickerProps): React.JSX.Element {
  return (
    <RadioGroup
      className="grid gap-2"
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as ComponentType)}
    >
      {COMPONENT_TYPES.map((type) => {
        const option = COMPONENT_TYPE_OPTIONS[type];
        const inputId = `component-type-${type}`;
        const helpId = `${inputId}-help`;
        return (
          <div
            key={type}
            className="rounded-[var(--radius)] border border-[color:var(--border-default)] p-2 text-body-sm has-[:disabled]:opacity-60"
          >
            {/* The help text sits outside <label> so it stays out of the
                radio's accessible NAME (badge label only) while still being
                announced as its accessible DESCRIPTION via aria-describedby. */}
            <div className="flex items-start gap-2">
              <RadioGroupItem
                id={inputId}
                value={type}
                aria-describedby={helpId}
              />
              <label htmlFor={inputId} className="font-medium text-foreground">
                {option.label}
              </label>
            </div>
            <p
              id={helpId}
              className="mt-0.5 pl-6 text-caption text-muted-foreground"
            >
              {option.help}
            </p>
          </div>
        );
      })}
    </RadioGroup>
  );
}
