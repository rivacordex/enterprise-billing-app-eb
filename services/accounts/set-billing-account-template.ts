// cm21 (binding plan D3/D12/D15, custmgmt Inv. #16/#17/#18) — set a BAN's
// invoice template reference, in v1 only ever back to NULL ("follow the
// active template"). One transaction, in this order:
//
//   1. assertBindableTemplate        → TEMPLATE_NOT_BINDABLE (v1: any non-NULL)
//   2. BAN missing, or owned by a different party role
//                                    → BAN_NOT_FOUND (no cross-customer reset)
//   3. BAN closed                    → BAN_CLOSED
//   4. stale lastModified            → CONFLICT
//   5. value unchanged               → ok, changed: false; no write, no audit
//   6. CAS write on billing_account.last_modified (lost race → CONFLICT)
//   7. BILLING_ACCOUNT_TEMPLATE_CHANGED audit event, before/after values
//
// The lock is the BAN's own last_modified (the ac16 `close` precedent), never
// party_role.last_modified_datetime, which is neither read nor bumped (Inv.
// #17). Permissions are the action's job (Inv. #16).

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { assertBindableTemplate } from "@/services/accounts/assert-bindable-template";
import type { SetBillingAccountTemplateInput } from "@/validation/accounts/set-billing-account-template.schema";

export type { SetBillingAccountTemplateInput };

export type SetBillingAccountTemplateResult =
  | {
      ok: true;
      value: { billingAccountId: string; changed: boolean; lastModified: Date };
    }
  | {
      ok: false;
      code:
        | "BAN_NOT_FOUND"
        | "BAN_CLOSED"
        | "CONFLICT"
        | "TEMPLATE_NOT_BINDABLE";
    };

export async function setBillingAccountTemplate(
  input: SetBillingAccountTemplateInput,
  actorId: string,
): Promise<SetBillingAccountTemplateResult> {
  return db.transaction(async (tx) => {
    const bindable = await assertBindableTemplate(
      tx,
      input.billTemplateVersionId,
    );
    if (!bindable.ok) return { ok: false, code: bindable.code };

    const before = await billingAccountRepository.findById(
      tx,
      input.billingAccountId,
    );
    if (!before || before.refPartyRoleId !== input.partyRoleId) {
      return { ok: false, code: "BAN_NOT_FOUND" };
    }
    if (before.state === "closed") return { ok: false, code: "BAN_CLOSED" };
    if (before.lastModified.getTime() !== input.lastModified.getTime()) {
      return { ok: false, code: "CONFLICT" };
    }

    if (before.refBillTemplateVersionId === input.billTemplateVersionId) {
      return {
        ok: true,
        value: {
          billingAccountId: input.billingAccountId,
          changed: false,
          lastModified: before.lastModified,
        },
      };
    }

    const written = await billingAccountRepository.setTemplateRef(
      tx,
      input.billingAccountId,
      input.lastModified,
      input.billTemplateVersionId,
      actorId,
    );
    if (written === "not_found") return { ok: false, code: "BAN_NOT_FOUND" };
    if (written === "closed") return { ok: false, code: "BAN_CLOSED" };
    if (written === "conflict") return { ok: false, code: "CONFLICT" };

    const after = await billingAccountRepository.findById(
      tx,
      input.billingAccountId,
    );
    if (!after) {
      throw new Error(
        `billing_account ${input.billingAccountId} not found after template reset`,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED",
      actorUserId: actorId,
      targetEntity: "BILLING_ACCOUNT",
      targetId: input.billingAccountId,
      beforeData: { refBillTemplateVersionId: before.refBillTemplateVersionId },
      afterData: { refBillTemplateVersionId: input.billTemplateVersionId },
    });

    return {
      ok: true,
      value: {
        billingAccountId: input.billingAccountId,
        changed: true,
        lastModified: after.lastModified,
      },
    };
  });
}
