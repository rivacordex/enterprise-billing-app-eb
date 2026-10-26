import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CreateTemplateTypeDialog } from "@/components/billing/invoice-settings/create-template-type-dialog";
import { InvoiceSettingsTabs } from "@/components/billing/invoice-settings/invoice-settings-tabs";
import { TemplateTypeList } from "@/components/billing/invoice-settings/template-type-list";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
import {
  getStandardTemplateTypeId,
  listTemplateTypes,
} from "@/services/billing/read/invoice-template-settings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { hasLevel } from "@/types/permissions";

// bm77-spec §7 (code-standards › Invoice Template Types, Next.js rule 3) — the
// invoice template TYPE list: a thin RSC (guard → services → components).
// READ sees every type; EDIT also gets "New invoice template type" (show/hide
// only — the create action re-checks EDIT). Each type's editor lives on its
// detail page, `[typeId]`. An old bookmark of the single-template page
// (`?tab=` / `?version=`) redirects to Standard's detail page with the same
// query.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice Settings — Invoice template types",
};

const DETAIL_BASE = "/administration/invoice-settings/invoice-template";

export default async function InvoiceTemplateTypesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.READ,
  );
  const params = await searchParams;
  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.EDIT,
  );

  if (params.tab !== undefined || params.version !== undefined) {
    const standardId = await getStandardTemplateTypeId();
    if (standardId !== null) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v !== undefined) query.append(key, v);
        }
      }
      redirect(`${DETAIL_BASE}/${standardId}?${query.toString()}`);
    }
  }

  const rows = await listTemplateTypes();

  return (
    <div className="space-y-4">
      <InvoiceSettingsTabs active="invoice-template" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-h2 font-semibold text-foreground">
          {TEMPLATE_TYPE_MESSAGES.listHeading}
        </h2>
        {canEdit ? <CreateTemplateTypeDialog /> : null}
      </div>
      <TemplateTypeList
        rows={rows}
        showRetired={params.retired === "1"}
        locale={await getAppLocale()}
        timezone={getAppTimezone()}
      />
    </div>
  );
}
