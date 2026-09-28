"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  uploadRatecardVersion,
  type RateCardUploadWarning,
} from "@/services/product/ratecard/upload-version";
import type {
  RateCardIssue,
  RateCardUploadViolation,
} from "@/validation/product/ratecard.schema";

// pm61-spec D1/D2 — the upload action's shape deliberately differs from the
// module's ordinary action shape, and that difference IS the security
// argument: requirePermission first, then the file leaves FormData and is
// checked (extension, MIME, byte size) BEFORE its bytes are read, then parse
// + structural validation happen inside the one service call. `safeParse`
// cannot run on a file handle — it runs on the parsed rows, inside the
// service, still before the transaction opens. The client (pm66) may read the
// first line to reject an obviously-wrong file early; that is a convenience
// and never a boundary — every check here runs unconditionally on the full
// file (§3.19).

const ALLOWED_EXTENSION = ".csv";
// A `.csv` file's MIME type is inconsistent across browsers/OSes — Chrome and
// Firefox commonly send "text/csv", some Windows setups send
// "application/vnd.ms-excel", and a blank string is common too. This is a
// cheap sanity check on an obviously wrong upload, not a security boundary —
// the server re-parses and re-validates the entire file regardless.
const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/csv",
  "",
]);
// A clear, typed refusal beneath the eventual 4 MB `serverActions.bodySizeLimit`
// pm66 raises `next.config.ts` to (D11 — that raise is pm66's, never routed
// around here). Under today's unmodified 1 MB Next default, an oversized file
// is refused by the framework itself before this action ever runs; this check
// exists so the day the ceiling is 4 MB, an oversized file still gets a
// validation message instead of a generic body-size error (code-standards
// §6.34's own reasoning).
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type UploadRatecardVersionActionResult =
  | {
      ok: true;
      versionId: string;
      rowCount: number;
      warnings: RateCardUploadWarning[];
    }
  | {
      ok: false;
      code: RateCardUploadViolation;
      issues: readonly RateCardIssue[];
    }
  | { ok: false; code: "CONCURRENT_UPLOAD_CONFLICT" }
  | { ok: false; code: "CARD_NAME_REQUIRED" }
  | { ok: false; code: "NO_FILE" }
  | { ok: false; code: "INVALID_FILE_TYPE" }
  | { ok: false; code: "FILE_TOO_LARGE" }
  | { ok: false; code: "UNPARSEABLE_FILE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// A `csv-parse` `CsvError` carries a `code` like
// `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` (pm59-spec, parse-csv.ts). Duck-typed
// rather than `instanceof` so this file never imports `csv-parse` itself —
// parse-csv.ts is guardrailed as the only file in the repo that does.
function isCsvParseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("CSV_")
  );
}

export async function uploadRatecardVersionAction(
  formData: FormData,
): Promise<UploadRatecardVersionActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.RATECARD,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const cardNameRaw = formData.get("cardName");
  const cardName = typeof cardNameRaw === "string" ? cardNameRaw.trim() : "";
  if (cardName.length === 0) {
    return { ok: false, code: "CARD_NAME_REQUIRED" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, code: "NO_FILE" };
  }

  // Extension, MIME type and byte size — checked before any byte is read
  // (D1). File metadata only; `file.arrayBuffer()` is not called yet.
  if (!file.name.toLowerCase().endsWith(ALLOWED_EXTENSION)) {
    return { ok: false, code: "INVALID_FILE_TYPE" };
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return { ok: false, code: "INVALID_FILE_TYPE" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "FILE_TOO_LARGE" };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  let result;
  try {
    result = await uploadRatecardVersion({
      cardName,
      bytes,
      sourceFile: file.name,
      uploadedBy: actorId,
      uploadedAt: new Date(),
    });
  } catch (error) {
    if (isCsvParseError(error)) {
      return { ok: false, code: "UNPARSEABLE_FILE" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result;
  }

  // D9 — this path only; the route doesn't exist yet (pm65), but revalidating
  // it now is harmless and means pm65 adds a page rather than a missing call.
  revalidatePath("/products/rate-card");

  return {
    ok: true,
    versionId: result.versionId,
    rowCount: result.rowCount,
    warnings: result.warnings,
  };
}
