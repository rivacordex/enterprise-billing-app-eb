"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";

import { authClient } from "@/auth/client";
import { cn } from "@/lib/utils";

interface NavSignOutButtonProps {
  // um28-spec §2.5: in the collapsed rail the footer is a sign-out icon only
  // (no label, no identity strip). `title` keeps it discoverable on hover.
  collapsed?: boolean;
}

// um26-spec §"SignOutButton appearance on the dark nav" (Option B). A
// dark-surface sign-out control for the admin sidebar footer. Kept separate
// from `components/sign-out-button.tsx` (the light `/no-access` button, a
// shadcn `Button` wrapper whose `variant` prop is already shadcn's) so neither
// regresses the other — the visual spec here (full-width, `LogOut` icon, dark
// nav tokens, "Signing out…" pending label) doesn't map onto shadcn's Button
// variants. Same sign-out mechanism as `SignOutButton`: the Better-Auth
// client sign-out + redirect to `/login`.
export function NavSignOutButton({
  collapsed = false,
}: NavSignOutButtonProps = {}): React.JSX.Element {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleSignOut(): Promise<void> {
    setIsPending(true);
    try {
      await authClient.signOut();
      router.push("/login");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      aria-label="Sign out"
      title={collapsed ? "Sign out" : undefined}
      onClick={() => void handleSignOut()}
      disabled={isPending}
      className={cn(
        "flex w-full items-center gap-2 rounded-md text-sm text-[color:var(--color-primary-300)] transition-colors outline-none hover:bg-[color:var(--color-primary-700)] hover:text-[color:var(--text-on-brand)] focus-visible:[box-shadow:var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50",
        collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
      )}
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <LogOut className="size-4" aria-hidden />
      )}
      {!collapsed && (isPending ? "Signing out…" : "Sign out")}
    </button>
  );
}
