import { and, asc, eq } from "drizzle-orm";

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

  // pm16-spec §3.5 (post-ship fix). Same shape as findByOfferingId, but
  // FOR UPDATE — used only by activateOffering's transaction-time
  // precondition re-check, to close the race where a mandatory
  // specification's defaultValue is cleared (or the spec deleted) between
  // the service's initial pre-transaction read and the activation write.
  async findByOfferingIdForUpdate(
    tx: Database,
    productOfferingId: string,
  ): Promise<SpecificationCard[]> {
    const rows = await tx
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
      )
      .for("update");

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
  // `refProductOfferingId` is an extra defense-in-depth backstop (same
  // shape as `updateOfferingDraftInPlace`'s status WHERE clause) — the
  // caller already resolves productSpecId against this exact offering.
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
        productSpecCharacteristics: data.productSpecCharacteristics,
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
