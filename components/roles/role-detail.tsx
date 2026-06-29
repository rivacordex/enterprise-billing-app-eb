"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { updateRoleAction } from "@/actions/roles/update-role.action";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { DeleteRoleDialog } from "@/components/roles/delete-role-dialog";
import { PermissionLevelTag } from "@/components/roles/permission-level-tag";
import { PermissionMatrixEditor } from "@/components/roles/permission-matrix-editor";
import { RoleForm } from "@/components/roles/role-form";
import { RoleBadge } from "@/components/role-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDatetime } from "@/lib/formatters";
import { hasLevel, type EffectivePermissionMap } from "@/types/permissions";
import { isSeededRole, PERMISSION_NAMES } from "@/types/rbac";
import { PERMISSION_DISPLAY_NAMES, type RoleWithMappings } from "@/types/roles";
import type { EditRoleFields } from "@/validation/update-role.schema";

interface RoleDetailProps {
  role: RoleWithMappings | null;
  selectedRoleId: string | null;
  permissionMap: EffectivePermissionMap;
  // Resolved server-side from the `app/locale` config row and threaded in as
  // a prop (um28-spec §2.9) — this client component can't read config itself.
  locale: string;
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

export function RoleDetail({
  role,
  selectedRoleId,
  permissionMap,
  locale,
}: RoleDetailProps): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<"ROLE_NOT_FOUND" | null>(null);
  const [nameConflict, setNameConflict] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  if (role === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md bg-card text-center shadow-md">
        <p className="text-muted-foreground">
          {selectedRoleId !== null
            ? "Role not found."
            : "Select a role to view details."}
        </p>
        {selectedRoleId !== null && (
          <Link
            href="/administration/roles"
            className="text-body-sm text-primary underline"
          >
            Back to roles
          </Link>
        )}
      </div>
    );
  }

  const canEdit = hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT);
  const showEdit = canEdit && mode === "view";
  const canDelete = hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.DELETE);
  const showDelete = canDelete && mode === "view";
  const isSeeded = isSeededRole(role.roleName);

  function handleDeleteSuccess(): void {
    router.push("/administration/roles");
    toast.success("Role deleted.");
  }

  async function handleEditSubmit(values: EditRoleFields): Promise<void> {
    setIsSaving(true);
    setNameConflict(false);
    setLocalError(null);
    try {
      const result = await updateRoleAction({
        roleId: role!.roleId,
        ...values,
      });
      if (result.ok) {
        setMode("view");
        // `revalidatePath` in the action causes the page to re-render with
        // updated props once the server response lands.
      } else if (result.code === "NAME_CONFLICT") {
        setNameConflict(true);
      } else if (result.code === "ROLE_NOT_FOUND") {
        setLocalError("ROLE_NOT_FOUND");
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
    <div className="h-full rounded-md bg-card shadow-md">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          {mode === "edit" ? (
            <h3 className="text-h3 font-semibold text-foreground">Edit Role</h3>
          ) : (
            <div>
              <h3 className="text-h3 font-semibold text-foreground">
                {role.roleName}
              </h3>
              <div className="mt-1">
                <RoleBadge roleName={role.roleName} />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            {showEdit && (
              <button
                type="button"
                onClick={() => {
                  setLocalError(null);
                  setNameConflict(false);
                  setMode("edit");
                }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
              >
                <Pencil size={14} />
                Edit
              </button>
            )}
            {showDelete && (
              <button
                type="button"
                onClick={() => setIsDeleteDialogOpen(true)}
                disabled={isSeeded}
                aria-disabled={isSeeded}
                title={
                  isSeeded
                    ? "Seeded roles (ADMIN, MANAGER, USER) cannot be deleted"
                    : undefined
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[color:var(--color-danger-500)] bg-transparent px-2 py-1 text-sm whitespace-nowrap text-[color:var(--color-danger-700)] outline-none hover:bg-[color:var(--color-danger-50)] focus-visible:[box-shadow:var(--focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
            {mode === "view" && (
              <button
                type="button"
                aria-label="Close"
                onClick={() => router.push("/administration/roles")}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-[color:var(--action-ghost-hover)] hover:text-foreground"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {mode === "edit" && localError === "ROLE_NOT_FOUND" && (
        <div className="px-4 pt-3">
          <Alert variant="destructive">
            <AlertDescription>
              Role not found. It may have been deleted by another admin.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <dl className="flex flex-col gap-6 p-4">
        <div className="flex flex-col gap-3">
          {mode === "edit" ? (
            <RoleForm
              mode="edit"
              defaultValues={{
                roleName: role.roleName,
                roleDescr: role.roleDescr ?? null,
              }}
              onSubmit={handleEditSubmit}
              isSubmitting={isSaving}
              externalFieldErrors={
                nameConflict
                  ? { roleName: "A role with this name already exists." }
                  : undefined
              }
            />
          ) : (
            <>
              <Field label="Name">{role.roleName}</Field>
              <Field label="Description">{role.roleDescr ?? "—"}</Field>
              <Field label="Created">
                <span className="font-mono text-mono">
                  {formatDatetime(role.createdDatetime, locale)}
                </span>
              </Field>
              <Field label="Last Modified">
                <span className="font-mono text-mono">
                  {formatDatetime(role.lastModifiedDatetime, locale)}
                </span>
              </Field>
            </>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Permissions
          </dt>
          {canEdit ? (
            <PermissionMatrixEditor role={role} />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                    Permission
                  </th>
                  <th className="py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                    Assigned Level
                  </th>
                </tr>
              </thead>
              <tbody>
                {PERMISSION_NAMES.map((name) => {
                  const mapping = role.mappings.find(
                    (m) => m.permissionName === name,
                  );

                  return (
                    <tr key={name} className="border-t border-border">
                      <td className="py-2 text-body text-foreground">
                        {PERMISSION_DISPLAY_NAMES[name]}
                      </td>
                      <td className="py-2">
                        {mapping?.assignedLevel ? (
                          <PermissionLevelTag level={mapping.assignedLevel} />
                        ) : (
                          <span className="text-body text-muted-foreground">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
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
          <Button type="submit" form="role-form-edit" disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" size={14} />}
            Save changes
          </Button>
        </div>
      )}

      <DeleteRoleDialog
        roleId={role.roleId}
        roleName={role.roleName}
        isOpen={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        onSuccess={handleDeleteSuccess}
      />
    </div>
  );
}
