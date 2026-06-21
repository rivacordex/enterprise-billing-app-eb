import "server-only";

import { hashPassword } from "better-auth/crypto";

// Reuses Better-Auth's own scrypt hashing helper (the same one `db/seeds/
// seed-admin.ts` uses) so the hash format is identical to what the
// credential sign-in flow already verifies against.
export async function hashTempPassword(plaintext: string): Promise<string> {
  return hashPassword(plaintext);
}
