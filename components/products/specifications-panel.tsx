import { Asterisk, ListChecks, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { SpecificationCard } from "@/types/product";

function characteristicText(value: string): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type SpecificationsPanelProps = {
  specifications: SpecificationCard[];
};

function SpecBadge({
  icon: Icon,
  label,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  tone: "info" | "neutral";
}): React.JSX.Element {
  return (
    <span
      className={
        tone === "info"
          ? "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-info-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-info-700)] uppercase"
          : "inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase"
      }
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

function specBadges(spec: SpecificationCard): React.JSX.Element[] {
  const badges: React.JSX.Element[] = [];

  if (spec.isMandatory) {
    badges.push(
      <SpecBadge
        key="mandatory"
        icon={Asterisk}
        label="Mandatory"
        tone="info"
      />,
    );
  }

  if (spec.isDefault) {
    badges.push(
      <SpecBadge key="default" icon={Star} label="Default" tone="neutral" />,
    );
  }

  return badges;
}

export function SpecificationsPanel({
  specifications,
}: SpecificationsPanelProps): React.JSX.Element {
  if (specifications.length === 0) {
    return (
      <div className="mt-2 rounded-md bg-[color:var(--surface-sunken)] p-6 text-center">
        <ListChecks
          className="mx-auto mb-2 size-8 text-[color:var(--text-muted)]"
          aria-hidden="true"
        />
        <p className="text-body-sm text-muted-foreground">
          No specifications for this offering.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {specifications.map((spec) => {
        const characteristicEntries = Object.entries(spec.characteristics);

        return (
          <div
            key={spec.productSpecId}
            className="rounded-md border border-[color:var(--border-subtle)] p-2"
          >
            <p className="font-mono text-overline text-muted-foreground tabular-nums">
              {spec.productSpecId}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-body font-semibold text-foreground">
                {spec.name}
              </span>
              {specBadges(spec)}
            </div>

            {spec.defaultValue !== null ? (
              <div className="mt-1.5">
                <p className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Default value
                </p>
                <p className="mt-0.5 text-body text-foreground">
                  {spec.defaultValue}
                </p>
              </div>
            ) : null}

            {characteristicEntries.length > 0 ? (
              <p className="mt-1.5 text-body-sm text-foreground">
                {characteristicEntries.map(([chKey, value], index) => (
                  <span key={chKey}>
                    {index > 0 ? ", " : null}
                    <span className="text-muted-foreground">{chKey}</span>
                    {": "}
                    <span className="font-mono tabular-nums">
                      {characteristicText(value)}
                    </span>
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
