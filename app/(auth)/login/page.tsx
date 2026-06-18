import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to the Enterprise Billing System",
};

export const dynamic = "force-dynamic";

export default async function LoginPage(): Promise<React.JSX.Element> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    redirect("/");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[color:var(--surface-nav)] px-4 py-12">
      {/* Low-opacity brand wash, not a full-bleed poster (ui-context §0/§2.1). */}
      <div className="absolute inset-0 bg-[image:var(--gradient-brand)] opacity-20" />

      {/* 440px cap is spec'd exactly (um03-spec §2.1), not on the radius/spacing scale. */}
      <div className="relative z-10 w-full max-w-[440px] rounded-lg bg-card p-8 shadow-lg">
        <div className="flex flex-col items-center">
          <span className="text-h4 font-semibold text-foreground">
            Enterprise Billing
          </span>
        </div>

        <h1 className="mt-6 text-h2 font-semibold text-foreground">Sign in</h1>
        <p className="mt-2 text-body text-muted-foreground">
          Use your assigned credentials to access the system.
        </p>

        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
