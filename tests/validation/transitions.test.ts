import { describe, expect, it } from "vitest";

import {
  CUSTOMER_TRANSITIONS,
  ORGANIZATION_TRANSITIONS,
} from "@/validation/customer/transitions";

// A structural test that fails loudly if a future edit silently narrows or
// widens either map without updating cm02-spec and the architecture doc
// together (cm02-spec §3.12, workflow §7.3).
describe("ORGANIZATION_TRANSITIONS", () => {
  it("contains exactly the edges in cm02-spec §3.2 — no more, no fewer", () => {
    expect(ORGANIZATION_TRANSITIONS).toEqual({
      REGISTERED: ["ACTIVE", "DISSOLVED"],
      ACTIVE: ["INACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
      INACTIVE: ["ACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
      SUSPENDED: ["ACTIVE", "INACTIVE", "DISSOLVED", "MERGED"],
      DISSOLVED: [],
      MERGED: [],
    });
  });
});

describe("CUSTOMER_TRANSITIONS", () => {
  it("contains exactly the edges in cm02-spec §3.2 — no more, no fewer", () => {
    expect(CUSTOMER_TRANSITIONS).toEqual({
      INITIALIZED: ["VALIDATED", "CLOSED"],
      VALIDATED: ["ACTIVE", "CLOSED"],
      ACTIVE: ["SUSPENDED", "CLOSED"],
      SUSPENDED: ["ACTIVE", "CLOSED"],
      CLOSED: [],
    });
  });

  it("never allows INITIALIZED to skip VALIDATED and reach ACTIVE directly", () => {
    expect(CUSTOMER_TRANSITIONS.INITIALIZED).not.toContain("ACTIVE");
  });

  it("allows every non-terminal state to reach CLOSED", () => {
    expect(CUSTOMER_TRANSITIONS.INITIALIZED).toContain("CLOSED");
    expect(CUSTOMER_TRANSITIONS.VALIDATED).toContain("CLOSED");
    expect(CUSTOMER_TRANSITIONS.ACTIVE).toContain("CLOSED");
    expect(CUSTOMER_TRANSITIONS.SUSPENDED).toContain("CLOSED");
  });

  it("CLOSED is terminal", () => {
    expect(CUSTOMER_TRANSITIONS.CLOSED).toEqual([]);
  });
});
