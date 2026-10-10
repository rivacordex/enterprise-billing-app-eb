import { describe, expect, it, vi } from "vitest";

// bm57: only a lost race on the working draft is a DRAFT_CONFLICT. A unique
// violation from anywhere else in the save transaction (the audit insert, a
// ULID clash) is a real fault and must not be reported as "another user
// changed the draft".

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {},
}));

import { isDraftRaceViolation } from "@/services/billing/invoice-template/save-template-draft";

describe("isDraftRaceViolation", () => {
  it.each(["btv_one_draft_uq", "btv_version_uq"])(
    "is true for a 23505 on %s",
    (constraint_name) => {
      expect(isDraftRaceViolation({ code: "23505", constraint_name })).toBe(
        true,
      );
    },
  );

  it("reads the code and constraint from a wrapped `cause` too", () => {
    expect(
      isDraftRaceViolation({
        message: "Failed query",
        cause: { code: "23505", constraint_name: "btv_one_draft_uq" },
      }),
    ).toBe(true);
  });

  it("is false for a 23505 on any other constraint (e.g. the audit table)", () => {
    expect(
      isDraftRaceViolation({
        code: "23505",
        constraint_name: "audit_log_audit_id_created_datetime_pk",
      }),
    ).toBe(false);
  });

  it("is false for a 23505 with no constraint name", () => {
    expect(isDraftRaceViolation({ code: "23505" })).toBe(false);
  });

  it("is false for other SQLSTATEs and non-errors", () => {
    expect(
      isDraftRaceViolation({
        code: "23001",
        constraint_name: "btv_one_draft_uq",
      }),
    ).toBe(false);
    expect(isDraftRaceViolation(new Error("boom"))).toBe(false);
    expect(isDraftRaceViolation(undefined)).toBe(false);
  });
});
