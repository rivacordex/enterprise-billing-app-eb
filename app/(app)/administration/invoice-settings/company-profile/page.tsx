import Link from "next/link";
import type { Metadata } from "next";
import { Info } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CreateDraftButton } from "@/components/billing/invoice-settings/company-profile-edit-form";
import { CompanyProfileForm } from "@/components/billing/invoice-settings/company-profile-form";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDatetime, formatRelativeTime } from "@/lib/formatters";
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
// here: bm59's Save draft is a Server Action that re-checks EDIT itself.
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

  const { shown, history, draft } = await getCompanyProfilePage({
    version,
    canEdit,
  });
  // bm59 D3 — EDIT users edit the working DRAFT, or (with no draft) the ACTIVE
  // values; while a draft exists it is the only editable version, so a save
  // can never silently replace it with another version's content (the bm57
  // owner decision). Other versions stay read-only.
  const shownIsDraft = shown !== null && shown.status === "DRAFT";
  const editable =
    canEdit && (shownIsDraft || (!draft && shown?.status === "ACTIVE"));
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
          {canEdit && draft && !shownIsDraft ? (
            <p
              role="status"
              className="inline-flex flex-wrap items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
            >
              <Info size={14} aria-hidden />
              This version is read-only while a working draft exists.
              <Link href="?tab=edit" className="font-semibold underline">
                Edit draft v{draft.version}
              </Link>
            </p>
          ) : null}
          {shownIsDraft && draft ? (
            <p
              role="status"
              className="inline-flex items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
            >
              <Info size={14} aria-hidden />
              Editing draft v{draft.version} — saved{" "}
              {formatRelativeTime(draft.savedAt)}
              {draft.savedBy ? ` by ${draft.savedBy}` : ""}. Drafts are never
              used on invoices.
            </p>
          ) : null}
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
            // A fresh form per shown version AND per draft token: after a
            // save, or "Reload" on a DRAFT_CONFLICT, the page re-renders with
            // the newer token and the form reloads from it.
            key={`${shown.version}:${draft?.token ?? "none"}`}
            mode={editable ? "edit" : "read"}
            fields={shown.fields}
            logoAssetVersionId={shown.logoAssetVersionId}
            expectedDraftToken={draft?.token ?? null}
          />
        </>
      ) : (
        <>
          <Alert className="border-[color:var(--color-info-500)] bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]">
            <Info aria-hidden />
            <AlertDescription className="text-[color:var(--color-info-700)]">
              No company profile is active. Invoices are issued without the
              issuer and payment blocks until a profile is activated.
            </AlertDescription>
            {canEdit ? (
              <div className="col-start-2 mt-2">
                <CreateDraftButton />
              </div>
            ) : null}
          </Alert>
          {canEdit ? (
            <CompanyProfileForm
              key="none"
              mode="edit"
              fields={{}}
              logoAssetVersionId={null}
              expectedDraftToken={null}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
