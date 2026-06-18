import { drizzle, type PostgresJsTransaction } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import postgres from "postgres";

import { config } from "@/lib/config";

import * as schema from "@/db/schema";

// Production `DATABASE_URL` is sourced from Key Vault via Managed Identity
// (um25); here it comes from the env via lib/config. The migration runner
// (db/migrate.ts) opens its own dedicated connection so DDL never contends
// with this pool.
const client = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

// A `db.transaction(async (tx) => ...)` callback's `tx` lacks the pool-only
// `$client` property, so it doesn't structurally match `typeof db` under
// `exactOptionalPropertyTypes`. Repositories take either handle (um03-spec
// §3.5) so callers can compose writes into their own transaction.
export type Database =
  | typeof db
  | PostgresJsTransaction<
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;
