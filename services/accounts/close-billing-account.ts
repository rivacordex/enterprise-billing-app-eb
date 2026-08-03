// close-BAN (ac16-spec §2.1/§2.5, §3.2) — gate (live A/R = 0) + `state =
// closed` + audit, all inside one transaction so a concurrent posting racing
// the closure can't slip through (Module Inv. #2's live-read requirement
// extends to the gate check itself, not just the eventual guard in
// post-document.ts). No ledger transfer is posted by closure itself — it is
// a state change after the last real transfer, only permitted at zero.

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { canCloseBillingAccount } from "@/services/accounts/closure-eligibility";
import type { CloseBillingAccountInput } from "@/validation/accounts/close-account.schema";

export type { CloseBillingAccountInput };

export type CloseBillingAccountResult =
  | {
      ok: true;
      value: {
        billingAccountId: string;
        state: "closed";
        lastModified: Date;
      };
    }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "CLOSURE_BLOCKED"; openReceivable: string }
  | { ok: false; code: "ALREADY_CLOSED" }
  | { ok: false; code: "CONFLICT" };

export async function closeBillingAccount(
  input: CloseBillingAccountInput,
  actorId: string,
): Promise<CloseBillingAccountResult> {
  return db.transaction(async (tx) => {
    const before = await billingAccountRepository.findById(
      tx,
      input.billingAccountId,
    );
    if (!before) return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
    if (before.state === "closed") return { ok: false, code: "ALREADY_CLOSED" };

    const eligibility = await canCloseBillingAccount(
      tx,
      input.billingAccountId,
    );
    if (!eligibility.ok) return { ok: false, code: eligibility.code };
    if (!eligibility.eligible) {
      return {
        ok: false,
        code: "CLOSURE_BLOCKED",
        openReceivable: eligibility.openReceivable,
      };
    }

    const closed = await billingAccountRepository.close(
      tx,
      input.billingAccountId,
      input.lastModified,
    );
    if (closed === "not_found") {
      return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
    }
    if (closed === "already_closed")
      return { ok: false, code: "ALREADY_CLOSED" };
    if (closed === "conflict") return { ok: false, code: "CONFLICT" };

    const after = await billingAccountRepository.findById(
      tx,
      input.billingAccountId,
    );
    if (!after) {
      throw new Error(
        `billing_account ${input.billingAccountId} not found after close`,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "ACCOUNT_CLOSED",
      actorUserId: actorId,
      targetEntity: "BILLING_ACCOUNT",
      targetId: input.billingAccountId,
      beforeData: { state: before.state },
      afterData: { state: after.state },
    });

    return {
      ok: true,
      value: {
        billingAccountId: input.billingAccountId,
        state: "closed",
        lastModified: after.lastModified,
      },
    };
  });
}
