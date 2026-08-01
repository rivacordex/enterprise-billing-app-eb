import type { Database } from "@/db/client";
import type { GlMapping } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5). GL-mapping seam (Module Inv. #10) — filled
// by ac03 (seed) and the GL mapping config unit.
export const glMappingRepository = {
  async findBySelector(
    _db: Database,
    _selectorType: string,
    _selector: string,
    _currency: string | null,
  ): Promise<GlMapping | null> {
    throw new Error("not implemented (ac03)");
  },
};
