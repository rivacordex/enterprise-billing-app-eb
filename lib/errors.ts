export const APP_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(
    code: AppErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "AppError";
  }
}

export function unauthenticated(
  message = "Authentication required.",
): AppError {
  return new AppError("UNAUTHENTICATED", message);
}

export function forbidden(
  message = "You do not have permission to do this.",
): AppError {
  return new AppError("FORBIDDEN", message);
}

export function notFound(
  message = "The requested resource was not found.",
): AppError {
  return new AppError("NOT_FOUND", message);
}

export function conflict(
  message = "The request conflicts with the current state.",
): AppError {
  return new AppError("CONFLICT", message);
}

export function validationFailed(
  message = "The request failed validation.",
): AppError {
  return new AppError("VALIDATION_FAILED", message);
}

export function internal(message = "An unexpected error occurred."): AppError {
  return new AppError("INTERNAL", message);
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

// Next.js's `redirect()` (used by `requirePermission`/`requireAuthenticated`,
// um06-spec §6.5) signals via a thrown error whose `.digest` starts with
// `NEXT_REDIRECT` — not exported from the public `next/navigation` entry
// point (confirmed in um06's deviations), so callers that need to tell an
// actual redirect apart from an unrelated thrown error (e.g. a DB failure)
// check this shape directly.
export function isRedirectError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT")
  );
}
