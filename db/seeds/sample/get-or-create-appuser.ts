import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";

// `ordering-inventory.ts` precedent — a get-or-create app user, used here as
// the actor id for the sample seed's `createCustomer`/`onboardCustomerAccounts`/
// `createOrder` service calls and every audit row they write.
export async function getOrCreateAppUser(
  db: Database,
  userName: string,
  userEmail: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: appuser.id })
    .from(appuser)
    .where(eq(appuser.userEmail, userEmail))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName,
      userEmail,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  return inserted!.id;
}
