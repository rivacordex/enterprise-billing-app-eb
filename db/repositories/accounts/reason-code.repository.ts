import { and, asc, eq, ne, sql } from "drizzle-orm";

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

  async findAll(db: Database): Promise<ReasonCode[]> {
    return db
      .select()
      .from(reasonCode)
      .orderBy(asc(reasonCode.docType), asc(reasonCode.reasonCode));
  },

  async insert(
    db: Database,
    values: {
      reasonCode: string;
      name?: string | null;
      description?: string | null;
      docType: string;
      postingNature: string;
      autoPostLimit: string;
      lastEditedBy: string;
    },
  ): Promise<ReasonCode> {
    const [row] = await db
      .insert(reasonCode)
      .values({
        reasonCode: values.reasonCode,
        name: values.name ?? null,
        description: values.description ?? null,
        docType: values.docType,
        postingNature: values.postingNature,
        autoPostLimit: values.autoPostLimit,
        state: "active",
        lastEditedBy: values.lastEditedBy,
      })
      .returning();
    if (!row) throw new Error("reason_code insert returned no row");
    return row;
  },

  // CAS update of editable fields (name, description, autoPostLimit).
  // doc_type / posting_nature are immutable after creation — not in the SET.
  // Returns 'updated' on success; 'not_found' or 'conflict' on failure.
  async update(
    db: Database,
    values: {
      reasonCode: string;
      name?: string | null;
      description?: string | null;
      autoPostLimit: string;
      lastModified: Date;
      lastEditedBy: string;
    },
  ): Promise<"updated" | "conflict" | "already_retired" | "not_found"> {
    const [updated] = await db
      .update(reasonCode)
      .set({
        name: values.name ?? null,
        description: values.description ?? null,
        autoPostLimit: values.autoPostLimit,
        lastEditedBy: values.lastEditedBy,
        lastModified: sql`now()`,
      })
      .where(
        and(
          eq(reasonCode.reasonCode, values.reasonCode),
          eq(reasonCode.lastModified, values.lastModified),
          ne(reasonCode.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, values.reasonCode))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "retired") return "already_retired";
    return "conflict";
  },

  // CAS retire: same pattern as gl-account retire (ac12 precedent).
  async retire(
    db: Database,
    reasonCodeValue: string,
    lastModified: Date,
  ): Promise<"updated" | "conflict" | "already_retired" | "not_found"> {
    const [updated] = await db
      .update(reasonCode)
      .set({ state: "retired", lastModified: sql`now()` })
      .where(
        and(
          eq(reasonCode.reasonCode, reasonCodeValue),
          eq(reasonCode.lastModified, lastModified),
          ne(reasonCode.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, reasonCodeValue))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "retired") return "already_retired";
    return "conflict";
  },
};
