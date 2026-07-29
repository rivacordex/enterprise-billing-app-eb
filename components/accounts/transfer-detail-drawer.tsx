// Transfer-detail drawer (ac06-spec §2.3) — both `pgledger_entries_view` legs
// for a transfer: account + kind chip, **signed** amount, and
// previous → current running balance. Teaches the signed convention
// (negative = credit) via `AmountCell`, never a raw `< 0` comparison.
// `metadata.doc`/`ban`/`type` render as plain text — no document exists to
// link to until ac07 (spec §2.3, §3.5).

import { ArrowRight, X } from "lucide-react";
import Link from "next/link";

import { AmountCell } from "@/components/accounts/amount-cell";
import { LedgerKindChip } from "@/components/accounts/ledger-kind-chip";
import { formatDatetime } from "@/lib/formatters";
import type { LedgerTransferDetail } from "@/types/accounts";

export interface TransferDetailDrawerProps {
  detail: LedgerTransferDetail;
  currency: string;
  closeHref: string;
  locale: string;
  timezone: string;
}

function metadataValue(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

export function TransferDetailDrawer({
  detail,
  currency,
  closeHref,
  locale,
  timezone,
}: TransferDetailDrawerProps): React.JSX.Element {
  const doc = metadataValue(detail.metadata, "doc");
  const ban = metadataValue(detail.metadata, "ban");
  const type = metadataValue(detail.metadata, "type");

  return (
    <aside className="space-y-4 rounded-none border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-h3 font-semibold text-foreground">
            Transfer Detail
          </h2>
          <p className="font-mono text-body-sm text-muted-foreground">
            {detail.id}
          </p>
        </div>
        <Link
          href={closeHref}
          aria-label="Close transfer detail"
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
        >
          <X className="size-4" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-[color:var(--border-subtle)] py-3 text-body-sm">
        <div>
          <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Event At
          </span>
          <span className="text-foreground">
            {formatDatetime(detail.eventAt, locale, timezone)}
          </span>
        </div>
        <div>
          <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Created At
          </span>
          <span className="text-foreground">
            {formatDatetime(detail.createdAt, locale, timezone)}
          </span>
        </div>
        {doc && (
          <div>
            <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Doc
            </span>
            <span className="font-mono text-mono text-foreground">{doc}</span>
          </div>
        )}
        {ban && (
          <div>
            <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              BAN
            </span>
            <span className="font-mono text-mono text-foreground">{ban}</span>
          </div>
        )}
        {type && (
          <div>
            <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Type
            </span>
            <span className="text-foreground">{type}</span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {detail.legs.map((leg) => (
          <div
            key={leg.accountId}
            className="rounded-none border border-[color:var(--border-subtle)] p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <LedgerKindChip kind={leg.label.kind} />
              <span className="truncate font-mono text-body-sm text-foreground">
                {leg.label.ownerLabel ?? leg.accountName}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Signed Amount
                </span>
                <AmountCell amount={leg.amount} currency={currency} />
              </div>
              <div>
                <span className="block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Balance
                </span>
                <span className="flex items-center justify-end gap-1.5">
                  <AmountCell
                    amount={leg.accountPreviousBalance}
                    currency={currency}
                    className="inline"
                  />
                  <ArrowRight
                    size={12}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <AmountCell
                    amount={leg.accountCurrentBalance}
                    currency={currency}
                    className="inline"
                  />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
