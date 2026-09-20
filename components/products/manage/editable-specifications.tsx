"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createSpecificationAction } from "@/actions/product/create-specification.action";
import { deleteSpecificationAction } from "@/actions/product/delete-specification.action";
import { updateSpecificationAction } from "@/actions/product/update-specification.action";
import { InlineRowEditor } from "@/components/products/manage/inline-row-editor";
import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
import { SpecificationForm } from "@/components/products/manage/specification-form";
import { Button } from "@/components/ui/button";
import type { LifecycleStatus, SpecificationCard } from "@/types/product";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";

// pm41 I1. The DRAFT-only client editor rendered by ManageSpecificationsPanel;
// the panel stays a server component and hands this leaf the version's specs.
// One row is editable at a time (D2): activating a second row (or a delete)
// while the open one is dirty prompts to discard first. Save/Cancel are
// explicit — no auto-save on blur, no optimistic row mutation; the server
// action's typed result is what updates the view (I3).
//
// Mid-edit races (someone advanced the version out of DRAFT while an editor was
// open): a RETIRED race returns OFFERING_RETIRED → the reload banner; an ACTIVE
// race makes the write branch a new draft → we navigate the user to it (D4 /
// overview flow step 5), preserving their edit rather than stranding it. The
// DRAFT→TESTING/OBSOLETE races are not reachable until pm42 adds those
// transitions; when they land, the spec write services should return a typed
// OFFERING_NOT_DRAFT (as the price services already do) so the reload banner
// fires — until then such a write is refused by the §3.5 trigger and surfaces
// as a generic SERVER_ERROR here.
const STALE_MESSAGE =
  "This version is no longer a draft — reload to see its current state.";
const FORBIDDEN_MESSAGE = "You no longer have permission to edit products.";
const KEPT_INPUT_MESSAGE =
  "Something went wrong. Your changes were kept — try saving again.";

// Coarse-pointer 44px hit area for the icon buttons (32px) and Add control
// (28px) on touch surfaces (ui-context §7).
const TOUCH_ICON = "[@media(pointer:coarse)]:size-11";
const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-[44px]";

type ActiveEditor =
  | { kind: "none" }
  | { kind: "edit"; id: string }
  | { kind: "add" };

// A transition awaiting a discard confirmation because the open editor is dirty:
// either activating another editor, or opening a delete confirm.
type PendingAction =
  | { kind: "activate"; target: ActiveEditor }
  | { kind: "delete"; id: string };

export interface EditableSpecificationsProps {
  offeringId: string;
  specifications: SpecificationCard[];
  // For navigate-on-branch when a mid-edit ACTIVE race branches a new draft (D4).
  familyId: string | null;
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

export function EditableSpecifications({
  offeringId,
  specifications,
  familyId,
  query,
  status,
  page,
}: EditableSpecificationsProps): React.JSX.Element {
  const router = useRouter();

  const [active, setActive] = useState<ActiveEditor>({ kind: "none" });
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<
    string,
    string[]
  > | null>(null);
  const [staleBanner, setStaleBanner] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    id: string;
    busy: boolean;
    error: string | null;
  } | null>(null);

  const editTriggers = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusRef = useRef<string | "add" | null>(null);

