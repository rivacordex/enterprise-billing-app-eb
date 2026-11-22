import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { canonicalDecimalString } from "@/lib/decimal-string";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Guardrail 50 (pm70-spec D12, prodmgmt Inv. #71) — 0056's backfill is proven
// lossless against a POPULATED pre-state, and a corrupt row aborts it with
// nothing dropped and nothing recorded.
//
// THIS IS THE ONLY TEST IN THE TREE THAT APPLIES A MIGRATION TO A POPULATED
// DATABASE. Do not "simplify" it to a from-empty run: an empty database has
// nothing to backfill, so the verification block would pass vacuously.
//
// The pre-state cannot come from the seeds — after pm73 they write through the
// repository and can no longer produce a 0055-shaped database — so it is one
// committed fixture, tests/fixtures/product/pre-0056-catalog.json, captured by
// pm70 from a freshly seeded 0055 database (db:setup seeds + db:seed-sample +
// db:seed-sample-5g + db:seed-demo), never written by hand.
//
// Flow, per describe: drop the schemas → migrate a TEMPORARY folder holding
// 0001–0055 and a journal truncated at idx 55 → load the fixture with raw SQL in
// guard-legal order → migrate the real folder, which applies exactly 0056 (its
// `when` is the only one newer than the last applied entry).
//
// The envelope reconstruction below is done in TypeScript from the view and
// price_component_type, independently of the SQL verify block inside 0056 — so
// the migration is not grading its own homework.
const databaseUrl = process.env.DATABASE_URL;

const MIGRATIONS = join(process.cwd(), "db", "migrations");
const FIXTURE = join(
  process.cwd(),
  "tests",
  "fixtures",
  "product",
  "pre-0056-catalog.json",
);
const LAST_PRE_STATE_IDX = 55;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Envelope = { [k: string]: Json } & {
  "@type": string;
  params: { [k: string]: Json };
};

type FixtureOffering = {
  product_offering_id: string;
  name: string;
  is_bundle: boolean;
  is_sellable: boolean;
  billing_only: boolean;
  lifecycle_status: string;
  version: number;
  family_offering_id: string | null;
};
type FixtureSpec = {
  product_spec_id: string;
  ref_product_offering_id: string;
  name: string;
  is_mandatory: boolean;
  is_default: boolean;
  default_value: string | null;
  product_spec_characteristics: Record<string, string>;
};
type FixturePrice = {
  product_offering_price_id: string;
  product_offering_id: string;
  name: string;
  component_type: string;
  price_component: Envelope;
  recurring_charge_period_length: number | null;
  recurring_charge_period_type: string | null;
  unit_of_measure: string | null;
  currency: string;
  gl_code: string | null;
  policy: string | null;
  start_date_time: string;
};
type Fixture = {
  offerings: FixtureOffering[];
  specifications: FixtureSpec[];
  prices: FixturePrice[];
};

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

const SCHEMAS = [
  "inventory",
  "ordering",
  "billing",
  "customer",
  "product",
  "rating",
  "core",
  "drizzle",
  "partman",
];

async function dropAll(sql: postgresjs.Sql): Promise<void> {
  for (const s of SCHEMAS) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

// A migrations folder holding copies of 0001–0055 and a journal truncated at
// idx 55. The migrator reads only the journal and the .sql files.
function buildPreStateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm70-pre-0056-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= LAST_PRE_STATE_IDX);
  for (const entry of journal.entries) {
    copyFileSync(
      join(MIGRATIONS, `${entry.tag}.sql`),
      join(dir, `${entry.tag}.sql`),
    );
  }
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify(journal, null, 2),
  );
  return dir;
}

async function migrateFolder(
  sql: postgresjs.Sql,
  migrationsFolder: string,
): Promise<void> {
  await migrate(drizzle(sql), {
    migrationsFolder,
    migrationsSchema: "drizzle",
  });
}

