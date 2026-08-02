"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  upsertReasonCode,
  type UpsertReasonCodeResult,
} from "@/services/accounts/reason-code";
import { upsertReasonCodeSchema } from "@/validation/accounts/reason-code.schema";

export type UpsertReasonCodeActionResult =
  | UpsertReasonCodeResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function upsertReasonCodeAction(
  rawInput: unknown,
): Promise<UpsertReasonCodeActionResult> {
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

  const parsed = upsertReasonCodeSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await upsertReasonCode(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/administration/accounts-settings");
  }

  return result;
}
