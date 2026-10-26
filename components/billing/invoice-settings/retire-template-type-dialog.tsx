"use client";

// bm83 (ui-context §10e, §7; code-standards › Invoice Template Types, Next.js
// rule 4 and Styling rule 5) — `RetireTemplateTypeDialog`, the outline
// **Retire type…** trigger in a non-Standard, non-retired type's detail header
// (EDIT only). The `AlertDialog` shows the bound-BAN count, a paginated BAN
// list ("Show more" reads the next page through `listBoundBansAction`), the
// target `Select` (Standard first and preselected, as `null`) and the typed
// name. The confirm is in the danger role inside the dialog only, disabled
// until the typed name matches after trim; the server re-checks it. It keeps
// no server state: success toasts and re-fetches; a refusal closes, toasts its
// message and re-fetches (the page may re-render read-only, removing this
// dialog — the DiscardDraftDialog precedent).

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { listBoundBansAction } from "@/actions/billing/invoice-settings/list-bound-bans.action";
import { retireTemplateTypeAction } from "@/actions/billing/invoice-settings/retire-template-type.action";
import {
  TEMPLATE_TYPE_MESSAGES,
  retireBody,
  retireSuccessToast,
  retireTitle,
} from "@/components/billing/invoice-settings/template-type-messages";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STANDARD_TYPE_NAME } from "@/types/accounts";
import {
  RETIRE_BAN_PAGE_SIZE,
  type BoundBanRow,
  type RetireTemplateTypeResult,
} from "@/types/billing";

// The Select needs string item values; Standard's null maps to this sentinel
// inside this component only.
const STANDARD_ITEM = "__standard__";

export interface RetireTemplateTypeDialogProps {
  typeId: string;
  typeName: string;
  boundBanCount: number;
  firstBoundBans: BoundBanRow[];
  // Usable types besides Standard, this type excluded.
  retireTargets: { billTemplateFamilyId: string; name: string }[];
}

export function retireRefusalMessage(
  code: Extract<RetireTemplateTypeResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "TEMPLATE_TYPE_RETIRED":
      return TEMPLATE_TYPE_MESSAGES.retireAlreadyRetired;
    case "DEFAULT_TYPE_NOT_RETIRABLE":
      return TEMPLATE_TYPE_MESSAGES.retireDefaultNotRetirable;
    case "RETIRE_TARGET_NOT_USABLE":
      return TEMPLATE_TYPE_MESSAGES.retireTargetNotUsable;
    case "RETIRE_NAME_MISMATCH":
      return TEMPLATE_TYPE_MESSAGES.retireNameMismatch;
    case "FORBIDDEN":
      return TEMPLATE_TYPE_MESSAGES.retireForbidden;
    default:
      return TEMPLATE_TYPE_MESSAGES.retireFailed;
  }
}

