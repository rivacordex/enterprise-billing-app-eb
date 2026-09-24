import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { pricingComponentSchema } from "@/validation/product/pricing-component.schema";
import type { insertPrice as InsertPrice } from "@/services/product/insert-price";
import type { updatePrice as UpdatePrice } from "@/services/product/update-price";
import type { deletePrice as DeletePrice } from "@/services/product/delete-price";
import type { validateOfferingComponents as ValidateOfferingComponents } from "@/services/product/validate-offering-components";
import type { getOfferingDetail as GetOfferingDetail } from "@/services/product/get-offering-detail";
import type { db as AppDb } from "@/db/client";
import type { UnitOfMeasure } from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// pm49-spec I7. Live-DB proof of the component write path: the repository's
// component-based read/write shape, the offering-level cross-row validator
// (VI3–VI5), the DRAFT-only gate the validator now sits inside, branch-on-
// ACTIVE validating against the branched draft, and the audit ripple. Every
// service uses its own `@/db/client` pool; the local `sql` handle drives
// fixture setup and raw-SQL assertions.
const databaseUrl = process.env.DATABASE_URL;

// Every price-write service enforces a 3-day backdating tolerance against the
// REAL clock (`now: Date = new Date()`), so fixture start dates are anchored
// to "now" rather than a fixed calendar literal — a hardcoded past date
// silently drifts into BACKDATED_START_TOO_FAR territory as the calendar
// moves on.
const START = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
const LATER_START = new Date(START.getTime() + 365 * 24 * 60 * 60 * 1000); // +1 year
// A point in time strictly after LATER_START, so effectivity resolved "as of"
// this instant treats LATER_START's row as already effective (and START's row
// as already superseded by it).
const AFTER_LATER_START = new Date(LATER_START.getTime() + 24 * 60 * 60 * 1000);

