import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productSpecifications } from "@/db/schema/product";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { SpecificationCard } from "@/types/product";

export const productSpecificationRepository = {
  // Backs the specifications panel (pm03-spec §3.6). Uses the
  // `product_specifications_offering_idx` FK index; `product_spec_
  // characteristics` is already `.$type<ProductSpecCharacteristics>()`
  // (pm02) — no cast, no re-parse on read.
  async findByOfferingId(
    db: Database,
    productOfferingId: string,
  ): Promise<SpecificationCard[]> {
    const rows = await db
      .select({
        productSpecId: productSpecifications.productSpecId,
        name: productSpecifications.name,
        isMandatory: productSpecifications.isMandatory,
        isDefault: productSpecifications.isDefault,
        defaultValue: productSpecifications.defaultValue,
        characteristics: productSpecifications.productSpecCharacteristics,
      })
      .from(productSpecifications)
      .where(eq(productSpecifications.refProductOfferingId, productOfferingId))
      .orderBy(
        asc(productSpecifications.name),
        asc(productSpecifications.productSpecId),
      );

    return rows;
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
        productSpecCharacteristics: data.productSpecCharacteristics,
      })
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error("insertSpecification: insert returned no row");
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. `productSpecId` is guaranteed by the caller to belong
  // to a DRAFT offering (Design) — this method does not re-check status.
  async updateSpecification(
    tx: Database,
    productSpecId: string,
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
        productSpecCharacteristics: data.productSpecCharacteristics,
      })
      .where(eq(productSpecifications.productSpecId, productSpecId))
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error(
        `updateSpecification: specification ${productSpecId} not found`,
      );
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. Hard delete — this table's only delete method, ever
  // (project-overview-phase2: "Hard delete is available for a
  // specification, but only on a DRAFT row"). Caller-guaranteed DRAFT
  // target, same as above.
  async deleteSpecification(
    tx: Database,
    productSpecId: string,
  ): Promise<void> {
    const deleted = await tx
      .delete(productSpecifications)
      .where(eq(productSpecifications.productSpecId, productSpecId))
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (deleted.length === 0) {
      throw new Error(
        `deleteSpecification: specification ${productSpecId} not found`,
      );
    }
  },
};
