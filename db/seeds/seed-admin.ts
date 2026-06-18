import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { appuser, account } from "@/db/schema/identity";

// Standalone script (`npm run db:seed`) — never imported by application
// code. Seeds the permanent break-glass LOCAL admin (um03-spec §2.5, §3.13).
// No `AUDIT_LOG` row is written here: this is infrastructure bootstrap at
// deployment time, not an application-operational mutation.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema: { appuser, account } });

  try {
    const [existing] = await db
      .select()
      .from(appuser)
      .where(eq(appuser.userEmail, config.BOOTSTRAP_ADMIN_EMAIL))
      .limit(1);

    if (existing) {
      logger.info("Bootstrap admin already exists, skipping seed.");
      return;
    }

    const hashedPassword = await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD);
    const userId = randomUUID();
    const accountId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(appuser).values({
        id: userId,
        userName: "System Administrator",
        userEmail: config.BOOTSTRAP_ADMIN_EMAIL,
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
