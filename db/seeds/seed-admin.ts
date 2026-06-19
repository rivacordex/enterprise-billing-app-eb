import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, ne } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { appuser, account } from "@/db/schema/identity";
import { loadBootstrapAdminConfig } from "@/db/seeds/seed-admin.config";

// Standalone script (`npm run db:seed`) — never imported by application
// code. Seeds the permanent break-glass LOCAL admin (um03-spec §2.5, §3.13).
// No `AUDIT_LOG` row is written here: this is infrastructure bootstrap at
// deployment time, not an application-operational mutation.
async function main(): Promise<void> {
  const bootstrapAdmin = loadBootstrapAdminConfig();
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema: { appuser, account } });

  try {
    // `appuser_email_unique` is a partial index (`WHERE status <> 'DELETED'`,
    // um02-spec §3.4) — a DELETED row sharing this email is not a live
    // admin and must not be mistaken for one, or this script would skip
    // reseeding and leave the system with zero working admins.
    const [existing] = await db
      .select()
      .from(appuser)
      .where(
        and(
          eq(appuser.userEmail, bootstrapAdmin.BOOTSTRAP_ADMIN_EMAIL),
          ne(appuser.status, "DELETED"),
        ),
      )
      .limit(1);

    if (existing) {
      logger.info("Bootstrap admin already exists, skipping seed.");
      return;
    }

    const hashedPassword = await hashPassword(
      bootstrapAdmin.BOOTSTRAP_ADMIN_PASSWORD,
    );
    const userId = randomUUID();
    const accountId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(appuser).values({
        id: userId,
        userName: "System Administrator",
        userEmail: bootstrapAdmin.BOOTSTRAP_ADMIN_EMAIL,
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
