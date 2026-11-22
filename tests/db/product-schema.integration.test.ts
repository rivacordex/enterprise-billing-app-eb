import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Guardrail 13 (schema-diff, integration half), re-baselined by pm70 (0056) —
// on a database migrated FROM EMPTY. Also the DB arms of guardrails 43
// (completeness), 44 (type pinning) and the lane key (Inv. #2), all provoked by
// direct SQL so a green run means the DATABASE refuses, independently of Zod
// and the repository (pm70-spec I6.2–I6.5).
const databaseUrl = process.env.DATABASE_URL;

// Every name pm70 introduces (code-standards §6.39, §6.37, §6.38, §6.43) —
// identical in the SQL, the Drizzle mirror and here; each must be ≤ 63 bytes
// or Postgres silently truncates it.
const NEW_CONSTRAINTS: Record<string, string[]> = {
  product_spec_characteristic: [
    "product_spec_characteristic_pk",
    "product_spec_characteristic_spec_fk",
    "product_spec_characteristic_order_unique",
    "product_spec_characteristic_name_check",
  ],
  price_component_type: [
    "price_component_type_pk",
    "price_component_type_applies_at_check",
    "price_component_type_basis_check",
  ],
  price_component_price_type: [
    "price_component_price_type_pk",
    "price_component_price_type_type_fk",
  ],
  product_offering_price: [
    "product_offering_price_price_type_fk",
    "product_offering_price_id_type_unique",
    "product_offering_price_usage_rate_check",
    "product_offering_price_flat_fee_check",
    "product_offering_price_capacity_commitment_check",
    "product_offering_price_capacity_motivation_check",
  ],
  pop_usage_rate: [
    "pop_usage_rate_pkey",
    "pop_usage_rate_header_fk",
    "pop_usage_rate_type_check",
    "pop_usage_rate_rate_check",
    "pop_usage_rate_lookup_check",
  ],
  pop_flat_fee: [
    "pop_flat_fee_pkey",
    "pop_flat_fee_header_fk",
    "pop_flat_fee_type_check",
    "pop_flat_fee_amount_check",
  ],
  pop_capacity_commitment: [
    "pop_capacity_commitment_pkey",
    "pop_capacity_commitment_header_fk",
    "pop_capacity_commitment_type_check",
    "pop_capacity_commitment_quantity_check",
  ],
  pop_motivation_step: [
    "pop_motivation_step_pk",
    "pop_motivation_step_header_fk",
    "pop_motivation_step_type_check",
    "pop_motivation_step_quantity_check",
    "pop_motivation_step_rate_check",
  ],
};
const CHILD_TABLES = [
  "product_spec_characteristic",
  "pop_usage_rate",
  "pop_flat_fee",
  "pop_capacity_commitment",
  "pop_motivation_step",
];
const COMPLETE_TRIGGERS = [
  "product_offering_price_complete_ct",
  "pop_usage_rate_complete_ct",
  "pop_flat_fee_complete_ct",
  "pop_capacity_commitment_complete_ct",
  "pop_motivation_step_complete_ct",
];
const DRAFT_GUARD_TRIGGERS = CHILD_TABLES.map((t) => `${t}_draft_guard`);
const OTHER_NEW_NAMES = [
  "product_offering_price_lane_start_unique",
  "price_header_is_complete",
  "offering_price_v",
  ...COMPLETE_TRIGGERS,
  ...DRAFT_GUARD_TRIGGERS,
];

// The locked migrations, hashed with line endings normalized. 0056 extends the
// DRAFT guard by CREATE OR REPLACE and swaps the lane index in a new file —
// it never reopens these (Inv. #71, W1).
const LOCKED_MIGRATION_SHA256: Record<string, string> = {
  "0006_product.sql":
    "328b2ec2258ea2241be7ae3c5dcdea73096536684ac32e05a3d232fa5b15bb9c",
  "0040_product_family_guards.sql":
    "3c7915bdf4818da04b704c457e47d3d5d21100deeb09e1ce8ceb9bd209259c8d",
  "0049_product_price_lane_key.sql":
    "f82c0eeb200f6a31c58a308fbec162d33897f3e0dbac2db621c1d0e673b5c985",
};

