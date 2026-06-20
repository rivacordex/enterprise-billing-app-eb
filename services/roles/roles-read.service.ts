import { db } from "@/db/client";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import { PERMISSION_NAMES } from "@/types/rbac";
import type { RoleListItem } from "@/types/rbac";
import type { RolePermissionMapping, RoleWithMappings } from "@/types/roles";

// Populates the "Initial Roles" checkbox list in the create-user dialog
// (um08-spec §8.6) and the "Add role" dropdown in `RoleAssignmentPanel`
// (um12-spec §12.5). Read-only, no audit.
export async function listRoles(): Promise<RoleListItem[]> {
  return rolesRepository.findAllRoles(db);
}

// Builds the fixed-order, gap-filled mapping array shared by both functions
// below (um18-spec §18.3) — one entry per `PERMISSION_NAMES` entry,
// `assignedLevel: null` for any permission the role has no grant for.
function buildMappings(
  assignments: Array<{
    permissionName: (typeof PERMISSION_NAMES)[number];
    permissionType: RolePermissionMapping["assignedLevel"];
  }>,
): RolePermissionMapping[] {
  return PERMISSION_NAMES.map((name) => {
    const assignment = assignments.find((a) => a.permissionName === name);
    return {
      permissionName: name,
      assignedLevel: assignment?.permissionType ?? null,
    };
  });
}

// Backs the Roles page table (um18-spec §18.3, §18.4). Read-only, no audit.
export async function getAllRolesWithMappings(): Promise<RoleWithMappings[]> {
  const roles = await rolesRepository.findAll(db);

  return Promise.all(
    roles.map(async (role) => {
      const assignments =
        await rolePermissionAssignRepository.findMappingsForRole(
          db,
          role.roleId,
        );
      return { ...role, mappings: buildMappings(assignments) };
    }),
  );
}

// Backs the Roles page detail panel (um18-spec §18.3, §18.4). Returns `null`
// when the role doesn't exist — the page renders the "Role not found" state.
export async function getRoleWithMappings(
  roleId: string,
): Promise<RoleWithMappings | null> {
  const role = await rolesRepository.findRoleById(db, roleId);
  if (!role) return null;

  const assignments = await rolePermissionAssignRepository.findMappingsForRole(
    db,
    roleId,
  );
  return { ...role, mappings: buildMappings(assignments) };
}
