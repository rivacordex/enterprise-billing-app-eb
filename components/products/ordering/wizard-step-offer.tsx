"use client";

import { useEffect, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { CharacteristicsEditor } from "@/components/products/ordering/characteristics-editor";
import { OverridePriceFields } from "@/components/products/ordering/override-price-fields";
import {
  wizardSearchOfferingsAction,
  type WizardOfferingOption,
} from "@/actions/accounts/new-order-wizard-reads";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/formatters";
import { BACKDATING_TOLERANCE_DAYS } from "@/validation/backdating-tolerance";
import type { OfferingDetail } from "@/types/product";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WizardStepOfferProps {
  selectedOffering: WizardOfferingOption | null;
  onSelectOffering: (offering: WizardOfferingOption | null) => void;
  offeringDetail: OfferingDetail | null;
  isLoadingOfferingDetail: boolean;
  currency: string;
  locale: string;
  isSubmitting: boolean;
}

// pm29-spec §Implementation-2 (`WizardStepOffer`). Offer picker (search,
// ephemeral local state — re-searching on return to this step is expected,
// unlike the *selected* offer's committed data) + current effective prices
// (read-only, `getOfferingDetail` — catalog effectivity reused, never
// reimplemented) + quantity/start-date + `CharacteristicsEditor` +
// `OverridePriceFields`. `offeringDetail` is fetched once by `NewOrderWizard`
// per selected offer and passed down (Design — "Back/forward between steps
// never refetches committed data").
export function WizardStepOffer({
  selectedOffering,
  onSelectOffering,
  offeringDetail,
  isLoadingOfferingDetail,
  currency,
  locale,
  isSubmitting,
}: WizardStepOfferProps): React.JSX.Element {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<WizardFormValues>();
  const startDate = useWatch({ control, name: "startDate" }) ?? "";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WizardOfferingOption[]>([]);
  // `isSearching` is derived, not its own setState toggled inside the effect
  // (react-hooks/set-state-in-effect forbids a synchronous setState call in
  // an effect body) — `resultsForQuery` only ever moves inside the async
  // `.then()` continuation below.
  const [resultsForQuery, setResultsForQuery] = useState<string | null>(null);
  const isSearching = query.trim() !== "" && resultsForQuery !== query;

  useEffect(() => {
    if (query.trim() === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void wizardSearchOfferingsAction(query)
        .then((data) => {
          if (cancelled) return;
          setResults(data ?? []);
        })
        .catch(() => {
          // A rejected search must not leave stale results or an unhandled
          // rejection — clear the list; `setResultsForQuery` (which clears the
          // derived `isSearching` flag) moves to `finally` so it runs on both
          // success and failure. Toast so a failed search (e.g. the offering
          // page-loop tripping its safety ceiling) is distinguishable from a
          // genuinely empty result set.
          if (cancelled) return;
          setResults([]);
          toast.error("Couldn't search offers. Please try again.");
        })
        .finally(() => {
          if (cancelled) return;
          setResultsForQuery(query);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const visibleResults = query.trim() === "" ? [] : results;

  // A mount-time snapshot of *today's local calendar day* (midnight), not the
  // wall-clock instant — so the backdate banner compares whole calendar days
  // (today is 0 days back, not "a few hours"), and today itself never trips it.
  // Snapshotted via a lazy initializer rather than a bare `new Date()` in the
  // render body to satisfy this codebase's `react-hooks/purity` rule (a
  // short-lived dialog can't outlive a day boundary meaningfully).
  const [todayLocalMs] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  });

  const currentPrices =
    offeringDetail?.prices.filter((p) => p.effectivityStatus === "current") ??
    [];

  return (
    <div className="space-y-4">
      {!selectedOffering && (
        <div className="flex flex-col gap-1">
          <label
            className="text-body-sm font-medium text-foreground"
            htmlFor="wizard-offer-search"
          >
            Search offers
          </label>
          <input
            id="wizard-offer-search"
            type="text"
            autoFocus
            placeholder="Offering name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-full rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
          {isSearching && (
            <p className="text-body-sm text-muted-foreground">Searching…</p>
          )}
          <ul className="divide-y divide-border rounded-md border border-border">
            {visibleResults.map((offering) => (
              <li key={offering.productOfferingId}>
                <button
                  type="button"
                  onClick={() => onSelectOffering(offering)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-body-sm hover:bg-[color:var(--action-ghost-hover)]"
                >
                  <span>{offering.name}</span>
                  <span className="font-mono text-mono text-muted-foreground">
                    {offering.productOfferingId} (v{offering.version})
                  </span>
                </button>
              </li>
            ))}
            {visibleResults.length === 0 &&
              !isSearching &&
              query.trim() !== "" && (
                <li className="px-3 py-4 text-center text-body-sm text-muted-foreground">
                  No orderable offers match your search
                </li>
              )}
          </ul>
        </div>
      )}

      {selectedOffering && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-[var(--radius)] bg-[color:var(--surface-selected)] px-3 py-2 text-body-sm">
            <span>
              <strong>{selectedOffering.name}</strong>{" "}
              <span className="font-mono text-mono text-muted-foreground">
                {selectedOffering.productOfferingId} (v
                {selectedOffering.version})
              </span>
            </span>
            <button
              type="button"
              className="text-caption text-muted-foreground underline"
              onClick={() => onSelectOffering(null)}
            >
              Change offer
            </button>
          </div>

          {isLoadingOfferingDetail && (
            <p className="text-body-sm text-muted-foreground">
              Loading offer details…
            </p>
          )}

          {offeringDetail && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-body-sm font-medium text-foreground">
                  Current effective prices
                </legend>
                {currentPrices.length === 0 && (
                  <p className="text-body-sm text-muted-foreground">
                    No currently effective prices.
                  </p>
                )}
                {currentPrices.map((price) => (
                  <div
                    key={price.productOfferingPriceId}
                    className="flex items-center justify-between text-body-sm"
                  >
                    <span>
                      {price.name}{" "}
                      <span className="text-muted-foreground">
                        ({price.priceType})
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {price.amount !== null
                        ? formatCurrency(price.amount, price.currency, locale)
                        : "tiered"}
                    </span>
                  </div>
                ))}
              </fieldset>

              <Field orientation="responsive">
                <Field>
                  <FieldLabel htmlFor="wizard-quantity">Quantity</FieldLabel>
                  <Input
                    id="wizard-quantity"
                    type="number"
                    min={1}
                    disabled={isSubmitting}
                    aria-invalid={!!errors.quantity}
                    {...register("quantity", { valueAsNumber: true })}
                  />
                  <FieldError errors={[errors.quantity]} />
                </Field>

                <Field>
                  <FieldLabel htmlFor="wizard-start-date">
                    Start date
                  </FieldLabel>
                  <Input
                    id="wizard-start-date"
                    type="date"
                    disabled={isSubmitting}
                    aria-invalid={!!errors.startDate}
                    {...register("startDate")}
                  />
                  <FieldError errors={[errors.startDate]} />
                  {startDate &&
                    !errors.startDate &&
                    (() => {
                      const start = new Date(`${startDate}T00:00:00`);
                      if (Number.isNaN(start.getTime())) return null;
                      // Whole calendar days between today and the start date;
                      // the banner is the in-tolerance historical window only
                      // (1..3 days back). Today (0) shows nothing; > tolerance
                      // is handled by the schema's blocking field error.
                      const daysInPast = Math.round(
                        (todayLocalMs - start.getTime()) / MS_PER_DAY,
                      );
                      if (
                        daysInPast >= 1 &&
                        daysInPast <= BACKDATING_TOLERANCE_DAYS
                      ) {
                        return (
                          <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
                            This order is backdated to {startDate}; historical
                            bills may be affected.
                          </div>
                        );
                      }
                      return null;
                    })()}
                </Field>
              </Field>

              <CharacteristicsEditor isSubmitting={isSubmitting} />

              <OverridePriceFields
                prices={currentPrices}
                currency={currency}
                locale={locale}
                isSubmitting={isSubmitting}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
