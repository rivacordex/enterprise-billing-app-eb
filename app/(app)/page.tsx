import Link from "next/link";
import { redirect } from "next/navigation";

import { getEffectivePermissions, loadSessionUser } from "@/auth/guard";
import { NAV_ICONS } from "@/components/nav-icons";
import { db } from "@/db/client";
import { deleteByUserId } from "@/db/repositories/session.repository";
import { visibleSections } from "@/lib/nav-registry";
import { resolveRootRedirect } from "@/lib/root-redirect";

export const dynamic = "force-dynamic";

// The default landing Homepage (plan §3.10): a directory of the pages the
// signed-in user may open, grouped by module section (D3 — this page is `/`,
// inheriting the shell). It is session-gated (D5): reachable by every ACTIVE
// user, and the list it renders IS the permission check, so it discloses
// nothing it doesn't permit.
//
// The redirect preamble still deliberately can't reuse `requirePermission`/
// `requireAuthenticated` — those redirect a `force_password_change` user to
// `/set-password`, which would loop here (um06-spec §6.8). It does share the
// request-scoped session/user + permission reads (loadSessionUser,
// getEffectivePermissions) with the shell layout so `/` resolves each once.
// Renders nothing only on the redirect paths.
export default async function HomePage(): Promise<React.JSX.Element> {
  const resolved = await loadSessionUser();
  if (!resolved) {
    redirect("/login");
  }

  const { userId, user } = resolved;

  // Stale-session cleanup for a missing/DISABLED/DELETED user (mirrors
  // `getActiveUser`); PENDING passes here so the force-password gate below can
  // route a LOCAL first-login to `/set-password`.
  if (!user || user.status === "DISABLED" || user.status === "DELETED") {
    await deleteByUserId(db, userId);
    redirect("/login");
  }

  const redirectTarget = resolveRootRedirect({
    forcePasswordChange: user.forcePasswordChange,
  });
  if (redirectTarget) {
    redirect(redirectTarget);
  }

  // Past the force-password gate, only an ACTIVE principal may see the
  // directory (Inv #4 "non-ACTIVE ⇒ no access", plan D5). A lingering
  // non-ACTIVE session — e.g. a PENDING SSO user whose first-login activation
  // never completed — is treated as no access: delete the stale session and
  // bounce to `/login`, exactly as `getActiveUser` does for guarded pages.
  if (user.status !== "ACTIVE") {
    await deleteByUserId(db, userId);
    redirect("/login");
  }

  const permissionMap = await getEffectivePermissions(userId);
  const sections = visibleSections(permissionMap);

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <header className="mb-8">
        <h1 className="text-h1 font-semibold text-foreground">Home</h1>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Signed in as {user.userName} · {user.userEmail}
        </p>
      </header>

      {sections.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-md border border-[color:var(--border-subtle)] [background-image:var(--gradient-brand)] p-10 text-center">
          <p className="max-w-md text-body font-medium text-[color:var(--text-on-brand)]">
            Your account doesn&apos;t have access to any modules yet. Contact an
            administrator.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {sections.map((section, sectionIndex) => {
            // Slugify the free-form caption so a multi-word/punctuated section
            // name still yields a valid single-token id for aria-labelledby;
            // fall back to the index if the caption has no ASCII alphanumerics
            // (e.g. a non-Latin caption) so the id is always present and unique.
            const slug = section.caption
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
            const headingId = `home-section-${slug || sectionIndex}`;
            return (
              <section key={section.caption} aria-labelledby={headingId}>
                <div className="mb-4 flex items-center gap-3">
                  <h2
                    id={headingId}
                    className="text-overline font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                  >
                    {section.caption}
                  </h2>
                  <span
                    aria-hidden
                    className="h-px flex-1 bg-[color:var(--border-subtle)]"
                  />
                </div>
                {/* Horizontal chips (icon beside label), 5 side by side at
                    every width (labels wrap within the chip when narrow). */}
                <ul className="grid grid-cols-5 gap-2.5">
                  {section.items.map((item) => {
                    const Icon = NAV_ICONS[item.href];
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="flex h-full items-center gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-2.5 text-left shadow-sm transition-colors outline-none hover:border-[color:var(--border-focus)] hover:bg-[color:var(--color-primary-50)] focus-visible:[box-shadow:var(--focus-ring)]"
                        >
                          <Icon
                            size={18}
                            aria-hidden
                            className="shrink-0 text-[color:var(--color-primary-500)]"
                          />
                          <span className="text-body-sm font-medium text-foreground">
                            {item.label}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
