import type { Database } from "@/db/client";
import type { ReasonCode } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5). Reader/CRUD seam for the reason-code
// catalog (natural PK) — filled by ac03 (seed) and the Accounts Settings
// config unit.
export const reasonCodeRepository = {
  async findByCode(
    _db: Database,
    _reasonCode: string,
  ): Promise<ReasonCode | null> {
    throw new Error("not implemented (ac03)");
  },
};
