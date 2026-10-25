"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  LAYOUT_PACKAGE_MAX_BYTES,
  type UploadLayoutPackageResult,
} from "@/types/billing";
import { layoutUploadSchema } from "@/validation/billing/layout-upload.schema";

// bm78 — guard → Zod → bytes → service (the upload-logo.action.ts shape). FormData within
// the unchanged bodySizeLimit; the zip never touches disk (code-standards › Invoice
// Template Types, Next.js rule 1).
async function guardEdit(): Promise<
  | { ok: true; actorId: string }
  | { ok: false; code: "FORBIDDEN" | "SERVER_ERROR" }
> {
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
    return { ok: true, actorId: userId };
  } catch (error) {
    if (isRedirectError(error)) return { ok: false, code: "FORBIDDEN" };
    return { ok: false, code: "SERVER_ERROR" };
  }
}

export async function uploadLayoutPackageAction(
  formData: FormData,
): Promise<UploadLayoutPackageResult> {
  const guard = await guardEdit();
  if (!guard.ok) return { ok: false, code: guard.code, problems: [] };

  const parsed = layoutUploadSchema.safeParse({
    familyId: formData.get("familyId"),
    expectedDraft: formData.get("expectedDraft"),
    file: formData.get("file"),
  });
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR", problems: [] };
  }
  const { familyId, expectedDraft, file } = parsed.data;
  if (file.size > LAYOUT_PACKAGE_MAX_BYTES) {
    return {
      ok: false,
      code: "LAYOUT_REJECTED",
      problems: [
        {
          file: file.name,
          code: "ZIP_TOO_LARGE",
          message: `the package is ${file.size} bytes; at most ${LAYOUT_PACKAGE_MAX_BYTES} are allowed`,
        },
      ],
    };
  }

  try {
    const zip = new Uint8Array(await file.arrayBuffer());
    const result = await uploadLayoutPackage(
      { familyId, zip, expectedDraft },
      guard.actorId,
    );
    if (result.ok) {
      revalidatePath("/administration/invoice-settings", "layout");
    }
    return result;
  } catch (error) {
    logger.error("uploadLayoutPackageAction failed", {
      familyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR", problems: [] };
  }
}
