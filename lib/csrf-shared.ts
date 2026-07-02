// Client-safe half of lib/csrf.ts — no node:crypto import here. Any of
// these names may be imported from a "use client" component. Constant
// generation/comparison (which need node:crypto) live in lib/csrf.ts;
// importing that from a client component would drag node:crypto's
// browser polyfill (crypto-browserify -> vm-browserify's eval()) into
// the shipped JS and trip the Dockerfile's `eval(` guard.
export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== name) continue;
    return decodeURIComponent(part.slice(separatorIndex + 1).trim());
  }
  return null;
}
