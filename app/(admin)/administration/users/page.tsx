import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { UserDetail } from "@/components/users/user-detail";
import { UserTable } from "@/components/users/user-table";
import * as rolesReadService from "@/services/roles/roles-read.service";
import * as usersReadService from "@/services/users/users-read.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users — Enterprise Billing",
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string }>;
}): Promise<React.JSX.Element> {
  const { userId: actorId, permissionMap } = await requirePermission(
    PERMISSIONS.USERS,
    LEVELS.READ,
  );

  const { userId: selectedUserId } = await searchParams;

  const [users, selectedUser, roles] = await Promise.all([
    usersReadService.listUsers(),
    selectedUserId
      ? usersReadService.getUserById(selectedUserId)
      : Promise.resolve(null),
    rolesReadService.listRoles(),
  ]);

  return (
    <div className="flex h-full gap-4 p-6">
      <div className="min-w-0 flex-[2]">
        <UserTable
          users={users}
          selectedUserId={selectedUserId}
          permissionMap={permissionMap}
          roles={roles}
        />
      </div>
      <div className="min-w-0 flex-[1]">
        <UserDetail
          key={selectedUserId ?? "none"}
          user={selectedUser}
          notFound={selectedUserId !== undefined && selectedUser === null}
          permissionMap={permissionMap}
          allRoles={roles}
          actorId={actorId}
        />
      </div>
    </div>
  );
}
