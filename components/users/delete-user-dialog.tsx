"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteUserAction } from "@/actions/users/delete-user.action";
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

type DeleteUserErrorCode = "INVALID_STATE" | "LAST_ADMIN" | "USER_NOT_FOUND";

const DELETE_USER_ERROR_MESSAGES: Record<DeleteUserErrorCode, string> = {
  INVALID_STATE: "This user must be disabled before they can be deleted.",
  LAST_ADMIN:
    "Cannot delete this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first.",
  USER_NOT_FOUND: "User not found. The record may have been deleted.",
};

interface DeleteUserDialogProps {
  targetUserId: string;
  targetUserName: string;
  actorId?: string | undefined;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// um17-spec §17.6. Tombstone confirmation modal built on `AlertDialog` (not
// `Dialog`) so the irreversible action cannot be dismissed by a backdrop
// click — `AlertDialog` forces an explicit button choice. The parent
// (`UserDetail`) owns the open state, consistent with the disable dialog
// pattern from um13.
export function DeleteUserDialog({
  targetUserId,
  targetUserName,
  actorId,
  isOpen,
  onOpenChange,
  onSuccess,
}: DeleteUserDialogProps): React.JSX.Element {
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionError, setActionError] = useState<DeleteUserErrorCode | null>(
    null,
  );

  // Re-opening after a prior error shows a clean dialog (um17-spec §17.6).
  // The enforced `react-hooks/set-state-in-effect` rule forbids doing this in
  // an effect, so clear the stale error during render on the false→true
  // transition by tracking the previous `isOpen` value (the codebase's
  // sanctioned reset-during-render pattern).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setActionError(null);
  }

  const isSelfDelete = actorId !== undefined && actorId === targetUserId;

  async function handleDeleteConfirm(): Promise<void> {
    setIsDeleting(true);
    setActionError(null);
    try {
      const result = await deleteUserAction({ userId: targetUserId });
      if (result.ok) {
        onOpenChange(false);
        onSuccess();
      } else if (
        result.code === "INVALID_STATE" ||
        result.code === "LAST_ADMIN" ||
        result.code === "USER_NOT_FOUND"
      ) {
        // Informational — the admin needs to act on these (re-enable, assign
        // another ADMIN), so the dialog stays open with the error inline.
        setActionError(result.code);
      } else {
        toast.error("Something went wrong. Please try again.");
        onOpenChange(false);
      }
    } catch {
      // The action itself never throws (its own internal try/catch always
      // returns a typed result) — this guards against a transport-level
      // failure invoking it (e.g. a network drop) rejecting instead.
      toast.error("Something went wrong. Please try again.");
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={isDeleting ? () => {} : onOpenChange}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Permanently delete {targetUserName}?
          </AlertDialogTitle>
        </AlertDialogHeader>

        {isSelfDelete && (
          <Alert className="border-[color:var(--color-warning-500)] text-[color:var(--color-warning-700)]">
            <AlertDescription className="text-[color:var(--color-warning-700)]">
              <strong>You are deleting your own account.</strong> You will be
              signed out and lose all access immediately.
            </AlertDescription>
          </Alert>
        )}

        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>
              {DELETE_USER_ERROR_MESSAGES[actionError]}
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogDescription asChild>
          <div className="space-y-3 text-sm">
            <p>
              Deleting <strong>{targetUserName}</strong> will:
            </p>
            <ul className="list-inside list-disc space-y-1 text-[color:var(--color-neutral-500)]">
              <li>Set their account status to DELETED</li>
              <li>Remove all role assignments</li>
              <li>Remove their stored credentials</li>
              <li>Revoke any remaining active sessions</li>
            </ul>
            <p>
              <strong>This cannot be undone.</strong> The account record is
              preserved for audit history, but the user will never be able to
              sign in. Once deleted, their email address and Entra identity can
              be reused for a new account.
            </p>
          </div>
        </AlertDialogDescription>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleDeleteConfirm()}
            disabled={isDeleting}
          >
            {isDeleting && <Loader2 size={14} className="mr-1 animate-spin" />}
            Delete user
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
