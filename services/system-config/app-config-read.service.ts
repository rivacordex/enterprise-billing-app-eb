import { cache } from "react";

import { db } from "@/db/client";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LOCALES,
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
  const [logoPath, markPath, appName] = await Promise.all([
    systemConfigRepository.findActiveValue(db, "app", "app_logo_path"),
    systemConfigRepository.findActiveValue(db, "app", "app_logo_mark_path"),
    systemConfigRepository.findActiveValue(db, "app", "app_name"),
  ]);

  const src = resolveBrandPath(logoPath);
  if (src === null) return null;

  const markSrc = resolveBrandPath(markPath);
  const alt = (appName ?? "").trim() || "Enterprise Billing";

  // `markSrc` is conditionally spread (not set to `undefined`) so the shape
  // satisfies `exactOptionalPropertyTypes` (`BrandingLogo.markSrc?: string`).
  return markSrc !== null ? { src, markSrc, alt } : { src, alt };
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
