import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { appuser, account } from "@/db/schema/identity";

// Bootstrap admin credentials are only required for this seed script, not
// for every app process, so they get their own schema rather than living in
// the shared `lib/config.ts` runtime config (um03).
const seedConfigSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(16),
});

function loadSeedConfig() {
  const parsed = seedConfigSchema.safeParse({
    BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid bootstrap admin environment configuration: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

// Standalone script (`npm run db:seed`) — never imported by application
// code. Seeds the permanent break-glass LOCAL admin (um03-spec §2.5, §3.13).
// No `AUDIT_LOG` row is written here: this is infrastructure bootstrap at
// deployment time, not an application-operational mutation.
async function main(): Promise<void> {
  const seedConfig = loadSeedConfig();
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema: { appuser, account } });

  try {
    const [existing] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.userEmail, seedConfig.BOOTSTRAP_ADMIN_EMAIL))
      .limit(1);

    if (existing) {
      logger.info("Bootstrap admin already exists, skipping seed.");
      return;
    }

    const hashedPassword = await hashPassword(
      seedConfig.BOOTSTRAP_ADMIN_PASSWORD,
    );
    const userId = randomUUID();
    const accountId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(appuser).values({
        id: userId,
        userName: "System Administrator",
        userEmail: seedConfig.BOOTSTRAP_ADMIN_EMAIL,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
        forcePasswordChange: false,
        failedLoginCount: 0,
      });

      await tx.insert(account).values({
        id: accountId,
        userId,
        providerId: "credential",
        providerAccountId: userId,
        password: hashedPassword,
      });
    });

    logger.info("Bootstrap admin seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Bootstrap admin seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
