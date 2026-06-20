import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { session } from "@/db/schema/identity";

// Deletes every session row for a user (instant revocation, Invariant #8)
// and returns how many rows were removed. The count feeds the
// `sessionsRevoked` metadata on the auth-method-change audit event
// (um16-spec §16.2.4); callers that don't need it simply ignore the return.
export async function deleteByUserId(
  db: Database,
  userId: string,
): Promise<number> {
  const deleted = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return deleted.length;
}
