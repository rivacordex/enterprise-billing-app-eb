"use client";

import { startTransition, useOptimistic, useState } from "react";
import { cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { setPermissionMappingAction } from "@/actions/roles/set-permission-level.action";
import { cn } from "@/lib/utils";
import { PERMISSION_NAMES } from "@/types/rbac";
import type { PermissionName, PermissionType } from "@/types/rbac";
import { PERMISSION_DISPLAY_NAMES } from "@/types/roles";
import type { RoleWithMappings } from "@/types/roles";

export interface PermissionMatrixEditorProps {
  role: RoleWithMappings;
  className?: string;
}

const LEVELS_WITH_NULL = [null, "READ", "EDIT", "DELETE"] as const;

// Token colors per level (ui-context §3.6 / um20-spec §"Level button group")
// — CSS variable references only, no raw hex. `locked` (the `audit_log`
// EDIT/DELETE guard) takes precedence over the selected/unselected look.
const levelButtonVariants = cva(
  "inline-flex items-center gap-1 rounded-xs px-2 py-1 text-overline font-semibold tracking-wider uppercase outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed",
  {
    variants: {
      level: {
        none: "",
        READ: "",
        EDIT: "",
        DELETE: "",
      } satisfies Record<"none" | PermissionType, string>,
      selected: { true: "", false: "" },
      locked: { true: "", false: "" },
    },
    compoundVariants: [
      {
        locked: true,
        class:
          "border border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] text-[color:var(--text-disabled)]",
      },
      {
        locked: false,
        selected: false,
        class:
          "border border-[color:var(--border-subtle)] bg-transparent text-[color:var(--text-muted)]",
      },
      {
        locked: false,
        selected: true,
        level: "none",
        class:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      },
      {
        locked: false,
        selected: true,
        level: "READ",
        class:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
      },
      {
        locked: false,
        selected: true,
        level: "EDIT",
        class:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
      },
      {
        locked: false,
        selected: true,
        level: "DELETE",
        class:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
      },
    ],
  },
);

function LevelButtonGroup({
  permissionName,
  currentLevel,
  isSaving,
  onChange,
}: {
  permissionName: PermissionName;
  currentLevel: PermissionType | null;
  isSaving: boolean;
  onChange: (
    permissionName: PermissionName,
    newLevel: PermissionType | null,
  ) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Permission level for ${PERMISSION_DISPLAY_NAMES[permissionName]}`}
      className="inline-flex gap-1"
    >
      {LEVELS_WITH_NULL.map((level) => {
        const isSelected = currentLevel === level;
        const isAuditLock =
          permissionName === "audit_log" &&
          (level === "EDIT" || level === "DELETE");
        const isDisabled = isSaving || isAuditLock;

        return (
          <button
            key={level ?? "none"}
            type="button"
            disabled={isDisabled}
            aria-pressed={isSelected}
            title={
              isAuditLock ? "Audit log permissions are read-only" : undefined
            }
            onClick={() => {
              if (!isDisabled) onChange(permissionName, level);
            }}
            className={levelButtonVariants({
              level: level ?? "none",
              selected: isSelected,
              locked: isAuditLock,
            })}
          >
            {isSaving && isSelected && (
              <Loader2 size={12} className="animate-spin" />
            )}
            {level === null ? "—" : level}
          </button>
        );
      })}
    </div>
  );
}

// um20-spec §20.5. Each level change saves immediately — there is nothing to
// "cancel," so this renders unconditionally inside `RoleDetail` whenever the
// actor has `roles:EDIT`, independent of the name/description edit toggle.
export function PermissionMatrixEditor({
  role,
  className,
}: PermissionMatrixEditorProps): React.JSX.Element {
  const [savingPermission, setSavingPermission] =
    useState<PermissionName | null>(null);

  const [optimisticMappings, updateOptimisticMappings] = useOptimistic(
    role.mappings,
    (
      state,
      update: { permissionName: PermissionName; level: PermissionType | null },
    ) =>
      state.map((m) =>
        m.permissionName === update.permissionName
          ? { ...m, assignedLevel: update.level }
          : m,
      ),
  );

  async function handleLevelChange(
    permissionName: PermissionName,
    newLevel: PermissionType | null,
  ): Promise<void> {
    if (savingPermission === permissionName) return;

    const current = optimisticMappings.find(
      (m) => m.permissionName === permissionName,
    );
    if (current?.assignedLevel === newLevel) return;

    startTransition(() => {
      updateOptimisticMappings({ permissionName, level: newLevel });
    });
    setSavingPermission(permissionName);

    try {
      const result = await setPermissionMappingAction({
        roleId: role.roleId,
        permissionName,
        level: newLevel,
      });

      if (!result.ok) {
        toast.error("Failed to update permission. Please try again.");
      }
    } catch {
      toast.error("Failed to update permission. Please try again.");
    } finally {
      setSavingPermission(null);
    }
  }

  return (
    <table className={className}>
      <thead>
        <tr>
          <th className="py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Permission
          </th>
          <th className="py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Level
          </th>
        </tr>
      </thead>
      <tbody>
        {PERMISSION_NAMES.map((name) => {
          const mapping = optimisticMappings.find(
            (m) => m.permissionName === name,
          );
          const currentLevel = mapping?.assignedLevel ?? null;
          const isSaving = savingPermission === name;

          return (
            <tr key={name} className={cn("border-t border-border")}>
              <td className="py-2 text-body text-foreground">
                {PERMISSION_DISPLAY_NAMES[name]}
              </td>
              <td className="py-2">
                <LevelButtonGroup
                  permissionName={name}
                  currentLevel={currentLevel}
                  isSaving={isSaving}
                  onChange={handleLevelChange}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
