import "server-only";

import { randomBytes } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

// 18 bytes -> 24 base64url characters (~144 bits of entropy). Never logged
// (um08-spec §8.2, Inv. #1) — the only place the plaintext exists is the
// return value of `createUser` (services/users/users-write.service.ts).
export function generateTempPassword(): string {
  return randomBytes(18).toString("base64url");
}

// Reuses Better-Auth's own scrypt hashing helper (the same one `db/seeds/
// seed-admin.ts` uses) so the hash format is identical to what the
// credential sign-in flow already verifies against.
export async function hashTempPassword(plaintext: string): Promise<string> {
  return hashPassword(plaintext);
}
