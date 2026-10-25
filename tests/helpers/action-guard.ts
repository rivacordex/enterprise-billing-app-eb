import type { requirePermission } from "@/auth/guard";

// Server-action test helpers: the error `requirePermission` throws for a
// caller without the level (Next.js's redirect, recognised by `isRedirectError`),
// and the principal an allowed caller resolves to.
export function redirectError(): Error & { digest: string } {
  const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
  e.digest = "NEXT_REDIRECT;replace;/no-access;307;";
  return e;
}

type Principal = Awaited<ReturnType<typeof requirePermission>>;

export function principal(
  permissionMap: Record<string, string>,
  userId = "actor-1",
): Principal {
  return {
    userId,
    userEmail: `${userId}@example.com`,
    permissionMap: permissionMap as Principal["permissionMap"],
  };
}
