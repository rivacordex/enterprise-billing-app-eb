import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import * as schema from "@/db/schema";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { buildIndex } from "@/scripts/invoice-templates/write-checksums";
import { blobStore } from "@/services/billing/blob-store";

// bm53-spec §Design D6 — `npm run db:seed-invoice-templates` (in `db:setup`
// after `db:seed-billing`; in prod, after `db:migrate` and after bm52's
// containers exist — environment-operations.md). Uploads the three seeded
// template versions' repo files to the `invoice-templates` container so a run
// with no admin activity renders the default FROM BLOB (guardrail 45).
//
// Real configuration, not sample data: no `_SAMPLE_` marker, no prod guard.
//
// For each seeded row (BTV00000001–3):
//   1. Recompute every file digest + the `checksums.json` digest from the repo;
//      it MUST equal the DB row's `checksum` (and the committed index must be
//      byte-identical to the recomputed one), else `SEED_CHECKSUM_DRIFT` — the
//      repo and the migration disagree, so nothing is uploaded (all three rows
//      are checked before the first put).
//   2. `putObject` every file (incl. `checksums.json`) write-once with
//      `onExists: 'returnExisting'`. A pre-existing blob whose digest differs
//      from the repo's is `SEED_BLOB_CONFLICT` — never overwritten.
// Idempotent: a re-run re-verifies and uploads nothing new.

export const SEEDED_TEMPLATE_VERSION_IDS = [
  "BTV00000001",
  "BTV00000002",
  "BTV00000003",
] as const;

const CONTAINER = "invoice-templates";
const INDEX_FILE = "checksums.json";

export const DEFAULT_SEED_REPO_ROOT = path.join(
  process.cwd(),
  "db/seeds/invoice-templates",
);

export type SeedInvoiceTemplatesErrorCode =
  | "SEED_CHECKSUM_DRIFT"
  | "SEED_BLOB_CONFLICT";

export class SeedInvoiceTemplatesError extends Error {
  readonly code: SeedInvoiceTemplatesErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(
    code: SeedInvoiceTemplatesErrorCode,
    message: string,
    detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SeedInvoiceTemplatesError";
    this.code = code;
    this.detail = detail;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".hbs": "text/x-handlebars-template; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  // The layout ships its font licence (`fonts/OFL.txt`).
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeOf(file: string): string {
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type) {
    throw new Error(`db:seed-invoice-templates: no content type for ${file}`);
  }
  return type;
}

// `invoice-templates/generated/INVOICE/v1/` → the blob directory
// `generated/INVOICE/v1/` and its repo directory. The repo mirrors the blob
// path after the container, except that the layout lives at
// `db/seeds/invoice-templates/INVTPL-STD-A4/v1/` (code-standards Part 2 data
// rule 10) while its blob path carries a `layouts/` segment.
function locate(
  repoRoot: string,
  versionId: string,
  blobRef: string,
): { blobDir: string; repoDir: string } {
  const slash = blobRef.indexOf("/");
  const container = blobRef.slice(0, slash);
  const blobDir = blobRef.slice(slash + 1);
  if (slash <= 0 || container !== CONTAINER || !blobDir.endsWith("/")) {
    throw new Error(
      `db:seed-invoice-templates: ${versionId} has an unexpected blob_ref ${blobRef}`,
    );
  }
  const repoRel = blobDir.replace(/^layouts\//, "");
  return { blobDir, repoDir: path.join(repoRoot, repoRel) };
}

interface PlannedVersion {
  versionId: string;
  blobDir: string;
  // index name → bytes (incl. `checksums.json`), all verified against the row.
  files: Map<string, Buffer>;
}

function planVersion(
  repoRoot: string,
  versionId: string,
  blobRef: string,
  rowChecksum: string,
): PlannedVersion {
  const { blobDir, repoDir } = locate(repoRoot, versionId, blobRef);
  const { bytes: indexBytes, digest } = buildIndex(repoDir);
  const committedIndex = readFileSync(path.join(repoDir, INDEX_FILE));
  if (digest !== rowChecksum || !committedIndex.equals(indexBytes)) {
    throw new SeedInvoiceTemplatesError(
      "SEED_CHECKSUM_DRIFT",
      `${versionId}: the repo files under ${repoDir} do not match the migration's checksum`,
      { versionId, expected: rowChecksum, actual: digest },
    );
  }

  const index = JSON.parse(indexBytes.toString("utf-8")) as {
    files: Record<string, string>;
  };
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(index.files)) {
    files.set(name, readFileSync(path.join(repoDir, name)));
  }
  files.set(INDEX_FILE, indexBytes);
  return { versionId, blobDir, files };
}

export interface SeedInvoiceTemplatesOptions {
  repoRoot?: string;
  // The blob transport (the real store by default). Tests pass a wrapper.
  store?: Pick<typeof blobStore, "putObject">;
}

export interface SeedInvoiceTemplatesResult {
  uploaded: string[]; // blob refs created by this run
  existing: string[]; // blob refs already present with the repo's bytes
}

export async function seedInvoiceTemplates(
  db: Database,
  {
    repoRoot = DEFAULT_SEED_REPO_ROOT,
    store = blobStore,
  }: SeedInvoiceTemplatesOptions = {},
): Promise<SeedInvoiceTemplatesResult> {
  // Step 1 for EVERY row before any upload.
  const plans: PlannedVersion[] = [];
  for (const versionId of SEEDED_TEMPLATE_VERSION_IDS) {
    const row = await billTemplateVersionRepository.findById(db, versionId);
    if (!row?.blobRef || !row.checksum) {
      throw new Error(
        `db:seed-invoice-templates: seeded row ${versionId} is missing — run db:migrate first.`,
      );
    }
    plans.push(planVersion(repoRoot, versionId, row.blobRef, row.checksum));
  }

  // Step 2.
  const result: SeedInvoiceTemplatesResult = { uploaded: [], existing: [] };
  for (const { versionId, blobDir, files } of plans) {
    for (const [name, bytes] of files) {
      const put = await store.putObject(
        CONTAINER,
        `${blobDir}${name}`,
        bytes,
        contentTypeOf(name),
        {
          writeOnce: true,
          onExists: "returnExisting",
          checksumAlgorithm: "sha256",
        },
      );
      if (put.created) {
        result.uploaded.push(put.blobRef);
        continue;
      }
      const expected = createHash("sha256").update(bytes).digest("hex");
      if (put.checksum !== expected) {
        throw new SeedInvoiceTemplatesError(
          "SEED_BLOB_CONFLICT",
          `${versionId}: stored blob ${put.blobRef} differs from the repo file — refusing to overwrite`,
          { versionId, blobRef: put.blobRef, expected, actual: put.checksum },
        );
      }
      result.existing.push(put.blobRef);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema });
  try {
    const { uploaded, existing } = await seedInvoiceTemplates(db);
    logger.info("Invoice template seed blobs verified.", {
      uploaded: uploaded.length,
      alreadyPresent: existing.length,
    });
  } finally {
    await sql.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main().catch((err: unknown) => {
    logger.error("Invoice template seed failed.", {
      code: err instanceof SeedInvoiceTemplatesError ? err.code : undefined,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    process.exit(1);
  });
}
