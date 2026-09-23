import { AlertTriangle } from "lucide-react";

import { PRICING_COMPONENT_BADGE_VARIANTS } from "@/components/products/pricing-component-badge";
import type { ComponentType, UnitOfMeasure } from "@/types/product";

// pm54-spec D4/I3. The offering-level (cross-component) refusal — VI3–VI5,
// pm49's `validateOfferingComponents` — rendered from the server's typed
// result and nothing else (§3.13): this component takes the action result as
// input and has no validation logic of its own. `componentType` (and, for
// AMBIGUOUS_BASE_RATE, `unitOfMeasure`) are supplied by the caller from the
// write it just attempted (the submitted form's own branch/unit, or the row
// being deleted) — pm49's action result itself doesn't carry them for every
// code, and this is reading back what was just submitted, never re-deriving
// or re-evaluating the VI3–VI5 rule client-side.
export type OfferingComponentBannerViolation =
  | {
      code: "MODIFIER_WITHOUT_BASE_RATE";
      unitOfMeasure: UnitOfMeasure;
      componentType: Extract<
        ComponentType,
        "capacity_commitment" | "capacity_motivation"
      >;
    }
  | { code: "AMBIGUOUS_BASE_RATE"; unitOfMeasure: UnitOfMeasure }
  | {
      code: "CURRENCY_MISMATCH";
      existingCurrency: string;
      candidateCurrency: string;
    };

export interface OfferingComponentErrorBannerProps {
  violation: OfferingComponentBannerViolation | null;
}

// D4's copy table — one entry per code, keyed off the code names (binding,
// §7.8). Names the missing counterpart, never the rule name.
function copyFor(violation: OfferingComponentBannerViolation): string {
  switch (violation.code) {
    case "MODIFIER_WITHOUT_BASE_RATE": {
      const label =
        PRICING_COMPONENT_BADGE_VARIANTS[violation.componentType].label;
      return `${label} needs a base usage rate in ${violation.unitOfMeasure}. Add one before saving.`;
    }
    case "AMBIGUOUS_BASE_RATE":
      return `This offering already has a usage rate in ${violation.unitOfMeasure} effective on that date. Change the start date or edit the existing rate.`;
    case "CURRENCY_MISMATCH":
      return `This offering's components are priced in ${violation.existingCurrency}. ${violation.candidateCurrency} cannot be mixed in.`;
  }
}

// pm54-spec D4. Danger role, `alert-triangle`, panel-level (not a
// `FieldError` — there is no field to attach to). Deliberately not the
// warning tint (§4), which would understate a rule that blocks the save.
export function OfferingComponentErrorBanner({
  violation,
}: OfferingComponentErrorBannerProps): React.JSX.Element | null {
  if (violation === null) return null;

  return (
    <div
      role="alert"
      className="mb-2 flex items-start gap-2 rounded-[var(--radius)] bg-[color:var(--bg-danger)] px-3 py-2 text-body-sm text-[color:var(--text-danger)]"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{copyFor(violation)}</span>
    </div>
  );
}