  // Focus return (D2): after an editor closes or a delete confirm resolves, put
  // focus back on a stable control (the row's Edit trigger, or the Add control
  // when the row is gone). A ref, not state, so this is a ref read — never a
  // setState in an effect. Keyed on both active and deleting since either can be
  // the interaction that just closed.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    const el =
      target === "add"
        ? addButtonRef.current
        : (editTriggers.current.get(target) ?? addButtonRef.current);
    el?.focus();
  }, [active, deleting]);

  function requestActivate(next: ActiveEditor): void {
    if (active.kind !== "none" && dirty) {
      setPending({ kind: "activate", target: next });
      return;
    }
    applyActivate(next);
  }

  function requestDelete(id: string): void {
    if (active.kind !== "none" && dirty) {
      setPending({ kind: "delete", id });
      return;
    }
    openDelete(id);
  }

  function applyActivate(next: ActiveEditor): void {
    setFormError(null);
    setServerFieldErrors(null);
    setDirty(false);
    setDeleting(null);
    setActive(next);
  }

  function openDelete(id: string): void {
    setActive({ kind: "none" });
    setDirty(false);
    setFormError(null);
    setServerFieldErrors(null);
    setDeleting({ id, busy: false, error: null });
  }

  function cancelDelete(id: string): void {
    setDeleting(null);
    pendingFocusRef.current = id;
  }

  function confirmDiscard(): void {
    if (!pending) return;
    if (pending.kind === "activate") {
      applyActivate(pending.target);
    } else {
      openDelete(pending.id);
    }
    setPending(null);
  }

  function closeEditor(): void {
    const focusTarget =
      active.kind === "edit" ? active.id : active.kind === "add" ? "add" : null;
    setActive({ kind: "none" });
    setDirty(false);
    setFormError(null);
    setServerFieldErrors(null);
    setPending(null);
    setDeleting(null);
    pendingFocusRef.current = focusTarget;
  }

  function navigateToBranchedDraft(newVersionId: string): void {
    if (familyId === null) {
      router.refresh();
      return;
    }
    router.push(
      buildManageProductsHref({
        q: query,
        status,
        page,
        family: familyId,
        version: newVersionId,
      }),
    );
  }

  async function handleSave(
    values: CreateSpecificationInput,
    editingId: string | null,
  ): Promise<void> {
    setIsSubmitting(true);
    setFormError(null);
    setServerFieldErrors(null);
    try {
      const result = editingId
        ? await updateSpecificationAction(editingId, offeringId, values)
        : await createSpecificationAction(offeringId, values);

      if (result.ok) {
        if (result.branched) {
          // A mid-edit ACTIVE race branched the edit into a new draft — take the
          // user there rather than leaving it silently stranded (D4).
          toast.success("New draft version created");
          navigateToBranchedDraft(result.offeringId);
          return;
        }
        toast.success(
          editingId ? "Specification updated" : "Specification added",
        );
        closeEditor();
        router.refresh();
        return;
      }

      switch (result.code) {
        case "VALIDATION_ERROR":
          setServerFieldErrors(result.fieldErrors);
          break;
        case "FORBIDDEN":
          setFormError(FORBIDDEN_MESSAGE);
          break;
        case "OFFERING_RETIRED":
          setStaleBanner(STALE_MESSAGE);
          closeEditor();
          router.refresh();
          break;
        case "OFFERING_NOT_FOUND":
        case "SPECIFICATION_NOT_FOUND":
          // The row (or offering) is gone — drop out of edit mode and refresh;
          // the row simply disappears from the re-rendered panel (I3).
          closeEditor();
          router.refresh();
          break;
        default:
          setFormError(KEPT_INPUT_MESSAGE);
      }
    } catch {
      setFormError(KEPT_INPUT_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteConfirm(id: string): Promise<void> {
    setDeleting({ id, busy: true, error: null });
    try {
      const result = await deleteSpecificationAction(id, offeringId);
      if (result.ok) {
        if (result.branched) {
          toast.success("New draft version created");
          setDeleting(null);
          navigateToBranchedDraft(result.offeringId);
          return;
        }
        toast.success("Specification deleted");
        setDeleting(null);
        pendingFocusRef.current = "add";
        router.refresh();
        return;
      }
      if (result.code === "FORBIDDEN") {
        setDeleting({ id, busy: false, error: FORBIDDEN_MESSAGE });
      } else if (
        result.code === "OFFERING_NOT_FOUND" ||
        result.code === "SPECIFICATION_NOT_FOUND"
      ) {
        setDeleting(null);
        pendingFocusRef.current = "add";
        router.refresh();
      } else if (result.code === "OFFERING_RETIRED") {
        setDeleting(null);
        setStaleBanner(STALE_MESSAGE);
        pendingFocusRef.current = "add";
        router.refresh();
      } else {
        setDeleting({ id, busy: false, error: KEPT_INPUT_MESSAGE });
      }
    } catch {
      setDeleting({ id, busy: false, error: KEPT_INPUT_MESSAGE });
    }
  }

  const hasRows = specifications.length > 0;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {staleBanner ? (
        <div
          role="status"
          className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]"
        >
          {staleBanner}
        </div>
      ) : null}

      {pending !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          <span>Discard unsaved changes to this specification?</span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={TOUCH_TARGET}
              onClick={() => setPending(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH_TARGET}
              onClick={confirmDiscard}
            >
              Discard
            </Button>
          </span>
        </div>
      ) : null}

      {!hasRows && active.kind !== "add" ? (
        <p className="py-2 text-body-sm text-muted-foreground">
          No specifications yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {specifications.map((spec) => {
            if (active.kind === "edit" && active.id === spec.productSpecId) {
              const formId = `spec-edit-${spec.productSpecId}`;
              return (
                <li key={spec.productSpecId} className="py-2">
                  <InlineRowEditor
                    formId={formId}
                    isSubmitting={isSubmitting}
                    saveLabel="Save"
                    formError={formError}
                    onCancel={closeEditor}
                  >
                    <SpecificationForm
                      formId={formId}
                      defaultValues={{
                        name: spec.name,
                        isMandatory: spec.isMandatory,
                        isDefault: spec.isDefault,
                        defaultValue: spec.defaultValue,
                        characteristics: spec.characteristics,
                      }}
                      onSubmit={(values) =>
                        handleSave(values, spec.productSpecId)
                      }
                      isSubmitting={isSubmitting}
                      onDirtyChange={setDirty}
                      serverFieldErrors={serverFieldErrors}
                    />
                  </InlineRowEditor>
                </li>
              );
            }

            const isConfirming = deleting?.id === spec.productSpecId;
            const characteristicEntries = Object.entries(spec.characteristics);
            return (
              <li
                key={spec.productSpecId}
                className="flex items-start justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <p className="font-mono text-overline text-muted-foreground tabular-nums">
                    {spec.productSpecId}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2">
                    <span className="text-body-sm font-medium text-foreground">
                      {spec.name}
                    </span>
                    <span className="text-body-sm text-muted-foreground">
                      {spec.isMandatory ? "Mandatory" : "Optional"} ·{" "}
                      {spec.isDefault ? "Default" : "Not default"}
                    </span>
                  </div>
                  {spec.defaultValue !== null ? (
                    <p className="text-body-sm text-foreground">
                      <span className="text-muted-foreground">
                        Default value:{" "}
                      </span>
                      {spec.defaultValue}
                    </p>
                  ) : null}
                  {characteristicEntries.length > 0 ? (
                    <p className="text-body-sm text-foreground">
                      {characteristicEntries.map(([chKey, value], index) => (
                        <span key={chKey}>
                          {index > 0 ? ", " : null}
                          <span className="text-muted-foreground">{chKey}</span>
                          {": "}
                          <span className="font-mono tabular-nums">
                            {value}
                          </span>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {/* pm42 D6/I6. A mandatory spec with no resolved default value
                      (null OR blank/whitespace, pm44 review) blocks
                      submit-for-testing; the requirement renders here, at the
                      row that owns it, as a live muted hint — never as dialog
                      copy on the Submit confirmation. */}
                  {spec.isMandatory &&
                  (spec.defaultValue === null ||
                    spec.defaultValue.trim() === "") ? (
                    <p className="text-body-sm text-muted-foreground">
                      A default value is required before this version can be
                      submitted for testing.
                    </p>
                  ) : null}
                  {isConfirming ? (
                    <div className="mt-1.5 flex flex-col gap-1">
                      <span className="text-body-sm text-foreground">
                        Delete this specification?
                      </span>
                      {deleting?.error ? (
                        <span className="text-body-sm text-[color:var(--text-danger)]">
                          {deleting.error}
                        </span>
                      ) : null}
                      <span className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={TOUCH_TARGET}
                          disabled={deleting?.busy}
                          onClick={() => cancelDelete(spec.productSpecId)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className={TOUCH_TARGET}
                          disabled={deleting?.busy}
                          onClick={() =>
                            void handleDeleteConfirm(spec.productSpecId)
                          }
                        >
                          {deleting?.busy ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : null}
                          Delete
                        </Button>
                      </span>
                    </div>
                  ) : null}
                </div>
                {!isConfirming ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      ref={(el) => {
                        editTriggers.current.set(spec.productSpecId, el);
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={TOUCH_ICON}
                      aria-label={`Edit ${spec.name} (${spec.productSpecId})`}
                      onClick={() =>
                        requestActivate({
                          kind: "edit",
                          id: spec.productSpecId,
                        })
                      }
                    >
                      <Pencil size={16} aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={TOUCH_ICON}
                      aria-label={`Delete ${spec.name} (${spec.productSpecId})`}
                      onClick={() => requestDelete(spec.productSpecId)}
                    >
                      <Trash2
                        size={16}
                        className="text-[color:var(--text-danger)]"
                        aria-hidden
                      />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {active.kind === "add" ? (
        <div className="border-t border-border py-2">
          <InlineRowEditor
            formId="spec-add"
            isSubmitting={isSubmitting}
            saveLabel="Add specification"
            formError={formError}
            onCancel={closeEditor}
          >
            <SpecificationForm
              formId="spec-add"
              onSubmit={(values) => handleSave(values, null)}
              isSubmitting={isSubmitting}
              onDirtyChange={setDirty}
              serverFieldErrors={serverFieldErrors}
            />
          </InlineRowEditor>
        </div>
      ) : (
        <div>
          <Button
            ref={addButtonRef}
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH_TARGET}
            onClick={() => requestActivate({ kind: "add" })}
          >
            <Plus size={14} aria-hidden />
            Add specification
          </Button>
        </div>
      )}
    </div>
  );
}
