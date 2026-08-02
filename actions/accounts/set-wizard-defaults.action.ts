"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  setWizardDefaults,
  type SetWizardDefaultsResult,
} from "@/services/accounts/wizard-defaults";
import { setWizardDefaultsSchema } from "@/validation/accounts/wizard-defaults.schema";

export type SetWizardDefaultsActionResult =
  | SetWizardDefaultsResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function setWizardDefaultsAction(
  rawInput: unknown,
): Promise<SetWizardDefaultsActionResult> {
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

  const parsed = setWizardDefaultsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await setWizardDefaults(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/administration/accounts-settings");
  }

  return result;
}
