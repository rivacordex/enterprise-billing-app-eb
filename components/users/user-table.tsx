"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp } from "lucide-react";

import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import { AuthMethodBadge } from "@/components/auth-method-badge";
import { RoleBadge } from "@/components/role-badge";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CreateUserDialog } from "@/components/users/create-user-dialog";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { hasLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { UserListItem } from "@/types/users";

interface UserTableProps {
  users: UserListItem[];
  // Not optional: `exactOptionalPropertyTypes` distinguishes "omitted" from
  // "explicitly undefined", and the page always passes this key.
  selectedUserId: string | undefined;
  permissionMap: EffectivePermissionMap;
  roles: Array<{ roleId: string; roleName: string; roleDescr: string | null }>;
}

type SortKey = "userName" | "userEmail" | "lastLoginDatetime";

const SORTABLE_COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "userName", label: "Name" },
  { key: "userEmail", label: "Email" },
  { key: "lastLoginDatetime", label: "Last Login" },
];

function compareUsers(
  a: UserListItem,
  b: UserListItem,
  sortKey: SortKey,
  sortDir: "asc" | "desc",
): number {
  if (sortKey === "lastLoginDatetime") {
    // `null` last-login values sort last regardless of direction.
    if (a.lastLoginDatetime === null && b.lastLoginDatetime === null) return 0;
    if (a.lastLoginDatetime === null) return 1;
    if (b.lastLoginDatetime === null) return -1;
    const diff = a.lastLoginDatetime.getTime() - b.lastLoginDatetime.getTime();
    return sortDir === "asc" ? diff : -diff;
  }

  const diff = a[sortKey].localeCompare(b[sortKey]);
  return sortDir === "asc" ? diff : -diff;
}

export function UserTable({
  users,
  selectedUserId,
  permissionMap,
  roles,
}: UserTableProps): React.JSX.Element {
  const router = useRouter();
  const [showDeleted, setShowDeleted] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("userName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const filteredUsers = showDeleted
    ? users
    : users.filter((u) => u.status !== "DELETED");
  const sortedUsers = [...filteredUsers].sort((a, b) =>
    compareUsers(a, b, sortKey, sortDir),
  );

  function handleRowClick(userId: string): void {
    router.push(`/administration/users?userId=${userId}`);
  }

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const canAddUser = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT);

  return (
    <div className="h-full rounded-md bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-h3 font-semibold text-foreground">Users</h2>
          <span className="text-body-sm text-muted-foreground">
            {sortedUsers.length}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="show-deleted"
              checked={showDeleted}
              onCheckedChange={setShowDeleted}
            />
            <label
              htmlFor="show-deleted"
              className="text-body-sm text-muted-foreground"
            >
              Show deleted users
            </label>
          </div>
          {canAddUser && (
            <CreateUserDialog
              roles={roles}
              trigger={<Button>Add User</Button>}
            />
          )}
        </div>
      </div>

      {sortedUsers.length === 0 ? (
        <p className="p-6 text-center text-body text-muted-foreground">
          No users found.
        </p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {SORTABLE_COLUMNS.map(({ key, label }) => (
                <th key={key} className="px-4 py-2 text-left">
                  <button
                    type="button"
                    onClick={() => handleSort(key)}
                    className="group inline-flex items-center gap-1 text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase"
                  >
                    {label}
                    {sortKey === key &&
                      (sortDir === "asc" ? (
                        <ChevronUp size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      ))}
                  </button>
                </th>
              ))}
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Auth Method
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Status
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Roles
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((user) => {
              const isSelected = user.userId === selectedUserId;
              const isDeleted = showDeleted && user.status === "DELETED";

              return (
                <tr
                  key={user.userId}
                  onClick={() => handleRowClick(user.userId)}
                  className={cn(
                    "cursor-pointer border-b border-border last:border-0 hover:bg-[color:var(--action-ghost-hover)]",
                    isSelected &&
                      "border-l-[3px] border-l-[color:var(--color-primary-500)] bg-[color:var(--surface-selected)]",
                    isDeleted &&
                      "bg-[color:var(--surface-sunken)] text-muted-foreground line-through",
                  )}
                >
                  <td className="px-4 py-2 font-medium">{user.userName}</td>
                  <td className="px-4 py-2 text-body">{user.userEmail}</td>
                  <td className="px-4 py-2 font-mono text-mono">
                    {user.lastLoginDatetime ? (
                      formatDatetime(user.lastLoginDatetime)
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <AuthMethodBadge authMethod={user.authMethod} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge
                      status={user.status}
                      isLocked={user.isLocked}
                    />
                  </td>
                  <td className="px-4 py-2">
                    {user.roles.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {user.roles.map((role) => (
                          <RoleBadge
                            key={role.roleId}
                            roleName={role.roleName}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
