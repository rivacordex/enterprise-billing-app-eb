import { describe, expect, it } from "vitest";

import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";

const MUTATION_NAME_PATTERN = /^(insert|create|update|delete|remove|set)/;

// Structural no-mutation assert (pm03-spec §3.8 precedent). v1 repositories
// export finders only (cm02-spec Design #2.2.2) — write functions arrive
// JIT in the mutation unit that first needs them.
describe("customer repository exports (structural)", () => {
  it("organizationRepository exports no mutation function", () => {
    const names = Object.keys(organizationRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });

  it("partyRoleRepository exports no mutation function", () => {
    const names = Object.keys(partyRoleRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });

  it("contactMediumRepository exports no mutation function", () => {
    const names = Object.keys(contactMediumRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });
});
