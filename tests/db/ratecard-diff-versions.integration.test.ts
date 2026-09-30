import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import {
  ratecardRepository,
  type LookupRowInput,
} from "@/db/repositories/ratecard";
import { diffAgainstActive } from "@/services/product/ratecard/diff-versions";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm62-spec I2 — live-DB proof of the whole diff, against a database built
// from EMPTY. `diffAgainstActive` takes `db` as an explicit argument (it is
// framework-agnostic and opens no transaction of its own, D7), so this suite
// passes it a counted `postgres()` client directly rather than mocking
// `@/db/client` (contrast tests/db/ratecard-upload-version.integration.test.ts,
// whose service reads the module singleton).
const databaseUrl = process.env.DATABASE_URL;

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl)(
  "diffAgainstActive (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    let db: DrizzleDb;
    let queries: string[] = [];

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, {
        max: 1,
        onnotice: () => {},
        debug: (_connection, query) => {
          queries.push(query);
        },
      });
      await sql_.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql_, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 60_000);

    afterAll(async () => {
      await sql_.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql_.end();
    });

    function row(
      overrides: Partial<LookupRowInput> & { polygonId: string },
    ): LookupRowInput {
      return {
        mnoPublicKey: "MNO-1",
        commercialUnitPublicKey: "CU-1",
        polygonStartDate: "2026-01-01",
        polygonEndDate: null,
        state: null,
        district: null,
        lkpSubscriberRefId: "PRDINV00000001",
        serviceCode: null,
        ratePerUnit: null,
        ...overrides,
      };
    }

    // Creates a version with the given rows, in one transaction, and returns
    // its id. `versionNum`/`status` are the caller's — this repository layer
    // decides nothing about lifecycle (pm60 D1).
    async function makeVersion(
      cardName: string,
      status: "DRAFT" | "ACTIVE" | "SUPERSEDED",
      versionNum: number,
      rows: LookupRowInput[],
    ): Promise<string> {
      return db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName,
          versionNum,
          status,
          snapshotDate: "2026-01-01",
          sourceFile: "diff-fixture.csv",
          rowCount: rows.length,
        });
        if (rows.length > 0) {
          await ratecardRepository.insertLookupRows(tx, versionId, rows);
        }
        return versionId;
      });
    }

    // I2.1 — a DRAFT diffed against the current ACTIVE returns the three
    // bucket counts and rows, IN CONTRACT ORDER (D1).
    it("returns the three named buckets, in contract order, with counts and rows", async () => {
      const activeId = await makeVersion("CARD_BASIC", "ACTIVE", 1, [
        row({ polygonId: "P-UNCHANGED" }), // stays identical
        row({ polygonId: "P-REMOVED" }), // absent from the draft
      ]);
      const draftId = await makeVersion("CARD_BASIC", "DRAFT", 2, [
        row({ polygonId: "P-UNCHANGED" }),
        row({ polygonId: "P-ADDED" }), // new key
      ]);

      const result = await diffAgainstActive(db, "CARD_BASIC", draftId);

      expect(Object.keys(result)).toEqual(["added", "changed", "removed"]);
      expect(result.added.count).toBe(1);
      expect(result.added.rows[0]!.polygonId).toBe("P-ADDED");
      expect(result.added.rows[0]!.incoming.ratecardVersionId).toBe(draftId);
      expect(result.changed.count).toBe(0);
      expect(result.removed.count).toBe(1);
      expect(result.removed.rows[0]!.polygonId).toBe("P-REMOVED");
      expect(result.removed.rows[0]!.outgoing.ratecardVersionId).toBe(activeId);
    });

    // I2.2 — an lkp_subscriber_ref_id difference lands in `changed`, carrying
    // both rows.
    it("a lkp_subscriber_ref_id difference lands in changed, carrying outgoing and incoming", async () => {
      await makeVersion("CARD_REFID", "ACTIVE", 1, [
        row({ polygonId: "P-1", lkpSubscriberRefId: "PRDINV00000001" }),
      ]);
      const draftId = await makeVersion("CARD_REFID", "DRAFT", 2, [
        row({ polygonId: "P-1", lkpSubscriberRefId: "PRDINV00000002" }),
      ]);

      const result = await diffAgainstActive(db, "CARD_REFID", draftId);

      expect(result.changed.count).toBe(1);
      expect(result.changed.rows[0]!.outgoing.lkpSubscriberRefId).toBe(
        "PRDINV00000001",
      );
      expect(result.changed.rows[0]!.incoming.lkpSubscriberRefId).toBe(
        "PRDINV00000002",
      );
      expect(result.added.count).toBe(0);
      expect(result.removed.count).toBe(0);
    });

    // I2.3 — a service_code difference lands in `changed`.
    it("a service_code difference lands in changed, carrying outgoing and incoming", async () => {
      await makeVersion("CARD_SVC", "ACTIVE", 1, [
        row({ polygonId: "P-1", serviceCode: "OLD" }),
      ]);
      const draftId = await makeVersion("CARD_SVC", "DRAFT", 2, [
        row({ polygonId: "P-1", serviceCode: "NEW" }),
      ]);

      const result = await diffAgainstActive(db, "CARD_SVC", draftId);

      expect(result.changed.count).toBe(1);
      expect(result.changed.rows[0]!.outgoing.serviceCode).toBe("OLD");
      expect(result.changed.rows[0]!.incoming.serviceCode).toBe("NEW");
    });

    // I2.4 — BOTH lkp_subscriber_ref_id and service_code differ → `changed`
    // exactly ONCE, not twice; counts sum to the number of changed keys.
    it("a key whose ref id AND service code both differ lands in changed once, not twice", async () => {
      await makeVersion("CARD_BOTH", "ACTIVE", 1, [
        row({
          polygonId: "P-1",
          lkpSubscriberRefId: "PRDINV00000001",
          serviceCode: "OLD",
        }),
      ]);
      const draftId = await makeVersion("CARD_BOTH", "DRAFT", 2, [
        row({
          polygonId: "P-1",
          lkpSubscriberRefId: "PRDINV00000002",
          serviceCode: "NEW",
        }),
      ]);

      const result = await diffAgainstActive(db, "CARD_BOTH", draftId);

      expect(result.changed.count).toBe(1);
      expect(
        result.added.count + result.changed.count + result.removed.count,
      ).toBe(1);
    });

    // I2.5 — an unchanged key appears in NO bucket.
    it("an unchanged key appears in no bucket", async () => {
      await makeVersion("CARD_SAME", "ACTIVE", 1, [row({ polygonId: "P-1" })]);
      const draftId = await makeVersion("CARD_SAME", "DRAFT", 2, [
        row({ polygonId: "P-1" }),
      ]);

      const result = await diffAgainstActive(db, "CARD_SAME", draftId);

      expect(result.added.count).toBe(0);
      expect(result.changed.count).toBe(0);
      expect(result.removed.count).toBe(0);
    });

    // I2.6 — a key absent from the upload is `removed`, carrying the
    // outgoing row.
    it("a key absent from the upload is bucketed removed, carrying the outgoing row", async () => {
      const activeId = await makeVersion("CARD_GONE", "ACTIVE", 1, [
        row({ polygonId: "P-GONE" }),
      ]);
      const draftId = await makeVersion("CARD_GONE", "DRAFT", 2, []);

      const result = await diffAgainstActive(db, "CARD_GONE", draftId);

      expect(result.removed.count).toBe(1);
      expect(result.removed.rows[0]!.polygonId).toBe("P-GONE");
      expect(result.removed.rows[0]!.outgoing.ratecardVersionId).toBe(activeId);
      expect(result.added.count).toBe(0);
      expect(result.changed.count).toBe(0);
    });

    // I2.7 — no ACTIVE version at all → everything added, no error (D6).
    it("with no ACTIVE version for the card, every uploaded key is added and nothing throws", async () => {
      const draftId = await makeVersion("CARD_FIRST_EVER", "DRAFT", 1, [
        row({ polygonId: "P-1" }),
        row({ polygonId: "P-2" }),
      ]);

      const result = await diffAgainstActive(db, "CARD_FIRST_EVER", draftId);

      expect(result.added.count).toBe(2);
      expect(result.changed.count).toBe(0);
      expect(result.removed.count).toBe(0);
    });

    // I2.8 — diffing a version against itself returns three empty buckets,
    // no error (D6).
    it("diffing the current ACTIVE version against itself returns three empty buckets", async () => {
      const activeId = await makeVersion("CARD_SELF", "ACTIVE", 1, [
        row({ polygonId: "P-1" }),
        row({ polygonId: "P-2" }),
      ]);

      const result = await diffAgainstActive(db, "CARD_SELF", activeId);

      expect(result.added.count).toBe(0);
      expect(result.changed.count).toBe(0);
      expect(result.removed.count).toBe(0);
    });

    // I2.9 — 5,500 vs 5,500 is ONE map comparison: the query budget for a
    // diff request is exactly TWO, nothing per row and nothing per bucket
    // (D5).
    it("the query budget for a 5,500-vs-5,500 diff is exactly two reads", async () => {
      const activeRows: LookupRowInput[] = Array.from(
        { length: 5500 },
        (_, i) => row({ polygonId: `P-BUDGET-${i}` }),
      );
      const draftRows: LookupRowInput[] = activeRows.map((r, i) =>
        i === 0 ? { ...r, serviceCode: "CHANGED" } : r,
      );
      await makeVersion("CARD_BUDGET", "ACTIVE", 1, activeRows);
      const draftId = await makeVersion("CARD_BUDGET", "DRAFT", 2, draftRows);

      queries = [];
      const result = await diffAgainstActive(db, "CARD_BUDGET", draftId);

      expect(result.changed.count).toBe(1);
      expect(result.added.count).toBe(0);
      expect(result.removed.count).toBe(0);
      expect(queries.length).toBe(2);
    });

    // I2.10 (behavioural half) — adversarial key values cannot collide
    // across different tuples (D4): ("AB","C") vs ("A","BC") on the same
    // polygon must be treated as two DISTINCT keys, not one. If the join
    // were a naive "+" concatenation they would collide and cancel out to
    // "no bucket"; with the shared NUL-delimited key they must not.
    it("adversarial key values that would collide under naive concatenation stay distinct (D4)", async () => {
      await makeVersion("CARD_COLLIDE", "ACTIVE", 1, [
        row({
          mnoPublicKey: "AB",
          commercialUnitPublicKey: "C",
          polygonId: "P-X",
        }),
      ]);
      const draftId = await makeVersion("CARD_COLLIDE", "DRAFT", 2, [
        row({
          mnoPublicKey: "A",
          commercialUnitPublicKey: "BC",
          polygonId: "P-X",
        }),
      ]);

      const result = await diffAgainstActive(db, "CARD_COLLIDE", draftId);

      // Two genuinely different tuples: the ACTIVE one is removed, the DRAFT
      // one is added — they must NOT cancel out to an empty diff.
      expect(result.removed.count).toBe(1);
      expect(result.added.count).toBe(1);
      expect(result.changed.count).toBe(0);
    });
  },
);
