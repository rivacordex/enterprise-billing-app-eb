import { describe, expect, it } from "vitest";

import {
  contactFieldsSchema,
  contactMediumIdSchema,
} from "@/validation/customer/contact-medium.schema";

describe("contactMediumIdSchema", () => {
  it("accepts a well-formed CTMD id", () => {
    expect(contactMediumIdSchema.safeParse("CTMD00000001").success).toBe(true);
  });

  it("rejects a wrong-length numeric suffix", () => {
    expect(contactMediumIdSchema.safeParse("CTMD1").success).toBe(false);
  });

  it("rejects a wrong prefix", () => {
    expect(contactMediumIdSchema.safeParse("ORG0000001").success).toBe(false);
  });
});

describe("contactFieldsSchema", () => {
  it("accepts only the required contactName, defaulting every optional to null", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "Jane Doe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        contactName: "Jane Doe",
        contactRole: null,
        phoneNumber: null,
        emailAddress: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        country: null,
      });
    }
  });

  it("trims string fields", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "  Jane Doe  ",
      contactRole: "  Billing Contact  ",
      city: "  Kuala Lumpur  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contactName).toBe("Jane Doe");
      expect(result.data.contactRole).toBe("Billing Contact");
      expect(result.data.city).toBe("Kuala Lumpur");
    }
  });

  it("rejects a missing contactName", () => {
    expect(contactFieldsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty contactName after trimming", () => {
    expect(contactFieldsSchema.safeParse({ contactName: "   " }).success).toBe(
      false,
    );
  });

  it("rejects a malformed emailAddress", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "Jane Doe",
      emailAddress: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed emailAddress", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "Jane Doe",
      emailAddress: "jane@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a phoneNumber shorter than 3 characters", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "Jane Doe",
      phoneNumber: "12",
    });
    expect(result.success).toBe(false);
  });

  it("accepts explicit null for every optional field", () => {
    const result = contactFieldsSchema.safeParse({
      contactName: "Jane Doe",
      contactRole: null,
      phoneNumber: null,
      emailAddress: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      stateProvince: null,
      postalCode: null,
      country: null,
    });
    expect(result.success).toBe(true);
  });
});
