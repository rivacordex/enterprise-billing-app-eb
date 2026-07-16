import { OrganizationStatusBadge } from "@/components/customers/organization-status-badge";
import { OrganizationTypeBadge } from "@/components/customers/organization-type-badge";
import { formatDatetime } from "@/lib/formatters";
import type { OrganizationDetail } from "@/types/customer";

export interface OrganizationSectionProps {
  organization: OrganizationDetail;
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

export function OrganizationSection({
  organization,
  locale,
  timezone,
}: OrganizationSectionProps): React.JSX.Element {
  return (
    <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
      <h2 className="text-h3 font-semibold text-foreground">
        Party – Organization
      </h2>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Name">{organization.name}</Field>
        <Field label="Trading Name">{organization.tradingName ?? "—"}</Field>
        <Field label="Type">
          <OrganizationTypeBadge
            organizationType={organization.organizationType}
          />
        </Field>
        <Field label="Registration Number">
          {organization.registrationNumber ? (
            <span className="font-mono">{organization.registrationNumber}</span>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Tax ID">{organization.taxId ?? "—"}</Field>
        <Field label="Industry">{organization.industry ?? "—"}</Field>
        <Field label="Status">
          <OrganizationStatusBadge status={organization.status} />
        </Field>
        <Field label="Status Reason">{organization.statusReason ?? "—"}</Field>
        <Field label="Last Modified By">
          {organization.lastModifiedByName}
        </Field>
        <Field label="Last Modified">
          {formatDatetime(organization.lastModifiedDatetime, locale, timezone)}
        </Field>
      </dl>
    </section>
  );
}
