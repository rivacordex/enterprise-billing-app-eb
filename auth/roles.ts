import { db } from "@/db/client";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";

// pm30-spec §1 — the codebase's first role-*name* authority check (as opposed
// to the permission-level checks in `resolver.ts`). Resolved live per request
// straight from `role_assign → roles.role_name` (platform Inv. #15): never
// cached, never read from the session, so a role granted or revoked between two
// calls takes effect on the very next call. Framework-agnostic (no `next/*`),
// so an approval service can call it as its pre-flight authority gate.
//
// Deliberately minimal (architecture §4, user-confirmed 2026-08-09): order
// approval is permission **and** role **and** identity; this helper answers
// only the role half, the `product_orders:EDIT` permission and reviewer ≠
// submitter checks live at their own layers.
export async function actorHasRole(
  userId: string,
  roleName: string,
): Promise<boolean> {
  const roleNames = await roleAssignRepository.findRoleNamesByUserId(
    db,
    userId,
  );
  return roleNames.includes(roleName);
}
