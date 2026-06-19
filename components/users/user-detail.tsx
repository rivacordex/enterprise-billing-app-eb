"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Ban,
  Check,
  CheckCircle,
  Loader2,
  Pencil,
  ShieldPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { disableUserAction } from "@/actions/users/disable-user.action";
import { enableUserAction } from "@/actions/users/enable-user.action";
import { updateUserDetailsAction } from "@/actions/users/update-user-details.action";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { AuthMethodBadge } from "@/components/auth-method-badge";
import { RoleBadge } from "@/components/role-badge";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RoleAssignmentPanel } from "@/components/users/role-assignment-panel";
import { UserForm } from "@/components/users/user-form";
import { formatDatetime } from "@/lib/formatters";
import { hasLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { RoleListItem } from "@/types/rbac";
import type { UserDetailView } from "@/types/users";
import type { EditUserDetailsFields } from "@/validation/update-user-details.schema";

type DisableEnableErrorCode = "LAST_ADMIN" | "USER_NOT_FOUND" | "INVALID_STATE";

const DISABLE_ENABLE_ERROR_MESSAGES: Record<DisableEnableErrorCode, string> = {
  LAST_ADMIN:
    "Cannot disable this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first.",
  USER_NOT_FOUND: "User not found. The record may have been deleted.",
  INVALID_STATE:
    "This action cannot be applied to a user in their current state.",
};

interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
  permissionMap: EffectivePermissionMap;
  allRoles: RoleListItem[];
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-body text-foreground">{children}</dd>
    </div>
  );
}