type PriceSpec = {
  type:
    | "usage_rate"
    | "flat_fee"
    | "capacity_commitment"
    | "capacity_motivation";
  priceType?: string;
  unit?: string | null;
  periodLength?: number | null;
  periodType?: string | null;
  start?: string;
};

describe.skipIf(!databaseUrl)(
  "product schema integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    const SCHEMAS = [
      "billing",
      "customer",
      "product",
      "inventory",
      "ordering",
      "rating",
      "core",
      "drizzle",
    ];

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      // "product" holds FKs into "core", so it must drop first.
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await sql.end();
    });

    async function insertOffering(
      name: string,
      status = "DRAFT",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status)
        VALUES (${name}, false, true, false, ${status}::product.lifecycle_status)
        RETURNING product_offering_id AS id
      `;
      if (!row) throw new Error("Offering insert returned no row.");
      return row.id;
    }

    function defaults(spec: PriceSpec) {
      const priceType =
        spec.priceType ??
        {
          usage_rate: "usage",
          flat_fee: "recurring",
          capacity_commitment: "commitment",
          capacity_motivation: "discount",
        }[spec.type];
      const isFlat = spec.type === "flat_fee";
      const recurring = isFlat && priceType === "recurring";
      return {
        priceType,
        unit: spec.unit !== undefined ? spec.unit : isFlat ? null : "GB",
        periodLength:
          spec.periodLength !== undefined
            ? spec.periodLength
            : recurring
              ? 1
              : null,
        periodType:
          spec.periodType !== undefined
            ? spec.periodType
            : recurring
              ? "months"
              : null,
        start: spec.start ?? "2026-01-01T00:00:00Z",
      };
    }

    // Header only, inside the caller's transaction.
    async function insertHeader(
      tx: postgresjs.TransactionSql,
      offeringId: string,
      spec: PriceSpec,
    ): Promise<string> {
      const d = defaults(spec);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_type,
           unit_of_measure, recurring_charge_period_length,
           recurring_charge_period_type, currency, start_date_time)
        VALUES (${offeringId}, ${spec.type}, ${spec.type}, ${d.priceType},
                ${d.unit}, ${d.periodLength}, ${d.periodType}, 'MYR',
                ${d.start}::timestamptz)
        RETURNING product_offering_price_id AS id`;
      if (!row) throw new Error("Price insert returned no row.");
      return row.id;
    }

    async function insertChild(
      tx: postgresjs.TransactionSql,
      headerId: string,
      type: PriceSpec["type"],
    ): Promise<void> {
      switch (type) {
        case "usage_rate":
          await tx`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit)
                   VALUES (${headerId}, 1.5)`;
          return;
        case "flat_fee":
          await tx`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
                   VALUES (${headerId}, 100)`;
          return;
        case "capacity_commitment":
          await tx`INSERT INTO product.pop_capacity_commitment (product_offering_price_id, committed_quantity)
                   VALUES (${headerId}, 1000)`;
          return;
        case "capacity_motivation":
          await tx`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                   VALUES (${headerId}, 1000, 50), (${headerId}, 2000, 25)`;
          return;
      }
    }

    // Header + its subtype row(s) in ONE transaction — the only legal write.
    async function insertPrice(
      offeringId: string,
      spec: PriceSpec,
    ): Promise<string> {
      let id = "";
      await sql.begin(async (tx) => {
        id = await insertHeader(tx, offeringId, spec);
        await insertChild(tx, id, spec.type);
      });
      return id;
    }

    async function caught(fn: () => Promise<unknown>): Promise<{
      code?: string;
      constraint_name?: string;
      message: string;
    }> {
      try {
        await fn();
      } catch (e) {
        const err = e as {
          code?: string;
          constraint_name?: string;
          message: string;
        };
        return err;
      }
      throw new Error("expected the statement to be refused");
    }

    // ── I6.2 — the shape, migrated from empty ─────────────────────────────────

    test("the product schema holds the five legacy tables, the seven Normalize tables and the view", async () => {
      const tables = await sql<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'product' AND c.relkind = 'r'`;
      expect(tables.map((t) => t.relname).sort()).toEqual(
        [
          "product_offering",
          "product_specifications",
          "product_offering_price",
          "ratecard_version",
          "ratecard_ran_usage_lkp",
          "product_spec_characteristic",
          "price_component_type",
          "price_component_price_type",
          "pop_usage_rate",
          "pop_flat_fee",
          "pop_capacity_commitment",
          "pop_motivation_step",
        ].sort(),
      );
      const views = await sql<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'product' AND c.relkind IN ('v', 'm')`;
      expect(views.map((v) => v.relname)).toEqual(["offering_price_v"]);

      // The sequences are unchanged — the new tables use natural keys.
      const sequences = await sql<{ sequencename: string }[]>`
        SELECT sequencename FROM pg_sequences WHERE schemaname = 'product'`;
      expect(sequences.map((s) => s.sequencename).sort()).toEqual(
        [
          "product_offering_seq",
          "product_specifications_seq",
          "product_offering_price_seq",
          "ratecard_version_seq",
        ].sort(),
      );
    });

    test("price_component_type holds exactly the four plan §2.3 rows, commitment before motivation", async () => {
      const rows = await sql<
        {
          component_type: string;
          applies_at: string;
          basis: string;
          pla_spec_id: string | null;
          apply_order: number;
        }[]
      >`SELECT component_type, applies_at, basis, pla_spec_id, apply_order
          FROM product.price_component_type ORDER BY apply_order`;
      expect(rows.map(({ apply_order: _o, ...r }) => r)).toEqual([
        {
          component_type: "usage_rate",
          applies_at: "rating",
          basis: "quantity",
          pla_spec_id: null,
        },
        {
          component_type: "flat_fee",
          applies_at: "billing",
          basis: "flat",
          pla_spec_id: null,
        },
        {
          component_type: "capacity_commitment",
          applies_at: "post_aggregation",
          basis: "quantity",
          pla_spec_id: "PLA_CAPACITY_COMMITMENT",
        },
        {
          component_type: "capacity_motivation",
          applies_at: "post_aggregation",
          basis: "quantity",
          pla_spec_id: "PLA_CAPACITY_MOTIVATION",
        },
      ]);
      const order = new Map(rows.map((r) => [r.component_type, r.apply_order]));
      expect(order.get("capacity_commitment")).toBeLessThan(
        order.get("capacity_motivation") as number,
      );
    });

    test("price_component_price_type holds exactly the five seeded pairs", async () => {
      const rows = await sql<{ pair: string }[]>`
        SELECT component_type || '/' || price_type AS pair
          FROM product.price_component_price_type ORDER BY 1`;
      expect(rows.map((r) => r.pair)).toEqual(
        [
          "capacity_commitment/commitment",
          "capacity_motivation/discount",
          "flat_fee/oneTime",
          "flat_fee/recurring",
          "usage_rate/usage",
        ].sort(),
      );
    });

    test("every §6.39 constraint name exists on its table and every new name is ≤ 63 bytes", async () => {
      for (const [table, names] of Object.entries(NEW_CONSTRAINTS)) {
        const rows = await sql<{ conname: string }[]>`
          SELECT con.conname FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'product' AND c.relname = ${table}`;
        const present = rows.map((r) => r.conname);
        for (const name of names) {
          expect(present, `${table}.${name}`).toContain(name);
        }
      }
      for (const name of [
        ...Object.values(NEW_CONSTRAINTS).flat(),
        ...OTHER_NEW_NAMES,
      ]) {
        expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
      }
    });

    test("the lane key is the same-named unique INDEX on five plain columns, NULLS NOT DISTINCT (C14)", async () => {
      const [row] = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'product'
           AND indexname = 'product_offering_price_lane_start_unique'`;
      expect(row?.indexdef).toBeDefined();
      expect(row?.indexdef).toContain("CREATE UNIQUE INDEX");
      expect(row?.indexdef).toContain(
        "(product_offering_id, component_type, unit_of_measure, price_type, start_date_time)",
      );
      expect(row?.indexdef).toContain("NULLS NOT DISTINCT");
      expect(row?.indexdef).not.toContain("price_component");
      // An index, not a constraint — the object kind the service keys off.
      const cons = await sql`
        SELECT 1 FROM pg_constraint
         WHERE conname = 'product_offering_price_lane_start_unique'`;
      expect(cons).toHaveLength(0);
    });

    test("the five _complete_ct triggers are DEFERRABLE INITIALLY DEFERRED constraint triggers on price_header_is_complete()", async () => {
      const rows = await sql<
        {
          tgname: string;
          relname: string;
          tgdeferrable: boolean;
          tginitdeferred: boolean;
          is_constraint: boolean;
          fn: string;
        }[]
      >`
        SELECT t.tgname, c.relname, t.tgdeferrable, t.tginitdeferred,
               t.tgconstraint <> 0 AS is_constraint, p.proname AS fn
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE n.nspname = 'product' AND t.tgname LIKE '%\\_complete\\_ct'
         ORDER BY t.tgname`;
      expect(rows.map((r) => r.tgname)).toEqual([...COMPLETE_TRIGGERS].sort());
      for (const r of rows) {
        expect(r.tgdeferrable, r.tgname).toBe(true);
        expect(r.tginitdeferred, r.tgname).toBe(true);
        expect(r.is_constraint, r.tgname).toBe(true);
        expect(r.fn).toBe("price_header_is_complete");
        expect(`${r.relname}_complete_ct`).toBe(r.tgname);
      }
    });

    test("seven _draft_guard triggers fire child_write_requires_draft — 0040's two plus the five new tables", async () => {
      const rows = await sql<{ tgname: string; fn: string }[]>`
        SELECT t.tgname, p.proname AS fn
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE n.nspname = 'product' AND t.tgname LIKE '%\\_draft\\_guard'
         ORDER BY t.tgname`;
      expect(rows.map((r) => r.tgname)).toEqual(
        [
          "product_specifications_draft_guard",
          "product_offering_price_draft_guard",
          ...DRAFT_GUARD_TRIGGERS,
        ].sort(),
      );
      for (const r of rows) expect(r.fn).toBe("child_write_requires_draft");
    });

    test("the dropped objects are absent: pricing_steps_ok, component_type_check, envelope_type_check, both jsonb columns", async () => {
      const fns = await sql`
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'product' AND p.proname = 'pricing_steps_ok'`;
      expect(fns).toHaveLength(0);
      const cons = await sql`
        SELECT 1 FROM pg_constraint
         WHERE conname IN ('product_offering_price_component_type_check',
                           'product_offering_price_envelope_type_check')`;
      expect(cons).toHaveLength(0);
      const cols = await sql`
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'product'
           AND column_name IN ('price_component', 'product_spec_characteristics')`;
      expect(cols).toHaveLength(0);
      // No constraint anywhere in product still reads a JSON path. (\m…\M are
      // word boundaries, so the new price_component_type / _price_type FKs do
      // not match.)
      const jsonCons = await sql<{ conname: string }[]>`
        SELECT con.conname FROM pg_constraint con
          JOIN pg_namespace n ON n.oid = con.connamespace
         WHERE n.nspname = 'product'
           AND pg_get_constraintdef(con.oid) ~ '(\\mprice_component\\M|->>|#>)'`;
      expect(jsonCons).toEqual([]);
    });

    test("the header's price_type is NOT NULL", async () => {
      const [row] = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'product' AND table_name = 'product_offering_price'
           AND column_name = 'price_type'`;
      expect(row?.is_nullable).toBe("NO");
    });

    test("the view exposes p.* plus the contract columns, owner-privileged (no security_invoker)", async () => {
      const cols = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'product' AND table_name = 'offering_price_v'
         ORDER BY ordinal_position`;
      expect(cols.map((c) => c.column_name)).toEqual([
        "product_offering_price_id",
        "product_offering_id",
        "name",
        "component_type",
        "recurring_charge_period_length",
        "recurring_charge_period_type",
        "unit_of_measure",
        "currency",
        "gl_code",
        "policy",
        "start_date_time",
        "created_at",
        "price_type",
        "applies_at",
        "basis",
        "pla_spec_id",
        "rate_per_unit",
        "rate_card_lookup",
        "amount",
        "committed_quantity",
        "steps",
      ]);
      const [opts] = await sql<{ reloptions: string[] | null }[]>`
        SELECT c.reloptions FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'product' AND c.relname = 'offering_price_v'`;
      expect(opts?.reloptions ?? []).not.toContain("security_invoker=true");
    });

    test("the view derives pla_spec_id and returns steps as JSON numbers ordered by above_quantity", async () => {
      const offeringId = await insertOffering("View Projection Offering");
      const plain = await insertPrice(offeringId, { type: "usage_rate" });
      let carded = "";
      await sql.begin(async (tx) => {
        carded = await insertHeader(tx, offeringId, {
          type: "usage_rate",
          unit: "MB",
        });
        await tx`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit, rate_card_lookup)
                 VALUES (${carded}, 2, 'CARD_A')`;
      });
      const motivation = await insertPrice(offeringId, {
        type: "capacity_motivation",
      });
      const rows = await sql<
        {
          product_offering_price_id: string;
          pla_spec_id: string | null;
          steps: unknown;
        }[]
      >`SELECT product_offering_price_id, pla_spec_id, steps
          FROM product.offering_price_v WHERE product_offering_id = ${offeringId}`;
      const byId = new Map(rows.map((r) => [r.product_offering_price_id, r]));
      expect(byId.get(plain)?.pla_spec_id).toBeNull();
      expect(byId.get(carded)?.pla_spec_id).toBe("PLA_USAGE_RATE");
      expect(byId.get(motivation)?.pla_spec_id).toBe("PLA_CAPACITY_MOTIVATION");
      const steps = byId.get(motivation)?.steps as {
        aboveQuantity: unknown;
        ratePerUnit: unknown;
      }[];
      expect(steps.map((s) => s.aboveQuantity)).toEqual([1000, 2000]);
      for (const s of steps) {
        expect(typeof s.aboveQuantity).toBe("number");
        expect(typeof s.ratePerUnit).toBe("number");
      }
    });

    test("0006_product.sql, 0040_product_family_guards.sql and 0049_product_price_lane_key.sql are byte-identical to the committed baseline", () => {
      for (const [file, expected] of Object.entries(LOCKED_MIGRATION_SHA256)) {
        const text = readFileSync(
          join(process.cwd(), "db", "migrations", file),
          "utf8",
        ).replace(/\r\n/g, "\n");
        expect(createHash("sha256").update(text).digest("hex"), file).toBe(
          expected,
        );
      }
    });

    // ── I6.3 — type pinning (guardrail 44, DB arm) ────────────────────────────
    // Replaces the old "component_type disagrees with its envelope @type" test:
    // the mismatch is now unrepresentable, so it fails as an FK violation.

    test("a pop_flat_fee row for a usage_rate header is an FK violation (Inv. #62)", async () => {
      const offeringId = await insertOffering("Pinning Offering");
      const headerId = await insertPrice(offeringId, { type: "usage_rate" });
      const err = await caught(
        () =>
          sql`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
              VALUES (${headerId}, 10)`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("pop_flat_fee_header_fk");
    });

    test("a subtype row cannot claim another type through its pinned column", async () => {
      const offeringId = await insertOffering("Pinned Column Offering");
      const headerId = await insertPrice(offeringId, { type: "flat_fee" });
      const err = await caught(
        () =>
          sql`INSERT INTO product.pop_usage_rate (product_offering_price_id, component_type, rate_per_unit)
              VALUES (${headerId}, 'flat_fee', 1)`,
      );
      expect(err.code).toBe("23514");
      expect(err.constraint_name).toBe("pop_usage_rate_type_check");
    });

    test("a header with an unseeded pair is refused: (usage_rate, recurring) by the pair FK", async () => {
      const offeringId = await insertOffering("Pair Offering");
      const err = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, {
            type: "usage_rate",
            priceType: "recurring",
          });
          await insertChild(tx, id, "usage_rate");
        }),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("product_offering_price_price_type_fk");
    });

    test("a header with the unseeded pair (flat_fee, usage) is refused — flat_fee_check fires first (CHECKs run before FKs)", async () => {
      // D8's flat_fee body admits only price_type 'recurring' / 'oneTime', so
      // for flat_fee the CHECK refuses an unseeded pair before the pair FK is
      // evaluated. Either way the row cannot exist.
      const offeringId = await insertOffering("Pair Offering 2");
      const err = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, {
            type: "flat_fee",
            priceType: "usage",
            periodLength: null,
            periodType: null,
          });
          await insertChild(tx, id, "flat_fee");
        }),
      );
      expect(err.code).toBe("23514");
      expect(err.constraint_name).toBe("product_offering_price_flat_fee_check");
    });

    test("an unknown component_type is refused by the pair FK (component_type_check is gone)", async () => {
      const offeringId = await insertOffering("Bogus Type Offering");
      const err = await caught(
        () =>
          sql`INSERT INTO product.product_offering_price
                (product_offering_id, name, component_type, price_type, currency, start_date_time)
              VALUES (${offeringId}, 'Bogus', 'bogus', 'usage', 'MYR', '2026-03-01T00:00:00Z')`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("product_offering_price_price_type_fk");
    });

    test("a bare UPDATE of component_type on a header with a subtype row fails the FK (Inv. #70)", async () => {
      const offeringId = await insertOffering("Type Change Offering");
      const headerId = await insertPrice(offeringId, {
        type: "capacity_commitment",
      });
      const err = await caught(
        () =>
          sql`UPDATE product.product_offering_price
                 SET component_type = 'usage_rate', price_type = 'usage'
               WHERE product_offering_price_id = ${headerId}`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("pop_capacity_commitment_header_fk");
    });

    test("the §1.50 order (delete subtype → update header → insert subtype) changes a DRAFT header's type in one transaction", async () => {
      const offeringId = await insertOffering("Type Change Order Offering");
      const headerId = await insertPrice(offeringId, {
        type: "capacity_commitment",
      });
      await sql.begin(async (tx) => {
        await tx`DELETE FROM product.pop_capacity_commitment WHERE product_offering_price_id = ${headerId}`;
        await tx`UPDATE product.product_offering_price
                    SET component_type = 'usage_rate', price_type = 'usage'
                  WHERE product_offering_price_id = ${headerId}`;
        await insertChild(tx, headerId, "usage_rate");
      });
      const [row] = await sql<{ component_type: string }[]>`
        SELECT component_type FROM product.offering_price_v
         WHERE product_offering_price_id = ${headerId}`;
      expect(row?.component_type).toBe("usage_rate");
    });

    // ── I6.4 — completeness at COMMIT (guardrail 43, DB arm) ──────────────────

    test("a header committed alone is refused with 23514 at COMMIT (Inv. #63)", async () => {
      const offeringId = await insertOffering("Lonely Header Offering");
      const err = await caught(() =>
        sql.begin(async (tx) => {
          await insertHeader(tx, offeringId, { type: "usage_rate" });
        }),
      );
      expect(err.code).toBe("23514");
      expect(err.message).toContain("product_price_header_incomplete");
      const rows = await sql`
        SELECT 1 FROM product.product_offering_price WHERE product_offering_id = ${offeringId}`;
      expect(rows).toHaveLength(0);
    });

    test("a capacity_motivation header with zero steps is refused at COMMIT", async () => {
      const offeringId = await insertOffering("No Steps Offering");
      const err = await caught(() =>
        sql.begin(async (tx) => {
          await insertHeader(tx, offeringId, { type: "capacity_motivation" });
        }),
      );
      expect(err.code).toBe("23514");
      expect(err.message).toContain("product_price_header_incomplete");
    });

    test("deleting a DRAFT motivation's only step and committing is refused", async () => {
      const offeringId = await insertOffering("Last Step Offering");
      let headerId = "";
      await sql.begin(async (tx) => {
        headerId = await insertHeader(tx, offeringId, {
          type: "capacity_motivation",
        });
        await tx`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                 VALUES (${headerId}, 500, 5)`;
      });
      const err = await caught(
        () =>
          sql`DELETE FROM product.pop_motivation_step WHERE product_offering_price_id = ${headerId}`,
      );
      expect(err.code).toBe("23514");
      expect(err.message).toContain("product_price_header_incomplete");
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM product.pop_motivation_step
         WHERE product_offering_price_id = ${headerId}`;
      expect(row?.n).toBe("1");
    });

    test("deleting one of two steps is accepted — at least one remains", async () => {
      const offeringId = await insertOffering("Two Steps Offering");
      const headerId = await insertPrice(offeringId, {
        type: "capacity_motivation",
      });
      await sql`DELETE FROM product.pop_motivation_step
                 WHERE product_offering_price_id = ${headerId} AND above_quantity = 2000`;
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM product.pop_motivation_step
         WHERE product_offering_price_id = ${headerId}`;
      expect(row?.n).toBe("1");
    });

    test("moving a DRAFT header's only subtype row to another header is refused at COMMIT", async () => {
      const offeringId = await insertOffering("Moved Child Offering");
      const fromHeader = await insertPrice(offeringId, { type: "flat_fee" });
      const err = await caught(() =>
        sql.begin(async (tx) => {
          // A second flat_fee header in its own lane (oneTime), left childless
          // so the move is what completes it — and what empties fromHeader.
          const toHeader = await insertHeader(tx, offeringId, {
            type: "flat_fee",
            priceType: "oneTime",
          });
          await tx`UPDATE product.pop_flat_fee SET product_offering_price_id = ${toHeader}
                   WHERE product_offering_price_id = ${fromHeader}`;
        }),
      );
      expect(err.code).toBe("23514");
      expect(err.message).toContain("product_price_header_incomplete");
      expect(err.message).toContain(fromHeader);
    });

    test("moving every step off a DRAFT motivation is refused at COMMIT", async () => {
      const offeringId = await insertOffering("Moved Steps Offering");
      const fromHeader = await insertPrice(offeringId, {
        type: "capacity_motivation",
      });
      const err = await caught(() =>
        sql.begin(async (tx) => {
          const toHeader = await insertHeader(tx, offeringId, {
            type: "capacity_motivation",
            unit: "MB",
          });
          await tx`UPDATE product.pop_motivation_step SET product_offering_price_id = ${toHeader}
                   WHERE product_offering_price_id = ${fromHeader}`;
        }),
      );
      expect(err.code).toBe("23514");
      expect(err.message).toContain("product_price_header_incomplete");
      expect(err.message).toContain(fromHeader);
    });

    test("header + child in one transaction is accepted for every type — header first (the subtype FKs are not deferrable)", async () => {
      const offeringId = await insertOffering("Complete Offering");
      for (const type of [
        "usage_rate",
        "flat_fee",
        "capacity_commitment",
        "capacity_motivation",
      ] as const) {
        await insertPrice(offeringId, { type });
      }
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM product.product_offering_price
         WHERE product_offering_id = ${offeringId}`;
      expect(row?.n).toBe("4");
      // Child first is refused at once, not at COMMIT.
      const childFirst = await caught(() =>
        sql.begin(async (tx) => {
          await tx`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
                   VALUES ('PRDOFP_NOT_YET_INSERTED', 1)`;
        }),
      );
      expect(childFirst.code).toBe("23503");
      expect(childFirst.constraint_name).toBe("pop_flat_fee_header_fk");
    });

    test("two steps at one above_quantity is a PK violation", async () => {
      const offeringId = await insertOffering("Dup Step Offering");
      const err = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, {
            type: "capacity_motivation",
          });
          await tx`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                   VALUES (${id}, 1000, 50), (${id}, 1000.000000, 40)`;
        }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("pop_motivation_step_pk");
    });

    test("money and quantity CHECKs refuse a negative rate and a zero quantity", async () => {
      const offeringId = await insertOffering("Bounds Offering");
      const negative = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, { type: "usage_rate" });
          await tx`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit)
                   VALUES (${id}, -1)`;
        }),
      );
      expect(negative.constraint_name).toBe("pop_usage_rate_rate_check");
      const zero = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, {
            type: "capacity_commitment",
            start: "2026-05-01T00:00:00Z",
          });
          await tx`INSERT INTO product.pop_capacity_commitment (product_offering_price_id, committed_quantity)
                   VALUES (${id}, 0)`;
        }),
      );
      expect(zero.constraint_name).toBe(
        "pop_capacity_commitment_quantity_check",
      );
      const blank = await caught(() =>
        sql.begin(async (tx) => {
          const id = await insertHeader(tx, offeringId, {
            type: "usage_rate",
            start: "2026-06-01T00:00:00Z",
          });
          await tx`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit, rate_card_lookup)
                   VALUES (${id}, 1, '   ')`;
        }),
      );
      expect(blank.constraint_name).toBe("pop_usage_rate_lookup_check");
    });

    // ── I6.5 — the lane (Inv. #2) ─────────────────────────────────────────────

    test("two recurring flat_fee prices at one start collide on product_offering_price_lane_start_unique (23505)", async () => {
      const offeringId = await insertOffering("Lane Offering");
      await insertPrice(offeringId, { type: "flat_fee" });
      const err = await caught(() =>
        insertPrice(offeringId, { type: "flat_fee" }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe(
        "product_offering_price_lane_start_unique",
      );
    });

    test("a recurring and a one-time flat_fee at one start are separate lanes — accepted", async () => {
      const offeringId = await insertOffering("Two Lanes Offering");
      await insertPrice(offeringId, { type: "flat_fee" });
      await insertPrice(offeringId, { type: "flat_fee", priceType: "oneTime" });
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM product.product_offering_price
         WHERE product_offering_id = ${offeringId}`;
      expect(row?.n).toBe("2");
    });

    test("the JSON-free per-type CHECKs still enforce unit/period shape", async () => {
      const offeringId = await insertOffering("Shape Offering");
      const noUnit = await caught(() =>
        insertPrice(offeringId, { type: "usage_rate", unit: null }),
      );
      expect(noUnit.code).toBe("23514");
      expect(noUnit.constraint_name).toBe(
        "product_offering_price_usage_rate_check",
      );
      const oneTimeWithPeriod = await caught(() =>
        insertPrice(offeringId, {
          type: "flat_fee",
          priceType: "oneTime",
          periodLength: 1,
          periodType: "months",
        }),
      );
      expect(oneTimeWithPeriod.constraint_name).toBe(
        "product_offering_price_flat_fee_check",
      );
      const recurringNoPeriod = await caught(() =>
        insertPrice(offeringId, {
          type: "flat_fee",
          periodLength: null,
          periodType: null,
        }),
      );
      expect(recurringNoPeriod.constraint_name).toBe(
        "product_offering_price_flat_fee_check",
      );
    });

    // ── Unchanged surface ─────────────────────────────────────────────────────

    test("inserted offering rows get PRDOFR-format IDs from the column default", async () => {
      const id = await insertOffering("Test Offering");
      expect(id).toMatch(/^PRDOFR\d{8}$/);
    });

    test("invalid lifecycle_status is rejected", async () => {
      await expect(
        sql`
          INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only, lifecycle_status)
          VALUES ('Bad Status Offering', false, true, false, 'BOGUS')
        `,
      ).rejects.toThrow();
    });

    test("a currency that is not a 3-character code is rejected (currency_check)", async () => {
      const offeringId = await insertOffering("Invalid Currency Offering");
      await expect(
        sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO product.product_offering_price
              (product_offering_id, name, component_type, price_type,
               recurring_charge_period_length, recurring_charge_period_type,
               currency, start_date_time)
            VALUES (${offeringId}, 'Bad Currency', 'flat_fee', 'recurring', 1,
                    'months', 'US', '2026-03-03T00:00:00Z')
            RETURNING product_offering_price_id AS id`;
          await insertChild(tx, row?.id as string, "flat_fee");
        }),
      ).rejects.toThrow("product_offering_price_currency_check");
    });

    test("last_edited_by FK to a nonexistent user is rejected", async () => {
      await expect(
        sql`
          INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only, last_edited_by)
          VALUES ('Bad FK Offering', false, true, false, 'nonexistent-user-id')
        `,
      ).rejects.toThrow();
    });

    test("the core.permissions row 'products' exists after migration", async () => {
      const rows = await sql<{ permission_name: string }[]>`
        SELECT permission_name FROM core.permissions WHERE permission_name = 'products'
      `;
      expect(rows).toHaveLength(1);
    });
  },
);
