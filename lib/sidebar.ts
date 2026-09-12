// Single shared constant for the admin sidebar collapse-state cookie
// (um28-spec §2.4). Imported by both the server read (`app/(app)/layout.tsx`)
// and the client write (`components/app-shell.tsx`) so the name can't drift.
// The cookie is intentionally NOT HttpOnly (the client toggle writes it via
// `document.cookie`) and carries no sensitive data — only "1"/"0".
export const SIDEBAR_COOKIE = "sidebar_collapsed";

// D9: the sidebar now defaults to COLLAPSED when no cookie is present — with
// the Homepage as the directory and the brand in the top bar, the expanded
// rail is no longer the primary way to find a page. An explicit user choice
// still wins and still persists for a year. Stated once here (not as a bare
// comparison operator in the layout) so the default is unit-testable.
export const DEFAULT_SIDEBAR_COLLAPSED = true;

// Maps the raw cookie value to the resolved collapse state: an explicit "0"
// expands, an explicit "1" collapses, and anything else (absent/garbage) falls
// back to the default (D9).
export function resolveSidebarCollapsed(
  cookieValue: string | undefined,
): boolean {
  if (cookieValue === "0") return false;
  if (cookieValue === "1") return true;
  return DEFAULT_SIDEBAR_COLLAPSED;
}
