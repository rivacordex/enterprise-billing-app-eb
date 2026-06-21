import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { auditLogSearchParamsSchema } from "@/validation/audit-log-filters.schema";

describe("auditLogSearchParamsSchema", () => {
  it("parses a bare object (all fields null/page absent) to all-null filters and page 1", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
    expect(result).toEqual({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
  });

  it("keeps a valid eventType", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: "USER_CREATED",
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
    expect(result.eventType).toBe("USER_CREATED");
  });

  it("coerces an invalid eventType to null", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: "FAKE_EVENT",
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
    expect(result.eventType).toBeNull();
  });

  it("keeps a valid UUID actorUserId", () => {
    const uuid = randomUUID();
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: uuid,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
    expect(result.actorUserId).toBe(uuid);
  });

  it("coerces an invalid UUID actorUserId to null", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: "not-a-uuid",
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
    expect(result.actorUserId).toBeNull();
  });

  it("keeps a valid dateFrom", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: "2026-01-01",
      dateTo: null,
      page: 1,
    });
    expect(result.dateFrom).toBe("2026-01-01");
  });

  it("coerces an invalid dateFrom to null", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: "not-a-date",
      dateTo: null,
      page: 1,
    });
    expect(result.dateFrom).toBeNull();
  });

  it("coerces an invalid dateTo to null", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: "not-a-date",
      page: 1,
    });
    expect(result.dateTo).toBeNull();
  });

  it("coerces page '3' (string) to the integer 3", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: "3",
    });
    expect(result.page).toBe(3);
  });

  it("coerces page '0' to 1 (minimum enforced, never throws)", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: "0",
    });
    expect(result.page).toBe(1);
  });

  it("defaults page to 1 when given a non-coercible value", () => {
    const result = auditLogSearchParamsSchema.parse({
      eventType: null,
      actorUserId: null,
      dateFrom: null,
      dateTo: null,
      page: "not-a-number",
    });
    expect(result.page).toBe(1);
  });
});
