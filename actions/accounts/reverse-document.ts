"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { getReversalPreview } from "@/services/accounts/get-reversal-preview";
import type { GetReversalPreviewResult } from "@/services/accounts/get-reversal-preview";
export type {
  ReversalPreview,
  ReversalPreviewLine,
} from "@/services/accounts/get-reversal-preview";
import { reverseDocument } from "@/services/accounts/reverse-document";
import type { ReverseDocumentResult } from "@/services/accounts/reverse-document";
import { reverseLine } from "@/services/accounts/reverse-line";
import type { ReverseLineResult } from "@/services/accounts/reverse-line";
import { reverseDocumentSchema } from "@/validation/accounts/reverse-document.schema";

export type ReverseDocumentActionResult =
  | ReverseDocumentResult
  | ReverseLineResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "INTERNAL_ERROR" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac11-spec §3.4 — routes to `reverseLine` when `selectedLineIds` is a
// non-empty array, otherwise to `reverseDocument` (document-level). Both
// require `accounts_transactions:EDIT`. Approval weight is inherited from
// the original's reason code (same `auto_post_limit` threshold), so a
// limit-0 doc (write-off, deposit) always routes to pending_approval here.
export async function reverseDocumentAction(
  rawInput: unknown,
): Promise<ReverseDocumentActionResult> {
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

  const parsed = reverseDocumentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const { selectedLineIds, ...rest } = parsed.data;
  const isLineLevel =
    Array.isArray(selectedLineIds) && selectedLineIds.length > 0;

  let result: ReverseDocumentResult | ReverseLineResult;
  try {
    result = isLineLevel
      ? await reverseLine({ ...rest, selectedLineIds }, actorId)
      : await reverseDocument(parsed.data, actorId);
  } catch {
    return { ok: false, code: "INTERNAL_ERROR" };
  }

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}

// Read action — loads the reversal preview for a posted document. Called by
// the ReversalsPanel before the operator confirms. Requires the same
// permission as any transaction mutation (read-only users see no panel).
export async function getReversalPreviewAction(
  documentId: string,
  financialAccountId: string,
): Promise<GetReversalPreviewResult | { ok: false; code: "FORBIDDEN" }> {
  try {
    await requirePermission(PERMISSIONS.ACCOUNTS_TRANSACTIONS, LEVELS.EDIT);
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }
  return getReversalPreview(documentId, financialAccountId);
}
