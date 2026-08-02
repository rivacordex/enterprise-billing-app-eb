"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { redateAndResubmit } from "@/services/accounts/document-state-machine";
import type { RedateAndResubmitResult } from "@/services/accounts/document-state-machine";
import { redateAndPostSchema } from "@/validation/accounts/redate-and-post.schema";

export type RedateAndPostActionResult =
  | RedateAndResubmitResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac14-spec §3.4 / §2.2 — re-date and re-submit a committed draft document.
// Called when a prior create action returned PERIOD_CLOSED and committed a
// draft to the DB. Corrects event_at and re-runs the posting path.
// Uses accounts_transactions:EDIT (the same gate as the original create action).
export async function redateAndPostAction(
  rawInput: unknown,
): Promise<RedateAndPostActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_TRANSACTIONS,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = redateAndPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await redateAndResubmit(
    parsed.data.documentId,
    new Date(parsed.data.eventAt),
    new Date(parsed.data.lastModified),
    actorId,
  );

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