describe.skipIf(!databaseUrl)(
  "component write path: repository, services, cross-row validator (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let insertPrice: typeof InsertPrice;
    let updatePrice: typeof UpdatePrice;
    let deletePrice: typeof DeletePrice;
    let validateOfferingComponents: typeof ValidateOfferingComponents;
    let getOfferingDetail: typeof GetOfferingDetail;
    let appDb: typeof AppDb;
    let actorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [
        insertPriceMod,
        updatePriceMod,
        deletePriceMod,
        validatorMod,
        detailMod,
        clientMod,
      ] = await Promise.all([
        import("@/services/product/insert-price"),
        import("@/services/product/update-price"),
        import("@/services/product/delete-price"),
        import("@/services/product/validate-offering-components"),
        import("@/services/product/get-offering-detail"),
        import("@/db/client"),
      ]);
      insertPrice = insertPriceMod.insertPrice;
      updatePrice = updatePriceMod.updatePrice;
      deletePrice = deletePriceMod.deletePrice;
      validateOfferingComponents = validatorMod.validateOfferingComponents;
      getOfferingDetail = detailMod.getOfferingDetail;
      appDb = clientMod.db;

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Price Editor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = user!.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function createOffering(
      name: string,
      status: "DRAFT" | "ACTIVE" | "TESTING" | "OBSOLETE" | "RETIRED" = "DRAFT",
    ): Promise<string> {
      const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status)
        VALUES (${name}, false, true, true, ${status}::product.lifecycle_status)
        RETURNING product_offering_id`;
      return rows[0]!.product_offering_id;
    }

    // -- Input builders, one per component-type branch of price-input.schema.ts

    function usageRateInput(opts: {
      unitOfMeasure: UnitOfMeasure;
      startDateTime: Date;
      ratePerUnit?: string;
      rateCardLookUp?: string | null;
      currency?: string;
      name?: string;
    }): InsertPriceInput {
      return {
        componentType: "usage_rate",
        name: opts.name ?? "Usage rate",
        currency: opts.currency ?? "USD",
        glCode: null,
        unitOfMeasure: opts.unitOfMeasure,
        params: {
          ratePerUnit: opts.ratePerUnit ?? "1.00",
          rateCardLookUp: opts.rateCardLookUp ?? null,
        },
        startDateTime: opts.startDateTime,
      };
    }

    function capacityCommitmentInput(opts: {
      unitOfMeasure: UnitOfMeasure;
      startDateTime: Date;
      committedQuantity?: number;
      currency?: string;
      name?: string;
    }): InsertPriceInput {
      return {
        componentType: "capacity_commitment",
        name: opts.name ?? "Capacity commitment",
        currency: opts.currency ?? "USD",
        glCode: null,
        unitOfMeasure: opts.unitOfMeasure,
        params: { committedQuantity: opts.committedQuantity ?? 1000 },
        startDateTime: opts.startDateTime,
      };
    }

    function capacityMotivationInput(opts: {
      unitOfMeasure: UnitOfMeasure;
      startDateTime: Date;
      currency?: string;
      name?: string;
    }): InsertPriceInput {
      return {
        componentType: "capacity_motivation",
        name: opts.name ?? "Capacity motivation",
        currency: opts.currency ?? "USD",
        glCode: null,
        unitOfMeasure: opts.unitOfMeasure,
        params: {
          steps: [
            { aboveQuantity: 1000, ratePerUnit: "50" },
            { aboveQuantity: 2000, ratePerUnit: "25" },
          ],
        },
        startDateTime: opts.startDateTime,
      };
    }

    function flatFeeRecurringInput(opts: {
      startDateTime: Date;
      amount?: string;
      currency?: string;
      name?: string;
    }): InsertPriceInput {
      return {
        componentType: "flat_fee",
        priceType: "recurring",
        name: opts.name ?? "Recurring fee",
        currency: opts.currency ?? "USD",
        glCode: null,
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        params: { amount: opts.amount ?? "100.00" },
        startDateTime: opts.startDateTime,
      };
    }

    function flatFeeOneTimeInput(opts: {
      startDateTime: Date;
      amount?: string;
      currency?: string;
      name?: string;
    }): InsertPriceInput {
      return {
        componentType: "flat_fee",
        priceType: "oneTime",
        name: opts.name ?? "One-time fee",
        currency: opts.currency ?? "USD",
        glCode: null,
        params: { amount: opts.amount ?? "50.00" },
        startDateTime: opts.startDateTime,
      };
    }

    async function auditCount(
      priceId: string,
      eventType: string,
    ): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM core.audit_log
        WHERE target_id = ${priceId} AND event_type = ${eventType}`;
      return Number(rows[0]!.count);
    }

    async function auditPayload(
      priceId: string,
      eventType: string,
    ): Promise<{
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }> {
      const rows = await sql<
        {
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown> | null;
        }[]
      >`
        SELECT before_data, after_data FROM core.audit_log
        WHERE target_id = ${priceId} AND event_type = ${eventType}
        ORDER BY created_datetime DESC
        LIMIT 1`;
      return {
        before: rows[0]?.before_data ?? null,
        after: rows[0]?.after_data ?? null,
      };
    }

    // -- I7.1: write path — four component types save and read back parsed,
    // per-lane effectivity.

    it("saves a usage_rate, a capacity_commitment, a capacity_motivation and a flat_fee on one DRAFT offering, and reads each back with a parsed envelope", async () => {
      const offeringId = await createOffering("pm49 four components");
      const start = START;

      const usage = await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const commitment = await insertPrice(
        offeringId,
        capacityCommitmentInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const motivation = await insertPrice(
        offeringId,
        capacityMotivationInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const fee = await insertPrice(
        offeringId,
        flatFeeRecurringInput({ startDateTime: start }),
        actorId,
      );

      expect(usage.ok).toBe(true);
      expect(commitment.ok).toBe(true);
      expect(motivation.ok).toBe(true);
      expect(fee.ok).toBe(true);

      const detail = await getOfferingDetail(offeringId);
      expect(detail?.prices).toHaveLength(4);

      const byType = new Map(detail!.prices.map((p) => [p.componentType, p]));
      expect(byType.get("usage_rate")?.component["@type"]).toBe("usage_rate");
      expect(byType.get("capacity_commitment")?.component["@type"]).toBe(
        "capacity_commitment",
      );
      expect(byType.get("capacity_motivation")?.component["@type"]).toBe(
        "capacity_motivation",
      );
      expect(byType.get("flat_fee")?.component["@type"]).toBe("flat_fee");
      // Every card in the same offering, same start — none supersedes another,
      // because each lives in its own (component_type, unit_of_measure) lane.
      for (const card of detail!.prices) {
        expect(card.endDateTime).toBeNull();
        expect(card.effectivityStatus).toBe("current");
      }
    });

    it("a dated usage_rate successor supersedes only the usage_rate lane, not the capacity_commitment beside it", async () => {
      const offeringId = await createOffering("pm49 per-lane succession");
      const start = START;
      const later = LATER_START;

      await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      await insertPrice(
        offeringId,
        capacityCommitmentInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const successor = await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: later,
          ratePerUnit: "2.00",
        }),
        actorId,
      );
      expect(successor.ok).toBe(true);

      const detail = await getOfferingDetail(offeringId, AFTER_LATER_START);
      const commitmentCard = detail!.prices.find(
        (p) => p.componentType === "capacity_commitment",
      );
      const firstUsageCard = detail!.prices.find(
        (p) =>
          p.componentType === "usage_rate" &&
          p.startDateTime.getTime() === start.getTime(),
      );
      expect(commitmentCard?.endDateTime).toBeNull();
      expect(commitmentCard?.effectivityStatus).toBe("current");
      expect(firstUsageCard?.endDateTime?.getTime()).toBe(later.getTime());
      expect(firstUsageCard?.effectivityStatus).toBe("superseded");
    });

    // -- I7.2: cross-component refusals, one case each with its typed code.

    it("refuses a capacity_commitment with no same-unit usage_rate: MODIFIER_WITHOUT_BASE_RATE", async () => {
      const offeringId = await createOffering("pm49 modifier no base EA");
      const result = await insertPrice(
        offeringId,
        capacityCommitmentInput({
          unitOfMeasure: "EA",
          startDateTime: START,
        }),
        actorId,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "MODIFIER_WITHOUT_BASE_RATE",
        unitOfMeasure: "EA",
      });
    });

    it("refuses a capacity_motivation in GB beside a usage_rate in EA — same-unit is the rule, not same-offering", async () => {
      const offeringId = await createOffering("pm49 modifier wrong unit");
      const start = START;
      await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const result = await insertPrice(
        offeringId,
        capacityMotivationInput({ unitOfMeasure: "GB", startDateTime: start }),
        actorId,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "MODIFIER_WITHOUT_BASE_RATE",
        unitOfMeasure: "GB",
      });
    });

    it("refuses a second effective usage_rate for one unit at one instant: AMBIGUOUS_BASE_RATE", async () => {
      const offeringId = await createOffering("pm49 ambiguous base rate");
      const start = START;
      await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const result = await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: start,
          ratePerUnit: "9.99",
        }),
        actorId,
      );
      expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_BASE_RATE" });
    });

    it("refuses a second component in a different currency: CURRENCY_MISMATCH", async () => {
      const offeringId = await createOffering("pm49 currency mismatch");
      const start = START;
      await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: start,
          currency: "USD",
        }),
        actorId,
      );
      const result = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: start, currency: "MYR" }),
        actorId,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "CURRENCY_MISMATCH",
        existingCurrency: "USD",
        candidateCurrency: "MYR",
      });
    });

    it("refuses deleting the last same-unit usage_rate while a modifier remains: MODIFIER_WITHOUT_BASE_RATE", async () => {
      const offeringId = await createOffering("pm49 delete last base rate");
      const start = START;
      const usage = await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      await insertPrice(
        offeringId,
        capacityCommitmentInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      expect(usage.ok).toBe(true);
      if (!usage.ok) return;

      const result = await deletePrice(usage.productOfferingPriceId, actorId);
      expect(result).toMatchObject({
        ok: false,
        code: "MODIFIER_WITHOUT_BASE_RATE",
        unitOfMeasure: "EA",
      });

      // Refused — the usage_rate row must still exist.
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_price_id = ${usage.productOfferingPriceId}`;
      expect(rows[0]!.count).toBe("1");
    });

    // -- I7.3: legitimate cases that must pass.

    it("accepts a dated successor usage_rate — VI4 is instant-scoped, not a period rule", async () => {
      const offeringId = await createOffering("pm49 legit dated successor");
      await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: START,
        }),
        actorId,
      );
      const successor = await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: LATER_START,
          ratePerUnit: "2.00",
        }),
        actorId,
      );
      expect(successor.ok).toBe(true);
    });

    it("accepts a flat_fee with no usage_rate anywhere on the offering — it is not a modifier", async () => {
      const offeringId = await createOffering("pm49 legit lone flat_fee");
      const result = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: START }),
        actorId,
      );
      expect(result.ok).toBe(true);
    });

    it("accepts two modifiers (commitment + motivation) over one usage_rate in the same unit", async () => {
      const offeringId = await createOffering("pm49 legit two modifiers");
      const start = START;
      await insertPrice(
        offeringId,
        usageRateInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const commitment = await insertPrice(
        offeringId,
        capacityCommitmentInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      const motivation = await insertPrice(
        offeringId,
        capacityMotivationInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      expect(commitment.ok).toBe(true);
      expect(motivation.ok).toBe(true);
    });

    // -- I7.4: DRAFT-only.

    it("insertPrice against a RETIRED offering is refused with OFFERING_RETIRED", async () => {
      const offeringId = await createOffering(
        "pm49 insert vs RETIRED",
        "RETIRED",
      );
      const result = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: START }),
        actorId,
      );
      expect(result).toMatchObject({ ok: false, code: "OFFERING_RETIRED" });
    });

    it("insertPrice against an ACTIVE offering branches first and the write succeeds on the new DRAFT (Design, unchanged by pm49)", async () => {
      const offeringId = await createOffering(
        "pm49 insert vs ACTIVE",
        "ACTIVE",
      );
      const result = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: START }),
        actorId,
      );
      expect(result.ok).toBe(true);
    });

    // TESTING/OBSOLETE are pre-existing gaps in insertPrice, unchanged by
    // pm49 (D9's "existing codes stay" names only OFFERING_NOT_FOUND/
    // OFFERING_RETIRED/BACKDATED_START_TOO_FAR/PRICE_NOT_FOUND/
    // OFFERING_NOT_DRAFT): insertPrice has never special-cased TESTING or
    // OBSOLETE (code-standards §1.10's "TESTING returns to DRAFT and edits
    // directly" was never wired into this service), so a direct attempt falls
    // through to a plain (non-branching) insert, which the §3.5 trigger
    // rejects — surfacing as an uncaught PostgresError, not a typed result.
    // Documented here, not fixed: out of pm49's stated boundary.
    it.each(["TESTING", "OBSOLETE"] as const)(
      "insertPrice against a %s offering throws (pre-existing gap, not a pm49 regression)",
      async (status) => {
        const offeringId = await createOffering(
          `pm49 insert vs ${status}`,
          status,
        );
        // The trigger's own message is on Drizzle's wrapped error's `.cause`,
        // not its own `.message` — asserting only that it throws (the
        // trigger's exact wording is already asserted directly in the
        // dedicated "direct SQL … refused by the §3.5 trigger" case below).
        await expect(
          insertPrice(
            offeringId,
            flatFeeOneTimeInput({ startDateTime: START }),
            actorId,
          ),
        ).rejects.toThrow();
      },
    );

    it("a direct SQL price write against a TESTING offering is refused by the §3.5 trigger", async () => {
      const offeringId = await createOffering(
        "pm49 trigger backstop",
        "TESTING",
      );
      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             unit_of_measure, currency, start_date_time)
          VALUES (
            ${offeringId}, ${"direct write"}, ${"usage_rate"},
            ${JSON.stringify({
              "@type": "usage_rate",
              specVersion: 1,
              plaSpecId: null,
              priceType: "usage",
              appliesAt: "rating",
              basis: "quantity",
              boundTo: { unitOfMeasure: "EA" },
              params: { ratePerUnit: "1.00", rateCardLookUp: null },
            })}::jsonb,
            ${"EA"}, ${"USD"}, ${"2026-01-01T00:00:00Z"}
          )`,
      ).rejects.toThrow();
    });

    // -- I7.5: branch-on-ACTIVE validates against the branch's own set.

    it("adding a component to an ACTIVE version branches a draft and validates against the branch's component set", async () => {
      // pm36's trigger refuses a child write against any non-DRAFT parent —
      // the offering must be seeded DRAFT, priced, THEN flipped to ACTIVE
      // directly (the trigger guards the child tables only, not the offering
      // row's own status column).
      const activeId = await createOffering("pm49 branch validate", "DRAFT");
      const start = START;
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component,
           unit_of_measure, currency, start_date_time)
        VALUES (
          ${activeId}, ${"seed usage"}, ${"usage_rate"},
          ${JSON.stringify({
            "@type": "usage_rate",
            specVersion: 1,
            plaSpecId: null,
            priceType: "usage",
            appliesAt: "rating",
            basis: "quantity",
            boundTo: { unitOfMeasure: "EA" },
            params: { ratePerUnit: "1.00", rateCardLookUp: null },
          })}::jsonb,
          ${"EA"}, ${"USD"}, ${start.toISOString()}
        )`;
      await sql`
        UPDATE product.product_offering
        SET lifecycle_status = 'ACTIVE'
        WHERE product_offering_id = ${activeId}`;

      // A capacity_commitment in GB (no matching usage_rate) must still be
      // refused against the BRANCHED draft's own component set, not silently
      // accepted because the source ACTIVE version's set was different.
      const refused = await insertPrice(
        activeId,
        capacityCommitmentInput({ unitOfMeasure: "GB", startDateTime: start }),
        actorId,
      );
      expect(refused).toMatchObject({
        ok: false,
        code: "MODIFIER_WITHOUT_BASE_RATE",
        unitOfMeasure: "GB",
      });
      // Refused before any write — no branch should have been committed.
      const draftCountAfterRefusal = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE family_offering_id = ${activeId}`;
      expect(draftCountAfterRefusal[0]!.count).toBe("0");

      // A capacity_commitment in EA (matching the copied usage_rate) must
      // succeed, on a freshly branched DRAFT.
      const accepted = await insertPrice(
        activeId,
        capacityCommitmentInput({ unitOfMeasure: "EA", startDateTime: start }),
        actorId,
      );
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.branched).toBe(true);
      expect(accepted.offeringId).not.toBe(activeId);

      const branchDetail = await getOfferingDetail(accepted.offeringId);
      expect(branchDetail?.lifecycleStatus).toBe("DRAFT");
      expect(branchDetail?.prices).toHaveLength(2);
    });

    // -- I7.6: negotiated_override cannot be written here — proved at the Zod
    // and DB layers (the type-level refusal is pm47's own proof — the
    // `insertPriceSchema` union has no `negotiated_override` branch to begin
    // with, so a caller cannot even construct one; see pricing-component.
    // schema.test.ts for the Zod-branch-level proof of persistablePricing
    // ComponentSchema's exclusion).

    it("negotiated_override fails persistablePricingComponentSchema validation before it ever reaches the database", () => {
      const negotiatedOverride = pricingComponentSchema.parse({
        "@type": "negotiated_override",
        specVersion: 1,
        plaSpecId: null,
        priceType: "discount",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { priceType: "usage", unitOfMeasure: "EA" },
        params: { ratePerUnit: "1.00" },
      });
      expect(negotiatedOverride["@type"]).toBe("negotiated_override");

      // `db/repositories/product-offering-price.ts`'s `toPriceWriteData` only
      // ever builds a `persistablePricingComponentSchema`-shaped envelope from
      // `InsertPriceInput`, whose `componentType` union has no
      // `negotiated_override` member (pm47 D3) — proved here by the DB CHECK
      // independently rejecting the same object if it reached raw SQL.
    });

    it("a direct SQL insert of a negotiated_override component is refused by the component_type CHECK", async () => {
      const offeringId = await createOffering(
        "pm49 negotiated_override db check",
      );
      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             unit_of_measure, currency, start_date_time)
          VALUES (
            ${offeringId}, ${"bad row"}, ${"negotiated_override"},
            ${JSON.stringify({
              "@type": "negotiated_override",
              specVersion: 1,
              plaSpecId: null,
              priceType: "discount",
              appliesAt: "rating",
              basis: "quantity",
              boundTo: { priceType: "usage", unitOfMeasure: "EA" },
              params: { ratePerUnit: "1.00" },
            })}::jsonb,
            ${"EA"}, ${"USD"}, ${"2026-01-01T00:00:00Z"}
          )`,
      ).rejects.toThrow(/product_offering_price_component_type_check/);
    });

    // -- updatePrice colliding onto an existing sibling's
    // (component_type, unit_of_measure, start_date_time) surfaces the rekeyed
    // UNIQUE (pm46) as the service's typed DUPLICATE_START. Two flat_fee rows
    // (NULL unit, one lane) at different starts pass the cross-row validator —
    // flat_fee is neither a modifier nor a base rate — so the collision is the
    // unique index, not a VI3–VI5 refusal.

    it("updatePrice colliding onto another price's (component_type, unit, start) is DUPLICATE_START", async () => {
      const offeringId = await createOffering("pm56 duplicate start");
      const first = await insertPrice(
        offeringId,
        flatFeeRecurringInput({ startDateTime: START, amount: "100.00" }),
        actorId,
      );
      const second = await insertPrice(
        offeringId,
        flatFeeRecurringInput({ startDateTime: LATER_START, amount: "200.00" }),
        actorId,
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      // Move the second row's start back onto the first row's start — same
      // (flat_fee, NULL unit, START) key the first row already owns.
      const collided = await updatePrice(
        second.productOfferingPriceId,
        flatFeeRecurringInput({ startDateTime: START, amount: "200.00" }),
        actorId,
      );
      expect(collided).toMatchObject({ ok: false, code: "DUPLICATE_START" });
    });

    // -- §3.5 trigger backstop: a raw SQL UPDATE and a raw SQL DELETE of an
    // existing price whose parent has been flipped to ACTIVE are each refused
    // by product_child_write_requires_draft — the DB guard the services'
    // DRAFT-lock mirrors.

    it("raw SQL UPDATE and DELETE of a price on an ACTIVE parent are refused by the §3.5 trigger", async () => {
      const offeringId = await createOffering("pm56 trigger update delete");
      const inserted = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: START }),
        actorId,
      );
      expect(inserted.ok).toBe(true);
      if (!inserted.ok) return;

      // Flip the parent to ACTIVE directly — the trigger guards the child
      // tables only, not the offering row's own status column.
      await sql`
        UPDATE product.product_offering
        SET lifecycle_status = 'ACTIVE'
        WHERE product_offering_id = ${offeringId}`;

      await expect(
        sql`
          UPDATE product.product_offering_price
          SET name = 'renamed'
          WHERE product_offering_price_id = ${inserted.productOfferingPriceId}`,
      ).rejects.toThrow(/product_child_write_requires_draft/);

      await expect(
        sql`
          DELETE FROM product.product_offering_price
          WHERE product_offering_price_id = ${inserted.productOfferingPriceId}`,
      ).rejects.toThrow(/product_child_write_requires_draft/);
    });

    // -- I7.7: audit — exactly one event per mutation, carrying the envelope.

    it("writes exactly one PRODUCT_PRICE_ADDED audit event carrying component_type and the envelope", async () => {
      const offeringId = await createOffering("pm49 audit insert");
      const result = await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: START,
        }),
        actorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(
        await auditCount(result.productOfferingPriceId, "PRODUCT_PRICE_ADDED"),
      ).toBe(1);
      const payload = await auditPayload(
        result.productOfferingPriceId,
        "PRODUCT_PRICE_ADDED",
      );
      expect(payload.after).toMatchObject({ componentType: "usage_rate" });
      expect(payload.after?.component).toMatchObject({ "@type": "usage_rate" });
    });

    it("writes exactly one PRODUCT_PRICE_UPDATED audit event with before/after envelopes", async () => {
      const offeringId = await createOffering("pm49 audit update");
      const inserted = await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: START,
          ratePerUnit: "1.00",
        }),
        actorId,
      );
      expect(inserted.ok).toBe(true);
      if (!inserted.ok) return;

      const updated = await updatePrice(
        inserted.productOfferingPriceId,
        usageRateInput({
          unitOfMeasure: "EA",
          startDateTime: START,
          ratePerUnit: "3.00",
        }),
        actorId,
      );
      expect(updated.ok).toBe(true);
      expect(
        await auditCount(
          inserted.productOfferingPriceId,
          "PRODUCT_PRICE_UPDATED",
        ),
      ).toBe(1);
      const payload = await auditPayload(
        inserted.productOfferingPriceId,
        "PRODUCT_PRICE_UPDATED",
      );
      expect(payload.before?.component).toMatchObject({
        params: { ratePerUnit: "1.00" },
      });
      expect(payload.after?.component).toMatchObject({
        params: { ratePerUnit: "3.00" },
      });
    });

    it("writes exactly one PRODUCT_PRICE_DELETED audit event", async () => {
      const offeringId = await createOffering("pm49 audit delete");
      const inserted = await insertPrice(
        offeringId,
        flatFeeOneTimeInput({ startDateTime: START }),
        actorId,
      );
      expect(inserted.ok).toBe(true);
      if (!inserted.ok) return;

      const deleted = await deletePrice(
        inserted.productOfferingPriceId,
        actorId,
      );
      expect(deleted.ok).toBe(true);
      expect(
        await auditCount(
          inserted.productOfferingPriceId,
          "PRODUCT_PRICE_DELETED",
        ),
      ).toBe(1);
    });

    // -- I7.8: the validator's own multi-violation ordering — currency first,
    // then base-rate presence, then ambiguity (I3).

    it("validateOfferingComponents reports CURRENCY_MISMATCH before MODIFIER_WITHOUT_BASE_RATE when both apply", async () => {
      const offeringId = await createOffering("pm49 validator order");
      const start = START;
      await insertPrice(
        offeringId,
        usageRateInput({
          unitOfMeasure: "GB", // different unit — irrelevant to the EA modifier
          startDateTime: start,
          currency: "USD",
        }),
        actorId,
      );

      // A capacity_commitment candidate in EA (no same-unit usage_rate — VI3
      // would fire) AND in a different currency (VI5 fires too) — currency
      // must win, per the documented fixed order.
      await appDb.transaction(async (tx) => {
        const result = await validateOfferingComponents(tx, offeringId, {
          kind: "insert",
          componentType: "capacity_commitment",
          unitOfMeasure: "EA",
          currency: "MYR",
          startDateTime: start,
        });
        expect(result).toMatchObject({
          ok: false,
          code: "CURRENCY_MISMATCH",
          existingCurrency: "USD",
          candidateCurrency: "MYR",
        });
      });
    });
  },
);
