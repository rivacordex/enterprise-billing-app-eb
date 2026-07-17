import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { formatDatetime } from "@/lib/formatters";
import type { CustomerRoleDetail } from "@/types/customer";

export interface CustomerRoleSectionProps {
  customerRole: CustomerRoleDetail;
  locale: string;
  timezone: string;
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

export function CustomerRoleSection({
  customerRole,
  locale,
  timezone,
}: CustomerRoleSectionProps): React.JSX.Element {
  return (
    <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
      <h2 className="text-h3 font-semibold text-foreground">Role – Customer</h2>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Customer ID">
          <span className="font-mono">{customerRole.partyRoleId}</span>
        </Field>
        <Field label="Status">
          <CustomerStatusBadge status={customerRole.status} />
        </Field>
        <Field label="Status Reason">{customerRole.statusReason ?? "—"}</Field>
        <Field label="Account">{customerRole.account ?? "—"}</Field>
      </dl>

      <dl className="mt-4">
        <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
          Specification
        </dt>
        <dd>
          <pre className="mt-0.5 overflow-x-auto rounded-md border border-border bg-[color:var(--surface-sunken)] p-3 font-mono text-body-sm">
            {JSON.stringify(customerRole.specification, null, 2)}
          </pre>
        </dd>
      </dl>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Last Modified By">
          {customerRole.lastModifiedByName}
        </Field>
        <Field label="Last Modified">
          {formatDatetime(customerRole.lastModifiedDatetime, locale, timezone)}
        </Field>
      </dl>
    </section>
  );
}
