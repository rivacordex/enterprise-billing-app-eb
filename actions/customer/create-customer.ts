"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { createCustomer } from "@/services/customer/create-customer";
import { createCustomerSchema } from "@/validation/customer/create-customer.schema";

export type CreateCustomerActionResult =
  | { ok: true; value: { organizationId: string; partyRoleId: string } }
  | { ok: false; code: "INVALID_SPECIFICATION" }
  | { ok: false; code: "DUPLICATE_REGISTRATION_NUMBER" }
  | { ok: false; code: "SIMILAR_NAMES_FOUND"; similarNames: string[] }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// cm07-spec §3.5. No DB access here — delegates entirely to `createCustomer`,
// matching um11's action shape exactly.
export async function createCustomerAction(
  rawInput: unknown,
): Promise<CreateCustomerActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = createCustomerSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await createCustomer(parsed.data, actorId);
  if (result.ok) {
    revalidatePath("/customers/manage");
  }
  return result;
}
