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
