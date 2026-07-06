// Single shared constant for the admin sidebar collapse-state cookie
// (um28-spec §2.4). Imported by both the server read (`app/(app)/layout.tsx`)
// and the client write (`components/admin-sidebar.tsx`) so the name can't
// drift. The cookie is intentionally NOT HttpOnly (the client toggle writes
// it via `document.cookie`) and carries no sensitive data — only "1"/"0".
export const SIDEBAR_COOKIE = "sidebar_collapsed";
