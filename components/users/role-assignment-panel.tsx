"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { assignRoleAction } from "@/actions/users/assign-role.action";
import { revokeRoleAction } from "@/actions/users/revoke-role.action";
import { RoleBadge } from "@/components/role-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UserStatus } from "@/types/rbac";

export interface RoleAssignmentPanelProps {
  userId: string;
  currentRoles: Array<{
    roleId: string;
    roleName: string;
    assignedBy: string | null;
  }>;
  availableRoles: Array<{ roleId: string; roleName: string }>;
  userStatus: UserStatus;
}

// um12-spec §12.10. Inline current-roles list + remove buttons, a
// last-ADMIN inline alert, and an "Add role" dropdown — no modal/drawer.
export function RoleAssignmentPanel({
  userId,
  currentRoles,
  availableRoles,
  userStatus,
}: RoleAssignmentPanelProps): React.JSX.Element {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [isSavingRoleId, setIsSavingRoleId] = useState<string | null>(null);
  const [lastAdminError, setLastAdminError] = useState(false);

  // Resets the dropdown selection when `availableRoles` changes (e.g. a
  // successful assign shrinks the list) — adjusting state during render
  // rather than in a `useEffect`, since `react-hooks/set-state-in-effect`
  // flags a synchronous `setState` inside an effect body (same lint
  // constraint documented for `UserDetail`'s mode-reset in um11-spec).
  const [prevAvailableRoles, setPrevAvailableRoles] = useState(availableRoles);
  if (availableRoles !== prevAvailableRoles) {
    setPrevAvailableRoles(availableRoles);
    setSelectedRoleId(null);
  }

  async function handleRevoke(roleId: string): Promise<void> {
    setIsSavingRoleId(roleId);
    setLastAdminError(false);
    try {
      const result = await revokeRoleAction({ userId, roleId });
      if (!result.ok) {
        if (result.code === "LAST_ADMIN_ROLE") {
          setLastAdminError(true);
        } else {
          toast.error("Failed to remove role. Please try again.");
        }
      }
      // On ok: true, `revalidatePath` in the action causes the page to
      // re-render with updated props — no client-side state patching needed.
    } finally {
      setIsSavingRoleId(null);
    }
  }

  async function handleAssign(): Promise<void> {
    if (!selectedRoleId) return;
    setIsSavingRoleId(selectedRoleId);
    setLastAdminError(false);
    try {
      const result = await assignRoleAction({ userId, roleId: selectedRoleId });
      if (!result.ok) {
        toast.error("Failed to assign role. Please try again.");
      }
    } finally {
      setIsSavingRoleId(null);
    }
  }

  if (userStatus === "DELETED") {
    return (
      <p className="text-muted-foreground">
        Cannot manage roles for a deleted user.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {currentRoles.length === 0 ? (
          <p className="text-muted-foreground">No roles assigned.</p>
        ) : (
          currentRoles.map((role) => (
            <div
              key={role.roleId}
              className="flex items-center justify-between"
            >
              <RoleBadge roleName={role.roleName} />
              <button
                type="button"
                aria-label={`Remove ${role.roleName}`}
                disabled={isSavingRoleId === role.roleId}
                onClick={() => void handleRevoke(role.roleId)}
                className="rounded-sm p-1 text-[color:var(--color-danger-700)] outline-none hover:bg-[color:var(--color-danger-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
              >
                {isSavingRoleId === role.roleId ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <X size={14} />
                )}
              </button>
            </div>
          ))
        )}
      </div>

      {lastAdminError && (
        <Alert variant="destructive">
          <AlertDescription>
            Cannot remove the last ADMIN role. Assign ADMIN to another user
            first.
          </AlertDescription>
        </Alert>
      )}

      {availableRoles.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Add role
          </label>
          <div className="flex items-center gap-2">
            <Select
              value={selectedRoleId ?? ""}
              onValueChange={setSelectedRoleId}
              disabled={isSavingRoleId !== null}
            >
              <SelectTrigger className="h-8 flex-1 text-sm">
                <SelectValue placeholder="Select a role…" />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map((role) => (
                  <SelectItem
                    key={role.roleId}
                    value={role.roleId}
                    className="focus:bg-muted focus:text-foreground"
                  >
                    {role.roleName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={!selectedRoleId || isSavingRoleId !== null}
              onClick={() => void handleAssign()}
            >
              {isSavingRoleId === selectedRoleId && selectedRoleId !== null ? (
                <Loader2 size={14} className="animate-spin" />
              ) : null}
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
