import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { customerBillLineRepository } from "@/db/repositories/billing/customer-bill-line.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm31-spec §Guardrails / Verification checklist — the DB-gated proof that the
// posting `charge_checksum` re-anchored onto `customer_bill_line` content
// behaves as specified. It drives `customerBillLineRepository.computeChargeChecksum`
// (the SQL-only md5 over each line's `(source, ref_product_offering_id, udr_type,
// line_type, gross_amount, discount_amount, net_amount)`, ordered by `line_no`)
// directly against a real Postgres, asserting:
//   * a recurring-only bill (RECURRING lines, no claimed `udr_rated`) hashes to a
//     real, non-empty value — NOT `md5('')` (the phase-2 regression);
//   * the checksum is content-derived + reproducible and INDEPENDENT of the
//     surrogate `customer_bill_line_id` / physical insert order (Inv #3): the
//     SAME `(line_no, content)` set inserted in a DIFFERENT order (so the
//     auto-generated ids map to line_no differently) yields the SAME checksum —
//     including when two lines TIE on `grouping_key` (a USAGE line whose
//     `udr_type` is literally 'RECURRING' collides with a real RECURRING line's
//     `offering:RECURRING` key). Ordering by `grouping_key` alone would leave that
//     tied pair in an unspecified `string_agg` order; ordering by `line_no` (the
//     deterministic assignment) keeps it reproducible;
//   * ALL THREE money columns matter, each in ISOLATION: changing ONLY
//     `gross_amount`, ONLY `discount_amount`, or ONLY `net_amount` each changes
//     the checksum — plus a `net`-preserving discount shift (gross +x, discount
//     +x, net unchanged).
//
// Lines are inserted directly with FK triggers off (session_replication_role =
// replica), the bm27/bm28 fixture technique — the checksum reads ONLY
// `customer_bill_line`, so no real `customer_bill`/`bill_run` header is needed.
// The partitioned table's DEFAULT partition (migration 0039) accepts any period.
// It runs on the superuser DATABASE_URL connection, exercising the checksum SQL,
// not the app-runtime grants (proven by billrun-db-roles.integration.test.ts).
const databaseUrl = process.env.DATABASE_URL;

const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";
const PERIOD = "2026-06-01";

type LineSpec = {
  billId: string;
  lineNo: number;
  source: "USAGE" | "RECURRING";
  offeringId: string;
  udrType: string | null;
  gross: string;
  discount: string;
  net: string;
  groupingKey: string;
};

