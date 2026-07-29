"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { approveDocumentStandalone } from "@/services/accounts/document-state-machine";
import type { ApproveDocumentResult } from "@/services/accounts/document-state-machine";
import { approveDocumentSchema } from "@/validation/accounts/approve-document.schema";

export type ApproveDocumentActionResult =
  | ApproveDocumentResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Approver ≠ creator (Inv. #6) is enforced in `approveDocument` itself —
// this action only checks the permission level, matching code-standards §8:
// MANAGER-vs-USER routing is a service-layer workflow rule, not a
// permission level (both hold `accounts_transactions:EDIT`).
export async function approveDocumentAction(
  rawInput: unknown,
): Promise<ApproveDocumentActionResult> {
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

  const parsed = approveDocumentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await approveDocumentStandalone(
    parsed.data.documentId,
    actorId,
  );

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
