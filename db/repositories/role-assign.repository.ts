import { and, count, eq, ne } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { roleAssign } from "@/db/schema/role-assign";
import type { RoleAssign } from "@/types/rbac";

export const roleAssignRepository = {
  async findRoleIdsByUserId(db: Database, userId: string): Promise<string[]> {
    const rows = await db
      .select({ refRoleId: roleAssign.refRoleId })
      .from(roleAssign)
      .where(eq(roleAssign.refUserId, userId));

    return rows.map((row) => row.refRoleId);
  },

  // Bulk-inserts initial role grants for a newly created user (um08-spec
  // §8.3.3). No-op when `roleIds` is empty — Drizzle's batch insert rejects
  // an empty values array.
  async insertRoleAssignments(
    tx: Database,
    userId: string,
    roleIds: string[],
    assignedByUserId: string,
  ): Promise<void> {
    if (roleIds.length === 0) return;

    await tx.insert(roleAssign).values(
      roleIds.map((roleId) => ({
        refUserId: userId,
        refRoleId: roleId,
        assignedBy: assignedByUserId,
      })),
    );
  },

  // Single-role assign/revoke from `RoleAssignmentPanel` (um12-spec §12.4).
  // The unique `(ref_user_id, ref_role_id)` constraint is enforced by the
  // DB; the service checks for an existing assignment before calling this.
  async insertRoleAssign(
    tx: Database,
    data: { refUserId: string; refRoleId: string; assignedBy: string },
  ): Promise<RoleAssign> {
    const [row] = await tx
      .insert(roleAssign)
      .values({
        refUserId: data.refUserId,
        refRoleId: data.refRoleId,
        assignedBy: data.assignedBy,
      })
      .returning();
    return row!;
  },

  // Returns the deleted row, or `null` if no matching row existed (a race
  // condition) — the service loads the assignment before opening the
  // transaction and treats a `null` here as a "disappeared mid-transaction"
  // failure (um12-spec §12.4).
  async deleteRoleAssign(
    tx: Database,
    data: { refUserId: string; refRoleId: string },
  ): Promise<RoleAssign | null> {
    const [row] = await tx
      .delete(roleAssign)
      .where(
        and(
          eq(roleAssign.refUserId, data.refUserId),
          eq(roleAssign.refRoleId, data.refRoleId),
        ),
      )
      .returning();
    return row ?? null;
  },

  async findByUserIdAndRoleId(
    db: Database,
    refUserId: string,
    refRoleId: string,
  ): Promise<RoleAssign | null> {
    const [row] = await db
      .select()
      .from(roleAssign)
      .where(
        and(
          eq(roleAssign.refUserId, refUserId),
          eq(roleAssign.refRoleId, refRoleId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // Backs the last-ADMIN-capable-account guard (um12-spec §12.4, Invariant
  // #13). Counts ACTIVE, PENDING, and DISABLED users — DISABLED users are
  // still ADMIN-capable (they can be re-enabled), only DELETED is excluded.
  async countNonDeletedUsersWithRole(
    db: Database,
    roleId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ count: count() })
      .from(roleAssign)
      .innerJoin(appuser, eq(roleAssign.refUserId, appuser.id))
      .where(
        and(eq(roleAssign.refRoleId, roleId), ne(appuser.status, "DELETED")),
      );
    return row?.count ?? 0;
  },
};
