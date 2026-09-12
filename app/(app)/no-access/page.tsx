import type { Metadata } from "next";

import { requireAuthenticated } from "@/auth/guard";
import { SignOutButton } from "@/components/sign-out-button";
import { getAppName } from "@/services/system-config/app-config-read.service";

// Dynamic so the tab title tracks the configured `app_name`; the visible
// wordmark (below) is the primary target. `getAppName()` is `React.cache`d ⇒
// it shares the page's single per-request read.
export async function generateMetadata(): Promise<Metadata> {
  return { title: `No Access — ${await getAppName()}` };
}

export default async function NoAccessPage(): Promise<React.JSX.Element> {
  await requireAuthenticated();
  const appName = await getAppName();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[440px] rounded-lg bg-card p-8 text-center shadow-lg">
        <span className="block max-w-full truncate text-h4 font-semibold text-foreground">
          {appName}
        </span>

        <h1 className="mt-6 text-h2 font-semibold text-foreground">
          No Access
        </h1>
        <p className="mt-2 text-body text-muted-foreground">
          Your account doesn&apos;t have access to this module yet. Contact an
          administrator if you believe this is an error.
        </p>

        <div className="mt-6 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
