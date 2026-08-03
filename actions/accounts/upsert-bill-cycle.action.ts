"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  upsertBillCycle,
  type UpsertBillCycleResult,
} from "@/services/accounts/bill-cycle";
import { upsertBillCycleSchema } from "@/validation/accounts/bill-cycle.schema";

export type UpsertBillCycleActionResult =
  | UpsertBillCycleResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[] | undefined>;
    };

export async function upsertBillCycleAction(
  rawInput: unknown,
): Promise<UpsertBillCycleActionResult> {
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

  const parsed = upsertBillCycleSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await upsertBillCycle(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/administration/accounts-settings");
  }

  return result;
}
