import { cn } from "@/lib/utils";
import type { BrandingLogo } from "@/types/system-config";

interface BrandLogoProps {
  logo: BrandingLogo | null;
  // Only two surfaces remain (D10): the light login card and the dark top bar.
  // The collapsed-rail monogram is gone — the brand renders once, in the top
  // bar, and never changes shape with collapse state or route (D13).
  variant: "login" | "topbar";
  // The configuration-driven application name (resolved server-side via
  // `getAppName()`). Required so the type-checker forces every wordmark
  // surface to supply it — no surface can be silently missed. Drives the text
  // fallback only; when a `logo` is set the `<img alt>` comes from `logo.alt`.
  appName: string;
}

// Pure presentational logo-or-wordmark renderer (um28-spec §2.3). NOT
// `"use client"`, no async, no DB — prop-driven and side-effect-free, so it
// renders identically inside the client top-bar tree and the server login page
// tree. The `system_config` read lives only in the server reader
// (`getBrandingLogo`), never here.
//
// Single asset on a logo plate: the login lockup sits on a white card while
// the top bar sits on dark navy, so one bare logo can't guarantee contrast on
// both. Rather than ship two assets, the `<img>` is wrapped in a consistent
// light plate (`--surface-card` bg, `--radius-sm`, a 1px demarcation border,
// small padding) so a single dark/full-color logo always sits on a known light
// backdrop. Border token by surface: `--border-default` on the white login
// card, a faint `--text-on-brand`/15 rule on the dark top bar.
const PLATE_BASE =
  "inline-flex items-center justify-center rounded-sm border bg-[color:var(--surface-card)] p-1.5";

export function BrandLogo({
  logo,
  variant,
  appName,
}: BrandLogoProps): React.JSX.Element {
  // Wordmark fallback when no valid logo is configured (the shipped default —
  // migration 0005 seeds `app_logo_path` as '').
  if (logo === null) {
    if (variant === "login") {
      // `max-w-full truncate`: an over-long admin-set app_name is clipped with
      // an ellipsis rather than overflowing the login card.
      return (
        <span className="max-w-full truncate text-h4 font-semibold text-foreground">
          {appName}
        </span>
      );
    }
    // topbar: the wordmark on dark chrome (the treatment the outgoing "nav"
    // variant used). `min-w-0 truncate`: shrink+ellipsize inside the bounded
    // brand slot instead of pushing the toggle off-row.
    return (
      <span className="min-w-0 truncate text-sm font-semibold text-[color:var(--text-on-brand)]">
        {appName}
      </span>
    );
  }

  const borderClass =
    variant === "login"
      ? "border-[color:var(--border-default)]"
      : "border-[color:var(--text-on-brand)]/15";

  const imgSizeClass =
    variant === "login" ? "max-h-12 w-auto" : "max-h-8 w-auto";
  return (
    <span className={cn(PLATE_BASE, borderClass)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- plain <img> is deliberate (um28-spec §2.3): next/image blocks SVG without dangerouslyAllowSVG (a CSP concern) and buys nothing for a local /public asset; this keeps next.config.ts untouched. */}
      <img src={logo.src} alt={logo.alt} className={imgSizeClass} />
    </span>
  );
}
