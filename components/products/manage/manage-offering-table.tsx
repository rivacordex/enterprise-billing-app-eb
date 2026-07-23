"use client";

import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ListChecks,
  PackageSearch,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { updateOfferingAction } from "@/actions/product/update-offering.action";
import { AddPriceDialog } from "@/components/products/manage/add-price-dialog";
import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { CreateOfferingDialog } from "@/components/products/manage/create-offering-dialog";
import { OfferingForm } from "@/components/products/manage/offering-form";
import { SpecificationsDialog } from "@/components/products/manage/specifications-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  OfferingFamilyRow,
  OfferingListRow,
  SpecificationCard,
} from "@/types/product";
import type { UpdateOfferingInput } from "@/validation/product/update-offering.schema";

interface ManageOfferingTableProps {
  families: OfferingFamilyRow[];
  locale: string;
  timezone: string;
  specificationsByOfferingId: Record<string, SpecificationCard[]>;
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-sm border-[0.5px] border-[color:var(--border)] outline-none focus-visible:[box-shadow:var(--focus-ring)]";

// Every button in this matrix renders now, real icon + real aria-label, and
// does nothing when clicked — the seam pm19–pm23 fill in one at a time
// (pm18-spec §2.6). None are `disabled`.
function RowActions({
  row,
  onEdit,
  onManageSpecs,
  onBranchPrice,
}: {
  row: OfferingListRow;
  onEdit: () => void;
  onManageSpecs: () => void;
  onBranchPrice: () => void;
}): React.JSX.Element {
  if (row.lifecycleStatus === "RETIRED") {
    return (
      <span className="text-caption text-[color:var(--text-muted)]">
        No actions — retired
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Edit ${row.name}`}
        className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
        onClick={onEdit}
      >
        <Pencil size={14} aria-hidden />
      </button>
      <AddPriceDialog
        offeringId={row.productOfferingId}
        offeringName={row.name}
        currentStatus={row.lifecycleStatus as "DRAFT" | "ACTIVE"}
        onBranched={onBranchPrice}
        trigger={
          <button
            type="button"
            aria-label={`Add price to ${row.name}`}
            className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
          >
            <CircleDollarSign size={14} aria-hidden />
          </button>
        }
      />
      {row.lifecycleStatus === "DRAFT" ? (
        <>
          <button
            type="button"
            aria-label={`Activate ${row.name}`}
            className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
            // pm23 seam: onClick activates the offering
          >
            <Check size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Discard ${row.name}`}
            className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
            // pm23 seam: onClick discards the draft
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={`Retire ${row.name}`}
          className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
          // pm23 seam: onClick retires the offering
        >
          <Archive size={14} aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-label={`Manage specifications for ${row.name}`}
        className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
        onClick={onManageSpecs}
      >
        <ListChecks size={14} aria-hidden />
      </button>
    </div>
  );
}

function FamilyRows({
  family,
  expanded,
  onToggle,
  onEditRow,
  onManageSpecsRow,
  onBranchPrice,
}: {
  family: OfferingFamilyRow;
  expanded: boolean;
  onToggle: () => void;
  onEditRow: (row: OfferingListRow, familyId: string) => void;
  onManageSpecsRow: (row: OfferingListRow, familyId: string) => void;
  onBranchPrice: (familyId: string) => void;
}): React.JSX.Element {
  const { primary } = family;
  const hasVersions = family.versions.length > 1;
  const isRetired = primary.lifecycleStatus === "RETIRED";

  return (
    <>
      <tr
        className={cn(
          "border-b border-[color:var(--border-subtle)] last:border-0",
          isRetired && "text-[color:var(--text-muted)]",
        )}
      >
        <td className="w-10 px-2 py-2">
          {hasVersions && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? `Hide other versions of ${primary.name}`
                  : `Show other versions of ${primary.name}`
              }
              className="flex size-6 items-center justify-center text-[color:var(--text-muted)]"
            >
              {expanded ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronRight size={16} aria-hidden />
              )}
            </button>
          )}
        </td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {primary.productOfferingId}
        </td>
        <td className="px-4 py-2 text-foreground">{primary.name}</td>
        <td className="px-4 py-2">
          <LifecycleBadge status={primary.lifecycleStatus} />
        </td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {primary.version}
        </td>
        <td className="px-4 py-2">
          <RowActions
            row={primary}
            onEdit={() => onEditRow(primary, family.familyId)}
            onManageSpecs={() => onManageSpecsRow(primary, family.familyId)}
            onBranchPrice={() => onBranchPrice(family.familyId)}
          />
        </td>
      </tr>
      {expanded &&
        family.versions.map((version) => {
          const versionRetired = version.lifecycleStatus === "RETIRED";
          return (
            <tr
              key={version.productOfferingId}
              className={cn(
                "border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] last:border-0",
                versionRetired && "text-[color:var(--text-muted)]",
              )}
            >
              <td className="w-10 px-2 py-2" />
              <td className="px-4 py-2 pl-8 font-mono text-mono tabular-nums">
                {version.productOfferingId}
              </td>
              <td className="px-4 py-2 text-foreground">{version.name}</td>
              <td className="px-4 py-2">
                <LifecycleBadge status={version.lifecycleStatus} />
              </td>
              <td className="px-4 py-2 font-mono text-mono tabular-nums">
                {version.version}
              </td>
              <td className="px-4 py-2">
                <RowActions
                  row={version}
                  onEdit={() => onEditRow(version, family.familyId)}
                  onManageSpecs={() =>
                    onManageSpecsRow(version, family.familyId)
                  }
                  onBranchPrice={() => onBranchPrice(family.familyId)}
                />
              </td>
            </tr>
          );
        })}
    </>
  );
}

