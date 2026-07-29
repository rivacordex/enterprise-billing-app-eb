// PAY leg templates (ac07-spec §2.4, plan §2 T3/T4/refund leg). Keyed on
// `doc_type` so a future `(DEP, refund)` template (ac08) is distinct from
// `(PAY, refund)` even though both post the identical payout leg shape.

import type { DocType, LineKind } from "@/types/accounts";

export type LegTemplateContext = {
  // fa.{FIN}.unapplied_cash — every PAY line touches this account.
  financialAccountUnappliedCashId: string;
  // The nature-resolved sys.{nature}.{ccy} account (post-document.ts §2.3
  // step 4) — null for line kinds that don't touch a sys account.
  sysAccountId: string | null;
  // ban.{BAN}.receivables — present only for an `allocation` line.
  billingAccountReceivablesId: string | null;
};

export type ResolvedLeg = { fromAccountId: string; toAccountId: string };

export type LegTemplate = (ctx: LegTemplateContext) => ResolvedLeg;

const PAY_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // capture (§2.4): fa.{FIN}.unapplied_cash → sys.cash.{ccy}.
  capture: (ctx) => {
    if (!ctx.sysAccountId) {
      throw new Error("PAY capture leg requires a resolved sys.cash account");
    }
    return {
      fromAccountId: ctx.financialAccountUnappliedCashId,
      toAccountId: ctx.sysAccountId,
    };
  },
  // allocation (§2.4): ban.{BAN}.receivables → fa.{FIN}.unapplied_cash. Both
  // sides are TMF-owned accounts — no nature/sys resolution involved.
  allocation: (ctx) => {
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("PAY allocation leg requires a receivables account");
    }
    return {
      fromAccountId: ctx.billingAccountReceivablesId,
      toAccountId: ctx.financialAccountUnappliedCashId,
    };
  },
  // release (§2.4b — the payment-refund workbench's allocation reversal):
  // fa.{FIN}.unapplied_cash → ban.{BAN}.receivables, the exact opposite of
  // `allocation`'s leg. Deterministic from (doc_type, line_kind, FA, BAN)
  // alone — same as every other template here, so it resolves through the
  // ordinary generic posting path (`postDocument`) rather than needing the
  // explicit-leg primitive. `postExplicitLegs` (post-document.ts) still
  // exists and is exported for ac11's true arbitrary reversals, where the
  // leg direction depends on an existing transfer's actual accounts rather
  // than a fixed per-kind shape.
  release: (ctx) => {
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("PAY release leg requires a receivables account");
    }
    return {
      fromAccountId: ctx.financialAccountUnappliedCashId,
      toAccountId: ctx.billingAccountReceivablesId,
    };
  },
  // refund (§2.4, Q17/Q20 payout leg): sys.cash.{ccy} → fa.{FIN}.unapplied_cash.
  refund: (ctx) => {
    if (!ctx.sysAccountId) {
      throw new Error("PAY refund leg requires a resolved sys.cash account");
    }
    return {
      fromAccountId: ctx.sysAccountId,
      toAccountId: ctx.financialAccountUnappliedCashId,
    };
  },
};

const LEG_TEMPLATES: Partial<
  Record<DocType, Partial<Record<LineKind, LegTemplate>>>
> = {
  PAY: PAY_LEG_TEMPLATES,
};

export function resolveLegTemplate(
  docType: DocType,
  lineKind: LineKind,
): LegTemplate {
  const template = LEG_TEMPLATES[docType]?.[lineKind];
  if (!template) {
    throw new Error(`no leg template for (${docType}, ${lineKind})`);
  }
  return template;
}
