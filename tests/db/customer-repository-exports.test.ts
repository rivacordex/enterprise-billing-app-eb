import { describe, expect, it } from "vitest";

import { contactMediumRepository } from "@/db/repositories/contact-medium";

const MUTATION_NAME_PATTERN = /^(insert|create|update|delete|remove|set)/;

// Structural no-mutation assert (pm03-spec §3.8 precedent). v1 repositories
// export finders only (cm02-spec Design #2.2.2) — write functions arrive
// JIT in the mutation unit that first needs them. `organizationRepository`
// and `partyRoleRepository` graduate out of this guardrail as of cm07,
// which is exactly that JIT unit (cm07-spec §3.1/§3.2, and this file's own
// prior comment anticipating it) — only `contactMediumRepository` (cm11+)
// remains finder-only.
describe("customer repository exports (structural)", () => {
  it("contactMediumRepository exports no mutation function", () => {
    const names = Object.keys(contactMediumRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });
});
