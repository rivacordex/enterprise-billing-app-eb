import { asc, eq, ilike } from "drizzle-orm";

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
  // role's name for the ADMIN guard and the audit event's `roleName`, and by
  // the Roles detail panel (um18-spec §18.2.1 `findById`) to load a single
  // full role row.
  async findRoleById(db: Database, roleId: string): Promise<Role | null> {
    const [row] = await db
      .select()
      .from(roles)
      .where(eq(roles.roleId, roleId))
      .limit(1);
    return row ?? null;
  },

  // Full role rows (incl. timestamps) for the Roles page table (um18-spec
  // §18.2.1) — `findAllRoles` above only projects the 3 fields the
  // create-user/role-assignment UIs need.
  async findAll(db: Database): Promise<Role[]> {
    return db.select().from(roles).orderBy(asc(roles.roleName));
  },

  // Case-insensitive name-uniqueness guard used by `createRole`/`updateRole`
  // (um19-spec §19.2.1) ahead of opening a transaction. `lower(role_name)`
  // has a matching unique index, so a concurrent duplicate that slips past
  // this pre-check is still rejected at the DB level.
  async findRoleByName(db: Database, name: string): Promise<Role | null> {
    const escaped = name.replace(/[%_\\]/g, "\\$&");
    const [row] = await db
      .select()
      .from(roles)
      .where(ilike(roles.roleName, escaped))
      .limit(1);
    return row ?? null;
  },

  // um19-spec §19.2.2. The UUID is generated here, not in the service.
  async insertRole(
    tx: Database,
    data: { roleName: string; roleDescr: string | null },
  ): Promise<{ roleId: string }> {
    const [row] = await tx
      .insert(roles)
      .values({
        roleName: data.roleName,
        roleDescr: data.roleDescr ?? null,
      })
      .returning({ roleId: roles.roleId });
    if (!row) {
      throw new Error("insertRole: insert returned no row");
    }
    return { roleId: row.roleId };
  },

  // um19-spec §19.2.3. Only updates `role_name`, `role_descr`, and
  // `last_modified_datetime` — no other columns are touched.
  async updateRoleNameDescr(
    tx: Database,
    roleId: string,
    data: { roleName: string; roleDescr: string | null },
  ): Promise<void> {
    await tx
      .update(roles)
      .set({
        roleName: data.roleName,
        roleDescr: data.roleDescr,
        lastModifiedDatetime: new Date(),
      })
      .where(eq(roles.roleId, roleId));
  },

  // um21-spec §21.3.1. The `role_assign.ref_role_id` FK is a final backstop
  // against deleting a role with live assignments — the service's
  // `countByRoleId` check is the primary guard.
  async deleteRoleById(tx: Database, roleId: string): Promise<void> {
    await tx.delete(roles).where(eq(roles.roleId, roleId));
  },
};
