import { createAuthClient } from "better-auth/react";

// Client-safe entry point (um03-spec §3.8) — the only module `components/`
// may import from `auth/`. Never import `auth/index.ts` (the server config)
// from here. `NEXT_PUBLIC_APP_URL` is the one public, non-secret env var
// introduced in this unit.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
});
