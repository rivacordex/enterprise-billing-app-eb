import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { logger } from "@/lib/logger";
import type { LockoutState } from "@/types/lockout";

const LOCKOUT_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export async function getLockoutState(
  db: Database,
  userId: string,
): Promise<LockoutState> {
  const [row] = await db
    .select({
      failedLoginCount: appuser.failedLoginCount,
      lockedUntil: appuser.lockedUntil,
    })
    .from(appuser)
    .where(eq(appuser.id, userId))
    .limit(1);

  return {
    failedLoginCount: row?.failedLoginCount ?? 0,
    lockedUntil: row?.lockedUntil ?? null,
  };
}

export async function recordFailedAttempt(
  db: Database,
  userId: string,
): Promise<void> {
  const { failedLoginCount: countBefore } = await getLockoutState(db, userId);
  const newCount = countBefore + 1;

  if (newCount < LOCKOUT_THRESHOLD) {
    await db
      .update(appuser)
      .set({ failedLoginCount: newCount })
      .where(eq(appuser.id, userId));
    return;
  }

  const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);

  await db.transaction(async (tx) => {
    await tx
      .update(appuser)
      .set({ failedLoginCount: newCount, lockedUntil })
      .where(eq(appuser.id, userId));

    await insertAuditEvent(tx, {
      eventType: "USER_LOCKED",
      actorUserId: null,
      targetEntity: "appuser",
      targetId: userId,
      beforeData: { failed_login_count: countBefore, locked_until: null },
      afterData: {
        failed_login_count: newCount,
        locked_until: lockedUntil.toISOString(),
      },
    });
  });

  logger.warn("Account locked after consecutive failed login attempts", {
    userId,
    failedLoginCount: newCount,
    lockedUntil: lockedUntil.toISOString(),
  });
}

export async function clearLockout(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .update(appuser)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(appuser.id, userId));
}
