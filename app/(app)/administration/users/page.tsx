import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { UserDetail } from "@/components/users/user-detail";
import { UserTable } from "@/components/users/user-table";
import {
  getAppLocale,
  getAppName,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import * as rolesReadService from "@/services/roles/roles-read.service";
import * as usersReadService from "@/services/users/users-read.service";

export const dynamic = "force-dynamic";

// Dynamic so the tab title tracks the configured `app_name` (`getAppName()` is
// `React.cache`d, so it shares the page's per-request read).
export async function generateMetadata(): Promise<Metadata> {
  return { title: `Users — ${await getAppName()}` };
}

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

  // `getAppTimezone()` is a synchronous config accessor (um29-spec §2.3), so
  // it is resolved outside the `Promise.all` that awaits the DB reads.
  const timezone = getAppTimezone();
  const [users, selectedUser, roles, locale] = await Promise.all([
    usersReadService.listUsers(),
    selectedUserId
      ? usersReadService.getUserById(selectedUserId)
      : Promise.resolve(null),
    rolesReadService.listRoles(),
    getAppLocale(),
  ]);

  return (
    <div className="flex h-full gap-4 p-6">
      <div className="min-w-0 flex-[2]">
        <UserTable
          users={users}
          selectedUserId={selectedUserId}
          permissionMap={permissionMap}
          roles={roles}
          locale={locale}
          timezone={timezone}
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
          locale={locale}
          timezone={timezone}
        />
      </div>
    </div>
  );
}
