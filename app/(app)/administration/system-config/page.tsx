import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ConfigTable } from "@/components/system-config/config-table";
import { CopyRedirectUriButton } from "@/components/system-config/copy-redirect-uri-button";
import { EntraConfigRow } from "@/components/system-config/entra-config-row";
import { entraConfig } from "@/lib/config";
import { groupConfigRows } from "@/lib/formatters";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import { getSystemConfigParams } from "@/services/system-config/system-config-read.service";
import { hasLevel } from "@/types/permissions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System Configuration — Enterprise Billing",
};

// um10 only built the read-only "Entra ID Settings" section (admin-nav's
// link was a 404-until-shipped placeholder since um07). um22 adds the
// DB-sourced "Configuration Parameters" section above it. No `PageHeader`/
// breadcrumb component exists anywhere in the codebase (Users/Roles pages
// have no page-level title either) — deviating from um22-spec's implied
// reuse, this renders a plain `<h1>` instead of inventing that component
// for a single caller.
export default async function SystemConfigPage(): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.SYSTEM_CONFIG,
    LEVELS.READ,
  );

  const rows = await getSystemConfigParams();
  const groups = groupConfigRows(rows);
  const timezone = getAppTimezone();
  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.SYSTEM_CONFIG,
    LEVELS.EDIT,
  );

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-h1 font-semibold text-foreground">
        System Configuration
      </h1>

      <section>
        <h2 className="mb-4 text-h2 font-semibold text-foreground">
          Configuration Parameters
        </h2>
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <ConfigTable groups={groups} canEdit={canEdit} timezone={timezone} />
        </div>
      </section>

      <hr className="border-border" />

      {/* um29-spec §2.9: read-only env-sourced "Application Settings" strip,
          mirroring the Entra ID Settings pattern below. The business timezone
          is env-sourced (APP_TIMEZONE), not a `system_config` row, so it is
          shown read-only and cannot be edited in-app. Gated by the existing
          `system_config:READ` (this page's guard); no new permission. */}
      <section className="max-w-2xl rounded-md bg-card p-6 shadow-sm">
        <h2 className="text-h3 font-semibold text-foreground">
          Application Settings
        </h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Read-only. These values are sourced from environment variables. The
          business timezone governs how datetimes are displayed and how local
          day boundaries (e.g. the Audit Log date filter) are resolved.
        </p>

        <dl className="mt-4">
          <EntraConfigRow label="Business Timezone" value={timezone} />
        </dl>
      </section>

      <hr className="border-border" />

      <section className="max-w-2xl rounded-md bg-card p-6 shadow-sm">
        <h2 className="text-h3 font-semibold text-foreground">
          Entra ID Settings
        </h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Read-only. These values are sourced from environment variables. Use
          the Redirect URI when registering this application in Microsoft Entra.
        </p>

        <dl className="mt-4">
          <EntraConfigRow label="Tenant ID" value={entraConfig.tenantId} />
          <EntraConfigRow label="Client ID" value={entraConfig.clientId} />
          <EntraConfigRow label="Redirect URI" value={entraConfig.redirectUri}>
            {entraConfig.redirectUri && (
              <CopyRedirectUriButton value={entraConfig.redirectUri} />
            )}
          </EntraConfigRow>
        </dl>
      </section>
    </div>
  );
}
