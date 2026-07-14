import { describe, expect, it } from "vitest";

import { isStatusInconsistent } from "@/components/customers/inconsistency-banner";
import type { CustomerStatus, OrganizationStatus } from "@/types/customer";

// cm05-spec §2.2 — the two-rule inconsistency check, table-driven over the
// worked examples plus a handful of "ordinary, not inconsistent" pairs.
const CASES: Array<[OrganizationStatus, CustomerStatus, boolean]> = [
  // Rule 1 — ACTIVE customer on a non-ACTIVE organization.
  ["SUSPENDED", "ACTIVE", true],
  ["ACTIVE", "ACTIVE", false],
  ["REGISTERED", "ACTIVE", true],
  // Rule 2 — terminal organization with a non-CLOSED engagement.
  ["DISSOLVED", "INITIALIZED", true],
  ["DISSOLVED", "CLOSED", false],
  ["MERGED", "SUSPENDED", true],
  // Ordinary, not inconsistent.
  ["REGISTERED", "INITIALIZED", false],
  ["ACTIVE", "SUSPENDED", false],
  ["INACTIVE", "VALIDATED", false],
];

describe("isStatusInconsistent", () => {
  for (const [organizationStatus, customerStatus, expected] of CASES) {
    it(`(${organizationStatus}, ${customerStatus}) => ${expected}`, () => {
      expect(isStatusInconsistent(organizationStatus, customerStatus)).toBe(
        expected,
      );
    });
  }
});
