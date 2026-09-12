export interface RootRedirectSession {
  forcePasswordChange: boolean;
}

// Extracted from the Homepage for testability (um06-spec §6.10) — callable
// directly without a running Next.js server. The permission-ordered
// `ROUTE_ORDER` table and the `/no-access` fallback are retired with the
// Homepage (D3): a user with no grants now lands on the Homepage's empty state,
// not `/no-access`. So this keeps only the two pre-render gates that don't
// depend on the viewer's permissions.
//
// Returns a redirect target, or `null` when the caller should render the
// Homepage itself.
export function resolveRootRedirect(
  session: RootRedirectSession | null,
): string | null {
  if (!session) return "/login";
  if (session.forcePasswordChange) return "/set-password";
  return null;
}
