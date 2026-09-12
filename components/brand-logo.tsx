import { DEFAULT_APP_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";
import type { BrandingLogo } from "@/types/system-config";

interface BrandLogoProps {
  logo: BrandingLogo | null;
  variant: "login" | "nav" | "nav-collapsed";
  // The configuration-driven application name (resolved server-side via
  // `getAppName()`). Required so the type-checker forces every wordmark
  // surface to supply it — no surface can be silently missed. Drives the
  // text/monogram fallback only; when a `logo` is set the `<img alt>` still
  // comes from `logo.alt`.
  appName: string;
}

// Pure presentational logo-or-wordmark renderer (um28-spec §2.3). NOT
// `"use client"`, no async, no DB — prop-driven and side-effect-free, so it
// renders identically inside the client `AdminSidebar` tree and the server
// login page tree. The `system_config` read lives only in the server reader
// (`getBrandingLogo`), never here.
//
// Single asset on a logo plate: the login lockup sits on a white card while
// the sidebar sits on dark navy, so one bare logo can't guarantee contrast on
// both. Rather than ship two assets, the `<img>` is wrapped in a consistent
// light plate (`--surface-card` bg, `--radius-sm`, a 1px demarcation border,
// small padding) so a single dark/full-color logo always sits on a known
// light backdrop. Border token by surface: `--border-default` on the white
// login card, a faint `--text-on-brand`/15 rule on the dark nav.
const PLATE_BASE =
  "inline-flex items-center justify-center rounded-sm border bg-[color:var(--surface-card)] p-1.5";

// Derive the collapsed-rail monogram from the application name: the first
// letter of each of the first two words, uppercased, capped at 2 chars
// (`"Enterprise Billing System"` → `"EB"`, `"Acme"` → `"A"`). This file is the
// only consumer, so it stays a tiny local helper.
function monogramFor(appName: string): string {
  const initials = appName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    // `[...word][0]` takes the first Unicode *code point* (string spread
    // iterates code points), so a name starting with an astral char — emoji,
    // supplementary-plane letter — yields a whole glyph, not a lone UTF-16
    // surrogate half. `filter(Boolean)` guarantees each word is non-empty.
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
  return initials || DEFAULT_APP_NAME[0]!;
}

// Monogram fallback for the collapsed rail when no square mark is configured
// (the mark is decorative when collapsed). Fits the w-16 rail.
function Monogram({ appName }: { appName: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-flex size-8 items-center justify-center rounded-sm bg-[color:var(--color-primary-700)] text-sm font-semibold text-[color:var(--text-on-brand)]"
    >
      {monogramFor(appName)}
    </span>
  );
}

export function BrandLogo({
  logo,
  variant,
  appName,
}: BrandLogoProps): React.JSX.Element {
  // Wordmark / monogram fallback when no valid logo is configured.
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
    if (variant === "nav") {
      // `min-w-0 truncate`: let the wordmark shrink+ellipsize inside the fixed-
      // width nav rail instead of pushing the collapse toggle off-row.
      return (
        <span className="min-w-0 truncate text-sm font-semibold text-[color:var(--text-on-brand)]">
          {appName}
        </span>
      );
    }
    return <Monogram appName={appName} />;
  }

  const borderClass =
    variant === "login"
      ? "border-[color:var(--border-default)]"
      : "border-[color:var(--text-on-brand)]/15";

  if (variant === "nav-collapsed") {
    if (logo.markSrc === undefined) {
      return <Monogram appName={appName} />;
    }
    return (
      <span className={cn(PLATE_BASE, borderClass)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- plain <img> is deliberate (um28-spec §2.3): next/image blocks SVG without dangerouslyAllowSVG (a CSP concern) and buys nothing for a local /public asset; this keeps next.config.ts untouched. */}
        <img src={logo.markSrc} alt={logo.alt} className="size-6 w-auto" />
      </span>
    );
  }

  const imgSizeClass =
    variant === "login" ? "max-h-12 w-auto" : "max-h-8 w-auto";
  return (
    <span className={cn(PLATE_BASE, borderClass)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- see §2.3 above: plain <img> over next/image for a local /public SVG. */}
      <img src={logo.src} alt={logo.alt} className={imgSizeClass} />
    </span>
  );
}
