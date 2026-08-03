// close-FA (ac16-spec §2.1/§2.5, §3.2) — gate (live unapplied = 0, deposits =
// 0, all BANs closed) + `state = closed` + audit, all inside one transaction.
// Same shape as `close-billing-account.ts`.

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { canCloseFinancialAccount } from "@/services/accounts/closure-eligibility";
import type { CloseFinancialAccountInput } from "@/validation/accounts/close-account.schema";

export type { CloseFinancialAccountInput };

export type CloseFinancialAccountResult =
  | {
      ok: true;
      value: {
        financialAccountId: string;
        state: "closed";
        lastModified: Date;
      };
    }
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | {
      ok: false;
      code: "CLOSURE_BLOCKED";
      unappliedCash: string;
      deposits: string;
      openBillingAccountIds: string[];
    }
  | { ok: false; code: "ALREADY_CLOSED" }
  | { ok: false; code: "CONFLICT" };

export async function closeFinancialAccount(
  input: CloseFinancialAccountInput,
  actorId: string,
): Promise<CloseFinancialAccountResult> {
  return db.transaction(async (tx) => {
    const before = await financialAccountRepository.findById(
      tx,
      input.financialAccountId,
    );
    if (!before) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };
    if (before.state === "closed") return { ok: false, code: "ALREADY_CLOSED" };

    const eligibility = await canCloseFinancialAccount(
      tx,
      input.financialAccountId,
    );
    if (!eligibility.ok) return { ok: false, code: eligibility.code };
    if (!eligibility.eligible) {
      return {
        ok: false,
        code: "CLOSURE_BLOCKED",
        unappliedCash: eligibility.unappliedCash,
        deposits: eligibility.deposits,
        openBillingAccountIds: eligibility.openBillingAccountIds,
      };
    }

    const closed = await financialAccountRepository.close(
      tx,
      input.financialAccountId,
      input.lastModified,
    );
    if (closed === "not_found") {
      return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };
    }
    if (closed === "already_closed")
      return { ok: false, code: "ALREADY_CLOSED" };
    if (closed === "conflict") return { ok: false, code: "CONFLICT" };

    const after = await financialAccountRepository.findById(
      tx,
      input.financialAccountId,
    );
    if (!after) {
      throw new Error(
        `financial_account ${input.financialAccountId} not found after close`,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "ACCOUNT_CLOSED",
      actorUserId: actorId,
      targetEntity: "FINANCIAL_ACCOUNT",
      targetId: input.financialAccountId,
      beforeData: { state: before.state },
      afterData: { state: after.state },
    });

    return {
      ok: true,
      value: {
        financialAccountId: input.financialAccountId,
        state: "closed",
        lastModified: after.lastModified,
      },
    };
  });
}
