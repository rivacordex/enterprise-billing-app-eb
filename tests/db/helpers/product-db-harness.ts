import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import type * as AuditRepository from "@/db/repositories/audit.repository";
import type { AuditEventInput } from "@/db/repositories/audit.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Shared setup of the product DB suites (pm71's envelope round-trip, pm72's
// characteristic order). The `@/db/repositories/audit.repository` imports above
// must stay type-only: `captureAuditEvents` runs inside that module's vi.mock
// factory, so a runtime import here would be circular.

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

export type ProductTestDb = ReturnType<typeof drizzle<typeof schema>>;

async function dropSchemas(sql: postgresjs.Sql): Promise<void> {
  for (const s of SCHEMAS) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

// Refuses a non-test target, then connects. Separate from the migration so a
// suite holds `sql` — and its afterAll can clean up — even if migrating fails.
export function connectProductDatabase(databaseUrl: string): postgresjs.Sql {
  assertTestDatabaseUrl(databaseUrl);
  return postgres(databaseUrl, { max: 1, onnotice: () => {} });
}

export async function migrateProductDatabase(
  sql: postgresjs.Sql,
): Promise<ProductTestDb> {
  await dropSchemas(sql);
  const db = drizzle(sql, { schema });
  await migrate(db, {
    migrationsFolder: "./db/migrations",
    migrationsSchema: "drizzle",
  });
  return db;
}

export async function closeProductDatabase(
  sql: postgresjs.Sql | undefined,
): Promise<void> {
  if (!sql) return;
  await dropSchemas(sql);
  await sql.end();
}

export async function insertTestActor(
  db: ProductTestDb,
  userName: string,
): Promise<string> {
  const [user] = await db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName,
      userEmail: `${crypto.randomUUID()}@example.com`,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  return user!.id;
}

// A drizzle instance over the suite's own connection that records every
// statement it sends (§1.61, §3.24).
export function countingDb(
  sql: postgresjs.Sql,
  statements: string[],
): ProductTestDb {
  return drizzle(sql, {
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  });
}

// Audit payloads are asserted on the object a service hands to
// insertAuditEvent: `before_data` / `after_data` are jsonb, which re-orders
// keys, so key ORDER can only be seen before it is stored. Vitest isolates
// modules per file, so each suite has its own array. Use:
//   vi.mock("@/db/repositories/audit.repository", async (importOriginal) =>
//     (await import("./helpers/product-db-harness")).captureAuditEvents(
//       await importOriginal<typeof AuditRepository>(),
//     ),
//   );
export const auditCalls: AuditEventInput[] = [];

export function captureAuditEvents(
  actual: typeof AuditRepository,
): typeof AuditRepository {
  return {
    ...actual,
    insertAuditEvent: async (
      ...args: Parameters<typeof actual.insertAuditEvent>
    ) => {
      auditCalls.push(args[1]);
      return actual.insertAuditEvent(...args);
    },
  };
}
