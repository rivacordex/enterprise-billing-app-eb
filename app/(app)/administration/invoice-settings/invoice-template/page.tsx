import Link from "next/link";
import type { Metadata } from "next";
import { AlertTriangle, Info } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { GeneratedHbsViewer } from "@/components/billing/invoice-settings/generated-hbs-viewer";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { InvoiceStructureForm } from "@/components/billing/invoice-settings/invoice-structure-form";
import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  getGeneratedHbsSources,
  getInvoiceTemplatePageData,
  listRecentPostedBills,
} from "@/services/billing/read/invoice-template-settings";
import { formatRelativeTime } from "@/lib/formatters";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import type { TemplateVersionStatus } from "@/types/billing";
import { hasLevel } from "@/types/permissions";
import {
  INVOICE_TEMPLATE_TABS,
  invoiceTemplateSearchParamsSchema,
  type InvoiceTemplateTab,
} from "@/validation/billing/invoice-settings-search-params.schema";

// bm55-spec §Design D4, code-standards Part 2 Next.js rules 1–2 — the Invoice
// template page: a thin RSC (guard → parse → services → components). READ
// views everything (form read-only, preview, Generated .hbs, history); EDIT
// only makes the form editable — `canEdit` is a show/hide gate, never
// enforcement. Save draft (bm57) and Activate (bm58) are server actions that re-check EDIT.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice Settings — Invoice template",
};

const TAB_LABELS: Record<InvoiceTemplateTab, string> = {
  edit: "Structure & preview",
  generated: "Generated .hbs",
  history: "Version history",
};

export default async function InvoiceTemplatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.READ,
  );
  const { tab, version } = invoiceTemplateSearchParamsSchema.parse(
    await searchParams,
  );

  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.EDIT,
  );
  const canPreviewBills = hasLevel(
    permissionMap,
    PERMISSIONS.BILLRUN_VIEW,
    LEVELS.READ,
  );

  const data = await getInvoiceTemplatePageData(version, { canEdit });
  const { current, draft } = data;
  // The version opened by default is the working DRAFT for an EDIT user who
  // has one (bm57 D4), else the current version. The Generated .hbs tab is the
  // exception: a DRAFT has no files, so without an explicit `?version=` it
  // keeps showing the current version's files (as it did before drafts).
  const onGenerated = tab === "generated";
  const defaultShown = onGenerated ? current : data.defaultShown;
  const shown = onGenerated && version === undefined ? current : data.shown;
  const viewingOther =
    shown.billTemplateVersionId !== defaultShown.billTemplateVersionId;
  const shownIsDraft = shown.status === "DRAFT";
  const versionQuery = viewingOther
    ? `&version=${shown.billTemplateVersionId}`
    : "";

  return (
    <div className="space-y-4">
      <InvoiceSettingsTabs active="invoice-template" />
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-h2 font-semibold text-foreground">
          Invoice template{" "}
          <span className="font-mono text-mono">v{shown.versionNo}</span>
        </h2>
        <TemplateVersionStatusBadge
          status={shown.status as TemplateVersionStatus}
          isDefault={shown.isDefault}
        />
        {viewingOther ? (
          <Link
            href="?tab=edit"
            className="text-body-sm font-medium text-[color:var(--action-primary-bg)] hover:underline"
          >
            Back to the {draft ? "working draft" : "current version"} (v
            {defaultShown.versionNo})
          </Link>
        ) : null}
      </div>

      <nav
        aria-label="Invoice template tabs"
        className="flex gap-1 border-b border-border"
      >
        {INVOICE_TEMPLATE_TABS.map((t) => (
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

      {tab === "edit" && canEdit && draft && !shownIsDraft ? (
        <p
          role="status"
          className="inline-flex flex-wrap items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
        >
          <Info size={14} aria-hidden />
          This version is read-only while a working draft exists.
          <Link href="?tab=edit" className="font-semibold underline">
            Edit draft v{draft.versionNo}
          </Link>
        </p>
      ) : null}

      {tab === "edit" && shownIsDraft && draft ? (
        <p
          role="status"
          className="inline-flex items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
        >
          <Info size={14} aria-hidden />
          Editing draft v{draft.versionNo} — saved{" "}
          {formatRelativeTime(draft.savedAt)}
          {draft.savedBy ? ` by ${draft.savedBy}` : ""}. Drafts are never used
          on invoices.
        </p>
      ) : null}

      {tab === "edit" ? (
        <InvoiceStructureForm
          // A fresh form (and preview) per shown version AND per draft token:
          // after a save, or after "Reload" on a DRAFT_CONFLICT, the page
          // re-renders with the newer token and the form must reload from it
          // instead of keeping its stale local state.
          key={`${shown.billTemplateVersionId}:${draft?.token ?? "none"}`}
          initialStructure={data.shownStructure}
          // While a working draft exists it is the only editable version, so
          // a save can never silently replace it with another version's
          // content (the token below is the draft's).
          editable={
            canEdit &&
            (shownIsDraft ||
              (!draft &&
                shown.billTemplateVersionId === current.billTemplateVersionId))
          }
          expectedDraftToken={draft?.token ?? null}
          draftVersionId={draft?.billTemplateVersionId ?? null}
          draftVersionNo={draft?.versionNo ?? null}
          activeStructure={current.structure}
          canPreviewBills={canPreviewBills}
          recentBills={canPreviewBills ? await listRecentPostedBills() : []}
        />
      ) : tab === "generated" ? (
        await renderGenerated(shown)
      ) : (
        <VersionHistoryTable
          rows={data.history}
          shownVersionId={shown.billTemplateVersionId}
          canViewDrafts={canEdit}
          locale={await getAppLocale()}
          timezone={getAppTimezone()}
        />
      )}
    </div>
  );
}

async function renderGenerated(
  shown: Awaited<ReturnType<typeof getInvoiceTemplatePageData>>["shown"],
): Promise<React.JSX.Element> {
  if (shown.status === "DRAFT") {
    // A DRAFT has no generated files until it is activated (bm58).
    return (
      <Alert>
        <Info aria-hidden />
        <AlertDescription>
          A draft has no generated files yet. They are written when it is
          activated.
        </AlertDescription>
      </Alert>
    );
  }
  const sources = await getGeneratedHbsSources(shown);
  if (!sources.ok) {
    // Inv #45 — unverified bytes are never shown.
    return (
      <Alert variant="destructive">
        <AlertTriangle aria-hidden />
        <AlertTitle>The stored template files failed verification.</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-mono">{sources.code}</span>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <GeneratedHbsViewer
      versionId={shown.billTemplateVersionId}
      versionNo={shown.versionNo}
      invoiceHbs={sources.invoiceHbs}
      footerHbs={sources.footerHbs}
    />
  );
}
