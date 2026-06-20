"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteRoleAction } from "@/actions/roles/delete-role.action";
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

type DeleteRoleErrorCode =
  | "ROLE_NOT_FOUND"
  | "SEEDED_ROLE"
  | "ROLE_IN_USE"
  | "FORBIDDEN"
  | "SERVER_ERROR";

interface DeleteRoleDialogProps {
  roleId: string;
  roleName: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function errorMessage(
  code: DeleteRoleErrorCode,
  assignedCount: number | undefined,
): string {
  switch (code) {
    case "ROLE_IN_USE": {
      const n = assignedCount ?? 0;
      return `This role is assigned to ${n} user${n === 1 ? "" : "s"}. Revoke all role assignments before deleting.`;
    }
    case "ROLE_NOT_FOUND":
      return "Role not found. It may have been deleted by another admin.";
    case "SEEDED_ROLE":
      return "Seeded roles (ADMIN, MANAGER, USER) cannot be deleted.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// um21-spec §21.6. Built on `AlertDialog` (not `Dialog`), mirroring
// `DeleteUserDialog`'s pattern (um17) — the parent (`RoleDetail`) owns the
// open state so it can clear local state and re-enable the Delete button on
// close. ROLE_IN_USE is not pre-checked before opening; the server check
// runs on confirm and the dialog stays open with the count inline if blocked.
export function DeleteRoleDialog({
  roleId,
  roleName,
  isOpen,
  onOpenChange,
  onSuccess,
}: DeleteRoleDialogProps): React.JSX.Element {
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionError, setActionError] = useState<{
    code: DeleteRoleErrorCode;
    assignedCount?: number;
  } | null>(null);

  // Re-opening after a prior error shows a clean dialog. The enforced
  // `react-hooks/set-state-in-effect` rule forbids doing this in an effect,
  // so clear the stale error during render on the false→true transition by
  // tracking the previous `isOpen` value (mirrors `DeleteUserDialog`).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setActionError(null);
  }

  async function handleDeleteConfirm(): Promise<void> {
    setIsDeleting(true);
    setActionError(null);
    try {
      const result = await deleteRoleAction({ roleId });
      if (result.ok) {
        onOpenChange(false);
        onSuccess();
      } else if (result.code === "VALIDATION_ERROR") {
        toast.error("Something went wrong. Please try again.");
        onOpenChange(false);
      } else if (result.code === "ROLE_IN_USE") {
        setActionError({
          code: result.code,
          assignedCount: result.assignedCount,
        });
      } else {
        setActionError({ code: result.code });
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
          <AlertDialogTitle>Delete role</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the role <strong>{roleName}</strong>.
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>
              {errorMessage(actionError.code, actionError.assignedCount)}
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleDeleteConfirm()}
            disabled={isDeleting}
          >
            {isDeleting && <Loader2 size={14} className="mr-1 animate-spin" />}
            Delete role
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
