import { db } from "@/db/client";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { SystemConfigDisplayRow } from "@/types/system-config";

// Backs the System Configuration page (um22-spec §22.4). Thin delegation —
// the service layer exists to maintain the page → service → repository
// boundary, not to transform data. Read-only, no audit.
export async function getSystemConfigParams(): Promise<
  SystemConfigDisplayRow[]
> {
  return systemConfigRepository.findAllNonSecret(db);
}
