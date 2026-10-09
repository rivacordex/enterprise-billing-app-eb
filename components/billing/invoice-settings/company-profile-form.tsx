// bm56-spec §Design D1, ui-context §10b ("Read-only view") — the company
// profile form. bm56 wires READ MODE ONLY: four groups of plain text (no
// disabled-input grey wash), blank optional fields as "—", colour swatches and
// the logo preview served by the session-guarded GET route. The `mode` prop
// exists so bm59 adds the editable rendering without reshaping the component;
// until then `'edit'` renders the same read view (nothing is writable here).
// A SERVER component — no state, no handlers.

import { MYINVOIS_STATE_LABELS, COUNTRY_LABELS } from "@/lib/myinvois-states";
import { cn } from "@/lib/utils";
import type { InvoiceProfileView } from "@/types/billing";

export const COMPANY_PROFILE_LOGO_BASE =
  "/administration/invoice-settings/company-profile/logo";

export interface CompanyProfileFormProps {
  mode?: "read" | "edit";
  fields: InvoiceProfileView;
  logoAssetVersionId: string | null;
}

const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const MUTED = "text-[color:var(--text-muted)]";

function Blank(): React.JSX.Element {
  return <span className={MUTED}>—</span>;
}

function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "text-body text-foreground",
          mono && "font-mono text-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-4 rounded-none border border-border bg-card p-4">
      <h3 className="text-h3 font-semibold text-foreground">{title}</h3>
      <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Colour({ value }: { value: string | null }): React.JSX.Element {
  if (!value) return <Blank />;
  return (
    <span className="inline-flex items-center gap-2">
      {COLOUR_RE.test(value) ? (
        <svg
          aria-hidden
          data-testid="colour-swatch"
          width={20}
          height={20}
          viewBox="0 0 20 20"
          className="shrink-0 rounded-xs border border-[color:var(--border-default)]"
        >
          <rect width={20} height={20} fill={value} />
        </svg>
      ) : null}
      {value}
    </span>
  );
}

export function CompanyProfileForm({
  fields,
  logoAssetVersionId,
}: CompanyProfileFormProps): React.JSX.Element {
  const text = (key: string): React.ReactNode => {
    const value = fields[key];
    return value ? value : <Blank />;
  };

  const stateCode = fields.state_code;
  const stateLabel = stateCode
    ? (MYINVOIS_STATE_LABELS[stateCode] ?? stateCode)
    : null;
  const countryCode = fields.country_code;
  const countryLabel = countryCode
    ? (COUNTRY_LABELS[countryCode] ?? countryCode)
    : null;
  const addressLines = [
    fields.address_line1,
    fields.address_line2,
    [fields.postcode, fields.city].filter(Boolean).join(" "),
    stateLabel,
    countryLabel,
  ].filter((line): line is string => Boolean(line));

  return (
    <div className="space-y-4">
      <Group title="Company">
        <Field label="Legal name">{text("company_name")}</Field>
        <Field label="SSM registration no." mono>
          {text("registration_no")}
        </Field>
        <Field label="TIN" mono>
          {text("tin")}
        </Field>
        <Field label="SST registration no." mono>
          {text("sst_reg_no")}
        </Field>
        <Field label="Address">
          {addressLines.length > 0 ? (
            addressLines.map((line, i) => <div key={i}>{line}</div>)
          ) : (
            <Blank />
          )}
        </Field>
        <Field label="Contact">
          <div>{text("phone")}</div>
          <div>{text("email")}</div>
          <div>{text("website")}</div>
        </Field>
      </Group>

      <Group title="Payment">
        <Field label="Bank">{text("bank_name")}</Field>
        <Field label="Account name">{text("bank_account_name")}</Field>
        <Field label="Account no." mono>
          {text("bank_account_no")}
        </Field>
        <Field label="SWIFT" mono>
          {text("swift")}
        </Field>
        <Field label="JomPAY biller code" mono>
          {text("jompay_biller_code")}
        </Field>
        <Field label="Remittance email">{text("remittance_email")}</Field>
      </Group>

      <Group title="Branding">
        <Field label="Brand colour" mono>
          <Colour value={fields.brand_color ?? null} />
        </Field>
        <Field label="Accent colour" mono>
          <Colour value={fields.accent_color ?? null} />
        </Field>
        <Field label="Logo">
          {logoAssetVersionId ? (
            // eslint-disable-next-line @next/next/no-img-element -- the logo is served by the session-guarded GET route (bm56 D3); next/image would proxy it past the route's CSP/no-store headers.
            <img
              src={`${COMPANY_PROFILE_LOGO_BASE}/${logoAssetVersionId}`}
              alt="Company logo"
              className="max-h-20 max-w-[240px] border border-[color:var(--border-subtle)] bg-white p-1"
            />
          ) : (
            <Blank />
          )}
        </Field>
      </Group>

      <Group title="Defaults">
        <Field label="Payment terms (days)">{text("payment_terms_days")}</Field>
      </Group>
    </div>
  );
}
