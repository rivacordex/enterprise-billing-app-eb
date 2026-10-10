// bm55-spec §Design D4 — the Invoice Settings shell's tab strip. A server
// component of plain `<Link>`s (the run-detail-tabs precedent: navigation
// only, no client state). The tab list is data: bm55 ships "Invoice template"
// only; bm56 appends "Company profile" here. A layout never sees the current
// path, so with one tab it is always the current one; bm56 must pass the
// active tab once a second one exists.

import Link from "next/link";

export const INVOICE_SETTINGS_TABS = [
  {
    key: "company-profile",
    label: "Company profile",
    href: "/administration/invoice-settings/company-profile",
  },
  {
    key: "invoice-template",
    label: "Invoice template",
    href: "/administration/invoice-settings/invoice-template",
  },
] as const;

export type InvoiceSettingsTabKey =
  (typeof INVOICE_SETTINGS_TABS)[number]["key"];

export interface InvoiceSettingsTabsProps {
  active: InvoiceSettingsTabKey;
}

export function InvoiceSettingsTabs({
  active,
}: InvoiceSettingsTabsProps): React.JSX.Element {
  return (
    <nav
      aria-label="Invoice Settings sections"
      className="flex gap-1 border-b border-border"
    >
      {INVOICE_SETTINGS_TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "border-b-2 border-[color:var(--color-primary-500)] px-4 py-2 text-body-sm font-semibold text-foreground"
                : "border-b-2 border-transparent px-4 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
