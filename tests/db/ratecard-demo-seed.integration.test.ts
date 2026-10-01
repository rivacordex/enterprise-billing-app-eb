import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, count, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { ratecardRanUsageLkp, ratecardVersion } from "@/db/schema/product";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { todayInZone } from "@/lib/timezone";
import { RATE_CARD_FILE_HEADERS } from "@/validation/product/ratecard.schema";

// pm67-spec I3 — live-DB proof that the demo seed stands up one ACTIVE + one
// SUPERSEDED version of the single tracked card `RAN_USAGE`, created THROUGH THE
// REAL upload + activate services (D2). The seed attributes uploads/activations
// to the system/ADMIN break-glass user (D2), so `beforeAll` provisions that
// admin (the "empty-database provisioning" concern, kept separate from the
// seed's attribution) before invoking the seed.
//
// `@/db/client`'s singleton `db` is replaced with the test connection (the
// upload-version integration precedent) so both the services AND the seed's own
// reads (the admin lookup, listVersions — all keyed off the SAME `db` import)
// run against it. `getAppTimezone` is mocked to a fixed zone so `snapshot_date`
// is deterministic (the seed itself passes the real clock — D6 — which we then
// read back).
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  holder: { db: undefined as unknown },
}));

vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));

import {
  seedRateCardDemo,
  buildRateCardDemoCsv,
  RAN_USAGE_CARD_NAME,
  RAN_USAGE_V1_ROWS,
  RAN_USAGE_V2_ROWS,
  RAN_USAGE_REMOVED_KEY,
} from "@/db/seeds/demo/product-demo";
import { loadBootstrapAdminConfig } from "@/db/seeds/seed-admin.config";
import { uploadRatecardVersion } from "@/services/product/ratecard/upload-version";

