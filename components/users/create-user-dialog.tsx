"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createUserAction } from "@/actions/users/create-user.action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TempPasswordDisplay } from "@/components/users/temp-password-display";
import { UserForm } from "@/components/users/user-form";
import type { CreateUserInput } from "@/validation/create-user.schema";

export interface CreateUserDialogProps {
  roles: Array<{ roleId: string; roleName: string; roleDescr: string | null }>;
  trigger: React.ReactNode;
}

interface SuccessData {
  userId: string;
  tempPassword: string;
}

export function CreateUserDialog({
  roles,
  trigger,
}: CreateUserDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dialogState, setDialogState] = useState<"form" | "success">("form");
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailConflict, setEmailConflict] = useState(false);

  function reset(): void {
    setDialogState("form");
    setSuccessData(null);
    setIsSubmitting(false);
    setEmailConflict(false);
  }

  function goToNewUser(userId: string): void {
    router.push(`/administration/users?userId=${userId}`);
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && dialogState === "success" && successData) {
      goToNewUser(successData.userId);
    }
    setOpen(nextOpen);
    if (!nextOpen) reset();
  }

  function handleDone(): void {
    if (successData) goToNewUser(successData.userId);
    setOpen(false);
    reset();
  }

  async function handleSubmit(values: CreateUserInput): Promise<void> {
    setIsSubmitting(true);
    setEmailConflict(false);

    try {
      const result = await createUserAction(values);

      if (result.ok) {
        if (result.tempPassword) {
          setSuccessData({
            userId: result.userId,
            tempPassword: result.tempPassword,
          });
          setDialogState("success");
        } else {
          setOpen(false);
          reset();
          goToNewUser(result.userId);
          toast.success("User created");
        }
      } else if (result.code === "EMAIL_CONFLICT") {
        setEmailConflict(true);
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        {dialogState === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add User</DialogTitle>
            </DialogHeader>
            <UserForm
              mode="create"
              roles={roles}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
              emailConflict={emailConflict}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="create-user-form"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="animate-spin" />}
                Create User
              </Button>
            </DialogFooter>
          </>
        ) : (
          successData && (
            <TempPasswordDisplay
              tempPassword={successData.tempPassword}
              onDone={handleDone}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