describe.skipIf(!databaseUrl)(
  "bm31 charge_checksum re-anchored on customer_bill_line (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    // Insert one customer_bill_line, bypassing the composite FK to
    // customer_bill (the checksum never reads the header). The surrogate
    // `customer_bill_line_id` is left to its sequence default so successive
    // inserts of identical content get DIFFERENT ids. Asserts the row landed so a
    // silent insert failure surfaces here, not as a confusing md5('') downstream.
    async function insertLine(spec: LineSpec): Promise<void> {
      const affected = await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        const res = await tx`
          INSERT INTO billing.customer_bill_line
            (ref_customer_bill_id, period_partition, line_no, source, line_type,
             ref_product_offering_id, udr_type, gross_amount, discount_amount,
             net_amount, grouping_key, currency)
          VALUES
            (${spec.billId}, ${PERIOD}, ${spec.lineNo}, ${spec.source}, 'charge',
             ${spec.offeringId}, ${spec.udrType}, ${spec.gross}, ${spec.discount},
             ${spec.net}, ${spec.groupingKey}, 'MYR')
        `;
        return res.count;
      });
      expect(affected).toBe(1);
    }

    async function checksum(billId: string): Promise<string> {
      return customerBillLineRepository.computeChargeChecksum(
        db,
        billId,
        PERIOD,
      );
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it("a recurring-only bill hashes to a real, non-empty checksum (not md5(''))", async () => {
      const billId = "CBL-BM31-REC";
      // Realistic RECURRING grouping keys — the real aggregation writes
      // `offering || ':RECURRING'` (billrun-aggregate.ts), udr_type NULL.
      await insertLine({
        billId,
        lineNo: 1,
        source: "RECURRING",
        offeringId: "OFR-BM31-A",
        udrType: null,
        gross: "50.00",
        discount: "0.00",
        net: "50.00",
        groupingKey: "OFR-BM31-A:RECURRING",
      });
      await insertLine({
        billId,
        lineNo: 2,
        source: "RECURRING",
        offeringId: "OFR-BM31-B",
        udrType: null,
        gross: "30.00",
        discount: "0.00",
        net: "30.00",
        groupingKey: "OFR-BM31-B:RECURRING",
      });

      const sum = await checksum(billId);
      expect(sum).toMatch(/^[0-9a-f]{32}$/);
      expect(sum).not.toBe(MD5_EMPTY);

      // A bill with no lines is the ONLY thing that hashes to md5('') (the
      // COALESCE path), confirming the recurring bill's value is content-derived.
      const empty = await checksum("CBL-BM31-NONE");
      expect(empty).toBe(MD5_EMPTY);
    });

    it("is content-derived + reproducible and INDEPENDENT of surrogate id / insert order, even under a grouping_key tie", async () => {
      // Two lines that TIE on grouping_key: a USAGE line whose free-text udr_type
      // is literally 'RECURRING' (grouping_key `offering:RECURRING`) and a real
      // RECURRING line for the SAME offering (also `offering:RECURRING`). This is
      // the exact collision bm29's `line_no` tiebreaker (ORDER BY grouping_key,
      // source) exists for; the checksum must stay reproducible under it.
      const OFF = "OFR-BM31-TIE";
      const line = (
        billId: string,
        lineNo: number,
        source: "USAGE" | "RECURRING",
      ): LineSpec =>
        source === "USAGE"
          ? {
              billId,
              lineNo,
              source,
              offeringId: OFF,
              udrType: "RECURRING",
              gross: "12.34",
              discount: "0.00",
              net: "12.34",
              groupingKey: `${OFF}:RECURRING`,
            }
          : {
              billId,
              lineNo,
              source,
              offeringId: OFF,
              udrType: null,
              gross: "99.99",
              discount: "0.00",
              net: "99.99",
              groupingKey: `${OFF}:RECURRING`,
            };

      // Bill 1: insert in line_no order (USAGE=1 gets the lower id, RECURRING=2
      // the higher). Bill 2: SAME (line_no, content) but inserted in REVERSE
      // order, so RECURRING=2 gets the LOWER id and USAGE=1 the HIGHER — id order
      // now diverges from line_no order. Equal checksums prove the hash follows
      // line_no, not the surrogate id or physical/insert order.
      await insertLine(line("CBL-BM31-T1", 1, "USAGE"));
      await insertLine(line("CBL-BM31-T1", 2, "RECURRING"));

      await insertLine(line("CBL-BM31-T2", 2, "RECURRING"));
      await insertLine(line("CBL-BM31-T2", 1, "USAGE"));

      const first = await checksum("CBL-BM31-T1");
      const second = await checksum("CBL-BM31-T2");
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(second).toBe(first);
      // A recompute over unchanged content matches (reproducible).
      expect(await checksum("CBL-BM31-T1")).toBe(first);
    });

    it("all three money columns matter IN ISOLATION, and a net-preserving discount shift still changes the checksum", async () => {
      const billId = "CBL-BM31-MONEY";
      await insertLine({
        billId,
        lineNo: 1,
        source: "USAGE",
        offeringId: "OFR-BM31-M",
        udrType: "RAN_USAGE",
        gross: "100.00",
        discount: "0.00",
        net: "100.00",
        groupingKey: "OFR-BM31-M:RAN_USAGE",
      });

      const setMoney = async (
        gross: string,
        discount: string,
        net: string,
      ): Promise<string> => {
        const res = await sql`
          UPDATE billing.customer_bill_line
             SET gross_amount = ${gross}, discount_amount = ${discount},
                 net_amount = ${net}
           WHERE ref_customer_bill_id = ${billId}
             AND period_partition = ${PERIOD}
        `;
        // Guard against a silently-zero-row UPDATE (e.g. a WHERE-clause typo)
        // making a later comparison pass vacuously.
        expect(res.count).toBe(1);
        return checksum(billId);
      };

      const s0 = await checksum(billId);
      // Change ONLY gross_amount → checksum changes (proves gross participates).
      const s1 = await setMoney("105.00", "0.00", "100.00");
      expect(s1).not.toBe(s0);
      // Change ONLY discount_amount → checksum changes (proves discount).
      const s2 = await setMoney("105.00", "5.00", "100.00");
      expect(s2).not.toBe(s1);
      // Change ONLY net_amount → checksum changes (proves net — the column a
      // gross+discount-only hash would silently omit).
      const s3 = await setMoney("105.00", "5.00", "95.00");
      expect(s3).not.toBe(s2);
      // A net-preserving shift (gross +5, discount +5, net UNCHANGED at 95) —
      // the tamper-evidence a net-only hash would miss — still changes it.
      const s4 = await setMoney("110.00", "10.00", "95.00");
      expect(s4).not.toBe(s3);
    });
  },
);
