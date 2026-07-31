// PAY/DEP leg templates (ac07-spec §2.4, ac08-spec §2.2, plan §2
// T3/T4/refund leg). Keyed on `doc_type` — `(DEP, release)` differs from
// `(PAY, release)` even though both share the `release` line_kind.

import type { DocType, LineKind } from "@/types/accounts";

export type LegTemplateContext = {
  // fa.{FIN}.unapplied_cash — every PAY line, and DEP's release/refund
  // lines, touch this account.
  financialAccountUnappliedCashId: string;
  // fa.{FIN}.deposits (ac08-spec §2.1 — DEP is FA-level) — null when the FA
  // has no deposits binding resolved for this document (never true for a
  // DEP document; PAY documents never need it).
  financialAccountDepositsId: string | null;
  // The nature-resolved sys.{nature-or-steered-name}.{ccy} account
  // (post-document.ts §2.3 step 4) — null for line kinds that don't touch a
  // sys account.
  sysAccountId: string | null;
  // ban.{BAN}.receivables — present only for an `allocation`/`charge` line.
  billingAccountReceivablesId: string | null;
  // sys.tax_payable.{ccy} (ac09-spec §2.3) — resolved unconditionally by
  // post-document.ts (like `financialAccountDepositsId`), null when no
  // sys.tax_payable account exists for the document's currency. Fixed by
  // design: a DBN's tax line always steers here regardless of the reason
  // code's posting_nature (Module Inv. #8's one documented exception).
  taxSysAccountId: string | null;
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

// DEP leg templates (ac08-spec §2.2 — reconciled direction, confirmed
// 2026-07-25: pgledger `from → to` makes `from` decrease, `to` increase).
const DEP_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // capture (§2.2): fa.{FIN}.deposits → sys.cash.{ccy}. deposits → −A (held
  // liability), cash → +A.
  capture: (ctx) => {
    if (!ctx.financialAccountDepositsId) {
      throw new Error(
        "DEP capture leg requires a resolved fa.deposits account",
      );
    }
    if (!ctx.sysAccountId) {
      throw new Error("DEP capture leg requires a resolved sys.cash account");
    }
    return {
      fromAccountId: ctx.financialAccountDepositsId,
      toAccountId: ctx.sysAccountId,
    };
  },
  // reverse-to-account (§2.2): fa.{FIN}.unapplied_cash → fa.{FIN}.deposits —
  // deposits → 0, unapplied → −A. Internal only, no sys.cash leg. Distinct
  // from PAY's `release` (the allocation-reversal leg) even though both
  // share the `release` line_kind — this map is keyed on doc_type too.
  release: (ctx) => {
    if (!ctx.financialAccountDepositsId) {
      throw new Error(
        "DEP release leg requires a resolved fa.deposits account",
      );
    }
    return {
      fromAccountId: ctx.financialAccountUnappliedCashId,
      toAccountId: ctx.financialAccountDepositsId,
    };
  },
  // refund (§2.2): sys.cash.{ccy} → fa.{FIN}.unapplied_cash — the identical
  // payout leg shape as `(PAY, refund)` (§3.1's noted sharing); reused
  // directly rather than re-declared.
  refund: PAY_LEG_TEMPLATES.refund!,
};

// DBN/CRN leg templates (ac09-spec §2.2 — nature steering, V12). Both use
// the `charge` line_kind (direction comes from `doc_type`, disambiguated by
// this map's top-level key, same as every other entry here).
const DBN_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // principal (§2.2 table): sys.revenue.{ccy} → ban.{BAN}.receivables.
  // A/R → +A (customer owes more); revenue → −A (credit).
  charge: (ctx) => {
    if (!ctx.sysAccountId) {
      throw new Error("DBN charge leg requires a resolved sys.revenue account");
    }
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("DBN charge leg requires a receivables account");
    }
    return {
      fromAccountId: ctx.sysAccountId,
      toAccountId: ctx.billingAccountReceivablesId,
    };
  },
  // fixed-tax second line (§2.3): sys.tax_payable.{ccy} → ban.{BAN}.receivables.
  // The tax leg's counter-account is fixed regardless of the reason code's
  // posting_nature, so it can't share the `charge` key's nature-resolved
  // `sysAccountId` — it needs a distinct (doc_type, line_kind) map entry to
  // reach `ctx.taxSysAccountId` instead. The DB's `document_line_line_kind_check`
  // has no dedicated "tax" value and this unit makes no schema change (§2
  // boundary), so this reuses the `release` line_kind purely as a
  // disambiguating map key — the same reuse-with-a-different-meaning-per-
  // doc_type precedent already established by `(DEP, release)` vs
  // `(PAY, release)` above.
  release: (ctx) => {
    if (!ctx.taxSysAccountId) {
      throw new Error(
        "DBN tax leg requires a resolved sys.tax_payable account",
      );
    }
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("DBN tax leg requires a receivables account");
    }
    return {
      fromAccountId: ctx.taxSysAccountId,
      toAccountId: ctx.billingAccountReceivablesId,
    };
  },
};

const CRN_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // credit (§2.2 table): ban.{BAN}.receivables → sys.revenue_adj.{ccy}.
  // A/R → −A (reduced); revenue_adj → +A.
  charge: (ctx) => {
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("CRN charge leg requires a receivables account");
    }
    if (!ctx.sysAccountId) {
      throw new Error(
        "CRN charge leg requires a resolved sys.revenue_adj account",
      );
    }
    return {
      fromAccountId: ctx.billingAccountReceivablesId,
      toAccountId: ctx.sysAccountId,
    };
  },
};

const LEG_TEMPLATES: Partial<
  Record<DocType, Partial<Record<LineKind, LegTemplate>>>
> = {
  PAY: PAY_LEG_TEMPLATES,
  DEP: DEP_LEG_TEMPLATES,
  DBN: DBN_LEG_TEMPLATES,
  CRN: CRN_LEG_TEMPLATES,
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
