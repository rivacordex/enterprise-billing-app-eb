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

// ADJ leg templates (ac10-spec §2.1/§2.2 — write-off + rounding, V12
// completion). Both natures (`write_off`/`rounding`) already resolve
// generically to `ctx.sysAccountId` via post-document.ts's
// `NATURE_SYS_ACCOUNT_NAME` map (no post-document.ts change needed) — this
// map only needs the leg *shapes*. Write-off is always the `charge`
// direction. Rounding can be either direction depending on the live A/R
// residue's sign (§2.2), decided by the calling service *before* the
// document line is inserted (it picks `charge` for a debit/positive residue,
// `release` for a credit/negative one) — so, same as `(DBN, release)`'s tax
// leg, `release` is reused here purely as a disambiguating map key for the
// reversed direction; `document_line_line_kind_check` has no dedicated value
// for it and this unit makes no schema change (§2 boundary).
const ADJ_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // write-off (§2.1 table row 1) + rounding clearing a debit/positive
  // residue (§2.2 default direction): ban.{BAN}.receivables →
  // sys.{write_off|rounding}.{ccy}. A/R → −A (removed/reduced); the sys
  // account → +A.
  charge: (ctx) => {
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("ADJ charge leg requires a receivables account");
    }
    if (!ctx.sysAccountId) {
      throw new Error(
        "ADJ charge leg requires a resolved sys.write_off/sys.rounding account",
      );
    }
    return {
      fromAccountId: ctx.billingAccountReceivablesId,
      toAccountId: ctx.sysAccountId,
    };
  },
  // rounding clearing a credit/negative residue (§2.2 reverse direction):
  // sys.rounding.{ccy} → ban.{BAN}.receivables — the exact opposite of
  // `charge`, above. Never used by write-off (always four-eyes, always the
  // `charge` direction).
  release: (ctx) => {
    if (!ctx.sysAccountId) {
      throw new Error(
        "ADJ release leg requires a resolved sys.rounding account",
      );
    }
    if (!ctx.billingAccountReceivablesId) {
      throw new Error("ADJ release leg requires a receivables account");
    }
    return {
      fromAccountId: ctx.sysAccountId,
      toAccountId: ctx.billingAccountReceivablesId,
    };
  },
};

// INV leg templates (bm09-spec §Design — "modeled on DBN's revenue leg plus
// a tax leg"). Same shape as DBN_LEG_TEMPLATES: `charge` is the revenue line,
// `release` is reused as the tax line's disambiguating map key (no dedicated
// `document_line_line_kind_check` value for "tax" — the same reuse
// precedent DBN/DEP/ADJ already established above). bm11 constructs the two
// document_lines (a revenue `charge` line + the tax); this template maps
// them to pgledger legs via the existing `resolveLegTemplate(docType,
// lineKind)` path — no post-document.ts change needed.
const INV_LEG_TEMPLATES: Partial<Record<LineKind, LegTemplate>> = {
  // revenue line: sys.revenue.{ccy} → ban.{BAN}.receivables — IDENTICAL to
  // (DBN, charge). tax line: sys.tax_payable.{ccy} → ban.{BAN}.receivables —
  // IDENTICAL to (DBN, release)'s tax leg. ALIASED (not re-declared) so a
  // future correction to the revenue/tax leg direction or guard can never
  // silently diverge INV from DBN — the same reuse idiom as
  // `refund: PAY_LEG_TEMPLATES.refund!` above.
  charge: DBN_LEG_TEMPLATES.charge!,
  release: DBN_LEG_TEMPLATES.release!,
};

const LEG_TEMPLATES: Partial<
  Record<DocType, Partial<Record<LineKind, LegTemplate>>>
> = {
  PAY: PAY_LEG_TEMPLATES,
  DEP: DEP_LEG_TEMPLATES,
  DBN: DBN_LEG_TEMPLATES,
  CRN: CRN_LEG_TEMPLATES,
  ADJ: ADJ_LEG_TEMPLATES,
  INV: INV_LEG_TEMPLATES,
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
