"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  retireReasonCode,
  type RetireReasonCodeResult,
} from "@/services/accounts/reason-code";
import { retireReasonCodeSchema } from "@/validation/accounts/reason-code.schema";

export type RetireReasonCodeActionResult =
  | RetireReasonCodeResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function retireReasonCodeAction(
  rawInput: unknown,
): Promise<RetireReasonCodeActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_CONFIG,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = retireReasonCodeSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await retireReasonCode(
    parsed.data.reasonCode,
    new Date(parsed.data.lastModified),
    actorId,
  );

  if (result.ok) {
    revalidatePath("/administration/accounts-settings");
  }

  return result;
}
