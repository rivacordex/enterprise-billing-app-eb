import type { Metadata } from "next";

import { resolveForcePasswordChangeSession } from "@/auth/guard";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { SignOutButton } from "@/components/sign-out-button";

export const metadata: Metadata = {
  title: "Set Password",
  description: "Set your password to continue",
};

export const dynamic = "force-dynamic";

export default async function SetPasswordPage(): Promise<React.JSX.Element> {
  const { status } = await resolveForcePasswordChangeSession();
  const isFirstLogin = status === "PENDING";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[color:var(--surface-nav)] px-4 py-12">
      {/* Low-opacity brand wash, matching /login (um03-spec §2.1). */}
      <div className="absolute inset-0 bg-[image:var(--gradient-brand)] opacity-20" />

      <div className="relative z-10 w-full max-w-[28rem] rounded-lg bg-card p-8 shadow-lg">
        <div className="flex flex-col items-center">
          <span className="text-h4 font-semibold text-foreground">
            Enterprise Billing
          </span>
        </div>

        <h1 className="mt-6 text-h2 font-semibold text-foreground">
          Set your password
        </h1>
        {isFirstLogin && (
          <p className="mt-2 text-body text-muted-foreground">
            You&apos;re signing in for the first time. Please set a new password
            to continue.
          </p>
        )}

        <div className="mt-6">
          <SetPasswordForm />
        </div>

        <div className="mt-4 flex justify-center">
          <SignOutButton
            variant="link"
            className="h-auto p-0 text-body-sm text-muted-foreground"
          />
        </div>
      </div>
    </div>
  );
}
