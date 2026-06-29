"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeftRight,
  Ban,
  Check,
  CheckCircle,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  ShieldPlus,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { disableUserAction } from "@/actions/users/disable-user.action";
import { enableUserAction } from "@/actions/users/enable-user.action";
import { resetPasswordAction } from "@/actions/users/reset-password.action";
import { switchAuthMethodAction } from "@/actions/users/switch-auth-method.action";
import { unlockAccountAction } from "@/actions/users/unlock-account.action";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DeleteUserDialog } from "@/components/users/delete-user-dialog";
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

type ResetPasswordErrorCode =
  | "USER_NOT_FOUND"
  | "NOT_LOCAL_USER"
  | "INVALID_STATE";

const RESET_PASSWORD_ERROR_MESSAGES: Record<ResetPasswordErrorCode, string> = {
  USER_NOT_FOUND: "User not found. The record may have been deleted.",
  NOT_LOCAL_USER: "Password reset is only available for LOCAL users.",
  INVALID_STATE:
    "Password reset cannot be applied to this user's current state.",
};

type UnlockErrorCode = "USER_NOT_FOUND" | "NOT_LOCKED" | "INVALID_STATE";

const UNLOCK_ERROR_MESSAGES: Record<UnlockErrorCode, string> = {
  USER_NOT_FOUND: "User not found. The record may have been deleted.",
  NOT_LOCKED:
    "This account is no longer locked. Refresh the page to see the current state.",
  INVALID_STATE: "Unlock cannot be applied to this user's current state.",
};

type SwitchAuthMethodErrorCode =
  | "USER_NOT_FOUND"
  | "USER_DELETED"
  | "ALREADY_METHOD";

const SWITCH_AUTH_METHOD_ERROR_MESSAGES: Record<
  SwitchAuthMethodErrorCode,
  string
> = {
  USER_NOT_FOUND: "User not found. The record may have been deleted.",
  USER_DELETED: "Cannot change the authentication method of a deleted user.",
  ALREADY_METHOD: "User already uses this authentication method.",
};

interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
  permissionMap: EffectivePermissionMap;
  allRoles: RoleListItem[];
  // um16-spec §16.6 — added to render the self-switch warning in the
  // auth-method switch dialog. Optional so tests rendering UserDetail in
  // isolation (and any caller without an actor in scope) simply hide the
  // switch control; the Server Action re-resolves the actor server-side and
  // never trusts this value for authorization.
  actorId?: string;
  // Resolved server-side from the `app/locale` config row and threaded in as
  // a prop (um28-spec §2.9) — this client component can't read config itself.
  locale: string;
  // Resolved server-side from the `APP_TIMEZONE` env var and threaded in as a
  // prop (um29-spec §2.4) — same reason: the client can't read config.
  timezone: string;
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
  actorId,
  locale,
  timezone,
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
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<ResetPasswordErrorCode | null>(
    null,
  );
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isUnlockConfirmOpen, setIsUnlockConfirmOpen] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<UnlockErrorCode | null>(null);
  const [isSwitchConfirmOpen, setIsSwitchConfirmOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] =
    useState<SwitchAuthMethodErrorCode | null>(null);
  // um17-spec §17.7. `isDeleted` is an optimistic flag flipped on a
  // successful tombstone so the header switches to the DELETED state before
  // `revalidatePath` re-renders the panel. Cross-user reset is handled by the
  // `key={selectedUserId}` remount on the page (the enforced
  // `react-hooks/set-state-in-effect` rule forbids resetting it in an effect).
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);

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
  // um17-spec §17.7. The DELETED header (muted name + "· Deleted", close
  // button only) renders when the user is persisted DELETED or has just been
  // optimistically tombstoned; every action button is suppressed for it.
  const isDeletedView = user.status === "DELETED" || isDeleted;
  const showDisable =
    canEdit &&
    !isDeletedView &&
    (user.status === "ACTIVE" || user.status === "PENDING");
  const showEnable = canEdit && !isDeletedView && user.status === "DISABLED";
  const showReset =
    canEdit &&
    !isDeletedView &&
    user.authMethod === "LOCAL" &&
    user.status !== "DELETED";
  const showUnlock =
    canEdit && !isDeletedView && user.isLocked && user.status !== "DELETED";

  // um17-spec §17.7. DELETE implies EDIT implies READ, so an actor who sees
  // "Delete user" also sees "Enable"/"Edit"; the three coexist for a DISABLED
  // user. `actionsDisabled` locks every header action while the panel is in
  // edit mode, a disable/enable is in flight, or the delete dialog is open.
  const canDelete = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.DELETE);
  const showDelete = canDelete && !isDeleted && user.status === "DISABLED";
  const actionsDisabled =
    mode === "edit" || isDisabling || isEnabling || isDeleteDialogOpen;

  // um16-spec §16.6. Switching is permitted for PENDING, ACTIVE, and
  // DISABLED users (a PENDING user may have no sessions to revoke — a valid
  // no-op). `actorId` gates the control because the dialog needs it to flag
  // a self-switch; without it there is no actor to compare against.
  const newAuthMethod = user.authMethod === "SSO" ? "LOCAL" : "SSO";
  const canSwitch =
    canEdit && actorId !== undefined && user.status !== "DELETED";
  const isSelfSwitch = actorId !== undefined && actorId === user.userId;

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
    } catch {
      // The action itself never throws (its own internal try/catch always
      // returns a typed result) — this guards against a transport-level
      // failure invoking it (e.g. a network drop) rejecting instead.
      toast.error("Something went wrong. Please try again.");
      setIsConfirmOpen(false);
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
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsEnabling(false);
    }
  }

  async function handleResetConfirm(): Promise<void> {
    setIsResetting(true);
    setResetError(null);
    try {
      const result = await resetPasswordAction({ userId: user!.userId });
      if (result.ok) {
        setIsResetConfirmOpen(false);
        setTempPassword(result.tempPassword);
      } else if (
        result.code === "USER_NOT_FOUND" ||
        result.code === "NOT_LOCAL_USER" ||
        result.code === "INVALID_STATE"
      ) {
        setResetError(result.code);
      } else {
        toast.error("Something went wrong. Please try again.");
        setIsResetConfirmOpen(false);
      }
    } catch {
      // The action itself never throws (its own internal try/catch always
      // returns a typed result) — this guards against a transport-level
      // failure invoking it (e.g. a network drop) rejecting instead.
      toast.error("Something went wrong. Please try again.");
      setIsResetConfirmOpen(false);
    } finally {
      setIsResetting(false);
    }
  }

  async function handleUnlockConfirm(): Promise<void> {
    setIsUnlocking(true);
    setUnlockError(null);
    try {
      const result = await unlockAccountAction({ userId: user!.userId });
      if (result.ok) {
        setIsUnlockConfirmOpen(false);
        // `revalidatePath` in the action causes the page to re-render with
        // the cleared lock state once the server response lands.
      } else if (
        result.code === "USER_NOT_FOUND" ||
        result.code === "NOT_LOCKED" ||
        result.code === "INVALID_STATE"
      ) {
        setUnlockError(result.code);
      } else {
        toast.error("Something went wrong. Please try again.");
        setIsUnlockConfirmOpen(false);
      }
    } catch {
      // The action itself never throws (its own internal try/catch always
      // returns a typed result) — this guards against a transport-level
      // failure invoking it (e.g. a network drop) rejecting instead.
      toast.error("Something went wrong. Please try again.");
      setIsUnlockConfirmOpen(false);
    } finally {
      setIsUnlocking(false);
    }
  }

  async function handleSwitchConfirm(): Promise<void> {
    setIsSwitching(true);
    setSwitchError(null);
    try {
      const result = await switchAuthMethodAction({
        userId: user!.userId,
        newAuthMethod,
      });
      if (result.ok) {
        setIsSwitchConfirmOpen(false);
        if (result.newAuthMethod === "LOCAL") {
          // SSO → LOCAL reveals the one-time temp password via the same
          // reveal modal um14's reset flow uses.
          setTempPassword(result.tempPassword);
        } else {
          toast.success(
            `Authentication method switched to SSO. ${user!.userName} must sign in via Microsoft.`,
          );
        }
        // `revalidatePath` in the action re-renders the panel and the
        // AuthMethodBadge with the new method once the response lands.
      } else if (
        result.code === "USER_NOT_FOUND" ||
        result.code === "USER_DELETED" ||
        result.code === "ALREADY_METHOD"
      ) {
        setSwitchError(result.code);
      } else {
        toast.error("Something went wrong. Please try again.");
        setIsSwitchConfirmOpen(false);
      }
    } catch {
      // The action itself never throws (its own internal try/catch always
      // returns a typed result) — this guards against a transport-level
      // failure invoking it (e.g. a network drop) rejecting instead.
      toast.error("Something went wrong. Please try again.");
      setIsSwitchConfirmOpen(false);
    } finally {
      setIsSwitching(false);
    }
  }

  function handleCopyPassword(): void {
    if (!tempPassword) return;
    // Fire-and-forget, matching `TempPasswordDisplay`'s established pattern
    // (um08) — clipboard access can be denied by browser policy, and that
    // failure shouldn't block the optimistic "Copied!" feedback or surface
    // as an unhandled rejection.
    navigator.clipboard.writeText(tempPassword).catch(() => {});
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }

  function handleDismissTempPassword(): void {
    setTempPassword(null);
    setIsCopied(false);
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
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div className="h-full rounded-md bg-card shadow-md">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3
                className={
                  isDeletedView && mode !== "edit"
                    ? "text-h3 font-semibold text-[color:var(--color-neutral-400)]"
                    : "text-h3 font-semibold text-foreground"
                }
              >
                {mode === "edit" ? "Edit User Details" : user.userName}
                {mode !== "edit" && isDeletedView && (
                  <span className="ml-2 text-xs text-[color:var(--color-danger-700)]">
                    · Deleted
                  </span>
                )}
              </h3>
              {mode === "view" && !isDeletedView && (
                <div className="mt-1">
                  <StatusBadge status={user.status} isLocked={user.isLocked} />
                </div>
              )}
            </div>
            {mode === "view" && (
              <Link
                href="/administration/users"
                aria-label="Close"
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-[color:var(--action-ghost-hover)] hover:text-foreground"
              >
                <X size={16} />
              </Link>
            )}
          </div>
          {mode !== "edit" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {mode === "view" && showDisable && (
                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setIsConfirmOpen(true);
                  }}
                  disabled={isDisabling || isDeleteDialogOpen}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--color-danger-500)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-[color:var(--color-danger-700)] outline-none hover:bg-[color:var(--color-danger-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <Ban size={14} />
                  Disable
                </button>
              )}
              {mode === "view" && showEnable && (
                <button
                  type="button"
                  onClick={() => void handleEnable()}
                  disabled={isEnabling || isDeleteDialogOpen}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--color-success-500)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-[color:var(--color-success-700)] outline-none hover:bg-[color:var(--color-success-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  {isEnabling ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <CheckCircle size={14} />
                  )}
                  Enable
                </button>
              )}
              {mode === "view" && showDelete && (
                <button
                  type="button"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={actionsDisabled}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-[color:var(--color-danger-500)] px-2 py-1 text-sm whitespace-nowrap text-white outline-none hover:bg-[color:var(--color-danger-700)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  Delete user
                </button>
              )}
              {mode === "view" && showUnlock && (
                <button
                  type="button"
                  onClick={() => {
                    setUnlockError(null);
                    setIsUnlockConfirmOpen(true);
                  }}
                  disabled={
                    isDisabling ||
                    isEnabling ||
                    isResetting ||
                    isUnlocking ||
                    isDeleteDialogOpen
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--color-success-500)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-[color:var(--color-success-700)] outline-none hover:bg-[color:var(--color-success-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <Unlock size={14} />
                  Unlock
                </button>
              )}
              {mode === "view" && showReset && (
                <button
                  type="button"
                  onClick={() => {
                    setResetError(null);
                    setIsResetConfirmOpen(true);
                  }}
                  disabled={
                    isDisabling ||
                    isEnabling ||
                    isResetting ||
                    isUnlocking ||
                    isDeleteDialogOpen
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--color-warning-500)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-[color:var(--color-warning-700)] outline-none hover:bg-[color:var(--color-warning-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <KeyRound size={14} />
                  Reset Password
                </button>
              )}
              {mode === "view" && canEdit && !isDeletedView && (
                <button
                  type="button"
                  onClick={handleEdit}
                  disabled={isDeleteDialogOpen}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <Pencil size={14} />
                  Edit
                </button>
              )}
              {mode === "view" && canEdit && !isDeletedView && (
                <button
                  type="button"
                  onClick={handleManageRoles}
                  disabled={isDeleteDialogOpen}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                >
                  <ShieldPlus size={14} />
                  Manage roles
                </button>
              )}
              {mode === "manageRoles" && (
                <button
                  type="button"
                  onClick={() => setMode("view")}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  <Check size={14} />
                  Done
                </button>
              )}
            </div>
          )}
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
              <div className="flex items-center gap-2">
                <AuthMethodBadge authMethod={user.authMethod} />
                {mode === "view" && canSwitch && (
                  <button
                    type="button"
                    onClick={() => {
                      setSwitchError(null);
                      setIsSwitchConfirmOpen(true);
                    }}
                    disabled={
                      isDisabling ||
                      isEnabling ||
                      isResetting ||
                      isUnlocking ||
                      isSwitching ||
                      isDeleteDialogOpen
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border-subtle)] bg-transparent px-2 py-0.5 text-body-sm text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                  >
                    <ArrowLeftRight size={12} />
                    Switch to {newAuthMethod}
                  </button>
                )}
              </div>
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
                  Locked until{" "}
                  {formatDatetime(user.lockedUntil, locale, timezone)}
                </span>
              ) : (
                <span className="text-muted-foreground">Not locked</span>
              )}
            </Field>
            <Field label="Last Login">
              <span className="font-mono text-mono">
                {formatDatetime(user.lastLoginDatetime, locale, timezone)}
              </span>
            </Field>
            <Field label="Created">
              <span className="font-mono text-mono">
                {formatDatetime(user.createdDatetime, locale, timezone)}
              </span>
            </Field>
            <Field label="Last Modified">
              <span className="font-mono text-mono">
                {formatDatetime(user.lastModifiedDatetime, locale, timezone)}
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

      <AlertDialog
        open={isUnlockConfirmOpen}
        onOpenChange={setIsUnlockConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlock {user.userName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the account lockout and allow {user.userName} to
              sign in again.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {unlockError && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>
                {UNLOCK_ERROR_MESSAGES[unlockError]}
              </AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnlocking}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => void handleUnlockConfirm()}
              disabled={isUnlocking}
            >
              {isUnlocking && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Unlock
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isSwitchConfirmOpen}
        onOpenChange={setIsSwitchConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {newAuthMethod} authentication
            </AlertDialogTitle>
            <AlertDialogDescription>
              {newAuthMethod === "LOCAL"
                ? `Switching ${user.userName} to local password authentication will remove their Entra SSO link, generate a temporary password (shown once — share it out of band), and revoke all of their active sessions immediately. They will need to sign in with the temporary password and set a new one.`
                : `Switching ${user.userName} to Entra SSO authentication will remove their password, clear any account lockout, and revoke all of their active sessions immediately. They will need to sign in via Microsoft to re-activate their account.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {isSelfSwitch && (
            <Alert className="mt-2 border-[color:var(--color-warning-500)] text-[color:var(--color-warning-700)]">
              <AlertDescription className="text-[color:var(--color-warning-700)]">
                <strong>You are switching your own account.</strong> Your
                current session will be revoked and you will be signed out
                immediately.
              </AlertDescription>
            </Alert>
          )}

          {switchError && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>
                {SWITCH_AUTH_METHOD_ERROR_MESSAGES[switchError]}
              </AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSwitching}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => void handleSwitchConfirm()}
              disabled={isSwitching}
            >
              {isSwitching && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Switch to {newAuthMethod}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isResetConfirmOpen}
        onOpenChange={setIsResetConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset {user.userName}&apos;s password?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will generate a new temporary password, immediately end all
              of {user.userName}&apos;s active sessions, and require them to set
              a new password on next sign-in. The temporary password is shown
              once and cannot be retrieved.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {resetError && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>
                {RESET_PASSWORD_ERROR_MESSAGES[resetError]}
              </AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleResetConfirm()}
              disabled={isResetting}
            >
              {isResetting && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Reset Password
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={tempPassword !== null} onOpenChange={() => {}}>
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Temporary Password — {user.userName}</DialogTitle>
          </DialogHeader>

          <Alert variant="destructive">
            <AlertDescription>
              This password is shown only once and cannot be retrieved. Share it
              with {user.userName} securely.
            </AlertDescription>
          </Alert>

          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-sunken)] px-3 py-2 font-mono text-sm tracking-wider select-all">
              {tempPassword}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyPassword}
              aria-label="Copy password"
            >
              {isCopied ? (
                <>
                  <Check
                    size={14}
                    className="text-[color:var(--color-success-700)]"
                  />
                  <span className="text-[color:var(--color-success-700)]">
                    Copied!
                  </span>
                </>
              ) : (
                <Copy size={14} />
              )}
            </Button>
          </div>

          <DialogFooter className="mt-4">
            <Button className="w-full" onClick={handleDismissTempPassword}>
              Done — I&apos;ve saved the password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteUserDialog
        targetUserId={user.userId}
        targetUserName={user.userName}
        actorId={actorId}
        isOpen={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        onSuccess={() => setIsDeleted(true)}
      />
    </>
  );
}
