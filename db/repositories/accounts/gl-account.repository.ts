import type { Database } from "@/db/client";
import type { GlAccount } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5). Chart of Accounts seam (Q26) — filled by
// ac03 (seed) and the Chart of Accounts config unit.
export const glAccountRepository = {
  async findByCode(_db: Database, _glCode: string): Promise<GlAccount | null> {
    throw new Error("not implemented (ac03)");
  },
};
