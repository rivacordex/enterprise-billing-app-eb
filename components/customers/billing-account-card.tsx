// cm20 / cm23 (custmgmt-ui-context §9.2/§10.1) — one card per BAN: id, name,
// state, bill cycle, resolved payment term, live receivable and the invoice
// template type label. The label is a reference, not a status: no badge
// color, except the warning treatment for a type that isn't usable (§10.1).

import { AlertTriangle, FileText } from "lucide-react";

import { AmountCell } from "@/components/accounts/amount-cell";
import { BanStateChip } from "@/components/customers/ban-state-chip";
import { TEMPLATE_TYPE_FIELD_LABEL } from "@/components/customers/billing-account-messages";
import { cn } from "@/lib/utils";
import type { AccountState, BanTemplateLabel } from "@/types/accounts";

export interface BillingAccountCardProps {
  billingAccountId: string;
  name: string;
  state: AccountState;
  billCycleName: string;
  paymentTermDays: number;
  receivableBalance: string;
  currency: string;
  templateLabel: BanTemplateLabel;
}

// §10.1 typography: muted caption field label, the type name, then " · " and
// `v{N}` in mono, or "· not usable" in the warning family with an icon. Built
// from the structured label, never by parsing `text` (code-standards §10 TS
// rule 3). Shared with the Manage Customer Billing account panel.
export function TemplateLabel({
  label,
}: {
  label: BanTemplateLabel;
}): React.JSX.Element {
  return (
    <p
      aria-label={label.text}
      className="flex flex-wrap items-start gap-1.5 text-body-sm text-[color:var(--text-body)]"
    >
      <FileText
        size={14}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[color:var(--color-neutral-600)]"
      />
      <span className="text-caption text-[color:var(--text-muted)]">
        {TEMPLATE_TYPE_FIELD_LABEL}
      </span>
      <span>
        {label.name}
        {label.versionNo !== null && (
          <>
            {" · "}
            <span className="font-mono">v{label.versionNo}</span>
          </>
        )}
      </span>
      {label.kind === "NOT_USABLE" && (
        <span className="inline-flex items-center gap-1 text-[color:var(--color-warning-700)]">
          <AlertTriangle
            size={14}
            aria-hidden="true"
            className="shrink-0 text-[color:var(--color-warning-500)]"
          />
          · not usable
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
