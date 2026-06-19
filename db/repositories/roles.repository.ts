import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { roles } from "@/db/schema/roles";
import type { Role, RoleListItem } from "@/types/rbac";

export const rolesRepository = {
  // Populates the "Initial Roles" checkbox list in the create-user dialog
  // (um08-spec §8.6) and the "Add role" dropdown in `RoleAssignmentPanel`
  // (um12-spec §12.3). Full CRUD arrives in um13.
  async findAllRoles(db: Database): Promise<RoleListItem[]> {
    return db
      .select({
        roleId: roles.roleId,
        roleName: roles.roleName,
        roleDescr: roles.roleDescr,
      })
      .from(roles)
      .orderBy(asc(roles.roleName));
  },

  // Used by `assignRole`/`revokeRole` (um12-spec §12.3) to resolve the
  // role's name for the ADMIN guard and the audit event's `roleName`.
  async findRoleById(db: Database, roleId: string): Promise<Role | null> {
    const [row] = await db
      .select()
      .from(roles)
      .where(eq(roles.roleId, roleId))
      .limit(1);
    return row ?? null;
  },
};
