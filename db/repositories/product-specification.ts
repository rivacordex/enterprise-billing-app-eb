import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productSpecifications } from "@/db/schema/product";
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
};
