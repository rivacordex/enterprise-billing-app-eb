// cm20 (custmgmt-ui-context §9.2/§9.4) — one card per BAN: id, name, state,
// bill cycle, resolved payment term, live receivable and the invoice-template
// label. The label is a reference, not a status: no badge color (§9.4).

import { FileText } from "lucide-react";

import { AmountCell } from "@/components/accounts/amount-cell";
import { BanStateChip } from "@/components/customers/ban-state-chip";
import { cn } from "@/lib/utils";
import type { AccountState } from "@/types/accounts";

export interface BillingAccountCardProps {
  billingAccountId: string;
  name: string;
  state: AccountState;
  billCycleName: string;
  paymentTermDays: number;
  receivableBalance: string;
  currency: string;
  templateLabel: string;
}

const FOLLOWS_LABEL =
  /^Follows active template \(currently: (.+) (v\d+)\), as of now$/;

// §9.4 typography: "vN" in mono, "as of now" muted caption. The rendered text
// stays identical to the service's label.
function TemplateLabel({ label }: { label: string }): React.JSX.Element {
  const match = FOLLOWS_LABEL.exec(label);
  return (
    <p className="flex items-start gap-1.5 text-body-sm text-[color:var(--text-body)]">
      <FileText
        size={14}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[color:var(--color-neutral-600)]"
      />
      {match === null ? (
        <span>{label}</span>
      ) : (
        <span>
          Follows active template (currently: {match[1]}{" "}
          <span className="font-mono">{match[2]}</span>),{" "}
          <span className="text-caption text-[color:var(--text-muted)]">
            as of now
          </span>
        </span>
      )}
    </p>
  );
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

export function BillingAccountCard({
  billingAccountId,
  name,
  state,
  billCycleName,
  paymentTermDays,
  receivableBalance,
  currency,
  templateLabel,
}: BillingAccountCardProps): React.JSX.Element {
  return (
    <section
      aria-label={`Billing account ${billingAccountId}`}
      className={cn(
        "rounded-md border border-border bg-[color:var(--surface-card)] p-4",
        state === "closed" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-h3 font-semibold text-foreground">
          <span className="font-mono text-mono">{billingAccountId}</span>
          <span className="text-muted-foreground"> · {name}</span>
        </h3>
        <BanStateChip state={state} />
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Field label="Bill cycle">{billCycleName}</Field>
        <Field label="Payment term">{paymentTermDays} days</Field>
        <Field label="Receivable">
          <AmountCell
            amount={receivableBalance}
            currency={currency}
            className="text-left"
          />
        </Field>
      </dl>
      <div className="mt-3">
        <TemplateLabel label={templateLabel} />
      </div>
    </section>
  );
}