// Guard-legal load order (the DRAFT guard is live in 0055): every offering is
// inserted DRAFT and as its own family (so no two open versions share a
// family), its specs and prices are inserted, then statuses are set, and only
// then the family links — at which point the recorded statuses already satisfy
// the one-open / one-active indexes.
async function loadFixture(sql: postgresjs.Sql): Promise<void> {
  for (const o of fixture.offerings) {
    await sql`
      INSERT INTO product.product_offering
        (product_offering_id, name, is_bundle, is_sellable, billing_only, version)
      VALUES (${o.product_offering_id}, ${o.name}, ${o.is_bundle},
              ${o.is_sellable}, ${o.billing_only}, ${o.version})`;
  }
  for (const s of fixture.specifications) {
    await sql`
      INSERT INTO product.product_specifications
        (product_spec_id, ref_product_offering_id, name, is_mandatory,
         is_default, default_value, product_spec_characteristics)
      VALUES (${s.product_spec_id}, ${s.ref_product_offering_id}, ${s.name},
              ${s.is_mandatory}, ${s.is_default}, ${s.default_value},
              ${JSON.stringify(s.product_spec_characteristics)}::jsonb)`;
  }
  for (const p of fixture.prices) {
    await sql`
      INSERT INTO product.product_offering_price
        (product_offering_price_id, product_offering_id, name, component_type,
         price_component, recurring_charge_period_length,
         recurring_charge_period_type, unit_of_measure, currency, gl_code,
         policy, start_date_time)
      VALUES (${p.product_offering_price_id}, ${p.product_offering_id},
              ${p.name}, ${p.component_type},
              ${JSON.stringify(p.price_component)}::jsonb,
              ${p.recurring_charge_period_length},
              ${p.recurring_charge_period_type}, ${p.unit_of_measure},
              ${p.currency}, ${p.gl_code}, ${p.policy},
              ${p.start_date_time}::timestamptz)`;
  }
  for (const o of fixture.offerings) {
    await sql`
      UPDATE product.product_offering
         SET lifecycle_status = ${o.lifecycle_status}::product.lifecycle_status
       WHERE product_offering_id = ${o.product_offering_id}`;
  }
  for (const o of fixture.offerings) {
    if (o.family_offering_id === null) continue;
    await sql`
      UPDATE product.product_offering
         SET family_offering_id = ${o.family_offering_id}
       WHERE product_offering_id = ${o.product_offering_id}`;
  }
}

