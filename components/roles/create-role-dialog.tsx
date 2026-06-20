"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createRoleAction } from "@/actions/roles/create-role.action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RoleForm } from "@/components/roles/role-form";
import type { CreateRoleInput } from "@/validation/create-role.schema";

export interface CreateRoleDialogProps {
  trigger: React.ReactNode;
}

export function CreateRoleDialog({
  trigger,
}: CreateRoleDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nameConflict, setNameConflict] = useState(false);

  function reset(): void {
    setIsSubmitting(false);
    setNameConflict(false);
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
    if (!nextOpen) reset();
  }

  async function handleSubmit(values: CreateRoleInput): Promise<void> {
    setIsSubmitting(true);
    setNameConflict(false);

    try {
      const result = await createRoleAction(values);

      if (result.ok) {
        setOpen(false);
        reset();
        router.push(`/administration/roles?roleId=${result.roleId}`);
        toast.success("Role created");
      } else if (result.code === "NAME_CONFLICT") {
        setNameConflict(true);
      } else {
        toast.error("Something went wrong. Please try again.");
        setOpen(false);
        reset();
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
      setOpen(false);
      reset();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Role</DialogTitle>
        </DialogHeader>

        <RoleForm
          mode="create"
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          externalFieldErrors={
            nameConflict
              ? { roleName: "A role with this name already exists." }
              : undefined
          }
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
          <Button type="submit" form="role-form" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            Create Role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
