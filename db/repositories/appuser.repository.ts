import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser, type AppUser } from "@/db/schema/identity";

export async function findUserById(
  db: Database,
  id: string,
): Promise<AppUser | null> {
  const [row] = await db
    .select()
    .from(appuser)
    .where(eq(appuser.id, id))
    .limit(1);
  return row ?? null;
}

export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<AppUser | null> {
  const [row] = await db
    .select()
    .from(appuser)
    .where(eq(appuser.userEmail, email))
    .limit(1);
  return row ?? null;
}

export async function updateLastLogin(
  db: Database,
  userId: string,
  loginDatetime: Date,
): Promise<void> {
  await db
    .update(appuser)
    .set({ lastLoginDatetime: loginDatetime })
    .where(eq(appuser.id, userId));
}
