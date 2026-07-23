"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createSpecificationAction } from "@/actions/product/create-specification.action";
import { deleteSpecificationAction } from "@/actions/product/delete-specification.action";
import { updateSpecificationAction } from "@/actions/product/update-specification.action";
import { SpecificationForm } from "@/components/products/manage/specification-form";
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
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";
import type { SpecificationCard } from "@/types/product";

export interface SpecificationsDialogProps {
  offeringId: string;
  offeringName: string;
  offeringStatus: "DRAFT" | "ACTIVE";
  familyId: string;
  specifications: SpecificationCard[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onBranch: (familyId: string) => void;
}

type View =
  | { name: "list" }
  | { name: "form"; editingSpec: SpecificationCard | null };

export function SpecificationsDialog({
  offeringId,
  offeringName,
  offeringStatus,
  familyId,
  specifications,
  isOpen,
  onOpenChange,
  onBranch,
}: SpecificationsDialogProps): React.JSX.Element {
  const router = useRouter();
  const [view, setView] = useState<View>({ name: "list" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingSpec, setDeletingSpec] = useState<SpecificationCard | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // pm21-spec §2.5. `open` transitions reset to the list view so a
  // re-opened dialog never resumes mid-edit against stale defaultValues.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setView({ name: "list" });
  }

  function handleDialogOpenChange(open: boolean): void {
    if (isSubmitting) return;
    onOpenChange(open);
  }

  async function handleFormSubmit(
    values: CreateSpecificationInput,
  ): Promise<void> {
    const editingSpec = view.name === "form" ? view.editingSpec : null;
    setIsSubmitting(true);
    try {
      const result = editingSpec
        ? await updateSpecificationAction(
            editingSpec.productSpecId,
            offeringId,
            values,
          )
        : await createSpecificationAction(offeringId, values);

      if (result.ok) {
        if (result.branched) {
          onOpenChange(false);
          toast.success("New draft version created");
          onBranch(familyId);
          router.refresh();
        } else {
          toast.success(
            editingSpec ? "Specification updated" : "Specification added",
          );
          setView({ name: "list" });
          router.refresh();
        }
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error(
          "This offering has been retired and can no longer be edited.",
        );
      } else if (
        result.code === "OFFERING_NOT_FOUND" ||
        result.code === "SPECIFICATION_NOT_FOUND"
      ) {
        toast.error("This item no longer exists. Refreshing...");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (!deletingSpec) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      // Delete is only ever offered on a DRAFT row (Design §2.8), so
      // result.branched is always false on any reachable call here — the
      // check below is still handled, not assumed, matching pm14's own
      // "guard it anyway" defensive stance for unreachable-by-construction
      // cases.
      const result = await deleteSpecificationAction(
        deletingSpec.productSpecId,
        offeringId,
      );
      if (result.ok) {
        setDeletingSpec(null);
        if (result.branched) {
          onOpenChange(false);
          toast.success("New draft version created");
          onBranch(familyId);
        } else {
          toast.success("Specification deleted");
        }
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        setDeleteError("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        setDeleteError(
          "This offering has been retired and can no longer be edited.",
        );
      } else if (
        result.code === "OFFERING_NOT_FOUND" ||
        result.code === "SPECIFICATION_NOT_FOUND"
      ) {
        setDeletingSpec(null);
        onOpenChange(false);
        toast.error("This item no longer exists. Refreshing...");
        router.refresh();
      } else {
        setDeleteError("Something went wrong. Please try again.");
      }
    } catch {
      setDeleteError("Something went wrong. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent>
          {view.name === "list" ? (
            <>
              <DialogHeader>
                <DialogTitle>Specifications — {offeringName}</DialogTitle>
              </DialogHeader>

              {offeringStatus === "ACTIVE" && (
                <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
                  {offeringName} is active. Adding or editing a specification
                  here creates a new draft version instead.
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setView({ name: "form", editingSpec: null })}
                >
                  <Plus size={14} aria-hidden />
                  Add specification
                </Button>
              </div>

              {specifications.length === 0 ? (
                <p className="py-4 text-center text-body-sm text-muted-foreground">
                  No specifications yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {specifications.map((spec) => (
                    <li
                      key={spec.productSpecId}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <div>
                        <p className="text-body-sm font-medium text-foreground">
                          {spec.name}
                        </p>
                        <p className="text-body-sm text-muted-foreground">
                          {spec.isMandatory ? "Mandatory" : "Optional"} ·{" "}
                          {spec.isDefault ? "Default" : "Not default"} ·{" "}
                          {Object.keys(spec.characteristics).length}{" "}
                          characteristic
                          {Object.keys(spec.characteristics).length === 1
                            ? ""
                            : "s"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${spec.name}`}
                          onClick={() =>
                            setView({ name: "form", editingSpec: spec })
                          }
                        >
                          <Pencil size={16} aria-hidden />
                        </Button>
                        {offeringStatus === "DRAFT" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${spec.name}`}
                            onClick={() => {
                              setDeleteError(null);
                              setDeletingSpec(spec);
                            }}
                          >
                            <Trash2
                              size={16}
                              className="text-[color:var(--text-danger)]"
                              aria-hidden
                            />
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {view.editingSpec
                    ? "Edit specification"
                    : "Add specification"}
                </DialogTitle>
              </DialogHeader>

              {view.editingSpec ? (
                <SpecificationForm
                  mode="edit"
                  formId="specification-form"
                  defaultValues={{
                    name: view.editingSpec.name,
                    isMandatory: view.editingSpec.isMandatory,
                    isDefault: view.editingSpec.isDefault,
                    defaultValue: view.editingSpec.defaultValue,
                    characteristics: view.editingSpec.characteristics,
                  }}
                  onSubmit={handleFormSubmit}
                  isSubmitting={isSubmitting}
                />
              ) : (
                <SpecificationForm
                  mode="create"
                  formId="specification-form"
                  onSubmit={handleFormSubmit}
                  isSubmitting={isSubmitting}
                />
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={() => setView({ name: "list" })}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  form="specification-form"
                  disabled={isSubmitting}
                >
                  {isSubmitting && <Loader2 className="animate-spin" />}
                  {view.editingSpec ? "Save changes" : "Add specification"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* pm21-spec §2.4. Nested AlertDialog, layered on top of the open
          Dialog above — reuses components/roles/delete-role-dialog.tsx's
          exact shape, the one real shipped hard-delete precedent in this
          codebase. Only ever rendered while offeringStatus === "DRAFT"
          (Design §2.8), since that's the only state deletingSpec can be set
          from. */}
      <AlertDialog
        open={!!deletingSpec}
        onOpenChange={
          isDeleting ? () => {} : (open) => !open && setDeletingSpec(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete specification</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the specification{" "}
              <strong>{deletingSpec?.name}</strong>. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
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
              {isDeleting && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Delete specification
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
