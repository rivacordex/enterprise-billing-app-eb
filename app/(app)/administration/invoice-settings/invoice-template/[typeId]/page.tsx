import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertTriangle, Info } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { GeneratedHbsViewer } from "@/components/billing/invoice-settings/generated-hbs-viewer";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { InvoiceStructureForm } from "@/components/billing/invoice-settings/invoice-structure-form";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
import { UploadLayoutDialog } from "@/components/billing/invoice-settings/upload-layout-dialog";
import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  getGeneratedHbsSources,
  getInvoiceTemplatePageData,
  listRecentPostedBills,
  type InvoiceTemplateEditorData,
} from "@/services/billing/read/invoice-template-settings";
import { formatRelativeTime } from "@/lib/formatters";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { hasLevel } from "@/types/permissions";
import {
  INVOICE_TEMPLATE_TABS,
  invoiceTemplateSearchParamsSchema,
  templateTypeIdParamSchema,
  type InvoiceTemplateTab,
} from "@/validation/billing/invoice-settings-search-params.schema";

// bm55-spec §Design D4, code-standards Part 2 Next.js rules 1–2 — an invoice
// template TYPE's detail page (bm77, code-standards › Invoice Template Types
// Next.js rule 3): a thin RSC (guard → parse → services → components). The
// type comes from the `[typeId]` segment, never the default. READ views
// everything (form read-only, preview, Generated .hbs, history); EDIT only
// makes the form editable — `canEdit` is a show/hide gate, never enforcement.
// Save draft (bm57), Activate (bm58) and Discard (bm79) are server actions that
// re-check EDIT.
// A type with no settings yet ("Not yet usable") shows the empty state; bm78
// adds the Upload button inside it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice Settings — Invoice template type",
};

const TAB_LABELS: Record<InvoiceTemplateTab, string> = {
  edit: "Structure & preview",
  generated: "Generated .hbs",
  history: "Version history",
};

export default async function InvoiceTemplateTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ typeId: string }>;
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

  const typeId = templateTypeIdParamSchema.safeParse((await params).typeId);
  if (!typeId.success) notFound();
  const data = await getInvoiceTemplatePageData(typeId.data, version, {
    canEdit,
  });
  if (!data) notFound();

  // bm78 — EDIT holders upload a layout package to a non-retired type. bm80:
  // over an open layout DRAFT the dialog carries the overwrite warning, built
  // from this server data (Next.js rule 5).
  const canUpload = canEdit && data.typeStatus !== "RETIRED";
  const locale = await getAppLocale();
  const timezone = getAppTimezone();
  const upload = (
    <UploadLayoutDialog
      familyId={data.typeId}
      nextVersionNo={data.nextLayoutVersionNo}
      openLayoutDraft={data.openLayoutDraft}
      locale={locale}
      timezone={timezone}
    />
  );

  const heading = (
    <div className="space-y-2">
      <Link
        href="/administration/invoice-settings/invoice-template"
        className="text-body-sm font-medium text-[color:var(--action-primary-bg)] hover:underline"
      >
        {TEMPLATE_TYPE_MESSAGES.backToList}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-h2 font-semibold text-foreground">
          Invoice template type — {data.typeName}
          {data.isDefaultType ? (
            <>
              {" "}
              <span className="font-normal text-[color:var(--text-muted)]">
                (default)
              </span>
            </>
          ) : null}
        </h2>
        {!data.empty ? (
          <span className="font-mono text-mono text-foreground">
            v
            {
              (tab === "generated" && version === undefined
                ? (data.current ?? data.shown)
                : data.shown
              ).versionNo
            }
          </span>
        ) : null}
        <TemplateVersionStatusBadge
          status={data.typeStatus}
          isDefault={data.isDefaultType}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-body-sm text-muted-foreground">
          Layout code{" "}
          <span className="font-mono text-mono text-foreground">
            {data.layoutCode}
          </span>{" "}
          · Next layout version{" "}
          <span className="font-mono text-mono text-foreground">
            v{data.nextLayoutVersionNo}
          </span>
        </p>
        {canUpload && !data.empty ? upload : null}
      </div>
    </div>
  );

  if (data.empty) {
    // Not yet usable: nothing uploaded. ui-context §10e Info alert; no tabs
    // body. bm78: the Upload trigger sits inside it for EDIT holders.
    return (
      <div className="space-y-4">
        <InvoiceSettingsTabs active="invoice-template" />
        {heading}
        <Alert>
          <Info aria-hidden />
          <AlertDescription className="space-y-3">
            <p>{TEMPLATE_TYPE_MESSAGES.emptyState}</p>
            {canUpload ? upload : null}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { current, draft } = data;
  // The version opened by default is the working DRAFT for an EDIT user who
  // has one (bm57 D4), else the current version. The Generated .hbs tab is the
  // exception: a DRAFT has no files, so without an explicit `?version=` it
  // keeps showing the current version's files (as it did before drafts).
  const onGenerated = tab === "generated";
  // bm78: an uploaded-but-not-activated type has no current version; its
  // Generated tab then shows the draft (which has no files yet).
  const defaultShown = onGenerated
    ? (current ?? data.shown)
    : data.defaultShown;
  const shown =
    onGenerated && version === undefined ? (current ?? data.shown) : data.shown;
  const viewingOther =
    shown.billTemplateVersionId !== defaultShown.billTemplateVersionId;
  const shownIsDraft = shown.status === "DRAFT";
  const versionQuery = viewingOther
    ? `&version=${shown.billTemplateVersionId}`
    : "";

  return (
    <div className="space-y-4">
      <InvoiceSettingsTabs active="invoice-template" />
      {heading}
      <div className="flex flex-wrap items-center gap-3">
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
          // A fresh form (and preview) per version opened from the history.
          // The working copy keeps one form across saves, activations and
          // Reloads: it adopts a newer server draft itself, so the refresh
          // after its own save never remounts it (which would close an
          // Activate dialog opened meanwhile).
          key={viewingOther ? shown.billTemplateVersionId : "working"}
          initialStructure={data.shownStructure}
          // While a working draft exists it is the only editable version, so
          // a save can never silently replace it with another version's
          // content (the token below is the draft's).
          editable={
            canEdit &&
            (shownIsDraft ||
              (!draft &&
                shown.billTemplateVersionId === current?.billTemplateVersionId))
          }
          expectedDraftToken={draft?.token ?? null}
          draftVersionId={draft?.billTemplateVersionId ?? null}
          draftVersionNo={draft?.versionNo ?? null}
          activeStructure={data.currentStructure}
          familyId={data.typeId}
          layoutChange={data.layoutChange}
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
          // bm79 — EDIT on a non-retired type (the upload gate) may discard
          // the DRAFT pair.
          discard={
            canUpload && draft
              ? {
                  familyId: data.typeId,
                  draftId: draft.billTemplateVersionId,
                  draftToken: draft.token,
                  layoutDraft: data.openLayoutDraft
                    ? {
                        code: data.layoutCode,
                        versionNo: data.openLayoutDraft.versionNo,
                      }
                    : null,
                }
              : null
          }
          locale={locale}
          timezone={timezone}
        />
      )}
    </div>
  );
}

async function renderGenerated(
  shown: InvoiceTemplateEditorData["shown"],
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
  if (shown.activatedDatetime === null) {
    // bm79 review fix — a discarded draft was never activated, so it never had
    // generated files (not a verification failure).
    return (
      <Alert>
        <Info aria-hidden />
        <AlertDescription>
          This draft was discarded before it was activated, so it has no
          generated files.
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
