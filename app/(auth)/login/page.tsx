import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BrandLogo } from "@/components/brand-logo";
import { LoginForm } from "@/components/login-form";
import { MicrosoftLogo } from "@/components/icons/microsoft-logo";
import { isSsoConfigured } from "@/lib/config";
import { getBrandingLogo } from "@/services/system-config/app-config-read.service";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to the Enterprise Billing System",
};

export const dynamic = "force-dynamic";

// um10-spec §"SSO rejection error display". `signup_disabled` is what
// Better-Auth's own `disableSignUp` produces for "no Entra email match at
// all" (no JIT provisioning); `unable_to_link_account` is what it produces
// when our `account.create.before` hook rejects a matched-but-ineligible
// user (LOCAL or DELETED); `account_not_linked` is its own native
// account-linking-policy rejection. All three are real rejection paths a
// user can hit and must show the identical "not authorized" message — no
// enumeration of which case occurred.
const SSO_NOT_AUTHORIZED_ERRORS = new Set([
  "sso_no_account",
  "signup_disabled",
  "unable_to_link_account",
  "account_not_linked",
]);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<React.JSX.Element> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    redirect("/");
  }

  const { error } = await searchParams;
  const logo = await getBrandingLogo();

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[color:var(--surface-nav)] px-4 py-12">
      {/* Low-opacity brand wash, not a full-bleed poster (ui-context §0/§2.1). */}
      <div className="absolute inset-0 bg-[image:var(--gradient-brand)] opacity-20" />

      {/* 440px cap is spec'd exactly (um03-spec §2.1), not on the radius/spacing scale. */}
      <div className="relative z-10 w-full max-w-[440px] rounded-lg bg-card p-8 shadow-lg">
        <div className="flex flex-col items-center">
          <BrandLogo variant="login" logo={logo} />
        </div>

        <h1 className="mt-6 text-h2 font-semibold text-foreground">Sign in</h1>
        <p className="mt-2 text-body text-muted-foreground">
          Use your assigned credentials to access the system.
        </p>

        {error && (
          <Alert variant="destructive" className="mt-6">
            <AlertDescription>
              {SSO_NOT_AUTHORIZED_ERRORS.has(error)
                ? "Your Microsoft account is not authorized to access this application. Contact your administrator."
                : "Sign-in failed. Please try again or contact your administrator."}
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-6">
          <LoginForm />
        </div>

        {isSsoConfigured && (
          <>
            <div className="relative mt-6 flex items-center gap-3">
              <hr className="flex-1 border-t border-border" />
              <span className="text-body-sm text-muted-foreground">or</span>
              <hr className="flex-1 border-t border-border" />
            </div>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- `/api/auth/signin/microsoft` is a Route Handler, not a page; it must be a real top-level GET navigation (um10-spec §"Sign-in entry point"), not Next's client-side `<Link>` router, which would try to fetch it as an RSC payload. */}
            <a
              href="/api/auth/signin/microsoft"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-card px-4 py-2 text-body font-medium text-foreground hover:border-[color:var(--border-default)] hover:bg-[color:var(--action-ghost-hover)]"
            >
              <MicrosoftLogo />
              Sign in with Microsoft
            </a>
          </>
        )}
      </div>
    </div>
  );
}
