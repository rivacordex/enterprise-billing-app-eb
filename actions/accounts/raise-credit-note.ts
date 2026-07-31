"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { raiseCreditNote } from "@/services/accounts/raise-credit-note";
import type { RaiseCreditNoteResult } from "@/services/accounts/raise-credit-note";
import { raiseCreditNoteSchema } from "@/validation/accounts/raise-credit-note.schema";

export type RaiseCreditNoteActionResult =
  | RaiseCreditNoteResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac09-spec §2.1/§3.4 — CRN additionally requires `?ban` (Q1); the context
// strip greys the action out until then, and this re-validates server-side
// via the Zod schema regardless.
export async function raiseCreditNoteAction(
  rawInput: unknown,
): Promise<RaiseCreditNoteActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_TRANSACTIONS,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = raiseCreditNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await raiseCreditNote(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
