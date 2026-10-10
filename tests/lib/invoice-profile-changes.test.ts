import { describe, expect, it } from "vitest";

import {
  describeProfileChanges,
  paymentFieldsChanged,
} from "@/lib/invoice-profile-changes";

// bm61-spec §Design D4–D6 — the one definition of "bank details changed"
// (the dialog's warning and G14 option C's four-eyes trigger) and the
// dialog's `label: old → new` diff.

const ACTIVE = {
  company_name: "Old Co",
  city: "Kuala Lumpur",
  bank_name: "Maybank",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  remittance_email: "ar@old.example",
  jompay_biller_code: null,
};

describe("paymentFieldsChanged", () => {
  it("is false when only non-payment fields change", () => {
    expect(
      paymentFieldsChanged(ACTIVE, {
        ...ACTIVE,
        city: "Ipoh",
        company_name: "New",
      }),
    ).toBe(false);
  });

  it.each([
    "bank_name",
    "bank_account_name",
    "bank_account_no",
    "swift",
    "jompay_biller_code",
    "remittance_email",
  ])("is true when %s changes", (key) => {
    expect(paymentFieldsChanged(ACTIVE, { ...ACTIVE, [key]: "changed" })).toBe(
      true,
    );
  });

  it("treats blank and null as the same (no spurious change)", () => {
    expect(
      paymentFieldsChanged(ACTIVE, { ...ACTIVE, jompay_biller_code: "  " }),
    ).toBe(false);
  });

  it("counts the first activation (no ACTIVE version) as a bank change", () => {
    expect(paymentFieldsChanged(null, ACTIVE)).toBe(true);
  });
});

describe("describeProfileChanges", () => {
  it("lists label: old → new for changed fields only, account numbers in full", () => {
    expect(
      describeProfileChanges(ACTIVE, {
        ...ACTIVE,
        bank_account_no: "9999-0000-1111",
        city: "Ipoh",
      }),
    ).toEqual([
      { key: "city", label: "City", from: "Kuala Lumpur", to: "Ipoh" },
      {
        key: "bank_account_no",
        label: "Account no.",
        from: "5140-1234-5678",
        to: "9999-0000-1111",
      },
    ]);
  });

  it("with no ACTIVE version every set field is new", () => {
    const changes = describeProfileChanges(null, { company_name: "First Co" });
    expect(changes).toEqual([
      { key: "company_name", label: "Legal name", from: null, to: "First Co" },
    ]);
  });
});
