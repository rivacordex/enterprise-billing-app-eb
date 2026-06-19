import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { session } from "@/db/schema/identity";

export async function deleteByUserId(
  db: Database,
  userId: string,
): Promise<void> {
  await db.delete(session).where(eq(session.userId, userId));
}
