export const CONFIG_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

// Shape returned by the repository join (system_config + appuser for
// modifier name). `modifiedByUserId` mirrors `appuser.id` (text, Better-Auth
// id format), not a uuid.
export interface SystemConfigDisplayRow {
  configId: string;
  configGroup: string;
  configVersion: number;
  configKey: string;
  configValue: string | null;
  // Read-only seeded documentation for the row (um28-spec §2.10), rendered as
  // a sublabel under the key. Null when the row has no seeded description.
  description: string | null;
  isSecret: boolean;
  status: ConfigStatus;
  modifiedByUserId: string | null;
  modifiedByName: string | null;
  lastModifiedDatetime: Date;
}

// Rows grouped by configGroup for rendering.
export interface SystemConfigGroup {
  group: string;
  rows: SystemConfigDisplayRow[];
}

// Resolved branding logo, produced server-side by `getBrandingLogo` and
// passed as a plain-serializable prop into `BrandLogo` / `AdminSidebar`
// (um28-spec §2.10). `src`/`markSrc` are validated same-origin `/brand/...`
// paths; `alt` comes from the `app_name` config row. `null` (not this type)
// signals "fall back to the text wordmark".
export interface BrandingLogo {
  src: string;
  markSrc?: string;
  alt: string;
}
