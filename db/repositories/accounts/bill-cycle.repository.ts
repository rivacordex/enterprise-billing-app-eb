import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import type { BillCycle } from "@/db/schema/billing/catalogs";

export const billCycleRepository = {
  async findById(db: Database, billCycleId: string): Promise<BillCycle | null> {
    const [row] = await db
      .select()
      .from(billCycle)
      .where(eq(billCycle.billCycleId, billCycleId))
      .limit(1);
    return row ?? null;
  },

  async findAllActive(db: Database): Promise<BillCycle[]> {
    return db.select().from(billCycle).where(eq(billCycle.state, "active"));
  },

  async findAll(db: Database): Promise<BillCycle[]> {
    return db.select().from(billCycle).orderBy(asc(billCycle.name));
  },

  async insert(
    db: Database,
    values: {
      name: string;
      description?: string | null;
      frequency: string;
      cycleDay: number;
      paymentDueDays: number;
      lastEditedBy: string;
    },
  ): Promise<BillCycle> {
    const [row] = await db
      .insert(billCycle)
      .values({
        name: values.name,
        description: values.description ?? null,
        frequency: values.frequency,
        cycleDay: values.cycleDay,
        paymentDueDays: values.paymentDueDays,
        state: "active",
        lastEditedBy: values.lastEditedBy,
      })
      .returning();
    if (!row) throw new Error("bill_cycle insert returned no row");
    return row;
  },

  // CAS update: same pattern as gl-account retire (ac12 precedent).
  async update(
    db: Database,
    values: {
      billCycleId: string;
      name: string;
      description?: string | null;
      frequency: string;
      cycleDay: number;
      paymentDueDays: number;
      lastModified: Date;
      lastEditedBy: string;
    },
  ): Promise<"updated" | "conflict" | "not_found"> {
    const [updated] = await db
      .update(billCycle)
      .set({
        name: values.name,
        description: values.description ?? null,
        frequency: values.frequency,
        cycleDay: values.cycleDay,
        paymentDueDays: values.paymentDueDays,
        lastEditedBy: values.lastEditedBy,
        lastModified: sql`now()`,
      })
      .where(
        and(
          eq(billCycle.billCycleId, values.billCycleId),
          eq(billCycle.lastModified, values.lastModified),
          ne(billCycle.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(billCycle)
      .where(eq(billCycle.billCycleId, values.billCycleId))
      .limit(1);
    if (!current) return "not_found";
    return "conflict";
  },

  // CAS retire: catalogs retire, never delete (Module Inv. #11 / V9).
  async retire(
    db: Database,
    billCycleId: string,
    lastModified: Date,
  ): Promise<"updated" | "conflict" | "already_retired" | "not_found"> {
    const [updated] = await db
      .update(billCycle)
      .set({ state: "retired", lastModified: sql`now()` })
      .where(
        and(
          eq(billCycle.billCycleId, billCycleId),
          eq(billCycle.lastModified, lastModified),
          ne(billCycle.state, "retired"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(billCycle)
      .where(eq(billCycle.billCycleId, billCycleId))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "retired") return "already_retired";
    return "conflict";
  },
};
