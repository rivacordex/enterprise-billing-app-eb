import { describe, expect, it } from "vitest";

import { allocatePaymentSchema } from "@/validation/accounts/allocate-payment.schema";

// Owner decision 2026-11-13 — every PAY allocation must name the INV/DBN it
// settles; `refSettledDocumentId` is no longer optional at the action boundary.
const base = {
  financialAccountId: "FIN00000001",
  billingAccountId: "BAN00000001",
  amount: "5400.00",
  eventAt: "2026-11-13",
  entryDate: "2026-11-13",
  referenceInfo: "TT-55120",
};

describe("allocatePaymentSchema — refSettledDocumentId is required", () => {
  it.each(["INV00000042", "DBN00000042"])("parses with %s", (id) => {
    const parsed = allocatePaymentSchema.safeParse({
      ...base,
      refSettledDocumentId: id,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.refSettledDocumentId).toBe(id);
  });

  it("rejects when omitted", () => {
    const parsed = allocatePaymentSchema.safeParse(base);
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.flatten().fieldErrors.refSettledDocumentId,
    ).toHaveLength(1);
  });

  it.each([null, "", "   ", "DBN42", "BAN00000001", "inv00000042"])(
    "rejects %j with a field error",
    (refSettledDocumentId) => {
      const parsed = allocatePaymentSchema.safeParse({
        ...base,
        refSettledDocumentId,
      });
      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.flatten().fieldErrors.refSettledDocumentId,
      ).toHaveLength(1);
    },
  );
});
