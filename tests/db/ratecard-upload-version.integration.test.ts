import fs from "node:fs";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { RATE_CARD_FILE_HEADERS } from "@/validation/product/ratecard.schema";

// pm61-spec I5 — live-DB proof of the whole upload pipeline: parse → structural
// validation → one write transaction, against a database built from EMPTY.
// `@/db/client`'s singleton `db` is replaced with one built on a counted
// `postgres()` client (manage-products-query-budget precedent) so the query
// count assertions (I5.5) can inspect the same connection the service uses.
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  queries: [] as string[],
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

import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import { uploadRatecardVersion } from "@/services/product/ratecard/upload-version";

const mockGetAppTimezone = vi.mocked(getAppTimezone);

describe.skipIf(!databaseUrl)(
  "uploadRatecardVersion (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
    let db: DrizzleDb;
    let actorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, {
        // `max: 1` (a single physical connection) would serialize the
        // "concurrent uploads" race test below onto one connection instead
        // of letting the two transactions actually overlap — the second
        // `sql.begin()` would just queue behind the first's commit, so the
        // race it exists to exercise would never happen. Needs at least 2.
        max: 5,
        onnotice: () => {},
        debug: (_connection, query) => {
          hoisted.queries.push(query);
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
      hoisted.holder.db = db;

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "pm61-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
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

    beforeEach(() => {
      hoisted.queries.length = 0;
      mockGetAppTimezone.mockReturnValue("UTC");
    });

    function validRow(i: number): string[] {
      return [
        `MNO-${i}`,
        `CU-${i}`,
        `POLY-${i}`,
        "2026-01-01",
        "",
        "",
        "",
        `PRDINV${String(i).padStart(8, "0")}`,
        "",
        "0.05",
      ];
    }

    function csv(rowCount: number, header = RATE_CARD_FILE_HEADERS): Buffer {
      const lines = [header.join(",")];
      for (let i = 0; i < rowCount; i++) {
        lines.push(validRow(i).join(","));
      }
      return Buffer.from(lines.join("\n") + "\n", "utf8");
    }

    async function versionCount(cardName: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(ratecardVersion)
        .where(eq(ratecardVersion.cardName, cardName));
      return row!.n;
    }

    async function uploadAuditCount(versionId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, "RATECARD_VERSION_UPLOADED"),
            eq(auditLog.targetId, versionId),
          ),
        );
      return row!.n;
    }

    it("a valid CSV creates exactly one DRAFT, with row_count matching the rows stored", async () => {
      const result = await uploadRatecardVersion({
        cardName: "CARD_HAPPY",
        bytes: csv(25),
        sourceFile: "happy.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-15T00:00:00Z"),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.rowCount).toBe(25);
      expect(result.warnings).toEqual([]);

      expect(await versionCount("CARD_HAPPY")).toBe(1);
      const [version] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, result.versionId));
      expect(version?.status).toBe("DRAFT");
      expect(version?.rowCount).toBe(25);

      const [rows] = await db
        .select({ n: count() })
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, result.versionId));
      expect(rows!.n).toBe(25);

      expect(await uploadAuditCount(result.versionId)).toBe(1);
    });

    it("the current ACTIVE version is untouched and still active after a new upload", async () => {
      const first = await uploadRatecardVersion({
        cardName: "CARD_ACTIVE_UNTOUCHED",
        bytes: csv(3),
        sourceFile: "v1.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-15T00:00:00Z"),
      });
      if (!first.ok) throw new Error("expected ok:true");
      await db
        .update(ratecardVersion)
        .set({ status: "ACTIVE" })
        .where(eq(ratecardVersion.ratecardVersionId, first.versionId));

      const second = await uploadRatecardVersion({
        cardName: "CARD_ACTIVE_UNTOUCHED",
        bytes: csv(4),
        sourceFile: "v2.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-16T00:00:00Z"),
      });
      expect(second.ok).toBe(true);

      const [activeStillActive] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, first.versionId));
      expect(activeStillActive?.status).toBe("ACTIVE");
      expect(await versionCount("CARD_ACTIVE_UNTOUCHED")).toBe(2);
    });

    it.each([
      [
        "duplicate row key",
        csv(2).toString("utf8") + validRow(0).join(",") + "\n",
      ],
      [
        "missing column",
        [
          RATE_CARD_FILE_HEADERS.filter((h) => h !== "District").join(","),
          "MNO-0,CU-0,POLY-0,2026-01-01,,,PRDINV00000000,,0.05",
        ].join("\n"),
      ],
      [
        "unknown column (a Date column)",
        [
          [...RATE_CARD_FILE_HEADERS, "Date"].join(","),
          "MNO-0,CU-0,POLY-0,2026-01-01,,,,PRDINV00000000,,0.05,2026-01-01",
        ].join("\n"),
      ],
    ])(
      "every structural refusal case (%s) creates no version",
      async (_label, content) => {
        const cardName = `CARD_REFUSAL_${Math.random().toString(36).slice(2)}`;
        const result = await uploadRatecardVersion({
          cardName,
          bytes: Buffer.from(content, "utf8"),
          sourceFile: "bad.csv",
          uploadedBy: actorId,
          uploadedAt: new Date(),
        });

        expect(result.ok).toBe(false);
        expect(await versionCount(cardName)).toBe(0);
      },
    );

    it("a query-budget-free refusal makes zero database queries", async () => {
      const result = await uploadRatecardVersion({
        cardName: "CARD_NO_QUERY_ON_REFUSAL",
        bytes: Buffer.from("Wrong,Header\n1,2\n", "utf8"),
        sourceFile: "bad.csv",
        uploadedBy: actorId,
        uploadedAt: new Date(),
      });

      expect(result.ok).toBe(false);
      expect(hoisted.queries.length).toBe(0);
    });

    it("a file_checksum match warns and does not refuse; the draft is created", async () => {
      const bytes = csv(3);

      const first = await uploadRatecardVersion({
        cardName: "CARD_CHECKSUM",
        bytes,
        sourceFile: "v1.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-15T00:00:00Z"),
      });
      if (!first.ok) throw new Error("expected ok:true");
      // Move the first version out of DRAFT so the second upload is a fresh
      // version, not a replace — isolating the checksum-warning behavior.
      await db
        .update(ratecardVersion)
        .set({ status: "ACTIVE" })
        .where(eq(ratecardVersion.ratecardVersionId, first.versionId));

      const second = await uploadRatecardVersion({
        cardName: "CARD_CHECKSUM",
        bytes,
        sourceFile: "v1-reupload.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-16T00:00:00Z"),
      });

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected ok:true");
      expect(second.warnings).toHaveLength(1);
      expect(second.warnings[0]?.reason).toContain(first.versionId);
      expect(await versionCount("CARD_CHECKSUM")).toBe(2);
    });

    it("the query budget is bounded by batch count, not row count", async () => {
      await uploadRatecardVersion({
        cardName: "CARD_BUDGET_SMALL",
        bytes: csv(10),
        sourceFile: "small.csv",
        uploadedBy: actorId,
        uploadedAt: new Date(),
      });
      const smallCount = hoisted.queries.length;

      hoisted.queries.length = 0;
      await uploadRatecardVersion({
        cardName: "CARD_BUDGET_LARGE",
        bytes: csv(1500), // two insertLookupRows batches (1000 + 500)
        sourceFile: "large.csv",
        uploadedBy: actorId,
        uploadedAt: new Date(),
      });
      const largeCount = hoisted.queries.length;

      // Exactly one extra statement for the extra batch — never proportional
      // to the 150x row-count difference.
      expect(largeCount - smallCount).toBe(1);
    });

    it("exactly one RATECARD_VERSION_UPLOADED audit event per success; a failed upload writes none", async () => {
      const cardName = "CARD_AUDIT";
      const before = await db
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.eventType, "RATECARD_VERSION_UPLOADED"));

      const failed = await uploadRatecardVersion({
        cardName,
        bytes: Buffer.from("Wrong,Header\n1,2\n", "utf8"),
        sourceFile: "bad.csv",
        uploadedBy: actorId,
        uploadedAt: new Date(),
      });
      expect(failed.ok).toBe(false);

      const afterFailure = await db
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.eventType, "RATECARD_VERSION_UPLOADED"));
      expect(afterFailure[0]!.n).toBe(before[0]!.n);

      const succeeded = await uploadRatecardVersion({
        cardName,
        bytes: csv(3),
        sourceFile: "good.csv",
        uploadedBy: actorId,
        uploadedAt: new Date(),
      });
      if (!succeeded.ok) throw new Error("expected ok:true");

      const afterSuccess = await db
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.eventType, "RATECARD_VERSION_UPLOADED"));
      expect(afterSuccess[0]!.n).toBe(before[0]!.n + 1);
      expect(await uploadAuditCount(succeeded.versionId)).toBe(1);
    });

    it("a second upload while a DRAFT is open replaces it (D12)", async () => {
      const cardName = "CARD_REPLACE_DRAFT";
      const first = await uploadRatecardVersion({
        cardName,
        bytes: csv(3),
        sourceFile: "draft1.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-15T00:00:00Z"),
      });
      if (!first.ok) throw new Error("expected ok:true");

      const second = await uploadRatecardVersion({
        cardName,
        bytes: csv(5),
        sourceFile: "draft2.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-01-16T00:00:00Z"),
      });
      if (!second.ok) throw new Error("expected ok:true");

      expect(second.versionId).not.toBe(first.versionId);
      expect(await versionCount(cardName)).toBe(1);

      const [remaining] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.cardName, cardName));
      expect(remaining?.ratecardVersionId).toBe(second.versionId);
      expect(remaining?.status).toBe("DRAFT");
      expect(remaining?.rowCount).toBe(5);
      // D12 — the new draft reuses the replaced draft's version number.
      expect(remaining?.versionNum).toBe(1);

      const [oldVersionGone] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, first.versionId));
      expect(oldVersionGone).toBeUndefined();

      const [oldRowsGone] = await db
        .select({ n: count() })
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, first.versionId));
      expect(oldRowsGone!.n).toBe(0);

      const [uploadedEvents] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.eventType, "RATECARD_VERSION_UPLOADED"));
      expect(uploadedEvents!.n).toBeGreaterThanOrEqual(2);
    });

    it("two concurrent uploads racing with no open draft: the loser gets a typed refusal, not a raw 23505", async () => {
      const cardName = "CARD_CONCURRENT_RACE";

      const [resultA, resultB] = await Promise.all([
        uploadRatecardVersion({
          cardName,
          bytes: csv(3),
          sourceFile: "race-a.csv",
          uploadedBy: actorId,
          uploadedAt: new Date(),
        }),
        uploadRatecardVersion({
          cardName,
          bytes: csv(3),
          sourceFile: "race-b.csv",
          uploadedBy: actorId,
          uploadedAt: new Date(),
        }),
      ]);

      const results = [resultA, resultB];
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual({
        ok: false,
        code: "CONCURRENT_UPLOAD_CONFLICT",
      });
      expect(await versionCount(cardName)).toBe(1);
    });

    it("no fs write occurs anywhere in the upload path", () => {
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../services/product/ratecard/upload-version.ts",
        ),
        "utf8",
      );
      expect(source).not.toMatch(/from ["']node:fs["']|require\(\s*["']fs["']/);
    });

    it("snapshot_date is the upload date in the app timezone, not the file (D4)", async () => {
      mockGetAppTimezone.mockReturnValue("Asia/Kuala_Lumpur");
      const kl = await uploadRatecardVersion({
        cardName: "CARD_TZ_KL",
        bytes: csv(1),
        sourceFile: "tz.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-09-25T17:00:00Z"),
      });
      if (!kl.ok) throw new Error("expected ok:true");
      const [klVersion] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, kl.versionId));
      expect(klVersion?.snapshotDate).toBe("2026-09-26");
      expect(klVersion?.uploadedAt.toISOString()).toBe(
        "2026-09-25T17:00:00.000Z",
      );

      mockGetAppTimezone.mockReturnValue("UTC");
      const utc = await uploadRatecardVersion({
        cardName: "CARD_TZ_UTC",
        bytes: csv(1),
        sourceFile: "tz.csv",
        uploadedBy: actorId,
        uploadedAt: new Date("2026-09-25T17:00:00Z"),
      });
      if (!utc.ok) throw new Error("expected ok:true");
      const [utcVersion] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, utc.versionId));
      expect(utcVersion?.snapshotDate).toBe("2026-09-25");
    });
  },
);
