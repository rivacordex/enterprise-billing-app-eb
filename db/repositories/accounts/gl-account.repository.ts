import { and, eq, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glAccount } from "@/db/schema/billing/catalogs";
import type { GlAccount } from "@/db/schema/billing/catalogs";

export const glAccountRepository = {
  async findAll(db: Database): Promise<GlAccount[]> {
    return db.select().from(glAccount).orderBy(glAccount.glCode);
  },

  async findByCode(db: Database, glCode: string): Promise<GlAccount | null> {
    const [row] = await db
      .select()
      .from(glAccount)
      .where(eq(glAccount.glCode, glCode))
      .limit(1);
    return row ?? null;
  },

  async insert(
    db: Database,
    values: {
      glCode: string;
      name: string;
      accountClass: string;
      normalBalance: string;
      parentGlCode?: string | null;
      isPostable: boolean;
      lastEditedBy: string | null;
    },
  ): Promise<GlAccount> {
    const [row] = await db.insert(glAccount).values(values).returning();
    if (!row) throw new Error("gl_account insert returned no row");
    return row;
  },

  // CAS retire: issues a single atomic UPDATE constrained on glCode,
  // lastModified, and non-retired state. Returns 'updated' on success;
  // performs a diagnostic SELECT to classify the failure into 'conflict',
  // 'already_retired', or 'not_found' when 0 rows are affected.
  async retire(
    db: Database,
    glCode: string,
    lastModified: Date,
  ): Promise<"updated" | "conflict" | "already_retired" | "not_found"> {
    const [updated] = await db
      .update(glAccount)
      .set({ state: "retired", lastModified: sql`now()` })
      .where(
        and(
          eq(glAccount.glCode, glCode),
          eq(glAccount.lastModified, lastModified),
          ne(glAccount.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(glAccount)
      .where(eq(glAccount.glCode, glCode))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "retired") return "already_retired";
    return "conflict";
  },
};
