"use client";

import { useRouter } from "next/navigation";

import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { Button } from "@/components/ui/button";
import { CreateRoleDialog } from "@/components/roles/create-role-dialog";
import { PermissionLevelTag } from "@/components/roles/permission-level-tag";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { hasLevel, type EffectivePermissionMap } from "@/types/permissions";
import { PERMISSION_DISPLAY_NAMES, type RoleWithMappings } from "@/types/roles";

interface RoleTableProps {
  roles: RoleWithMappings[];
  selectedRoleId: string | null;
  permissionMap: EffectivePermissionMap;
  // Resolved server-side from the `app/locale` config row and threaded in as
  // a prop (um28-spec §2.9) — this client component can't read config itself.
  locale: string;
}

export function RoleTable({
  roles,
  selectedRoleId,
  permissionMap,
  locale,
}: RoleTableProps): React.JSX.Element {
  const router = useRouter();

  function handleRowClick(roleId: string): void {
    router.push(`/administration/roles?roleId=${encodeURIComponent(roleId)}`);
  }

  const canAddRole = hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT);

  return (
    <div className="h-full rounded-md bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-h3 font-semibold text-foreground">Roles</h2>
          <span className="text-body-sm text-muted-foreground">
            {roles.length}
          </span>
        </div>
        {canAddRole && <CreateRoleDialog trigger={<Button>Add Role</Button>} />}
      </div>

      {roles.length === 0 ? (
        <p className="p-6 text-center text-body text-muted-foreground">
          No roles found.
        </p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Role
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Description
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Permissions
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const isSelected = role.roleId === selectedRoleId;
              const grantedMappings = role.mappings.filter(
                (m) => m.assignedLevel !== null,
              );

              return (
                <tr
                  key={role.roleId}
                  onClick={() => handleRowClick(role.roleId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRowClick(role.roleId);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  className={cn(
                    "cursor-pointer border-b border-border outline-none last:border-0 hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]",
                    isSelected &&
                      "border-l-[3px] border-l-[color:var(--color-primary-500)] bg-[color:var(--surface-selected)]",
                  )}
                >
                  <td className="px-4 py-2 font-medium">{role.roleName}</td>
                  <td className="px-4 py-2 text-body text-muted-foreground">
                    {role.roleDescr ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    {grantedMappings.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {grantedMappings.map((mapping) => (
                          <span
                            key={mapping.permissionName}
                            className="inline-flex items-center gap-1 rounded-xs bg-[color:var(--surface-sunken)] px-1.5 py-0.5 text-caption text-muted-foreground"
                          >
                            {PERMISSION_DISPLAY_NAMES[mapping.permissionName]}
                            <PermissionLevelTag
                              level={mapping.assignedLevel!}
                            />
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        No permissions
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-mono text-muted-foreground">
                    {formatDatetime(role.createdDatetime, locale)}
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