describe.skipIf(!databaseUrl)(
  "seedRateCardDemo (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
    let db: DrizzleDb;
    let adminId: string;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "inventory",
        "ordering",
        "rating",
        "core",
        "drizzle",
      ]) {
        await sql_.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, { max: 5, onnotice: () => {} });
      await dropAll();
      db = drizzle(sql_, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      hoisted.holder.db = db;

      // Provision the system/ADMIN break-glass user the seed attributes to (D2)
      // — this is the "empty-database provisioning" concern, kept SEPARATE from
      // the seed's attribution logic: the seed looks the admin up (by
      // BOOTSTRAP_ADMIN_EMAIL) and refuses if absent, so the test stands it up
      // here, the same way `db:seed` (seed-admin.ts) does in a real setup. No
      // db:setup-partman is run; the audit default partition (0001) absorbs the
      // four events.
      const { BOOTSTRAP_ADMIN_EMAIL } = loadBootstrapAdminConfig();
      const [admin] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "System Administrator",
          userEmail: BOOTSTRAP_ADMIN_EMAIL,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      adminId = admin!.id;

      await seedRateCardDemo();
    }, 60_000);

    afterAll(async () => {
      await dropAll();
      await sql_.end();
    });

    async function versions() {
      return db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.cardName, RAN_USAGE_CARD_NAME))
        .orderBy(ratecardVersion.versionNum);
    }

    async function rowsOf(versionId: string) {
      return db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, versionId));
    }

    async function auditCountFor(
      eventType: "RATECARD_VERSION_UPLOADED" | "RATECARD_VERSION_ACTIVATED",
      targetId: string,
    ): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, eventType),
            eq(auditLog.targetId, targetId),
          ),
        );
      return row!.n;
    }

    // I3.1 — one ACTIVE + one SUPERSEDED version, in lineage.
    it("stands up exactly one ACTIVE and one SUPERSEDED version of RAN_USAGE, in lineage (I3.1)", async () => {
      const all = await versions();
      expect(all).toHaveLength(2);

      const [v1, v2] = all;
      expect(v1!.versionNum).toBe(1);
      expect(v2!.versionNum).toBe(2);
      expect(v1!.status).toBe("SUPERSEDED");
      expect(v2!.status).toBe("ACTIVE");

      // D6 — the two versions are told apart by version_num, status AND
      // uploaded_at. Each upload reads its own real-clock instant, and v2 is
      // uploaded after v1's full upload+activate round-trip, so v2's upload
      // instant is strictly later (not the same captured Date).
      expect(v2!.uploadedAt.getTime()).toBeGreaterThan(
        v1!.uploadedAt.getTime(),
      );

      // Lineage: the superseded v1 points at the ACTIVE v2; v2 points at
      // nothing. Both name the system/ADMIN user (D2), never NULL.
      expect(v1!.supersededByVersionId).toBe(v2!.ratecardVersionId);
      expect(v2!.supersededByVersionId).toBeNull();
      for (const v of [v1!, v2!]) {
        expect(v.uploadedBy).toBe(adminId);
        expect(v.activatedBy).toBe(adminId);
      }
    });

    // I3.2 — lkp_subscriber_ref_id structural only (no referential assertion).
    it("every lkp_subscriber_ref_id is non-empty and PRDINV+8-digit shaped (I3.2, D-A1)", async () => {
      const all = await versions();
      for (const v of all) {
        const rows = await rowsOf(v.ratecardVersionId);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.lkpSubscriberRefId).toMatch(/^PRDINV\d{8}$/);
        }
      }
    });

    // I3.3 — rate_per_unit: at least one populated, at least one NULL; empty
    // stays NULL, never 0.
    it("rate_per_unit follows D4 — populated and empty rows, empty is NULL not 0 (I3.3)", async () => {
      const [v1] = await versions();
      const rows = await rowsOf(v1!.ratecardVersionId);
      const populated = rows.filter((r) => r.ratePerUnit !== null);
      const empty = rows.filter((r) => r.ratePerUnit === null);
      expect(populated.length).toBeGreaterThan(0);
      expect(empty.length).toBeGreaterThan(0);
      // No empty source cell became "0".
      for (const r of rows) {
        if (r.ratePerUnit !== null) {
          expect(Number(r.ratePerUnit)).toBeGreaterThan(0);
        }
      }
    });

    // I3.4 — exactly one key removed; the diff (as the activation recorded it)
    // reports removed = 1; the key is gone from ACTIVE, kept in SUPERSEDED; each
    // version's stored rows equal its row_count.
    it("exactly one key removed: diff removed = 1, absent from ACTIVE, kept in SUPERSEDED, rows == row_count (I3.4, D6/RV3)", async () => {
      const [v1, v2] = await versions();

      const matchesRemoved = (r: {
        mnoPublicKey: string;
        commercialUnitPublicKey: string;
        polygonId: string;
      }) =>
        r.mnoPublicKey === RAN_USAGE_REMOVED_KEY.mno_public_key &&
        r.commercialUnitPublicKey ===
          RAN_USAGE_REMOVED_KEY.commercial_unit_public_key &&
        r.polygonId === RAN_USAGE_REMOVED_KEY.polygon_id;

      const v1Rows = await rowsOf(v1!.ratecardVersionId);
      const v2Rows = await rowsOf(v2!.ratecardVersionId);
      expect(v1Rows.some(matchesRemoved)).toBe(true); // kept in SUPERSEDED
      expect(v2Rows.some(matchesRemoved)).toBe(false); // gone from ACTIVE

      // Stored rows == the uploaded file's row_count (RV3): the removed key adds
      // nothing to the newer version.
      expect(v1Rows).toHaveLength(RAN_USAGE_V1_ROWS.length);
      expect(v2Rows).toHaveLength(RAN_USAGE_V2_ROWS.length);
      expect(v1!.rowCount).toBe(RAN_USAGE_V1_ROWS.length);
      expect(v2!.rowCount).toBe(RAN_USAGE_V2_ROWS.length);

      // The diff the ACTIVE version's activation computed and recorded (the
      // durable record of what it moved): removed = 1, added = 0, changed = 0.
      const [activation] = await db
        .select({ afterData: auditLog.afterData })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, "RATECARD_VERSION_ACTIVATED"),
            eq(auditLog.targetId, v2!.ratecardVersionId),
          ),
        )
        .limit(1);
      const after = activation!.afterData as {
        added: number;
        changed: number;
        removed: number;
      };
      expect(after.removed).toBe(1);
      expect(after.added).toBe(0);
      expect(after.changed).toBe(0);
    });

    // I3.5 — the config row tracks exactly one card_name; service_code is plain
    // data, with a pair differing only by it.
    it("tracks exactly one card_name; service_code is plain data with a differ-only-by-it pair (I3.5)", async () => {
      const distinct = await db
        .selectDistinct({ cardName: ratecardVersion.cardName })
        .from(ratecardVersion);
      expect(distinct.map((d) => d.cardName)).toEqual([RAN_USAGE_CARD_NAME]);

      const [v1] = await versions();
      const rows = await rowsOf(v1!.ratecardVersionId);
      const withCode = rows.find((r) => r.polygonId === "POLY-0101")!;
      const withoutCode = rows.find((r) => r.polygonId === "POLY-0102")!;
      // Differ ONLY by service_code (and the mandatory key component polygon_id).
      expect(withCode.serviceCode).toBe("SVC-VOICE");
      expect(withoutCode.serviceCode).toBeNull();
      expect(withCode.mnoPublicKey).toBe(withoutCode.mnoPublicKey);
      expect(withCode.commercialUnitPublicKey).toBe(
        withoutCode.commercialUnitPublicKey,
      );
      expect(withCode.polygonStartDate).toBe(withoutCode.polygonStartDate);
      expect(withCode.polygonEndDate).toBe(withoutCode.polygonEndDate);
      expect(withCode.state).toBe(withoutCode.state);
      expect(withCode.district).toBe(withoutCode.district);
      expect(withCode.lkpSubscriberRefId).toBe(withoutCode.lkpSubscriberRefId);
      expect(withCode.ratePerUnit).toBe(withoutCode.ratePerUnit);
    });

    // I3.6 — a deliberately malformed seed fails at Zod BEFORE any insert.
    it("a malformed seed fails at Zod before the insert, writing no version row (I3.6, D1)", async () => {
      const malformedCardName = "RAN_USAGE_MALFORMED_TEST";
      const bad = { ...RAN_USAGE_V1_ROWS[0]!, rate_per_unit: "-5" }; // sign is invalid

      const result = await uploadRatecardVersion({
        cardName: malformedCardName,
        bytes: buildRateCardDemoCsv([bad]),
        sourceFile: "bad.csv",
        uploadedBy: adminId,
        uploadedAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ROW_SCHEMA_INVALID");
      }

      // Nothing written — no version row for the malformed card.
      const [row] = await db
        .select({ n: count() })
        .from(ratecardVersion)
        .where(eq(ratecardVersion.cardName, malformedCardName));
      expect(row!.n).toBe(0);
    });

    // I3.7 — four audit events, through the real path.
    it("writes four audit events — two uploads, two activations (I3.7)", async () => {
      const [v1, v2] = await versions();
      for (const v of [v1!, v2!]) {
        expect(
          await auditCountFor("RATECARD_VERSION_UPLOADED", v.ratecardVersionId),
        ).toBe(1);
        expect(
          await auditCountFor(
            "RATECARD_VERSION_ACTIVATED",
            v.ratecardVersionId,
          ),
        ).toBe(1);
      }
    });

    // I3.8 — small (a demo seed is read by humans, not a batching benchmark).
    it("is small — a handful of rows, not 5,400 (I3.8, D4)", async () => {
      const [total] = await db.select({ n: count() }).from(ratecardRanUsageLkp);
      expect(total!.n).toBe(
        RAN_USAGE_V1_ROWS.length + RAN_USAGE_V2_ROWS.length,
      );
      expect(total!.n).toBeLessThanOrEqual(50);
    });

    // I3.11 — the CSV header is exactly the ten pm58 headers (no Date column);
    // both versions' snapshot_date equal the seed-run date in the app timezone.
    it("uses the ten pm58 headers with no Date column; both snapshot_date == the seed-run date (I3.11, D6)", async () => {
      // buildRateCardDemoCsv emits RFC-4180 CRLF line endings (shared
      // lib/csv.ts) — split on either so the header line carries no trailing
      // \r regardless of the line-ending convention.
      const headerLine = buildRateCardDemoCsv(RAN_USAGE_V1_ROWS)
        .toString("utf8")
        .split(/\r?\n/)[0];
      expect(headerLine).toBe(RATE_CARD_FILE_HEADERS.join(","));
      expect(RATE_CARD_FILE_HEADERS).toHaveLength(10);
      // No standalone `Date` column (D-A8) — the file has no snapshot-date
      // column. "Polygon Start Date"/"Polygon End Date" are legitimate headers;
      // it is a header cell EQUAL to "Date" that must be absent.
      expect(headerLine!.split(",")).not.toContain("Date");

      const [v1, v2] = await versions();
      expect(v1!.snapshotDate).toBe(v2!.snapshotDate);
      expect(v1!.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Derive the expected date from the RECORDED upload instant, not the
      // assertion-time clock — `snapshot_date` is computed from `uploaded_at`
      // in the app timezone (mocked to UTC here), so tying the check to
      // `uploadedAt` removes any midnight-boundary flake between seeding and
      // this assertion.
      expect(v1!.snapshotDate).toBe(todayInZone(v1!.uploadedAt, "UTC"));
    });

    // Idempotent — a second run skips wholesale, leaving exactly two versions.
    it("is idempotent — a second seedRateCardDemo() run adds nothing", async () => {
      await seedRateCardDemo();
      const all = await versions();
      expect(all).toHaveLength(2);
    });
  },
);