export function UserDetail({
  user,
  notFound,
  permissionMap,
  allRoles,
}: UserDetailProps): React.JSX.Element {
  const [mode, setMode] = useState<"view" | "edit" | "manageRoles">("view");
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<"USER_NOT_FOUND" | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [actionError, setActionError] = useState<DisableEnableErrorCode | null>(
    null,
  );

  if (user === null || notFound === true) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md bg-card text-center shadow-md">
        <p className="text-muted-foreground">
          {notFound ? "User not found." : "Select a user to view details."}
        </p>
        {notFound && (
          <Link
            href="/administration/users"
            className="text-body-sm text-primary underline"
          >
            Back to users
          </Link>
        )}
      </div>
    );
  }

  const canEdit = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT);
  const showDisable =
    canEdit && (user.status === "ACTIVE" || user.status === "PENDING");
  const showEnable = canEdit && user.status === "DISABLED";

  // um12-spec §"`allRoles` prop flow" — excludes roles the user already
  // holds from the "Add role" dropdown.
  const availableRoles = allRoles.filter(
    (role) => !user.roles.some((r) => r.roleId === role.roleId),
  );

  function handleEdit(): void {
    setLocalError(null);
    setMode("edit");
  }

  function handleManageRoles(): void {
    setMode("manageRoles");
  }

  async function handleDisableConfirm(): Promise<void> {
    setIsDisabling(true);
    setActionError(null);
    try {
      const result = await disableUserAction({ userId: user!.userId });
      if (result.ok) {
        setIsConfirmOpen(false);
        // `revalidatePath` in the action causes the page to re-render with
        // the updated status once the server response lands.
      } else if (
        result.code === "LAST_ADMIN" ||
        result.code === "USER_NOT_FOUND" ||
        result.code === "INVALID_STATE"
      ) {
        setActionError(result.code);
        // The LAST_ADMIN explanation is read inside the dialog itself
        // (um13-spec §"Error feedback") — every other code closes it.
        if (result.code !== "LAST_ADMIN") {
          setIsConfirmOpen(false);
        }
      } else {
        toast.error("Something went wrong. Please try again.");
        setIsConfirmOpen(false);
      }
    } finally {
      setIsDisabling(false);
    }
  }

  async function handleEnable(): Promise<void> {
    setIsEnabling(true);
    setActionError(null);
    try {
      const result = await enableUserAction({ userId: user!.userId });
      if (!result.ok) {
        if (
          result.code === "USER_NOT_FOUND" ||
          result.code === "INVALID_STATE"
        ) {
          setActionError(result.code);
        } else {
          toast.error("Something went wrong. Please try again.");
        }
      }
      // On success, `revalidatePath` re-renders with the updated status.
    } finally {
      setIsEnabling(false);
    }
  }

  async function handleEditSubmit(
    values: EditUserDetailsFields,
  ): Promise<void> {
    setIsSaving(true);
    try {
      const result = await updateUserDetailsAction({
        ...values,
        userId: user!.userId,
      });

      if (result.ok) {
        setMode("view");
        // `revalidatePath` in the action causes the page to re-render with
        // updated props once the server response lands — no client-side
        // state patching needed.
      } else if (result.code === "USER_NOT_FOUND") {
        setLocalError("USER_NOT_FOUND");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div className="h-full rounded-md bg-card shadow-md">
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-h3 font-semibold text-foreground">
              {mode === "edit" ? "Edit User Details" : user.userName}
            </h3>
            {mode === "view" && (
              <div className="mt-1">
                <StatusBadge status={user.status} isLocked={user.isLocked} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "view" && showDisable && (
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  setIsConfirmOpen(true);
                }}
                disabled={isDisabling}
                className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--color-danger-500)] bg-transparent px-2 py-1 text-sm text-[color:var(--color-danger-700)] outline-none hover:bg-[color:var(--color-danger-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
              >
                <Ban size={14} />
                Disable
              </button>
            )}
            {mode === "view" && showEnable && (
              <button
                type="button"
                onClick={() => void handleEnable()}
                disabled={isEnabling}
                className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--color-success-500)] bg-transparent px-2 py-1 text-sm text-[color:var(--color-success-700)] outline-none hover:bg-[color:var(--color-success-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
              >
                {isEnabling ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <CheckCircle size={14} />
                )}
                Enable
              </button>
            )}
            {mode === "view" && canEdit && (
              <button
                type="button"
                onClick={handleEdit}
                className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
              >
                <Pencil size={14} />
                Edit
              </button>
            )}
            {mode === "view" && canEdit && (
              <button
                type="button"
                onClick={handleManageRoles}
                className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
              >
                <ShieldPlus size={14} />
                Manage roles
              </button>
            )}
            {mode === "view" && (
              <Link
                href="/administration/users"
                aria-label="Close"
                className="rounded-sm p-1 text-muted-foreground hover:bg-[color:var(--action-ghost-hover)] hover:text-foreground"
              >
                <X size={16} />
              </Link>
            )}
            {mode === "manageRoles" && (
              <button
                type="button"
                onClick={() => setMode("view")}
                className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
              >
                <Check size={14} />
                Done
              </button>
            )}
          </div>
        </div>

        {mode === "view" && !isConfirmOpen && actionError && (
          <div className="px-4 pt-3">
            <Alert variant="destructive">
              <AlertDescription>
                {DISABLE_ENABLE_ERROR_MESSAGES[actionError]}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {mode === "edit" && localError === "USER_NOT_FOUND" && (
          <div className="px-4 pt-3">
            <Alert variant="destructive">
              <AlertDescription>
                User not found. The record may have been deleted.{" "}
                <Link href="/administration/users" className="underline">
                  Back to users
                </Link>
              </AlertDescription>
            </Alert>
          </div>
        )}

        <dl className="flex flex-col gap-6 p-4">
          <div className="flex flex-col gap-3">
            {mode === "edit" ? (
              <UserForm
                mode="edit"
                defaultValues={{
                  userName: user.userName,
                  userPhonenum: user.userPhonenum,
                }}
                onSubmit={handleEditSubmit}
                isSubmitting={isSaving}
              />
            ) : (
              <>
                <Field label="Full Name">{user.userName}</Field>
                <Field label="Email">{user.userEmail}</Field>
                <Field label="Phone">{user.userPhonenum ?? "—"}</Field>
              </>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <Field label="Auth Method">
              <AuthMethodBadge authMethod={user.authMethod} />
            </Field>
            <Field label="Roles">
              {mode === "manageRoles" ? (
                <RoleAssignmentPanel
                  userId={user.userId}
                  currentRoles={user.roles}
                  availableRoles={availableRoles}
                  userStatus={user.status}
                />
              ) : user.roles.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <RoleBadge key={role.roleId} roleName={role.roleName} />
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">None assigned</span>
              )}
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <Field label="Status">
              <StatusBadge status={user.status} />
            </Field>
            <Field label="Locked">
              {user.isLocked ? (
                <span className="font-mono text-mono text-[color:var(--color-danger-700)]">
                  Locked until {formatDatetime(user.lockedUntil)}
                </span>
              ) : (
                <span className="text-muted-foreground">Not locked</span>
              )}
            </Field>
            <Field label="Last Login">
              <span className="font-mono text-mono">
                {formatDatetime(user.lastLoginDatetime)}
              </span>
            </Field>
            <Field label="Created">
              <span className="font-mono text-mono">
                {formatDatetime(user.createdDatetime)}
              </span>
            </Field>
            <Field label="Last Modified">
              <span className="font-mono text-mono">
                {formatDatetime(user.lastModifiedDatetime)}
              </span>
            </Field>
          </div>
        </dl>

        {mode === "edit" && (
          <div className="flex justify-end gap-2 border-t border-border p-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMode("view")}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" form="edit-user-form" disabled={isSaving}>
              {isSaving && <Loader2 className="animate-spin" size={14} />}
              Save changes
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {user.userName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately end all of {user.userName}&apos;s active
              sessions. They will be blocked from signing in until re-enabled.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {actionError && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>
                {DISABLE_ENABLE_ERROR_MESSAGES[actionError]}
              </AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDisableConfirm()}
              disabled={isDisabling}
            >
              {isDisabling && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Disable user
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
