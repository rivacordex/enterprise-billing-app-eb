import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glMapping } from "@/db/schema/billing/catalogs";
import type { GlMapping } from "@/db/schema/billing/catalogs";

export const glMappingRepository = {
  async findAll(db: Database): Promise<GlMapping[]> {
    return db
      .select()
      .from(glMapping)
      .orderBy(glMapping.selectorType, glMapping.selector);
  },

  async findById(db: Database, glMappingId: string): Promise<GlMapping | null> {
    const [row] = await db
      .select()
      .from(glMapping)
      .where(eq(glMapping.glMappingId, glMappingId))
      .limit(1);
    return row ?? null;
  },

  async findBySelector(
    db: Database,
    selectorType: string,
    selector: string,
    currency: string | null,
  ): Promise<GlMapping | null> {
    const [row] = await db
      .select()
      .from(glMapping)
      .where(
        and(
          eq(glMapping.selectorType, selectorType),
          eq(glMapping.selector, selector),
          currency === null
            ? isNull(glMapping.currency)
            : eq(glMapping.currency, currency),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // Checks whether a given selector triple already exists on a different row
  // (used to enforce the UNIQUE constraint before insert/update so callers
  // receive a typed DUPLICATE_SELECTOR result rather than a DB exception).
  async findDuplicateSelector(
    db: Database,
    selectorType: string,
    selector: string,
    currency: string | null,
    excludeGlMappingId?: string,
  ): Promise<GlMapping | null> {
    const conditions = [
      eq(glMapping.selectorType, selectorType),
      eq(glMapping.selector, selector),
      currency === null
        ? isNull(glMapping.currency)
        : eq(glMapping.currency, currency),
    ];
    if (excludeGlMappingId) {
      conditions.push(ne(glMapping.glMappingId, excludeGlMappingId));
    }
    const [row] = await db
      .select()
      .from(glMapping)
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  },

  async insert(
    db: Database,
    values: {
      selectorType: string;
      selector: string;
      currency: string | null;
      refGlCode: string;
      lastEditedBy: string | null;
    },
  ): Promise<GlMapping> {
    const [row] = await db.insert(glMapping).values(values).returning();
    if (!row) throw new Error("gl_mapping insert returned no row");
    return row;
  },

  async update(
    db: Database,
    glMappingId: string,
    values: {
      selectorType: string;
      selector: string;
      currency: string | null;
      refGlCode: string;
      lastEditedBy: string | null;
    },
  ): Promise<GlMapping | null> {
    const [row] = await db
      .update(glMapping)
      .set({ ...values, lastModified: sql`now()` })
      .where(eq(glMapping.glMappingId, glMappingId))
      .returning();
    return row ?? null;
  },

  // CAS retire: issues a single atomic UPDATE constrained on glMappingId,
  // lastModified, and non-retired state. Returns 'updated' on success;
  // performs a diagnostic SELECT to classify the failure when 0 rows affected.
  async retire(
    db: Database,
    glMappingId: string,
    lastModified: Date,
    lastEditedBy: string | null,
  ): Promise<"updated" | "conflict" | "already_retired" | "not_found"> {
    const [updated] = await db
      .update(glMapping)
      .set({ state: "retired", lastModified: sql`now()`, lastEditedBy })
      .where(
        and(
          eq(glMapping.glMappingId, glMappingId),
          eq(glMapping.lastModified, lastModified),
          ne(glMapping.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(glMapping)
      .where(eq(glMapping.glMappingId, glMappingId))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "retired") return "already_retired";
    return "conflict";
  },
};
