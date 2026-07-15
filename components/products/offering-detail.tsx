import { AlertTriangle, Boxes, Receipt, ShoppingCart } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { formatDatetime } from "@/lib/formatters";
import type { OfferingDetail as OfferingDetailModel } from "@/types/product";

type OfferingDetailProps = {
  offering: OfferingDetailModel;
  locale: string;
  timezone: string;
};

function FlagChip({
  icon: Icon,
  label,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  tone?: "neutral" | "warning";
}): React.JSX.Element {
  return (
    <span
      className={
        tone === "warning"
          ? "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase"
          : "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase"
      }
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

function offeringFlagChips(offering: OfferingDetailModel): React.JSX.Element[] {
  const chips: React.JSX.Element[] = [];

  if (offering.isBundle) {
    chips.push(<FlagChip key="bundle" icon={Boxes} label="Bundle" />);
  }

  if (offering.isSellable) {
    chips.push(
      <FlagChip key="sellable" icon={ShoppingCart} label="Sellable" />,
    );
  } else if (offering.lifecycleStatus === "ACTIVE") {
    chips.push(
      <FlagChip
        key="not-sellable"
        icon={AlertTriangle}
        label="Not sellable"
        tone="warning"
      />,
    );
  }

  if (offering.billingOnly) {
    chips.push(
      <FlagChip key="billing-only" icon={Receipt} label="Billing only" />,
    );
  }

  return chips;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-body text-foreground">{children}</dd>
    </div>
  );
}

export function OfferingDetail({
  offering,
  locale,
  timezone,
}: OfferingDetailProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-mono text-mono text-muted-foreground tabular-nums">
          {offering.productOfferingId}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-h3 font-semibold text-foreground">
            {offering.name}
          </span>
          <LifecycleBadge status={offering.lifecycleStatus} />
          {offeringFlagChips(offering)}
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-[color:var(--border-subtle)] pt-3">
        <Field label="Version">
          <span className="font-mono tabular-nums">{offering.version}</span>
        </Field>
        <Field label="Last Modified">
          <span className="whitespace-nowrap">
            {formatDatetime(offering.lastModified, locale, timezone)}
          </span>
        </Field>
        <Field label="Last Edited By">{offering.lastEditedByName ?? "—"}</Field>
      </dl>
    </div>
  );
}
