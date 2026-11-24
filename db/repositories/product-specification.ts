// The specification repository (pm03 → pm14 → pm16 → pm72).
//
// pm72 (Part 6 — Normalize, code-standards §1.55): a specification's
// characteristics are rows in `product_spec_characteristic` (0056), one per
// entry, with `display_order`. The `Record<string,string>` stays the input and
// read contract; it is assembled and decomposed only in this file.
//
//   - Write: `display_order = 1…n` from the validated record's entries; `{}`
//     writes no rows; an update REPLACES the row set, never merges.
//   - Read: the record is rebuilt in `display_order`, so its key order IS the
//     display order (Inv. #66). `displayOrder` never leaves this file (§2.32).
//   - Every write must run on a transaction (specification + rows).
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  productSpecCharacteristic,
  productSpecifications,
} from "@/db/schema/product";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { SpecificationCard } from "@/types/product";

type SpecRowWithCharacteristics = typeof productSpecifications.$inferSelect & {
  characteristics: Array<typeof productSpecCharacteristic.$inferSelect>;
};

// `row.characteristics` must already be in `display_order`.
function toCard(row: SpecRowWithCharacteristics): SpecificationCard {
  return {
    productSpecId: row.productSpecId,
    name: row.name,
    isMandatory: row.isMandatory,
    isDefault: row.isDefault,
    defaultValue: row.defaultValue,
    characteristics: Object.fromEntries(
      row.characteristics.map((c) => [c.charName, c.charValue]),
    ),
  };
}

// `Object.entries` is insertion order for string keys — the order the user
// entered. Integer-like keys would be hoisted; Zod refuses them (pm69 D5).
function toCharacteristicRows(
  productSpecId: string,
  record: ProductSpecCharacteristics,
): Array<typeof productSpecCharacteristic.$inferInsert> {
  return Object.entries(record).map(([charName, charValue], i) => ({
    productSpecId,
    charName,
    charValue,
    displayOrder: i + 1,
  }));
}

