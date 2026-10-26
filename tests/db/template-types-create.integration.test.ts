import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { billingAccount, financialAccount } from "@/db/schema/billing/accounts";
import { billCycle } from "@/db/schema/billing/catalogs";
import { organization, partyRole } from "@/db/schema/customer";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm77-spec §11 (Inv #65, guardrail 79 grant half) — create type on a real
// database: the derived code and layout code, no version rows, one
// INVOICE_TEMPLATE_TYPE_CREATED row; a case/space variant of any name
// (retired included) is TEMPLATE_TYPE_NAME_TAKEN; a code collision takes the
// next `_2` suffix; `listUsable` picks only bindable types; and app_runtime's
// grants after the real bootstrap (asserted over information_schema — the
// service runs on the harness's owner connection). The service opens its own
// transaction on the `@/db/client` singleton, so that singleton is replaced
// with one built on a real client (the save-template-draft precedent).
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import {
  countBoundBansByType,
  createTemplateType,
} from "@/services/billing/invoice-template/template-types";
import { listTemplateTypes } from "@/services/billing/read/invoice-template-settings";
import type { Database } from "@/db/client";

const ACTOR = "bm77-actor";

function statements(path: string): string[] {
  return readFileSync(join(process.cwd(), path), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!databaseUrl)(
  "bm77 create invoice template type (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    async function typeByName(name: string) {
      const [row] = await sql<
        { bill_template_family_id: string; code: string; layout_code: string }[]
      >`
        SELECT bill_template_family_id, code, layout_code
        FROM billing.bill_template_family WHERE name = ${name}`;
      return row;
    }

    async function auditCount(targetId?: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_TYPE_CREATED'
          AND (${targetId ?? null}::text IS NULL OR target_id = ${targetId ?? null})`;
      return row!.n;
    }

    async function typeCount(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_family`;
      return row!.n;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5, onnotice: () => {} });
      await dropAll();
      const drizzleDb = drizzle(sql, { schema });
      await migrate(drizzleDb, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      // The real role bootstrap, in provisioning order (kestra skipped).
      for (const file of [
        "db/bootstrap/bootstrap-db-roles.sql",
        "db/bootstrap/rating-db-roles.sql",
        "db/bootstrap/billrun-db-roles.sql",
      ]) {
        for (const stmt of statements(file)) await sql.unsafe(stmt);
      }
      db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Type Creator', 'type-creator@example.com', 'LOCAL', 'ACTIVE')`;
    }, 180_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("creates 'Wholesale' as WHOLESALE / INVTPL-WHOLESALE, with no version rows and one audit row", async () => {
      const result = await createTemplateType({ name: "Wholesale" }, ACTOR);
      expect(result).toMatchObject({
        ok: true,
        code: "WHOLESALE",
        layoutCode: "INVTPL-WHOLESALE",
      });
      if (!result.ok) throw new Error("expected ok");

      const row = await typeByName("Wholesale");
      expect(row).toMatchObject({
        bill_template_family_id: result.typeId,
        code: "WHOLESALE",
        layout_code: "INVTPL-WHOLESALE",
      });
      const [versions] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${result.typeId}`;
      expect(versions!.n).toBe(0);
      expect(await auditCount(result.typeId)).toBe(1);
      const [audit] = await sql<
        { actor_user_id: string; after_data: unknown }[]
      >`
        SELECT actor_user_id, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_TYPE_CREATED' AND target_id = ${result.typeId}`;
      expect(audit).toEqual({
        actor_user_id: ACTOR,
        after_data: {
          name: "Wholesale",
          code: "WHOLESALE",
          layoutCode: "INVTPL-WHOLESALE",
        },
      });
    });

    it.each([["wholesale"], [" Wholesale "], ["WHOLESALE"]])(
      "creating %j is TEMPLATE_TYPE_NAME_TAKEN and writes nothing",
      async (name) => {
        const types = await typeCount();
        const audits = await auditCount();
        const result = await createTemplateType({ name }, ACTOR);
        expect(result).toMatchObject({
          ok: false,
          code: "TEMPLATE_TYPE_NAME_TAKEN",
          fieldErrors: { name: [expect.stringContaining("already exists")] },
        });
        expect(await typeCount()).toBe(types);
        expect(await auditCount()).toBe(audits);
      },
    );

    it("an invalid name is TEMPLATE_TYPE_NAME_INVALID with the format message", async () => {
      expect(await createTemplateType({ name: "ab" }, ACTOR)).toMatchObject({
        ok: false,
        code: "TEMPLATE_TYPE_NAME_INVALID",
        fieldErrors: {
          name: ["Use 3–60 letters, digits, spaces, & ( ) or -."],
        },
      });
    });

    it("a retired type's name stays taken", async () => {
      await sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE name = 'Wholesale'`;
      expect(
        await createTemplateType({ name: "Wholesale" }, ACTOR),
      ).toMatchObject({ ok: false, code: "TEMPLATE_TYPE_NAME_TAKEN" });
    });

    it("'Wholesale 2' derives the free code WHOLESALE_2", async () => {
      const result = await createTemplateType({ name: "Wholesale 2" }, ACTOR);
      expect(result).toMatchObject({
        ok: true,
        code: "WHOLESALE_2",
        layoutCode: "INVTPL-WHOLESALE_2",
      });
    });

    it("a code collision takes the next suffix: ACME exists, 'Acme' → ACME_2", async () => {
      await sql`
        INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, layout_code, kind)
        VALUES ('BTF00000900', 'ACME', 'Acme Legacy', 'INVTPL-ACME', 'generated')`;
      const result = await createTemplateType({ name: "Acme" }, ACTOR);
      expect(result).toMatchObject({
        ok: true,
        code: "ACME_2",
        layoutCode: "INVTPL-ACME_2",
      });
    });

    it("guardrail 79 (grant half) — app_runtime: INSERT and UPDATE, not DELETE, on bill_template_family; USAGE on its sequence", async () => {
      const privs = await sql<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_runtime' AND table_schema = 'billing'
          AND table_name = 'bill_template_family'`;
      const names = privs.map((p) => p.privilege_type);
      expect(names).toEqual(expect.arrayContaining(["INSERT", "UPDATE"]));
      expect(names).not.toContain("DELETE");
      const [seq] = await sql<{ usage: boolean }[]>`
        SELECT has_sequence_privilege('app_runtime', 'billing.bill_template_family_seq', 'USAGE') AS usage`;
      expect(seq!.usage).toBe(true);
    });

    it("listUsable: a non-default type with an ACTIVE settings row only — not Standard, a retired type, or DRAFT/RETIRED-only types", async () => {
      // One type per case, each with its own layout v1 (bm74: a settings row
      // must point at a layout of its own type), copied from Standard v1.
      async function typeWithSettings(
        id: string,
        code: string,
        name: string,
        settings: "ACTIVE" | "DRAFT" | "RETIRED" | null,
        retired = false,
      ): Promise<void> {
        await sql`
          INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, layout_code, kind)
          VALUES (${id}, ${code}, ${name}, ${`INVTPL-${code}`}, 'generated')`;
        const layoutId = `BTV0000${id.slice(-4)}1`;
        await sql`
          INSERT INTO billing.bill_template_version
            (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
             ref_bill_template_family_id, layout_code, page_setup, blob_ref, checksum,
             checksum_algorithm, change_note, activated_datetime)
          SELECT ${layoutId}, 'INVOICE', 'layout', 1, 'ACTIVE', false,
                 ${id}, ${`INVTPL-${code}`}, page_setup, blob_ref, checksum,
                 checksum_algorithm, 'bm77 fixture', now()
          FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000001'`;
        if (settings !== null) {
          const active = settings !== "DRAFT";
          await sql`
            INSERT INTO billing.bill_template_version
              (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
               ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
               checksum_algorithm, change_note, activated_datetime, retired_datetime)
            SELECT ${`BTV0000${id.slice(-4)}2`}, 'INVOICE', 'generated', 1, ${settings}, false,
                   ${layoutId}, ${id}, structure,
                   ${active ? "invoice-templates/generated/INVOICE/vx/" : null},
                   ${active ? "a".repeat(64) : null}, ${active ? "sha256" : null},
                   ${active ? "bm77 fixture" : null},
                   ${active ? sql`now()` : null},
                   ${settings === "RETIRED" ? sql`now()` : null}
            FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
        }
        if (retired) {
          await sql`
            UPDATE billing.bill_template_family SET retired_datetime = now()
            WHERE bill_template_family_id = ${id}`;
        }
      }
      await typeWithSettings(
        "BTF00000910",
        "USABLE_ONE",
        "Usable One",
        "ACTIVE",
      );
      await typeWithSettings(
        "BTF00000911",
        "RETIRED_ONE",
        "Retired One",
        "ACTIVE",
        true,
      );
      await typeWithSettings(
        "BTF00000912",
        "DRAFT_ONLY",
        "Draft Only",
        "DRAFT",
      );
      await typeWithSettings(
        "BTF00000913",
        "RETIRED_SETTINGS",
        "Retired Settings",
        "RETIRED",
      );

      expect(await billTemplateFamilyRepository.listUsable(db)).toEqual([
        { billTemplateFamilyId: "BTF00000910", name: "Usable One" },
      ]);
    });

    // bm82 (D4) — the "Bound BANs" count: one GROUP BY over the BAN type column,
    // NULL counted under Standard, every state (closed included), and the type
    // list carries it (0 for a type nothing is bound to).
    it("countBoundBansByType counts NULL BANs under Standard and bound BANs under their type, closed included; listTemplateTypes shows the counts", async () => {
      const drizzleDb = db as unknown as ReturnType<
        typeof drizzle<typeof schema>
      >;
      const [cycle] = await drizzleDb
        .insert(billCycle)
        .values({ name: "BM82 Bound BANs Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      const [org] = await drizzleDb
        .insert(organization)
        .values({
          name: "BM82 Bound BANs Customer",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await drizzleDb
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await drizzleDb
        .insert(financialAccount)
        .values({
          name: "BM82 FA",
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: ACTOR,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      async function ban(
        state: "active" | "closed",
        typeId: string | null,
      ): Promise<void> {
        await drizzleDb.insert(billingAccount).values({
          name: "BM82 BAN",
          state,
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "MYR",
          refBillCycleId: cycle!.billCycleId,
          refBillTemplateFamilyId: typeId,
          lastEditedBy: ACTOR,
        });
      }
      // Two NULL BANs (one closed) → Standard; two on Usable One (one closed).
      await ban("active", null);
      await ban("closed", null);
      await ban("active", "BTF00000910");
      await ban("closed", "BTF00000910");

      const counts = await countBoundBansByType(db);
      expect(Object.fromEntries(counts)).toEqual({
        BTF00000001: 2,
        BTF00000910: 2,
      });

      const rows = await listTemplateTypes();
      const byId = new Map(rows.map((r) => [r.billTemplateFamilyId, r]));
      expect(byId.get("BTF00000001")?.boundBanCount).toBe(2);
      expect(byId.get("BTF00000910")?.boundBanCount).toBe(2);
      expect(byId.get("BTF00000912")?.boundBanCount).toBe(0);
    });
  },
);
