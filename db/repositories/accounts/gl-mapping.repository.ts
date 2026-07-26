import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glMapping } from "@/db/schema/billing/catalogs";
import type { GlMapping, GlMappingInsert } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; GL mapping CRUD
// is a later unit.
export const glMappingRepository = {
  async findById(db: Database, glMappingId: string): Promise<GlMapping | null> {
    const [row] = await db
      .select()
      .from(glMapping)
      .where(eq(glMapping.glMappingId, glMappingId))
      .limit(1);
    return row ?? null;
  },

  async insert(_tx: Database, _data: GlMappingInsert): Promise<GlMapping> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the Chart of Accounts unit",
    );
  },
};
