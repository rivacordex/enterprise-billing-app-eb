import { expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Shared fresh-migrate + seed fixture for the onboardCustomerAccounts
// integration tests (v07 atomicity, cm18 template binding).
const SCHEMAS = [
  "inventory",
  "ordering",
  "billing",
  "customer",
  "product",
  "rating",
  "core",
  "partman",
  "drizzle",
];

export interface OnboardingDatabase {
  sql: postgresjs.Sql;
  appuserId: string;
  cycleId: string;
}

async function dropSchemas(sql: postgresjs.Sql): Promise<void> {
  for (const s of SCHEMAS) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

/**
 * Drops and re-migrates every module schema, then seeds one ACTIVE appuser
 * and one active monthly bill cycle. Migrates on a short-lived connection and
 * reads on a fresh one: migrate() poisons the connection's type-OID cache so
 * later timestamptz reads on it return raw strings (module Key Decision —
 * "migrate()-poisons-connection quirk").
 */
export async function setUpOnboardingDatabase(
  databaseUrl: string,
  userTag: string,
): Promise<OnboardingDatabase> {
  assertTestDatabaseUrl(databaseUrl);

  const migrateSql = postgres(databaseUrl, { max: 1 });
  try {
    await dropSchemas(migrateSql);
    await migrate(drizzle(migrateSql), {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });
  } finally {
    await migrateSql.end();
  }

  const sql = postgres(databaseUrl, { max: 1 });

  const [user] = await sql<{ id: string }[]>`
    INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
    VALUES (${`test-user-${userTag}`}, ${`${userTag} Test User`}, ${`${userTag}@example.com`}, 'LOCAL', 'ACTIVE')
    RETURNING user_id AS id
  `;
  if (!user) throw new Error("appuser insert returned no row");

  const [cycle] = await sql<{ id: string }[]>`
    INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
    VALUES ('Monthly – Day 1', 'monthly', 1, 30, 'active')
    RETURNING bill_cycle_id AS id
  `;
  if (!cycle) throw new Error("bill_cycle insert returned no row");

  return { sql, appuserId: user.id, cycleId: cycle.id };
}

export async function tearDownOnboardingDatabase(
  sql: postgresjs.Sql,
): Promise<void> {
  await dropSchemas(sql);
  await sql.end();
}

/** Seeds an organization with an INITIALIZED party_role, ready to onboard. */
export async function seedInitializedCustomer(
  db: OnboardingDatabase,
  name: string,
): Promise<{ id: string; ts: Date }> {
  const { sql, appuserId } = db;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO customer.organization (name, organization_type, last_modified_by)
    VALUES (${name}, 'COMPANY', ${appuserId})
    RETURNING organization_id AS id
  `;
  if (!org) throw new Error("organization insert failed");

  const [pr] = await sql<{ id: string; ts: Date }[]>`
    INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
    VALUES (${org.id}, 'INITIALIZED', ${appuserId})
    RETURNING party_role_id AS id, last_modified_datetime AS ts
  `;
  if (!pr) throw new Error("party_role insert failed");
  return pr;
}

/**
 * Asserts a refused or rolled-back onboarding left no trace: the party_role
 * is still INITIALIZED and no financial_account / billing_account row exists.
 */
export async function expectNotOnboarded(
  sql: postgresjs.Sql,
  partyRoleId: string,
): Promise<void> {
  const [status] = await sql<{ status: string }[]>`
    SELECT status FROM customer.party_role WHERE party_role_id = ${partyRoleId}
  `;
  expect(status?.status).toBe("INITIALIZED");

  for (const table of ["financial_account", "billing_account"]) {
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM ${sql("billing")}.${sql(table)}
      WHERE ref_party_role_id = ${partyRoleId}
    `;
    expect(Number(row?.count), table).toBe(0);
  }
}
