import { AppError, type AppErrorCode } from "@/lib/errors";
import { describeInvoiceRenderCode } from "@/lib/invoice-render-messages";
import { logger } from "@/lib/logger";
import type { InvoiceErrorCode } from "@/types/billing";

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

// bm66-spec §5 (general §5.5–§5.6, §5 rule 7) — the one mapping of an invoice
// render failure to its HTTP envelope: 422 with the typed code and the safe
// text for that code and its `detail.reason` (only the D55 cause gets the
// "activate, then rerun" copy). Never the internal message or a stack.
export function toInvoiceRenderResponse(error: {
  code: InvoiceErrorCode;
  detail?: Record<string, unknown> | undefined;
}): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: describeInvoiceRenderCode(error.code, error.detail?.reason),
      },
    },
    { status: 422 },
  );
}
