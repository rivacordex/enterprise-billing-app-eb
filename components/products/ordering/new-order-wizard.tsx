"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Loader2 } from "lucide-react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { createOrderAction } from "@/actions/ordering/create-order.action";
import {
  listToRecord,
  recordToList,
} from "@/components/products/ordering/characteristics-editor";
import {
  wizardGetCustomerAccountsAction,
  wizardGetOfferingDetailAction,
  type WizardBillingAccountOption,
  type WizardOfferingOption,
} from "@/actions/accounts/new-order-wizard-reads";

import { WizardStepAccount } from "@/components/products/ordering/wizard-step-account";
import { WizardStepCustomer } from "@/components/products/ordering/wizard-step-customer";
import { WizardStepOffer } from "@/components/products/ordering/wizard-step-offer";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { inclusiveBilledDateSchema } from "@/validation/backdating-tolerance";
import { PRICE_TYPES } from "@/types/product";
import type { OfferingDetail } from "@/types/product";
import type { CustomerSearchResult } from "@/types/customer";
import type { CreateOrderActionResult } from "@/actions/ordering/create-order.action";

const MONEY_2DP_REGEX = /^\d{1,10}(\.\d{1,2})?$/;

// pm29-spec §Implementation-2. UI-only, mirroring createOrderSchema's own
// rules (fast-fail) without literally reusing the object — useFieldArray
// needs the array shapes, the same local-schema-plus-translation call
// price-form.tsx/specification-form.tsx already make for the same reason.
const wizardFormSchema = z
  .object({
    quantity: z
      .number({ error: "Quantity is required" })
      .int()
      .min(1, "Quantity must be at least 1"),
    startDate: inclusiveBilledDateSchema,
    characteristicsList: z.array(
      z.object({ key: z.string().trim(), value: z.string() }),
    ),
    overrides: z.array(
      z.object({
        priceType: z.enum(PRICE_TYPES),
        amount: z.string(),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    value.overrides.forEach((override, index) => {
      const trimmed = override.amount.trim();
      if (trimmed === "") return;
      if (!MONEY_2DP_REGEX.test(trimmed) || Number(trimmed) <= 0) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid positive amount, up to 2 decimals.",
          path: ["overrides", index, "amount"],
        });
      }
    });
  });

function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultFormValues(): WizardFormValues {
  return {
    quantity: 1,
    startDate: todayLocalDate(),
    characteristicsList: [],
    overrides: [],
  };
}

// pm28's own precondition codes, derived from the action's own result type
// (not imported from `services/ordering` directly — `components/**` may not
// depend on `services/**`, ESLint `boundaries/dependencies`) and mapped to a
// form-level message each (pm29-spec §Implementation-1 — "typed {ok, code}
// result mapping every pm28 error code to a field- or form-level message").
type OrderPreconditionErrorCode = Exclude<
  Extract<CreateOrderActionResult, { ok: false }>["code"],
  "VALIDATION_ERROR" | "FORBIDDEN" | "SERVER_ERROR"
>;

const ORDER_ERROR_MESSAGES: Record<OrderPreconditionErrorCode, string> = {
  CUSTOMER_NOT_ACTIVE:
    "This customer is no longer ACTIVE. Please reload and search again.",
  BILLING_ACCOUNT_CLOSED:
    "This billing account has been closed. Please choose another.",
  BILLING_ACCOUNT_MISMATCH:
    "This billing account no longer belongs to the selected customer.",
  OFFERING_NOT_ORDERABLE:
    "This offer is no longer orderable (not active, sellable, and billing-only).",
  NO_PRICE_ROWS: "This offer has no prices and cannot be ordered.",
  OVERRIDE_PRICE_TYPE_INVALID:
    "A negotiated price type is no longer valid for this offer.",
  OVERRIDE_CURRENCY_MISMATCH:
    "A negotiated price's currency does not match the billing account's currency.",
  BACKDATED_START_TOO_FAR: "Start date cannot be more than 3 days in the past.",
};

type WizardStep = 1 | 2 | 3;

const STEP_LABELS: Record<WizardStep, string> = {
  1: "Customer",
  2: "Account",
  3: "Offer",
};

export interface NewOrderWizardProps {
  trigger: React.ReactNode;
  locale: string;
}

