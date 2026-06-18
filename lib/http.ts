import { AppError, type AppErrorCode } from "@/lib/errors";
import { logger } from "@/lib/logger";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export function toHttpResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: STATUS_BY_CODE[error.code] },
    );
  }

  logger.error("Unhandled error coerced to INTERNAL", { error });

  return Response.json(
    { error: { code: "INTERNAL", message: "An unexpected error occurred." } },
    { status: STATUS_BY_CODE.INTERNAL },
  );
}