// `locale`/`timezone` are accepted for forward-compat with a future
// "last modified" column (pm18-spec §3.7 note 6) — this unit's column set
// doesn't render one yet, so they're threaded through the prop signature
// but not consumed by this component's markup.
export function ManageOfferingTable({
  families,
  specificationsByOfferingId,
}: ManageOfferingTableProps): React.JSX.Element {
  const router = useRouter();
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(
    new Set(),
  );
  const [editingRow, setEditingRow] = useState<{
    row: OfferingListRow;
    familyId: string;
  } | null>(null);
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);
  const [specsRow, setSpecsRow] = useState<{
    row: OfferingListRow;
    familyId: string;
  } | null>(null);

  function toggleFamily(familyId: string): void {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(familyId)) {
        next.delete(familyId);
      } else {
        next.add(familyId);
      }
      return next;
    });
  }

  function handleEditOpenChange(open: boolean): void {
    if (isEditSubmitting) return;
    if (!open) setEditingRow(null);
  }

  async function handleEditSubmit(values: UpdateOfferingInput): Promise<void> {
    if (!editingRow) return;
    setIsEditSubmitting(true);
    try {
      const result = await updateOfferingAction(
        editingRow.row.productOfferingId,
        values,
      );
      if (result.ok) {
        const branched = result.branched;
        const familyId = editingRow.familyId;
        setEditingRow(null);
        if (branched) {
          toast.success("New draft version created");
          // Design §2.9 — make the new sibling visible without an extra click.
          setExpandedFamilies((prev) => new Set(prev).add(familyId));
        } else {
          toast.success("Offering updated");
        }
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error(
          "This offering has been retired and can no longer be edited.",
        );
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setEditingRow(null);
        router.refresh();
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsEditSubmitting(false);
    }
  }

  return (
    <div className="rounded-md bg-card shadow-sm">
      <div className="flex items-center justify-end border-b border-border p-4">
        <CreateOfferingDialog
          trigger={
            <button
              type="button"
              aria-label="New offering"
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
            >
              <Plus size={16} aria-hidden />
              New offering
            </button>
          }
        />
      </div>

      {families.length === 0 ? (
        <div className="flex flex-col items-center gap-3 bg-[color:var(--surface-sunken)] py-16 text-center">
          <PackageSearch className="size-12 text-[color:var(--text-muted)]" />
          <p className="text-body text-muted-foreground">
            No offerings yet — create one to get started
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                <th className="w-10 px-2 py-3" aria-hidden />
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Version
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {families.map((family) => (
                <FamilyRows
                  key={family.familyId}
                  family={family}
                  expanded={expandedFamilies.has(family.familyId)}
                  onToggle={() => toggleFamily(family.familyId)}
                  onEditRow={(row, familyId) =>
                    setEditingRow({ row, familyId })
                  }
                  onManageSpecsRow={(row, familyId) =>
                    setSpecsRow({ row, familyId })
                  }
                  onBranchPrice={(familyId) =>
                    setExpandedFamilies((prev) => new Set(prev).add(familyId))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingRow && (
        <Dialog open onOpenChange={handleEditOpenChange}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingRow.row.lifecycleStatus === "ACTIVE"
                  ? "Edit — creates new draft"
                  : "Edit draft"}
              </DialogTitle>
            </DialogHeader>

            <OfferingForm
              mode="edit"
              offeringName={editingRow.row.name}
              currentStatus={
                editingRow.row.lifecycleStatus as "DRAFT" | "ACTIVE"
              }
              defaultValues={{
                name: editingRow.row.name,
                isSellable: editingRow.row.isSellable,
                billingOnly: editingRow.row.billingOnly,
              }}
              onSubmit={handleEditSubmit}
              onCancel={() => handleEditOpenChange(false)}
              isSubmitting={isEditSubmitting}
            />
          </DialogContent>
        </Dialog>
      )}

      {specsRow && (
        <SpecificationsDialog
          offeringId={specsRow.row.productOfferingId}
          offeringName={specsRow.row.name}
          offeringStatus={specsRow.row.lifecycleStatus as "DRAFT" | "ACTIVE"}
          familyId={specsRow.familyId}
          specifications={
            specificationsByOfferingId[specsRow.row.productOfferingId] ?? []
          }
          isOpen
          onOpenChange={(open) => {
            if (!open) setSpecsRow(null);
          }}
          onBranch={(familyId) =>
            setExpandedFamilies((prev) => new Set(prev).add(familyId))
          }
        />
      )}
    </div>
  );
}
