import { db } from "@/db/client";
import { rolesRepository } from "@/db/repositories/roles.repository";
import type { RoleListItem } from "@/types/rbac";

// Populates the "Initial Roles" checkbox list in the create-user dialog
// (um08-spec §8.6) and the "Add role" dropdown in `RoleAssignmentPanel`
// (um12-spec §12.5). Read-only, no audit.
export async function listRoles(): Promise<RoleListItem[]> {
  return rolesRepository.findAllRoles(db);
}
