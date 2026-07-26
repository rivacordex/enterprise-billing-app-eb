import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glAccount } from "@/db/schema/billing/catalogs";
import type { GlAccount, GlAccountInsert } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; Chart of
// Accounts CRUD is a later unit.
export const glAccountRepository = {
  async findById(db: Database, glCode: string): Promise<GlAccount | null> {
    const [row] = await db
      .select()
      .from(glAccount)
      .where(eq(glAccount.glCode, glCode))
      .limit(1);
    return row ?? null;
  },

  async insert(_tx: Database, _data: GlAccountInsert): Promise<GlAccount> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the Chart of Accounts unit",
    );
  },
};