export function RetireTemplateTypeDialog({
  typeId,
  typeName,
  boundBanCount,
  firstBoundBans,
  retireTargets,
}: RetireTemplateTypeDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bans, setBans] = useState<BoundBanRow[]>(firstBoundBans);
  const [page, setPage] = useState(0);
  // A short page means the live set has no more rows, whatever the count says.
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [target, setTarget] = useState(STANDARD_ITEM);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canConfirm = typed.trim() === typeName && !submitting;
  const targetTypeId = target === STANDARD_ITEM ? null : target;
  const targetName =
    retireTargets.find((t) => t.billTemplateFamilyId === targetTypeId)?.name ??
    STANDARD_TYPE_NAME;

  // Every close starts the next opening clean (a refused retire included).
  function resetForm(): void {
    setTyped("");
    setTarget(STANDARD_ITEM);
    setMessage(null);
  }

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    setOpen(next);
    if (next) {
      // Review fix — each opening lists from the page's current server data
      // (a refresh may have changed the count and the first page).
      setBans(firstBoundBans);
      setPage(0);
      setExhausted(false);
    } else {
      resetForm();
    }
  }

  async function showMore(): Promise<void> {
    setLoadingMore(true);
    setMessage(null);
    try {
      const result = await listBoundBansAction({ typeId, page: page + 1 });
      if (result.ok) {
        // Review fix — OFFSET paging over a live set: a row that shifted
        // across pages is listed once.
        setBans((prev) => {
          const seen = new Set(prev.map((b) => b.billingAccountId));
          return [
            ...prev,
            ...result.rows.filter((b) => !seen.has(b.billingAccountId)),
          ];
        });
        setPage((p) => p + 1);
        if (result.rows.length < RETIRE_BAN_PAGE_SIZE) setExhausted(true);
      } else {
        setMessage(TEMPLATE_TYPE_MESSAGES.retireListFailed);
      }
    } catch {
      setMessage(TEMPLATE_TYPE_MESSAGES.retireListFailed);
    } finally {
      setLoadingMore(false);
    }
  }

  async function retire(): Promise<void> {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await retireTemplateTypeAction({
        typeId,
        targetTypeId,
        confirmName: typed,
      });
      setOpen(false);
      resetForm();
      if (result.ok) {
        toast.success(
          retireSuccessToast(typeName, result.movedBanCount, targetName),
        );
      } else {
        toast.error(retireRefusalMessage(result.code));
      }
      router.refresh();
    } catch {
      setMessage(TEMPLATE_TYPE_MESSAGES.retireFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {TEMPLATE_TYPE_MESSAGES.retireTrigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{retireTitle(typeName)}</AlertDialogTitle>
          <AlertDialogDescription>
            {retireBody(typeName)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <p className="flex items-baseline gap-2">
            <span
              data-testid="retire-bound-ban-count"
              className="text-h3 font-semibold text-foreground tabular-nums"
            >
              {boundBanCount}
            </span>
            <span className="text-body-sm text-muted-foreground">
              {TEMPLATE_TYPE_MESSAGES.retireBoundBansLabel}
            </span>
          </p>
          {bans.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">
              {TEMPLATE_TYPE_MESSAGES.retireNoBoundBans}
            </p>
          ) : (
            <ul
              aria-label="Bound billing accounts"
              className="max-h-48 divide-y divide-border overflow-y-auto rounded-sm border border-border"
            >
              {bans.map((ban) => (
                <li
                  key={ban.billingAccountId}
                  className="flex items-center gap-3 px-3 py-1.5 text-body-sm"
                >
                  <span className="font-mono text-mono text-foreground">
                    {ban.billingAccountId}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {ban.name ?? "—"}
                  </span>
                  <span className="text-muted-foreground">{ban.state}</span>
                </li>
              ))}
            </ul>
          )}
          {!exhausted && bans.length < boundBanCount ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => void showMore()}
            >
              {TEMPLATE_TYPE_MESSAGES.retireShowMore}
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="retire-target"
            className="text-body-sm font-medium text-foreground"
          >
            {TEMPLATE_TYPE_MESSAGES.retireTargetLabel}
          </label>
          <Select
            value={target}
            onValueChange={setTarget}
            disabled={submitting}
          >
            <SelectTrigger id="retire-target" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={STANDARD_ITEM}>
                {STANDARD_TYPE_NAME}
              </SelectItem>
              {retireTargets.map((t) => (
                <SelectItem
                  key={t.billTemplateFamilyId}
                  value={t.billTemplateFamilyId}
                >
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="retire-confirm-name"
            className="text-body-sm font-medium text-foreground"
          >
            {TEMPLATE_TYPE_MESSAGES.retireNameLabel}
          </label>
          <Input
            id="retire-confirm-name"
            value={typed}
            autoComplete="off"
            disabled={submitting}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>

        {message ? (
          <p
            role="alert"
            className="text-body-sm text-[color:var(--color-danger-700)]"
          >
            {message}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirm}
            onClick={() => void retire()}
          >
            {TEMPLATE_TYPE_MESSAGES.retireConfirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
