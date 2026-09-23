"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deletePriceAction } from "@/actions/product/delete-price.action";
import { insertPriceAction } from "@/actions/product/insert-price.action";
import { updatePriceAction } from "@/actions/product/update-price.action";
import { InlineRowEditor } from "@/components/products/manage/inline-row-editor";
import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
import { OfferingComponentErrorBanner } from "@/components/products/manage/offering-component-error-banner";
import type { OfferingComponentBannerViolation } from "@/components/products/manage/offering-component-error-banner";
import {
  PriceForm,
  priceCardToFormValues,
} from "@/components/products/manage/price-form";
import { renderPriceAmount } from "@/components/products/price-amount";
import {
  PriceEffectivityTag,
  effectivityAccentClass,
} from "@/components/products/price-effectivity";
import { PricingComponentBadge } from "@/components/products/pricing-component-badge";
import { Button } from "@/components/ui/button";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type {
  ComponentType,
  LifecycleStatus,
  PriceCard,
  UnitOfMeasure,
} from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// pm41 I2, reworked pm54/pm55 for the pricing-components update. The
// DRAFT-only client editor rendered by ManagePricesPanel (which stays a
// server component). One row edits at a time (D2); Save/Cancel are explicit;
// the typed action result updates the view (I3). The offering-level banner
// (pm54 D4) renders exclusively from the last action result — never from
// client-side VI3–VI5 evaluation — and disables Save while it's present.
//
// Mid-edit races: a RETIRED/non-DRAFT race returns OFFERING_RETIRED /
// OFFERING_NOT_DRAFT → the reload banner; an ACTIVE race on ADD branches a new
// draft → we navigate the user to it (D4), preserving their work.
const STALE_MESSAGE =
  "This version is no longer a draft — reload to see its current state.";
const FORBIDDEN_MESSAGE = "You no longer have permission to edit products.";
const KEPT_INPUT_MESSAGE =
  "Something went wrong. Your changes were kept — try saving again.";
const DUPLICATE_START_MESSAGE =
  "A price of this type already starts on that date. Choose a different start date.";
const BACKDATED_MESSAGE =
  "Start date is more than 3 days in the past and can no longer be used.";

const TOUCH_ICON = "[@media(pointer:coarse)]:size-11";
const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-[44px]";

const MODIFIER_COMPONENT_TYPES: readonly ComponentType[] = [
  "capacity_commitment",
  "capacity_motivation",
];

type ActiveEditor =
  | { kind: "none" }
  | { kind: "edit"; id: string }
  | { kind: "add" };

type PendingAction =
  | { kind: "activate"; target: ActiveEditor }
  | { kind: "delete"; id: string };

// pm55-spec D4/I3 — the four not-yet-billable warnings, kept in one place
// (beside the component's other copy) so the "exactly four copies" rule
// stays checkable and a future wording change is one edit. Warning-tinted,
// inline under the component row, and never block the save.
function notYetBillableWarnings(price: PriceCard): string[] {
  const warnings: string[] = [];

  if (price.componentType === "capacity_commitment") {
    warnings.push(
      "Bill run does not apply a capacity commitment yet — this component is stored but not billed.",
    );
  }
  if (price.componentType === "capacity_motivation") {
    warnings.push(
      "Bill run does not apply a capacity motivation yet — usage bills at the base rate until then.",
    );
  }
  if (
    price.component["@type"] === "usage_rate" &&
    price.component.params.rateCardLookUp !== null
  ) {
    warnings.push(
      `No rate card exists yet — ${price.component.params.rateCardLookUp} falls back to the rate per unit.`,
    );
  }
  if (
    MODIFIER_COMPONENT_TYPES.includes(price.componentType) &&
    price.unitOfMeasure === "Mbps"
  ) {
    warnings.push(
      "A capacity component in Mbps has no agreed basis yet; confirm what the committed quantity means before this version goes live.",
    );
  }

  return warnings;
}

// A delete's MODIFIER_WITHOUT_BASE_RATE names the unit but not which
// remaining component now lacks a base rate (pm49's result carries only the
// unit) — read it back from the still-visible sibling rows, the same
// "read what was just submitted" rule the add/edit path applies to its own
// form values.
function findOrphanedModifierType(
  prices: PriceCard[],
  excludeId: string,
  unitOfMeasure: UnitOfMeasure,
): Extract<ComponentType, "capacity_commitment" | "capacity_motivation"> {
  const orphan = prices.find(
    (price) =>
      price.productOfferingPriceId !== excludeId &&
      MODIFIER_COMPONENT_TYPES.includes(price.componentType) &&
      price.unitOfMeasure === unitOfMeasure,
  );
  return orphan?.componentType === "capacity_motivation"
    ? "capacity_motivation"
    : "capacity_commitment";
}

