// Carved out ahead of the general "lib" pattern (um25-spec §"Policy
// source"): `validation/password.ts` needs `passwordPolicy` to build
// `defaultPasswordSchema`, but `validation/**` is deliberately restricted
// from the general `lib/**` boundary (validation files stay zod-only,
// framework-agnostic). This is a narrow, non-secret re-export — same shape
// as the `auth-permission-constants` carve-out.
export { passwordPolicy } from "@/lib/config";