// pm29-spec — the app's first multi-step wizard: a full-screen `Dialog`
// opened from pm27's "New order" CTA, step state client-held (`useState`) —
// UX only, the submit payload is re-validated by Zod in the action and by
// pm28's service under locks. Back/forward between steps never refetches
// committed data (customer/account/offer selections persist in plain
// `useState`, not re-fetched on navigation).
export function NewOrderWizard({
  trigger,
  locale,
}: NewOrderWizardProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [customer, setCustomer] = useState<CustomerSearchResult | null>(null);
  const [account, setAccount] = useState<WizardBillingAccountOption | null>(
    null,
  );
  const [offering, setOffering] = useState<WizardOfferingOption | null>(null);

  // Step 2's data, lifted here (not fetched inside `WizardStepAccount`) so
  // navigating back to step 2 never re-fetches (Design — "Back/forward
  // between steps never refetches committed data"): the effect below only
  // re-runs when the *selected customer* changes, not on step navigation,
  // since `WizardStepAccount` no longer mounts/unmounts its own fetch.
  const [accounts, setAccounts] = useState<WizardBillingAccountOption[]>([]);
  const [financialAccountName, setFinancialAccountName] = useState<
    string | null
  >(null);
  // `isLoadingAccounts` is derived, not its own setState toggled inside the
  // effect (react-hooks/set-state-in-effect forbids a synchronous setState
  // call in an effect body) — `accountsLoadedFor` only ever moves inside the
  // async `.then()` continuation below.
  const [accountsLoadedFor, setAccountsLoadedFor] = useState<string | null>(
    null,
  );
  const isLoadingAccounts =
    customer !== null && accountsLoadedFor !== customer.partyRoleId;

  useEffect(() => {
    // No synchronous setState on the no-customer branch (react-hooks/set-
    // state-in-effect) — every place `customer` transitions to `null`
    // (`resetWizard`, `selectCustomer`) explicitly clears `accounts`/
    // `financialAccountName` itself, in the event handler, not here.
    if (!customer) return;
    let cancelled = false;
    void wizardGetCustomerAccountsAction(customer.partyRoleId).then((data) => {
      if (cancelled) return;
      setAccounts(data?.bans ?? []);
      setFinancialAccountName(data?.financialAccountName ?? null);
      setAccountsLoadedFor(customer.partyRoleId);
      if (data?.bans.length === 1 && data.bans[0]) {
        setAccount(data.bans[0]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  // Step 3's offer-detail data, same lifted-state reasoning as accounts
  // above — re-fetches only when the *selected offer* changes.
  const [offeringDetail, setOfferingDetail] = useState<OfferingDetail | null>(
    null,
  );
  // Same derived-loading shape as `isLoadingAccounts` above.
  const [offeringDetailLoadedFor, setOfferingDetailLoadedFor] = useState<
    string | null
  >(null);
  const isLoadingOfferingDetail =
    offering !== null && offeringDetailLoadedFor !== offering.productOfferingId;

  const form = useForm<WizardFormValues>({
    resolver: zodResolver(wizardFormSchema),
    defaultValues: defaultFormValues(),
  });

  useEffect(() => {
    // No synchronous setState on the no-offer branch — every place
    // `offering` transitions to `null` (`resetWizard`, `selectOffering`)
    // explicitly clears `offeringDetail` itself, in the event handler.
    if (!offering) return;
    let cancelled = false;
    void wizardGetOfferingDetailAction(offering.productOfferingId).then(
      (detail) => {
        if (cancelled) return;
        setOfferingDetail(detail);
        setOfferingDetailLoadedFor(offering.productOfferingId);
        if (!detail) return;

        // Prefill from the version's spec-characteristic keys + defaults
        // (pm29-spec §Implementation-2) — union of every specification's
        // own characteristics record.
        const merged = Object.assign(
          {},
          ...detail.specifications.map((spec) => spec.characteristics),
        ) as Record<string, string>;
        form.setValue("characteristicsList", recordToList(merged));

        // One override slot per current, flat price — fixed-size, reset
        // whenever the selected offer changes (tiered rows get no slot).
        const flatPrices = detail.prices.filter(
          (p) => p.effectivityStatus === "current" && p.pricingModel === "flat",
        );
        form.setValue(
          "overrides",
          flatPrices.map((p) => ({ priceType: p.priceType, amount: "" })),
        );
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offering]);

  function resetWizard(): void {
    setStep(1);
    setCustomer(null);
    setAccounts([]);
    setFinancialAccountName(null);
    setAccountsLoadedFor(null);
    setAccount(null);
    setOffering(null);
    setOfferingDetail(null);
    setOfferingDetailLoadedFor(null);
    setSubmitError(null);
    form.reset(defaultFormValues());
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
    if (!nextOpen) resetWizard();
  }

  function selectCustomer(next: CustomerSearchResult): void {
    setCustomer(next);
    setAccounts([]);
    setFinancialAccountName(null);
    setAccount(null);
  }

  function selectOffering(next: WizardOfferingOption | null): void {
    setOffering(next);
    if (!next) setOfferingDetail(null);
  }

  async function submitOrder(values: WizardFormValues): Promise<void> {
    if (!customer || !account || !offering) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const overrides = values.overrides
        .filter((o) => o.amount.trim() !== "")
        .map((o) => ({
          priceType: o.priceType,
          amount: o.amount.trim(),
          currency: account.currency,
        }));

      const result = await createOrderAction({
        customerPartyRoleId: customer.partyRoleId,
        billingAccountId: account.billingAccountId,
        productOfferingId: offering.productOfferingId,
        quantity: values.quantity,
        startDate: values.startDate,
        characteristics: listToRecord(values.characteristicsList),
        overrides: overrides.length > 0 ? overrides : undefined,
      });

      if (result.ok) {
        setOpen(false);
        resetWizard();
        toast.success(
          result.status === "PENDING"
            ? `Order ${result.orderId} submitted for approval`
            : `Order ${result.orderId} completed`,
        );
        router.refresh();
        return;
      }

      if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
        return;
      }

      if (result.code === "VALIDATION_ERROR") {
        setSubmitError(
          "Validation failed. Please check the form and try again.",
        );
        return;
      }

      if (result.code === "SERVER_ERROR") {
        setSubmitError("Something went wrong. Please try again.");
        return;
      }

      if (result.code === "BACKDATED_START_TOO_FAR") {
        form.setError("startDate", {
          message: ORDER_ERROR_MESSAGES[result.code],
        });
      }
      setSubmitError(ORDER_ERROR_MESSAGES[result.code]);
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const canGoToStep2 = customer !== null;
  const canGoToStep3 = canGoToStep2 && account !== null;
  const canSubmit = canGoToStep3 && offering !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="flex h-screen w-screen max-w-none flex-col overflow-y-auto rounded-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
        </DialogHeader>

        <ol className="flex items-center gap-4 border-b border-border pb-3">
          {([1, 2, 3] as const).map((s) => {
            const isDone = s < step;
            const isCurrent = s === step;
            return (
              <li key={s} className="flex items-center gap-2 text-body-sm">
                <span
                  className={
                    "flex size-6 items-center justify-center rounded-full text-caption font-semibold " +
                    (isDone
                      ? "bg-[color:var(--color-success-500)] text-white"
                      : isCurrent
                        ? "bg-[color:var(--action-cta-bg)] text-white"
                        : "bg-[color:var(--surface-sunken)] text-muted-foreground")
                  }
                >
                  {isDone ? <Check size={14} aria-hidden /> : s}
                </span>
                <span
                  className={
                    isCurrent
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {STEP_LABELS[s]}
                </span>
              </li>
            );
          })}
        </ol>

        <FormProvider {...form}>
          <form
            id="new-order-wizard-form"
            noValidate
            onSubmit={(e) => void form.handleSubmit(submitOrder)(e)}
            className="flex-1 space-y-4"
          >
            {step === 1 && (
              <WizardStepCustomer
                selectedCustomer={customer}
                onSelect={selectCustomer}
              />
            )}
            {step === 2 && customer && (
              <WizardStepAccount
                isLoading={isLoadingAccounts}
                financialAccountName={financialAccountName}
                bans={accounts}
                selectedAccount={account}
                onSelect={setAccount}
              />
            )}
            {step === 3 && account && (
              <WizardStepOffer
                selectedOffering={offering}
                onSelectOffering={selectOffering}
                offeringDetail={offeringDetail}
                isLoadingOfferingDetail={isLoadingOfferingDetail}
                currency={account.currency}
                locale={locale}
                isSubmitting={isSubmitting}
              />
            )}

            {submitError && (
              <div className="rounded-[var(--radius)] bg-[color:var(--color-danger-50)] px-3 py-2 text-body-sm text-[color:var(--color-danger-700)]">
                {submitError}
              </div>
            )}
          </form>
        </FormProvider>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => setStep((s) => (s - 1) as WizardStep)}
            >
              Back
            </Button>
          )}
          {step < 3 && (
            <Button
              type="button"
              disabled={
                (step === 1 && !canGoToStep2) || (step === 2 && !canGoToStep3)
              }
              onClick={() => setStep((s) => (s + 1) as WizardStep)}
            >
              Next
            </Button>
          )}
          {step === 3 && (
            <Button
              type="submit"
              form="new-order-wizard-form"
              disabled={isSubmitting || !canSubmit}
            >
              {isSubmitting && <Loader2 className="animate-spin" />}
              Submit order
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
