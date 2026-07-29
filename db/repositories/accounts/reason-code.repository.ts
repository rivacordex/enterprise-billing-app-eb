import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { reasonCode } from "@/db/schema/billing/catalogs";
import type { ReasonCode } from "@/db/schema/billing/catalogs";

export const reasonCodeRepository = {
  async findByCode(
    db: Database,
    reasonCodeValue: string,
  ): Promise<ReasonCode | null> {
    const [row] = await db
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, reasonCodeValue))
      .limit(1);
    return row ?? null;
  },
};
