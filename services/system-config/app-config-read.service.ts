import { cache } from "react";

import { db } from "@/db/client";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { DEFAULT_APP_NAME } from "@/lib/branding";
import { config } from "@/lib/config";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LOCALES,
  type SupportedTimezone,
} from "@/lib/locale";
import type { BrandingLogo } from "@/types/system-config";

// App-level config reads that back the admin chrome and locale/currency
// wiring (um28-spec §2.6, §2.9). Each is wrapped in `React.cache` so the
// per-request reads dedupe — the layout's branding read and a page's locale
// read never double-query within one request. Read-only, no audit.

// Validates the *shape* of a logo path, not that the file exists (um28-spec
// §2.11 — render optimistically). The value renders into an `<img src>` on
// the unauthenticated login page, so an external / `data:` / `javascript:`
// value would be a stored-injection + visitor-IP-leak vector. The
// `/brand/`-only check closes it: `startsWith("/brand/")` already rejects any
// scheme and protocol-relative (`//host`) value; the `..` check closes path
// traversal. Returns the validated path, or `null` (⇒ wordmark fallback).
function resolveBrandPath(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("/brand/")) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

export const getBrandingLogo = cache(async (): Promise<BrandingLogo | null> => {
  const [logoPath, markPath, alt] = await Promise.all([
    systemConfigRepository.findActiveValue(db, "app", "app_logo_path"),
    systemConfigRepository.findActiveValue(db, "app", "app_logo_mark_path"),
    // Route the `alt` through the shared `getAppName()` reader (both are
    // `React.cache`d ⇒ one query) so the `DEFAULT_APP_NAME` fallback lives in
    // exactly one place instead of a re-implemented inline literal here.
    getAppName(),
  ]);

  const src = resolveBrandPath(logoPath);
  if (src === null) return null;

  const markSrc = resolveBrandPath(markPath);

  // `markSrc` is conditionally spread (not set to `undefined`) so the shape
  // satisfies `exactOptionalPropertyTypes` (`BrandingLogo.markSrc?: string`).
  return markSrc !== null ? { src, markSrc, alt } : { src, alt };
});

// The displayed application name — highest-version ACTIVE, non-secret
// `app`/`app_name` value, resolved once server-side and threaded to every
// wordmark surface as a plain `appName: string` prop (symmetric with
// `getAppLocale()` / `getAppCurrency()`). Blank / whitespace / missing →
// `DEFAULT_APP_NAME`, so the header is never empty.
export const getAppName = cache(async (): Promise<string> => {
  const value = await systemConfigRepository.findActiveValue(
    db,
    "app",
    "app_name",
  );
  return value?.trim() || DEFAULT_APP_NAME;
});

export const getAppLocale = cache(async (): Promise<string> => {
  const value = await systemConfigRepository.findActiveValue(
    db,
    "app",
    "locale",
  );
  const trimmed = value?.trim() ?? null;
  return trimmed !== null &&
    (SUPPORTED_LOCALES as readonly string[]).includes(trimmed)
    ? trimmed
    : DEFAULT_LOCALE;
});

export const getAppCurrency = cache(async (): Promise<string> => {
  const value = await systemConfigRepository.findActiveValue(
    db,
    "app",
    "default_currency",
  );
  const trimmed = value?.trim() ?? null;
  return trimmed !== null &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(trimmed)
    ? trimmed
    : DEFAULT_CURRENCY;
});

// The configured business timezone (um29-spec §2.3). Unlike the locale/
// currency readers above this is NOT a DB read — `config.APP_TIMEZONE` is
// validated and frozen at boot — so it is a plain synchronous accessor with
// no `React.cache` (caching a constant buys nothing). It lives here purely
// for call-site symmetry with `getAppLocale()` (a server component resolves
// locale + timezone together).
export function getAppTimezone(): SupportedTimezone {
  return config.APP_TIMEZONE;
}
