import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { reasonCode } from "@/db/schema/billing/catalogs";
import type {
  ReasonCode,
  ReasonCodeInsert,
} from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; catalog CRUD is
// the Accounts Settings unit.
export const reasonCodeRepository = {
  async findById(
    db: Database,
    reasonCodeId: string,
  ): Promise<ReasonCode | null> {
    const [row] = await db
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, reasonCodeId))
      .limit(1);
    return row ?? null;
  },

  async insert(_tx: Database, _data: ReasonCodeInsert): Promise<ReasonCode> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the Accounts Settings unit",
    );
  },
};