export interface EditablePricesProps {
  offeringId: string;
  offeringName: string;
  prices: PriceCard[];
  locale: string;
  timezone: string;
  // For navigate-on-branch when a mid-edit ACTIVE race branches a new draft (D4).
  familyId: string | null;
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

export function EditablePrices({
  offeringId,
  offeringName,
  prices,
  locale,
  timezone,
  familyId,
  query,
  status,
  page,
}: EditablePricesProps): React.JSX.Element {
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
  const [violation, setViolation] =
    useState<OfferingComponentBannerViolation | null>(null);
  const [staleBanner, setStaleBanner] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    id: string;
    busy: boolean;
    error: string | null;
  } | null>(null);

  const editTriggers = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusRef = useRef<string | "add" | null>(null);

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
    setViolation(null);
    setDirty(false);
    setDeleting(null);
    setActive(next);
  }

  function openDelete(id: string): void {
    setActive({ kind: "none" });
    setDirty(false);
    setFormError(null);
    setServerFieldErrors(null);
    setViolation(null);
    setDeleting({ id, busy: false, error: null });
  }

  function cancelDelete(id: string): void {
    setDeleting(null);
    setViolation(null);
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
    setViolation(null);
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
    values: InsertPriceInput,
    editingId: string | null,
  ): Promise<void> {
    setIsSubmitting(true);
    setFormError(null);
    setServerFieldErrors(null);
    setViolation(null);
    try {
      const result = editingId
        ? await updatePriceAction(editingId, values)
        : await insertPriceAction(offeringId, values);

      if (result.ok) {
        // Only the insert path can branch (on a mid-edit ACTIVE race); update
        // never branches. Navigate to the new draft rather than stranding it.
        if ("branched" in result && result.branched) {
          toast.success("New draft version created");
          navigateToBranchedDraft(result.offeringId);
          return;
        }
        toast.success(editingId ? "Price updated" : "Price added");
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
        case "DUPLICATE_START":
          // I3: a field error on the start date (attached via the form).
          setServerFieldErrors({ startDateTime: [DUPLICATE_START_MESSAGE] });
          break;
        case "BACKDATED_START_TOO_FAR":
          setServerFieldErrors({ startDateTime: [BACKDATED_MESSAGE] });
          break;
        case "MODIFIER_WITHOUT_BASE_RATE":
          if (
            values.componentType === "capacity_commitment" ||
            values.componentType === "capacity_motivation"
          ) {
            setViolation({
              code: "MODIFIER_WITHOUT_BASE_RATE",
              unitOfMeasure: result.unitOfMeasure,
              componentType: values.componentType,
            });
          } else if (values.componentType === "usage_rate") {
            setViolation({
              code: "MODIFIER_WITHOUT_BASE_RATE",
              unitOfMeasure: result.unitOfMeasure,
              componentType: findOrphanedModifierType(
                prices,
                editingId ?? "",
                result.unitOfMeasure,
              ),
            });
          }
          break;
        case "AMBIGUOUS_BASE_RATE":
          if (values.componentType === "usage_rate") {
            setViolation({
              code: "AMBIGUOUS_BASE_RATE",
              unitOfMeasure: values.unitOfMeasure,
            });
          }
          break;
        case "CURRENCY_MISMATCH":
          setViolation({
            code: "CURRENCY_MISMATCH",
            existingCurrency: result.existingCurrency,
            candidateCurrency: result.candidateCurrency,
          });
          break;
        case "OFFERING_NOT_DRAFT":
        case "OFFERING_RETIRED":
          setStaleBanner(STALE_MESSAGE);
          closeEditor();
          router.refresh();
          break;
        case "PRICE_NOT_FOUND":
        case "OFFERING_NOT_FOUND":
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
    setViolation(null);
    try {
      const result = await deletePriceAction(id);
      if (result.ok) {
        toast.success("Price deleted");
        setDeleting(null);
        pendingFocusRef.current = "add";
        router.refresh();
        return;
      }
      if (result.code === "FORBIDDEN") {
        setDeleting({ id, busy: false, error: FORBIDDEN_MESSAGE });
      } else if (result.code === "PRICE_NOT_FOUND") {
        setDeleting(null);
        pendingFocusRef.current = "add";
        router.refresh();
      } else if (result.code === "OFFERING_NOT_DRAFT") {
        setDeleting(null);
        setStaleBanner(STALE_MESSAGE);
        pendingFocusRef.current = "add";
        router.refresh();
      } else if (result.code === "MODIFIER_WITHOUT_BASE_RATE") {
        setViolation({
          code: "MODIFIER_WITHOUT_BASE_RATE",
          unitOfMeasure: result.unitOfMeasure,
          componentType: findOrphanedModifierType(
            prices,
            id,
            result.unitOfMeasure,
          ),
        });
        setDeleting({ id, busy: false, error: null });
      } else if (
        result.code === "AMBIGUOUS_BASE_RATE" ||
        result.code === "CURRENCY_MISMATCH"
      ) {
        // Deleting can only ever shrink the ambiguity/currency sets
        // (services/product/validate-offering-components.ts) — unreachable
        // in practice, kept so the exhaustive switch has nowhere silent to
        // fall through to.
        setDeleting({ id, busy: false, error: KEPT_INPUT_MESSAGE });
      } else {
        setDeleting({ id, busy: false, error: KEPT_INPUT_MESSAGE });
      }
    } catch {
      setDeleting({ id, busy: false, error: KEPT_INPUT_MESSAGE });
    }
  }

  const hasRows = prices.length > 0;

  return (
    <div className="mt-2 flex flex-col gap-2">
      <OfferingComponentErrorBanner violation={violation} />

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
          <span>Discard unsaved changes to this price?</span>
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
          No prices yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {prices.map((price) => {
            if (
              active.kind === "edit" &&
              active.id === price.productOfferingPriceId
            ) {
              const formId = `price-edit-${price.productOfferingPriceId}`;
              return (
                <li key={price.productOfferingPriceId} className="py-2">
                  <InlineRowEditor
                    formId={formId}
                    isSubmitting={isSubmitting}
                    saveLabel="Save"
                    formError={formError}
                    saveDisabled={violation !== null}
                    onCancel={closeEditor}
                  >
                    <PriceForm
                      offeringName={offeringName}
                      currentStatus="DRAFT"
                      formId={formId}
                      defaultValues={priceCardToFormValues(price)}
                      baselineStartDateTime={price.startDateTime}
                      onSubmit={(values) =>
                        handleSave(values, price.productOfferingPriceId)
                      }
                      isSubmitting={isSubmitting}
                      onDirtyChange={setDirty}
                      onValuesChange={() => setViolation(null)}
                      serverFieldErrors={serverFieldErrors}
                    />
                  </InlineRowEditor>
                </li>
              );
            }

            const isConfirming = deleting?.id === price.productOfferingPriceId;
            const startLabel = formatDatetime(
              price.startDateTime,
              locale,
              timezone,
            );
            const warnings = notYetBillableWarnings(price);
            return (
              <li
                key={price.productOfferingPriceId}
                className={cn(
                  "flex items-start justify-between gap-2 py-2",
                  effectivityAccentClass(price.effectivityStatus),
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body-sm font-medium text-foreground">
                      {price.name}
                    </span>
                    {price.componentType === price.component["@type"] ? (
                      <PricingComponentBadge
                        componentType={price.componentType}
                        priceType={price.component.priceType}
                      />
                    ) : null}
                    <PriceEffectivityTag
                      price={price}
                      locale={locale}
                      timezone={timezone}
                    />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-body-sm text-muted-foreground">
                    {renderPriceAmount(price, prices, locale)}
                    <span>
                      ·{" "}
                      <time dateTime={price.startDateTime.toISOString()}>
                        {startLabel}
                      </time>
                    </span>
                  </div>
                  {warnings.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-1">
                      {warnings.map((warning) => (
                        <li
                          key={warning}
                          className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-2 py-1 text-body-sm text-[color:var(--text-warning)]"
                        >
                          {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {isConfirming ? (
                    <div className="mt-1.5 flex flex-col gap-1">
                      <span className="text-body-sm text-foreground">
                        Delete this price?
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
                          onClick={() =>
                            cancelDelete(price.productOfferingPriceId)
                          }
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className={TOUCH_TARGET}
                          disabled={deleting?.busy || violation !== null}
                          onClick={() =>
                            void handleDeleteConfirm(
                              price.productOfferingPriceId,
                            )
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
                        editTriggers.current.set(
                          price.productOfferingPriceId,
                          el,
                        );
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={TOUCH_ICON}
                      aria-label={`Edit ${price.name}, starting ${startLabel}`}
                      onClick={() =>
                        requestActivate({
                          kind: "edit",
                          id: price.productOfferingPriceId,
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
                      aria-label={`Delete ${price.name}, starting ${startLabel}`}
                      onClick={() =>
                        requestDelete(price.productOfferingPriceId)
                      }
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
            formId="price-add"
            isSubmitting={isSubmitting}
            saveLabel="Add price"
            formError={formError}
            saveDisabled={violation !== null}
            onCancel={closeEditor}
          >
            <PriceForm
              offeringName={offeringName}
              currentStatus="DRAFT"
              formId="price-add"
              onSubmit={(values) => handleSave(values, null)}
              isSubmitting={isSubmitting}
              onDirtyChange={setDirty}
              onValuesChange={() => setViolation(null)}
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
            Add price
          </Button>
        </div>
      )}
    </div>
  );
}
