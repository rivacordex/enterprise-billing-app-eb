import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { RoleDetail } from "@/components/roles/role-detail";
import { RoleTable } from "@/components/roles/role-table";
import {
  getAllRolesWithMappings,
  getRoleWithMappings,
} from "@/services/roles/roles-read.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Roles — Enterprise Billing",
};

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ roleId?: string }>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.ROLES,
    LEVELS.READ,
  );

  const { roleId: selectedRoleId } = await searchParams;

  const [roles, selectedRole] = await Promise.all([
    getAllRolesWithMappings(),
    selectedRoleId
      ? getRoleWithMappings(selectedRoleId)
      : Promise.resolve(null),
  ]);

  return (
    <div className="flex h-full gap-4 p-6">
      <div className="min-w-0 flex-[2]">
        <RoleTable
          roles={roles}
          selectedRoleId={selectedRoleId ?? null}
          permissionMap={permissionMap}
        />
      </div>
      <div className="min-w-0 flex-[1]">
        <RoleDetail
          key={selectedRoleId ?? "none"}
          role={selectedRole}
          selectedRoleId={selectedRoleId ?? null}
          permissionMap={permissionMap}
        />
      </div>
    </div>
  );
}