async function columnExists(
  sql: postgresjs.Sql,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'product' AND table_name = ${table}
       AND column_name = ${column}`;
  return rows.length === 1;
}

// Money normalized on both sides (the same comparison the migration runs):
// the stored string may carry trailing zeros ("5500.00") numeric cannot keep.
function normalizeMoney(envelope: Envelope): Envelope {
  const params: { [k: string]: Json } = { ...envelope.params };
  for (const key of ["ratePerUnit", "amount"]) {
    if (typeof params[key] === "string") {
      params[key] = canonicalDecimalString(params[key]);
    }
  }
  if (Array.isArray(params.steps)) {
    params.steps = params.steps.map((step) => {
      const s = { ...(step as { [k: string]: Json }) };
      if (typeof s.ratePerUnit === "string") {
        s.ratePerUnit = canonicalDecimalString(s.ratePerUnit);
      }
      return s;
    });
  }
  return { ...envelope, params };
}

type ViewRow = {
  product_offering_price_id: string;
  component_type: string;
  price_type: string;
  unit_of_measure: string | null;
  applies_at: string;
  basis: string;
  pla_spec_id: string | null;
  rate_per_unit: string | null;
  rate_card_lookup: string | null;
  amount: string | null;
  committed_quantity: string | null;
  steps: { aboveQuantity: number; ratePerUnit: number }[] | null;
};

// The envelope rebuilt from the view's columns plus price_component_type (via
// the view's applies_at / basis / pla_spec_id) — no constant from TypeScript.
function envelopeFromView(row: ViewRow): Envelope {
  const params: { [k: string]: Json } = (() => {
    switch (row.component_type) {
      case "usage_rate":
        return {
          ratePerUnit: canonicalDecimalString(row.rate_per_unit as string),
          rateCardLookUp: row.rate_card_lookup,
        };
      case "flat_fee":
        return { amount: canonicalDecimalString(row.amount as string) };
      case "capacity_commitment":
        return { committedQuantity: Number(row.committed_quantity) };
      case "capacity_motivation":
        return {
          steps: (row.steps ?? []).map((s) => ({
            aboveQuantity: s.aboveQuantity,
            ratePerUnit: canonicalDecimalString(String(s.ratePerUnit)),
          })),
        };
      default:
        throw new Error(`unknown component_type ${row.component_type}`);
    }
  })();
  return {
    "@type": row.component_type,
    specVersion: 1,
    plaSpecId: row.pla_spec_id,
    priceType: row.price_type,
    appliesAt: row.applies_at,
    basis: row.basis,
    boundTo:
      row.component_type === "flat_fee"
        ? null
        : { unitOfMeasure: row.unit_of_measure },
    params,
  };
}

function countOf(type: string): number {
  return fixture.prices.filter((p) => p.component_type === type).length;
}

describe.skipIf(!databaseUrl)(
  "guardrail 50 — 0056 backfill against the seeded pre-state (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let preStateFolder: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // Sanity: the fixture must exercise every branch of the backfill.
      for (const type of [
        "usage_rate",
        "flat_fee",
        "capacity_commitment",
        "capacity_motivation",
      ]) {
        expect(countOf(type), `fixture has no ${type} price`).toBeGreaterThan(
          0,
        );
      }
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      preStateFolder = buildPreStateFolder();
      await dropAll(sql);
      await migrateFolder(sql, preStateFolder);
      await loadFixture(sql);
      await migrateFolder(sql, MIGRATIONS);
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
      if (preStateFolder)
        rmSync(preStateFolder, { recursive: true, force: true });
    }, 120_000);

    it("applied exactly 0056 on top of the pre-state", async () => {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`;
      expect(Number(row?.n)).toBe(LAST_PRE_STATE_IDX + 1);
    });

    it("the two jsonb columns are gone", async () => {
      expect(
        await columnExists(sql, "product_offering_price", "price_component"),
      ).toBe(false);
      expect(
        await columnExists(
          sql,
          "product_specifications",
          "product_spec_characteristics",
        ),
      ).toBe(false);
    });

    it("headers, specifications and offerings all survived", async () => {
      const [counts] = await sql<
        { offerings: string; specs: string; prices: string }[]
      >`
        SELECT (SELECT count(*) FROM product.product_offering)::text AS offerings,
               (SELECT count(*) FROM product.product_specifications)::text AS specs,
               (SELECT count(*) FROM product.product_offering_price)::text AS prices`;
      expect(Number(counts?.offerings)).toBe(fixture.offerings.length);
      expect(Number(counts?.specs)).toBe(fixture.specifications.length);
      expect(Number(counts?.prices)).toBe(fixture.prices.length);
    });

    it("row counts per new table equal the fixture's component and characteristic counts", async () => {
      const [c] = await sql<
        {
          usage: string;
          flat: string;
          commitment: string;
          steps: string;
          chars: string;
        }[]
      >`
        SELECT (SELECT count(*) FROM product.pop_usage_rate)::text AS usage,
               (SELECT count(*) FROM product.pop_flat_fee)::text AS flat,
               (SELECT count(*) FROM product.pop_capacity_commitment)::text AS commitment,
               (SELECT count(*) FROM product.pop_motivation_step)::text AS steps,
               (SELECT count(*) FROM product.product_spec_characteristic)::text AS chars`;
      const expectedSteps = fixture.prices
        .filter((p) => p.component_type === "capacity_motivation")
        .reduce(
          (n, p) => n + (p.price_component.params.steps as Json[]).length,
          0,
        );
      const expectedChars = fixture.specifications.reduce(
        (n, s) => n + Object.keys(s.product_spec_characteristics).length,
        0,
      );
      expect(Number(c?.usage)).toBe(countOf("usage_rate"));
      expect(Number(c?.flat)).toBe(countOf("flat_fee"));
      expect(Number(c?.commitment)).toBe(countOf("capacity_commitment"));
      expect(Number(c?.steps)).toBe(expectedSteps);
      expect(Number(c?.chars)).toBe(expectedChars);
    });

    it("every header's envelope is reconstructible from the view + price_component_type (money compared canonically)", async () => {
      const rows = await sql<ViewRow[]>`
        SELECT product_offering_price_id, component_type, price_type,
               unit_of_measure, applies_at, basis, pla_spec_id,
               rate_per_unit::text AS rate_per_unit, rate_card_lookup,
               amount::text AS amount,
               committed_quantity::text AS committed_quantity, steps
          FROM product.offering_price_v`;
      const byId = new Map(rows.map((r) => [r.product_offering_price_id, r]));
      expect(byId.size).toBe(fixture.prices.length);
      for (const price of fixture.prices) {
        const row = byId.get(price.product_offering_price_id);
        expect(row, price.product_offering_price_id).toBeDefined();
        expect(
          envelopeFromView(row as ViewRow),
          price.product_offering_price_id,
        ).toEqual(normalizeMoney(price.price_component));
      }
    });

    it("every characteristic set reads back equal, in the order it rendered in before (display_order 1…n)", async () => {
      const rows = await sql<
        {
          product_spec_id: string;
          char_name: string;
          char_value: string;
          display_order: number;
        }[]
      >`
        SELECT product_spec_id, char_name, char_value, display_order
          FROM product.product_spec_characteristic
         ORDER BY product_spec_id, display_order`;
      for (const spec of fixture.specifications) {
        const own = rows.filter(
          (r) => r.product_spec_id === spec.product_spec_id,
        );
        expect(own.map((r) => Number(r.display_order))).toEqual(
          own.map((_, i) => i + 1),
        );
        const rebuilt = Object.fromEntries(
          own.map((r) => [r.char_name, r.char_value]),
        );
        expect(rebuilt, spec.product_spec_id).toEqual(
          spec.product_spec_characteristics,
        );
        // The fixture holds the jsonb's own key order — the order the panel
        // rendered in under 0055. The backfill froze exactly that order.
        expect(Object.keys(rebuilt)).toEqual(
          Object.keys(spec.product_spec_characteristics),
        );
      }
    });

    it("price_type equals the envelope's priceType for every header", async () => {
      const rows = await sql<
        { product_offering_price_id: string; price_type: string }[]
      >`SELECT product_offering_price_id, price_type FROM product.product_offering_price`;
      const byId = new Map(
        rows.map((r) => [r.product_offering_price_id, r.price_type]),
      );
      for (const price of fixture.prices) {
        expect(byId.get(price.product_offering_price_id)).toBe(
          price.price_component.priceType,
        );
      }
    });
  },
);