export const productSpecificationRepository = {
  // Backs the specifications panel (pm03-spec §3.6). Uses the
  // `product_specifications_offering_idx` FK index. One relational statement:
  // the characteristics ride on the specification query (pm72 D3, §3.24).
  async findByOfferingId(
    db: Database,
    productOfferingId: string,
  ): Promise<SpecificationCard[]> {
    const rows = await db.query.productSpecifications.findMany({
      where: eq(productSpecifications.refProductOfferingId, productOfferingId),
      with: {
        characteristics: {
          orderBy: asc(productSpecCharacteristic.displayOrder),
        },
      },
      orderBy: [
        asc(productSpecifications.name),
        asc(productSpecifications.productSpecId),
      ],
    });

    return rows.map(toCard);
  },

  // pm16-spec §3.5 (post-ship fix). Same shape as findByOfferingId, but
  // FOR UPDATE — used only by activateOffering's transaction-time
  // precondition re-check, to close the race where a mandatory
  // specification's defaultValue is cleared (or the spec deleted) between
  // the service's initial pre-transaction read and the activation write.
  //
  // pm72 D3: two fixed statements, because the relational builder has no FOR
  // UPDATE. The lock covers the specification rows, which carry both columns
  // the precondition reads; the characteristic rows are not locked — they are
  // returned only because the return type is `SpecificationCard[]`.
  async findByOfferingIdForUpdate(
    tx: Database,
    productOfferingId: string,
  ): Promise<SpecificationCard[]> {
    const specs = await tx
      .select()
      .from(productSpecifications)
      .where(eq(productSpecifications.refProductOfferingId, productOfferingId))
      .orderBy(
        asc(productSpecifications.name),
        asc(productSpecifications.productSpecId),
      )
      .for("update");
    if (specs.length === 0) return [];

    const characteristics = await tx
      .select()
      .from(productSpecCharacteristic)
      .where(
        inArray(
          productSpecCharacteristic.productSpecId,
          specs.map((spec) => spec.productSpecId),
        ),
      )
      .orderBy(
        asc(productSpecCharacteristic.productSpecId),
        asc(productSpecCharacteristic.displayOrder),
      );
    const bySpecId = new Map<string, typeof characteristics>();
    for (const c of characteristics) {
      const group = bySpecId.get(c.productSpecId);
      if (group) group.push(c);
      else bySpecId.set(c.productSpecId, [c]);
    }

    return specs.map((spec) =>
      toCard({
        ...spec,
        characteristics: bySpecId.get(spec.productSpecId) ?? [],
      }),
    );
  },

  // pm14-spec §3.3. `refProductOfferingId` is supplied by the caller — the
  // service already knows whether that's the original DRAFT offering or a
  // freshly branched clone (Design). No status backstop here: this table
  // has no lifecycle_status column of its own, and "target is always DRAFT"
  // is a caller guarantee, not a repository-enforced one (build plan's own
  // wording, §pm14 header).
  async insertSpecification(
    tx: Database,
    data: {
      refProductOfferingId: string;
      name: string;
      isMandatory: boolean;
      isDefault: boolean;
      defaultValue: string | null;
      productSpecCharacteristics: ProductSpecCharacteristics;
    },
  ): Promise<{ productSpecId: string }> {
    const [row] = await tx
      .insert(productSpecifications)
      .values({
        refProductOfferingId: data.refProductOfferingId,
        name: data.name,
        isMandatory: data.isMandatory,
        isDefault: data.isDefault,
        defaultValue: data.defaultValue,
      })
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error("insertSpecification: insert returned no row");
    }

    const characteristicRows = toCharacteristicRows(
      row.productSpecId,
      data.productSpecCharacteristics,
    );
    if (characteristicRows.length > 0) {
      await tx.insert(productSpecCharacteristic).values(characteristicRows);
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. `productSpecId` is guaranteed by the caller to belong
  // to a DRAFT offering (Design) — this method does not re-check status.
  // `refProductOfferingId` is an extra defense-in-depth backstop (same
  // shape as `updateOfferingDraftInPlace`'s status WHERE clause) — the
  // caller already resolves productSpecId against this exact offering.
  //
  // pm72 D2: the characteristic rows are replaced, so a removed key disappears
  // and `display_order` is 1…n after every write. The UPDATE comes first: it
  // locks the specification row, which serializes concurrent replacements.
  async updateSpecification(
    tx: Database,
    productSpecId: string,
    refProductOfferingId: string,
    data: {
      name: string;
      isMandatory: boolean;
      isDefault: boolean;
      defaultValue: string | null;
      productSpecCharacteristics: ProductSpecCharacteristics;
    },
  ): Promise<{ productSpecId: string }> {
    const [row] = await tx
      .update(productSpecifications)
      .set({
        name: data.name,
        isMandatory: data.isMandatory,
        isDefault: data.isDefault,
        defaultValue: data.defaultValue,
      })
      .where(
        and(
          eq(productSpecifications.productSpecId, productSpecId),
          eq(productSpecifications.refProductOfferingId, refProductOfferingId),
        ),
      )
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error(
        `updateSpecification: specification ${productSpecId} not found on offering ${refProductOfferingId}`,
      );
    }

    await tx
      .delete(productSpecCharacteristic)
      .where(eq(productSpecCharacteristic.productSpecId, productSpecId));
    const characteristicRows = toCharacteristicRows(
      productSpecId,
      data.productSpecCharacteristics,
    );
    if (characteristicRows.length > 0) {
      await tx.insert(productSpecCharacteristic).values(characteristicRows);
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. Hard delete — this table's only delete method, ever
  // (project-overview-phase2: "Hard delete is available for a
  // specification, but only on a DRAFT row"). Caller-guaranteed DRAFT
  // target, same as above. `refProductOfferingId` backstop, same rationale
  // as updateSpecification above.
  async deleteSpecification(
    tx: Database,
    productSpecId: string,
    refProductOfferingId: string,
  ): Promise<void> {
    const deleted = await tx
      .delete(productSpecifications)
      .where(
        and(
          eq(productSpecifications.productSpecId, productSpecId),
          eq(productSpecifications.refProductOfferingId, refProductOfferingId),
        ),
      )
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (deleted.length === 0) {
      throw new Error(
        `deleteSpecification: specification ${productSpecId} not found on offering ${refProductOfferingId}`,
      );
    }
  },
};
