import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll } from "vitest";

import type { Database } from "@/db/client";
import {
  billTemplateVersionRepository,
  type TemplateDraftRow,
} from "@/db/repositories/billing/bill-template-version";
import * as schema from "@/db/schema";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import type { UploadLayoutPackageResult } from "@/types/billing";
import { dropAllSchemas } from "@/tests/e2e/helpers/fresh-database";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  buildLayoutPackage,
  cleanRender,
} from "@/tests/helpers/layout-package";

// bm78/bm79 — the shared harness of the Invoice Template Types DB suites
// (upload, pair activation, discard): a fresh migrated + seeded database, the
// `invoice-templates` blob container, and the service calls those suites
// repeat. Each suite still installs its own `@/db/client` mock (vi.mock is
// per file) over a hoisted `holder`, which the harness fills.

// Drop, migrate, add the actor, seed Standard's layout + settings (their
// blobs included) and clear the compiled-template memo.
export async function freshTemplateDatabase(
  sql: postgresjs.Sql,
  actor: TemplateTypeActor,
): Promise<Database> {
  await dropAllSchemas(sql);
  const drizzleDb = drizzle(sql, { schema });
  await migrate(drizzleDb, {
    migrationsFolder: "./db/migrations",
    migrationsSchema: "drizzle",
  });
  const db = drizzleDb as unknown as Database;
  await sql`
    INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
    VALUES (${actor.id}, ${actor.name}, ${actor.email}, 'LOCAL', 'ACTIVE')`;
  await seedInvoiceTemplates(db);
  clearLoadedTemplateMemo();
  return db;
}

function invoiceTemplates(service: BlobServiceClient): ContainerClient {
  return service.getContainerClient("invoice-templates");
}

export async function blobNames(
  container: ContainerClient,
  prefix: string,
): Promise<string[]> {
  const names: string[] = [];
  for await (const b of container.listBlobsFlat({ prefix })) {
    names.push(b.name);
  }
  return names;
}

async function deleteBlobs(
  container: ContainerClient,
  prefixes: readonly string[],
): Promise<void> {
  for (const prefix of prefixes) {
    for (const name of await blobNames(container, prefix)) {
      await container.deleteBlob(name).catch(() => undefined);
    }
  }
}

export interface TemplateTypeActor {
  id: string;
  name: string;
  email: string;
}

export type AuditRow = {
  target_id: string;
  before_data: unknown;
  after_data: unknown;
};

export interface TemplateTypeDb {
  // The fresh database and its client (available once `beforeAll` has run).
  readonly db: Database;
  readonly sql: postgresjs.Sql;
  templates(): ContainerClient;
  blobNames(prefix: string): Promise<string[]>;
  // Upload the reference package as `layoutCode` v`n` as the actor (clean
  // probe render); throws on a refusal, so a fixture step never fails silently.
  upload(
    familyId: string,
    layoutCode: string,
    n: number,
  ): Promise<Extract<UploadLayoutPackageResult, { ok: true }>>;
  // The type's settings DRAFT and its token, as the page would load them.
  settingsDraft(familyId: string): Promise<TemplateDraftRow>;
  // A new type with its layout v1 uploaded (a layout + settings DRAFT pair).
  createTypeWithLayout(name: string): Promise<string>;
  // The audit rows of one event type, oldest first.
  auditRows(eventType: string): Promise<AuditRow[]>;
}

// The suite lifecycle, registered from inside a `describe` whose skip
// condition requires both stores. Before all: guard both stores, build the
// fresh database, hand it to the suite's `@/db/client` mock (`holder.db`) and
// remove the suite's blobs. After all: remove the blobs ONLY if the guards
// passed (Vitest runs `afterAll` even when `beforeAll` threw), and drop every
// schema. The suite's own `beforeAll` hooks run after this one.
export function registerTemplateTypeDb(opts: {
  databaseUrl: string | undefined;
  blobConnection: string | undefined;
  actor: TemplateTypeActor;
  blobPrefixes: readonly string[];
  holder: { db: unknown };
}): TemplateTypeDb {
  let service: BlobServiceClient | null = null;
  let sql: postgresjs.Sql | undefined;
  let db: Database | undefined;
  let guarded = false;

  const templates = (): ContainerClient => {
    if (!service) {
      throw new Error(
        "registerTemplateTypeDb: a guarded BILLRUN_BLOB_CONNECTION_STRING is required",
      );
    }
    return invoiceTemplates(service);
  };

  beforeAll(async () => {
    assertTestDatabaseUrl(opts.databaseUrl as string);
    // The cleanup deletes blobs, so guard the blob store like the DB.
    assertTestBlobConnection(opts.blobConnection as string);
    guarded = true;
    service = BlobServiceClient.fromConnectionString(
      opts.blobConnection as string,
    );
    sql = postgres(opts.databaseUrl as string, { max: 8, onnotice: () => {} });
    db = await freshTemplateDatabase(sql, opts.actor);
    opts.holder.db = db;
    await deleteBlobs(templates(), opts.blobPrefixes);
  }, 180_000);

  afterAll(async () => {
    if (guarded && service) await deleteBlobs(templates(), opts.blobPrefixes);
    clearLoadedTemplateMemo();
    if (sql) {
      await dropAllSchemas(sql);
      await sql.end();
    }
  }, 60_000);

  const handle: TemplateTypeDb = {
    get db(): Database {
      if (!db) throw new Error("registerTemplateTypeDb: no database yet");
      return db;
    },
    get sql(): postgresjs.Sql {
      if (!sql) throw new Error("registerTemplateTypeDb: no client yet");
      return sql;
    },
    templates,
    blobNames: (prefix) => blobNames(templates(), prefix),
    async upload(familyId, layoutCode, n) {
      const result = await uploadLayoutPackage(
        {
          familyId,
          zip: buildLayoutPackage({ layoutCode, layoutVersion: n }).zip,
          expectedDraft: { none: true },
        },
        opts.actor.id,
        { render: cleanRender() },
      );
      if (!result.ok) throw new Error(`upload failed: ${result.code}`);
      return result;
    },
    async settingsDraft(familyId) {
      const draft = await billTemplateVersionRepository.findDraft(handle.db, {
        kind: "generated",
        familyId,
      });
      if (!draft) throw new Error("no settings draft");
      return draft;
    },
    async createTypeWithLayout(name) {
      const created = await createTemplateType({ name }, opts.actor.id);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      await handle.upload(created.typeId, created.layoutCode, 1);
      return created.typeId;
    },
    auditRows: (eventType) => handle.sql<AuditRow[]>`
      SELECT target_id, before_data, after_data FROM core.audit_log
      WHERE event_type = ${eventType} ORDER BY created_datetime`,
  };
  return handle;
}
