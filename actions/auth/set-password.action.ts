"use server";

import { redirect } from "next/navigation";

import { resolveForcePasswordChangeSession } from "@/auth/guard";
import { setPassword } from "@/services/users/users-auth.service";
import { setPasswordSchema } from "@/validation/set-password.schema";

export type SetPasswordActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um09-spec §9.6. `resolveForcePasswordChangeSession`'s `redirect('/login')`/
// `redirect('/')` calls are thrown `NEXT_REDIRECT` digest errors — they are
// deliberately not caught here so Next.js can process them normally.
export async function setPasswordAction(
  rawInput: unknown,
): Promise<SetPasswordActionResult> {
  const session = await resolveForcePasswordChangeSession();

  const parsed = setPasswordSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await setPassword(session.userId, parsed.data.newPassword);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: "FORBIDDEN" };
  }

  redirect("/");
}
