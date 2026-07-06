import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
} from "@/db/schema/product";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";

const CURRENCY = "MYR"; // SYSTEM_CONFIG.default_currency (0005 seed)

interface SpecSeed {
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: Record<string, string>;
}

interface PriceSeed {
  name: string;
  priceType: "recurring" | "usage" | "once";
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  glCode: string | null;
  startDateTime: Date;
  pricingModel: "flat" | "tiered";
  amount: string | null;
  pricingCharacteristics: unknown;
}

interface OfferingSeed {
  name: string;
  specs: SpecSeed[];
  prices: PriceSeed[];
}

const OFFERING_SEEDS: OfferingSeed[] = [
  {
    name: "TOREMOVE-Template-5G-Nationwide-Service-Plan",
    specs: [
      {
        name: "TOREMOVE-Template-Network-Slice-eMBB",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { SST_ID: "01", SD_ID: "A0C4E2" },
      },
      {
        name: "TOREMOVE-Template-QoS-Profile",
        isMandatory: false,
        isDefault: false,
        defaultValue: "standard",
        characteristics: { "5QI": "9", ARP: "8" },
      },
    ],
    prices: [
      {
        name: "TOREMOVE-Template-Monthly-Recurring-Charge",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "5000.00",
        pricingCharacteristics: null,
      },
      {
        // Future-dated successor of the same price_type — pm03's
        // derived-effectivity fixture (pm02-spec §3.7).
        name: "TOREMOVE-Template-Monthly-Recurring-Charge-2027",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2027-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "5500.00",
        pricingCharacteristics: null,
      },
      {
        name: "TOREMOVE-Template-Activation-Fee",
        priceType: "once",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: null,
        glCode: null,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "1000.00",
        pricingCharacteristics: null,
      },
      {
        name: "TOREMOVE-Template-Data-Overage",
        priceType: "usage",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "tiered",
        amount: null,
        pricingCharacteristics: {
          tiers: [
            { from: 0, to: 1000, rate: "0.05" },
            { from: 1000, to: 10000, rate: "0.04" },
            { from: 10000, to: null, rate: "0.03" },
          ],
        },
      },
    ],
  },
  {
    name: "TOREMOVE-Template-Enterprise-IoT-Access",
    specs: [
      {
        name: "TOREMOVE-Template-Network-Slice-mMTC",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { SST_ID: "03", SD_ID: "B1D2E3" },
      },
    ],
    prices: [
      {
        name: "TOREMOVE-Template-Monthly-Recurring-Charge",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "1200.00",
        pricingCharacteristics: null,
      },
      {
        name: "TOREMOVE-Template-Data-Usage",
        priceType: "usage",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "0.02",
        pricingCharacteristics: null,
      },
    ],
  },
];

// Standalone script (`npm run db:seed-product`) — never imported by
// application code. Depends on `seed-rbac.ts` having already run (the ADMIN
// role must exist for the products:DELETE grant, pm02-spec Design #7).
// Idempotent: checks for any product_offering row before inserting; the
// whole seed is one transaction. Every JSONB/price payload is parsed through
// the validation/product schemas before insert (code-standards §1.7) — a bad
// payload throws and nothing lands.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, {
    schema: {
      roles,
      permissions,
      rolePermissionAssign,
      productOffering,
      productSpecifications,
      productOfferingPrice,
    },
  });

  try {
    const [existingOffering] = await db
      .select({ productOfferingId: productOffering.productOfferingId })
      .from(productOffering)
      .limit(1);

    if (existingOffering) {
      logger.info("Product catalog already seeded, skipping.");
      return;
    }

    await db.transaction(async (tx) => {
      for (const offeringSeed of OFFERING_SEEDS) {
        const [insertedOffering] = await tx
          .insert(productOffering)
          .values({
            name: offeringSeed.name,
            isBundle: false,
            isSellable: true,
            billingOnly: false,
            lifecycleStatus: "ACTIVE",
            version: 1,
            lastEditedBy: null,
          })
          .returning({
            productOfferingId: productOffering.productOfferingId,
          });

        if (!insertedOffering) {
          throw new Error(
            `Offering '${offeringSeed.name}' was not inserted as expected.`,
          );
        }
        const offeringId = insertedOffering.productOfferingId;

        for (const specSeed of offeringSeed.specs) {
          const characteristics = productSpecCharacteristicsSchema.parse(
            specSeed.characteristics,
          );
          await tx.insert(productSpecifications).values({
            refProductOfferingId: offeringId,
            name: specSeed.name,
            isMandatory: specSeed.isMandatory,
            isDefault: specSeed.isDefault,
            defaultValue: specSeed.defaultValue,
            productSpecCharacteristics: characteristics,
          });
        }

        for (const priceSeed of offeringSeed.prices) {
          const characteristics = priceCharacteristicsSchema.parse({
            pricing_model: priceSeed.pricingModel,
            amount: priceSeed.amount,
            pricing_characteristics: priceSeed.pricingCharacteristics,
          });
          await tx.insert(productOfferingPrice).values({
            productOfferingId: offeringId,
            name: priceSeed.name,
            priceType: priceSeed.priceType,
            recurringChargePeriodLength: priceSeed.recurringChargePeriodLength,
            recurringChargePeriodType: priceSeed.recurringChargePeriodType,
            unitOfMeasure: priceSeed.unitOfMeasure,
            amount: characteristics.amount,
            currency: CURRENCY,
            glCode: priceSeed.glCode,
            pricingModel: characteristics.pricing_model,
            policy: null,
            pricingCharacteristics: characteristics.pricing_characteristics,
            startDateTime: priceSeed.startDateTime,
          });
        }
      }

      const [adminRole] = await tx
        .select({ roleId: roles.roleId })
        .from(roles)
        .where(eq(roles.roleName, "ADMIN"))
        .limit(1);

      if (!adminRole) {
        throw new Error("ADMIN role not found. Run db:seed-rbac first.");
      }

      const [productsPermission] = await tx
        .select({ permissionId: permissions.permissionId })
        .from(permissions)
        .where(eq(permissions.permissionName, "products"))
        .limit(1);

      if (!productsPermission) {
        throw new Error("products permission not found. Run db:migrate first.");
      }

      const [existingGrant] = await tx
        .select({ rolePermissionId: rolePermissionAssign.rolePermissionId })
        .from(rolePermissionAssign)
        .where(
          and(
            eq(rolePermissionAssign.refRoleId, adminRole.roleId),
            eq(
              rolePermissionAssign.refPermissionId,
              productsPermission.permissionId,
            ),
          ),
        )
        .limit(1);

      if (!existingGrant) {
        await tx.insert(rolePermissionAssign).values({
          refRoleId: adminRole.roleId,
          refPermissionId: productsPermission.permissionId,
          permissionType: "DELETE",
        });
      }
    });

    logger.info("Product catalog seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Product seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
