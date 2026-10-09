import Link from "next/link";
import type { Metadata } from "next";
import { Info } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CompanyProfileForm } from "@/components/billing/invoice-settings/company-profile-form";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDatetime } from "@/lib/formatters";
import { getCompanyProfilePage } from "@/services/billing/read/company-profile-settings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { hasLevel } from "@/types/permissions";
import {
  COMPANY_PROFILE_TABS,
  companyProfileSearchParamsSchema,
  type CompanyProfileTab,
} from "@/validation/billing/invoice-settings-search-params.schema";

// bm56-spec §Design D1, code-standards Part 2 Next.js rules 1–2 — the Company
// profile page: a thin RSC (guard → parse → service → components). READ views
// the ACTIVE profile (or the empty state) and its history; EDIT additionally
// sees a DRAFT. `canEdit` is a show/hide gate, never enforcement. No mutation
// here (bm59/bm61).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice Settings — Company profile",
};

const TAB_LABELS: Record<CompanyProfileTab, string> = {
  edit: "Profile",
  history: "Version history",
};

export default async function CompanyProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.READ,
  );
  const { tab, version } = companyProfileSearchParamsSchema.parse(
    await searchParams,
  );
  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.EDIT,
  );

  const { shown, history } = await getCompanyProfilePage({
    version,
    canEdit,
  });
  const locale = await getAppLocale();
  const timezone = getAppTimezone();
  const versionQuery = shown ? `&version=${shown.version}` : "";

  return (
    <div className="space-y-4">
      <InvoiceSettingsTabs active="company-profile" />
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-h2 font-semibold text-foreground">
          Company profile
          {shown ? (
            <>
              {" "}
              <span className="font-mono text-mono">v{shown.version}</span>
            </>
          ) : null}
        </h2>
        {shown ? <TemplateVersionStatusBadge status={shown.status} /> : null}
      </div>

      <nav
        aria-label="Company profile tabs"
        className="flex gap-1 border-b border-border"
      >
        {COMPANY_PROFILE_TABS.map((t) => (
          <Link
            key={t}
            href={`?tab=${t}${versionQuery}`}
            aria-current={tab === t ? "page" : undefined}
            className={
              tab === t
                ? "border-b-2 border-[color:var(--color-primary-500)] px-4 py-2 text-body-sm font-semibold text-foreground"
                : "border-b-2 border-transparent px-4 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {tab === "history" ? (
        <VersionHistoryTable
          kind="profile"
          rows={history}
          shownVersionId={shown ? String(shown.version) : ""}
          locale={locale}
          timezone={timezone}
        />
      ) : shown ? (
        <>
          <p className="text-body-sm text-muted-foreground">
            {shown.meta["meta.activated_at"]
              ? `Activated ${formatDatetime(
                  new Date(shown.meta["meta.activated_at"]),
                  locale,
                  timezone,
                )}${shown.activatedByName ? ` by ${shown.activatedByName}` : ""}`
              : "Not activated yet"}
            {shown.meta["meta.change_note"]
              ? ` — ${shown.meta["meta.change_note"]}`
              : ""}
          </p>
          <CompanyProfileForm
            mode="read"
            fields={shown.fields}
            logoAssetVersionId={shown.logoAssetVersionId}
          />
        </>
      ) : (
        <Alert className="border-[color:var(--color-info-500)] bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]">
          <Info aria-hidden />
          <AlertDescription className="text-[color:var(--color-info-700)]">
            No company profile is active. Invoices are issued without the issuer
            and payment blocks until a profile is activated.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
