import { formatDatetime } from "@/lib/formatters";
import type { EffectivityStatus, PriceCard } from "@/types/product";

// Shared price-effectivity presentation (pm41 review #8). The read-only
// PricesPanel and Manage Products' inline price editor both render the same
// derived state — a future price's "Starts <date>" tag, a superseded price's
// "Superseded" tag, the current price's cyan left border and the superseded
// muting — so the signal must not drift between the read and edit surfaces
// (spec D1). Extracted here (rather than duplicated) and imported by both;
// this is a read-only presentational leaf, so View importing it stays within
// the read surface.

export function PriceEffectivityTag({
  price,
  locale,
  timezone,
}: {
  price: Pick<PriceCard, "effectivityStatus" | "startDateTime">;
  locale: string;
  timezone: string;
}): React.JSX.Element | null {
  if (price.effectivityStatus === "future") {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-xs)] bg-[color:var(--color-info-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-info-700)] uppercase">
        {`Starts ${formatDatetime(price.startDateTime, locale, timezone)}`}
      </span>
    );
  }

  if (price.effectivityStatus === "superseded") {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase">
        Superseded
      </span>
    );
  }

  return null;
}

// The status-dependent accent applied to a price card/row: the current price
// carries a cyan left border (a functional "live" marker, ui-context §4), a
// superseded price is muted. Returned as a className fragment so each surface
// keeps its own base (card padding vs list-row divider).
export function effectivityAccentClass(status: EffectivityStatus): string {
  if (status === "current") {
    return "border-l-4 border-l-[color:var(--color-cyan-500)]";
  }
  if (status === "superseded") {
    return "text-muted-foreground";
  }
  return "";
}
