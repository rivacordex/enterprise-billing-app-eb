"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  importAppLogo,
  uploadLogo,
  type UploadLogoResult,
} from "@/services/billing/invoice-profile/upload-logo";
import {
  importAppLogoSchema,
  logoDeclaredMimeSchema,
  logoUploadSchema,
} from "@/validation/billing/logo-upload.schema";

export type UploadLogoActionResult =
  | UploadLogoResult
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "VALIDATION_ERROR"
        | "SERVER_ERROR"
        | "APP_LOGO_UNAVAILABLE";
    };

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

// bm60-spec §Design D1, code-standards Part 2 Next.js rules 3–4: upload the
// invoice logo onto the working DRAFT profile. A MUTATION taking `FormData`
// within the unchanged `bodySizeLimit`; the guard is `invoice_settings : EDIT`
// and is the first statement. Order: guard → Zod (a declared type outside the
// three logo types is `LOGO_REJECTED: mime`) → bytes → service (checks, blob,
// one transaction, one audit row) → revalidate the Invoice Settings layout.
export async function uploadLogoAction(
  formData: FormData,
): Promise<UploadLogoActionResult> {
  const guard = await guardEdit();
  if (!guard.ok) return guard;

  const parsed = logoUploadSchema.safeParse({
    file: formData.get("file"),
    expectedDraftToken: formData.get("expectedDraftToken"),
  });
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };
  const { file, expectedDraftToken } = parsed.data;
  if (!logoDeclaredMimeSchema.safeParse(file.type).success) {
    return {
      ok: false,
      code: "LOGO_REJECTED",
      reason: "mime",
      detail: { declared: file.type || null, detected: null },
    };
  }

  let result: UploadLogoResult;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    result = await uploadLogo(
      { bytes, declaredMime: file.type, expectedDraftToken },
      guard.actorId,
    );
  } catch (error) {
    logger.error("company profile logo upload failed", {
      declaredMime: file.type,
      byteSize: file.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (result.ok) revalidatePath("/administration/invoice-settings", "layout");
  return result;
}

// bm60-spec §Design D8 — "Use the current app logo": the same guard and the
// same pipeline over `public/brand/…` read from disk.
export async function importAppLogoAction(
  rawInput: unknown,
): Promise<UploadLogoActionResult> {
  const guard = await guardEdit();
  if (!guard.ok) return guard;

  const parsed = importAppLogoSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  let result: Awaited<ReturnType<typeof importAppLogo>>;
  try {
    result = await importAppLogo(parsed.data.expectedDraftToken, guard.actorId);
  } catch (error) {
    logger.error("company profile app-logo import failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (result.ok) revalidatePath("/administration/invoice-settings", "layout");
  return result;
}