describe.skipIf(!databaseUrl)(
  "guardrail 50 — a corrupt envelope aborts 0056 with nothing dropped (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let preStateFolder: string;
    let migrationError: unknown;
    let corruptedId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      preStateFolder = buildPreStateFolder();
      await dropAll(sql);
      await migrateFolder(sql, preStateFolder);
      await loadFixture(sql);

      // Corrupt one usage_rate envelope so every 0055 JSON CHECK still passes
      // but its appliesAt disagrees with price_component_type (the rebuilt
      // envelope takes appliesAt from the reference table). The DRAFT guard is
      // lifted around the corruption only — the row may sit on a released
      // version.
      const target = fixture.prices.find(
        (p) => p.component_type === "usage_rate",
      );
      if (!target) throw new Error("fixture has no usage_rate price");
      corruptedId = target.product_offering_price_id;
      await sql.unsafe(
        'ALTER TABLE "product"."product_offering_price" DISABLE TRIGGER "product_offering_price_draft_guard"',
      );
      await sql`
        UPDATE product.product_offering_price
           SET price_component = price_component || '{"appliesAt":"billing"}'::jsonb
         WHERE product_offering_price_id = ${corruptedId}`;
      await sql.unsafe(
        'ALTER TABLE "product"."product_offering_price" ENABLE TRIGGER "product_offering_price_draft_guard"',
      );

      try {
        await migrateFolder(sql, MIGRATIONS);
      } catch (err) {
        migrationError = err;
      }
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
      if (preStateFolder)
        rmSync(preStateFolder, { recursive: true, force: true });
    }, 120_000);

    it("migrate() throws product_normalize_backfill_mismatch naming the corrupted row", () => {
      expect(migrationError).toBeDefined();
      const message = String(
        (migrationError as { cause?: unknown }).cause ?? migrationError,
      );
      const full = `${String(migrationError)} ${message}`;
      expect(full).toContain("product_normalize_backfill_mismatch");
      expect(full).toContain(corruptedId);
    });

    it("price_component and product_spec_characteristics still exist", async () => {
      expect(
        await columnExists(sql, "product_offering_price", "price_component"),
      ).toBe(true);
      expect(
        await columnExists(
          sql,
          "product_specifications",
          "product_spec_characteristics",
        ),
      ).toBe(true);
      expect(
        await columnExists(sql, "product_offering_price", "price_type"),
      ).toBe(false);
    });

    it("no new table or view exists", async () => {
      const rows = await sql<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'product'
           AND c.relname IN ('pop_usage_rate', 'pop_flat_fee',
                             'pop_capacity_commitment', 'pop_motivation_step',
                             'product_spec_characteristic',
                             'price_component_type',
                             'price_component_price_type', 'offering_price_v')`;
      expect(rows).toEqual([]);
    });

    it("drizzle.__drizzle_migrations has no 0056 row", async () => {
      const rows = await sql<{ n: string; last: string }[]>`
        SELECT count(*)::text AS n, max(created_at)::text AS last
          FROM drizzle.__drizzle_migrations`;
      expect(Number(rows[0]?.n)).toBe(LAST_PRE_STATE_IDX);
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; when: number }[] };
      const idx55 = journal.entries.find((e) => e.idx === LAST_PRE_STATE_IDX);
      expect(rows[0]?.last).toBe(String(idx55?.when));
    });

    it("the pre-state is intact: the corrupted row is still the only disagreement", async () => {
      const [row] = await sql<{ applies_at: string }[]>`
        SELECT price_component ->> 'appliesAt' AS applies_at
          FROM product.product_offering_price
         WHERE product_offering_price_id = ${corruptedId}`;
      expect(row?.applies_at).toBe("billing");
    });
  },
);
