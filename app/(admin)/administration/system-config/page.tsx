import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CopyRedirectUriButton } from "@/components/system-config/copy-redirect-uri-button";
import { EntraConfigRow } from "@/components/system-config/entra-config-row";
import { entraConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System Configuration — Enterprise Billing",
};

// Minimal scaffold: no unit before um10 built this page (admin-nav's link
// to it was a deliberate 404-until-shipped placeholder since um07). um10
// only specifies the read-only "Entra ID Settings" section below — no
// other system-config content exists yet, so that's all this page renders.
export default async function SystemConfigPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ);

  return (
    <div className="p-6">
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
