import "server-only";
import { timingSafeEqual } from "node:crypto";

import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";

// bm04-spec §Design/§5, architecture §4/Inv. #9. The inbound M2M auth for
// `app/api/billrun/*` — a dedicated bearer service token, never a session.
// `serviceTokenMatches` mirrors `csrfTokensMatch`'s length-guard +
// constant-time-compare idiom (`lib/csrf.ts`) exactly.

export function serviceTokenMatches(
  submitted: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!submitted || !expected || submitted.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}

// Extracts the `Authorization: Bearer <token>` header and constant-time
// compares it against `BILLRUN_APP_TOKEN`. Throws `UNAUTHENTICATED` (mapped
// to 401 by `toHttpResponse`) on a missing header, a malformed scheme, a
// mismatched token, or an unconfigured token (fail-closed — code-standards
// §5.2). Never logs the submitted or expected value.
export function requireServiceToken(request: Request): void {
  const header = request.headers.get("authorization");
  const submitted =
    header && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!serviceTokenMatches(submitted, config.BILLRUN_APP_TOKEN ?? null)) {
    throw new AppError("UNAUTHENTICATED", "Invalid service token.");
  }
}
