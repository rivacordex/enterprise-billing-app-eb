"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import type { RaiseDebitNoteResult } from "@/services/accounts/raise-debit-note";
import { raiseDebitNoteSchema } from "@/validation/accounts/raise-debit-note.schema";

export type RaiseDebitNoteActionResult =
  | RaiseDebitNoteResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac09-spec §2.1/§3.4 — DBN additionally requires `?ban` (Q1); the context
// strip greys the action out until then, and this re-validates server-side
// via the Zod schema regardless.
export async function raiseDebitNoteAction(
  rawInput: unknown,
): Promise<RaiseDebitNoteActionResult> {
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

  const parsed = raiseDebitNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await raiseDebitNote(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
