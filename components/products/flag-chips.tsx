import { Receipt, ShoppingCart } from "lucide-react";

import type { LifecycleStatus } from "@/types/product";

// Shared offering flag chips (pm39 review dedup) — used by View Product's
// offerings table and Manage Products' families table so the chip markup lives
// in one place (ui-context §3). No hooks/handlers, so it renders in both server
// and client components.
const CHIP_NEUTRAL =
  "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase";
const CHIP_WARNING =
  "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase";

export interface SellabilityChipProps {
  isSellable: boolean;
  lifecycleStatus: LifecycleStatus;
  // Rendered when the offering is not sellable and not ACTIVE — an em-dash on
  // View Product's table, nothing on Manage Products (each caller's convention).
  emptyFallback?: React.ReactNode;
}

// A false `is_sellable` on an ACTIVE offering is the combination Billing Ops must
// notice, so it shows a warning "Not sellable" chip; false on any other status
// shows `emptyFallback` (ui-context §3).
export function SellabilityChip({
  isSellable,
  lifecycleStatus,
  emptyFallback = null,
}: SellabilityChipProps): React.JSX.Element {
  if (isSellable) {
    return (
      <span className={CHIP_NEUTRAL}>
        <ShoppingCart size={12} aria-hidden="true" />
        Sellable
      </span>
    );
  }
  if (lifecycleStatus === "ACTIVE") {
    return (
      <span className={CHIP_WARNING}>
        <ShoppingCart size={12} aria-hidden="true" />
        Not sellable
      </span>
    );
  }
  return <>{emptyFallback}</>;
}

export function BillingOnlyChip(): React.JSX.Element {
  return (
    <span className={CHIP_NEUTRAL}>
      <Receipt size={12} aria-hidden="true" />
      Billing only
    </span>
  );
}
