import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { BlobServiceClient } from "@azure/storage-blob";
import type postgresjs from "postgres";

// bm63-spec §Design D1/D2 — a FRESH database built by the repo's own setup
// scripts, shared by the ship-gate journey and the admin browser e2e. Every
// script runs as a child process without `--env-file=.env`. The app scripts
// connect through DATABASE_URL (sentinel-checked by the integration global
// setup); the role bootstraps and partman setups connect through
// BOOTSTRAP_DATABASE_URL as a superuser, so `runScript` refuses to start
// unless that URL names the same database (host, port, name) as DATABASE_URL.
// Callers also assert the throwaway Postgres/Azurite (`assertTestDatabaseUrl`,
// `assertTestBlobConnection`).

export const REPO_ROOT = join(__dirname, "../../..");

// `db:migrate` + the role bootstraps, then `db:setup` in its own order
// (kestra's roles live in a separate database and are skipped).
export const SETUP_SCRIPTS = [
  "db/migrate.ts",
  "db/bootstrap/bootstrap-db-roles.ts",
  "db/bootstrap/rating-db-roles.ts",
  "db/bootstrap/billrun-db-roles.ts",
  "db/migrate.ts",
  "db/bootstrap/audit-partman-setup.ts",
  "db/bootstrap/billing-partman-setup.ts",
  "db/bootstrap/rating-partman-setup.ts",
  "db/seeds/seed-admin.ts",
  "db/seeds/seed-rbac.ts",
  "db/seeds/product.ts",
  "db/seeds/customer.ts",
  "db/seeds/accounts/seed-accounts.ts",
  "db/seeds/ordering-inventory.ts",
  "db/seeds/billing.ts",
  "db/seeds/invoice-templates.ts",
  "db/seeds/rating-event-catalog.ts",
] as const;

function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  return `${host}:${parsed.port || "5432"}${parsed.pathname}`;
}

// The bootstrap scripts never read DATABASE_URL. A BOOTSTRAP_DATABASE_URL
// inherited from the shell (e.g. the dev one) would run them against another
// database as a superuser, so it must be the disposable database itself.
export function assertBootstrapTargetsTestDatabase(): void {
  const app = process.env.DATABASE_URL;
  const bootstrap = process.env.BOOTSTRAP_DATABASE_URL;
  if (!app || !bootstrap) {
    throw new Error(
      "DATABASE_URL and BOOTSTRAP_DATABASE_URL are both required.",
    );
  }
  if (databaseIdentity(app) !== databaseIdentity(bootstrap)) {
    throw new Error(
      "Refusing to run the setup scripts: BOOTSTRAP_DATABASE_URL " +
        `(${databaseIdentity(bootstrap)}) is not the disposable DATABASE_URL ` +
        `(${databaseIdentity(app)}). Load .env.test and unset any exported dev value.`,
    );
  }
}

export function runScript(
  script: string,
  env: Record<string, string> = {},
): void {
  assertBootstrapTargetsTestDatabase();
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", script],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${script} exited ${result.status}\n${result.stderr}\n${result.stdout}`,
    );
  }
}

export async function dropAllSchemas(sql: postgresjs.Sql): Promise<void> {
  for (const s of [
    "inventory",
    "ordering",
    "billing",
    "customer",
    "product",
    "rating",
    "core",
    "drizzle",
    "partman",
  ]) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

// Deletes what an earlier run left in the throwaway Azurite: stored invoice
// PDFs (`document_inv_seq` restarts per database, and `putInvoice` would
// adopt an old PDF at the same path), logos, and activated generated
// versions. The seeded layouts and the default `generated/INVOICE/v1/` stay.
export async function purgeInvoiceBlobs(
  service: BlobServiceClient,
): Promise<void> {
  for (const container of ["invoices", "invoice-assets"]) {
    const client = service.getContainerClient(container);
    await client.createIfNotExists();
    for await (const b of client.listBlobsFlat()) {
      await client.deleteBlob(b.name).catch(() => undefined);
    }
  }
  const templates = service.getContainerClient("invoice-templates");
  await templates.createIfNotExists();
  for await (const b of templates.listBlobsFlat({
    prefix: "generated/INVOICE/",
  })) {
    if (!b.name.startsWith("generated/INVOICE/v1/")) {
      await templates.deleteBlob(b.name).catch(() => undefined);
    }
  }
}

export async function freshDatabase(
  sql: postgresjs.Sql,
  service: BlobServiceClient,
): Promise<void> {
  await dropAllSchemas(sql);
  await purgeInvoiceBlobs(service);
  for (const script of SETUP_SCRIPTS) runScript(script);
}
