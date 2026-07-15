import { beforeEach, describe, expect, it, vi } from "vitest";

// `create-customer.ts` imports the runtime `db` instance to open its own
// transaction — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation, mirroring
// tests/services/users-write.service.test.ts.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));

vi.mock("@/db/repositories/organization", () => ({
  organizationRepository: {
    insert: vi.fn(),
    findSimilarNames: vi.fn(),
  },
}));
vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    insert: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { createCustomer } from "@/services/customer/create-customer";
import type { CreateCustomerInput } from "@/validation/customer/create-customer.schema";

const mockInsertOrganization = vi.mocked(organizationRepository.insert);
const mockFindSimilarNames = vi.mocked(organizationRepository.findSimilarNames);
const mockInsertPartyRole = vi.mocked(partyRoleRepository.insert);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const BASE_INPUT: CreateCustomerInput = {
  name: "Acme Corp",
  tradingName: null,
  organizationType: "COMPANY",
  registrationNumber: "REG-123",
  taxId: null,
  industry: null,
  specificationRaw: "{}",
  confirmed: false,
};

const ORG_ROW = {
  organizationId: "ORG0000001",
  name: "Acme Corp",
  tradingName: null,
  organizationType: "COMPANY",
  registrationNumber: "REG-123",
  taxId: null,
  industry: null,
  status: "REGISTERED",
  statusReason: null,
  lastModifiedBy: "actor-1",
  createdDatetime: new Date(),
  lastModifiedDatetime: new Date(),
} as never;

const ROLE_ROW = {
  partyRoleId: "PTRL00000001",
  engagedParty: "ORG0000001",
  status: "INITIALIZED",
  statusReason: null,
  partyRoleSpecification: {},
  account: null,
  contactMedium: null,
  lastModifiedBy: "actor-1",
  createdDatetime: new Date(),
  lastModifiedDatetime: new Date(),
} as never;

beforeEach(() => {
  mockInsertOrganization.mockReset();
  mockFindSimilarNames.mockReset();
  mockInsertPartyRole.mockReset();
  mockInsertAuditEvent.mockReset();

  mockFindSimilarNames.mockResolvedValue([]);
  mockInsertOrganization.mockResolvedValue(ORG_ROW);
  mockInsertPartyRole.mockResolvedValue(ROLE_ROW);
});

describe("createCustomer", () => {
  it("happy path: inserts organization then party role, writes both audit events with beforeData null, returns both IDs", async () => {
    const result = await createCustomer(BASE_INPUT, "actor-1");

    expect(mockInsertOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Acme Corp",
        registrationNumber: "REG-123",
        lastModifiedBy: "actor-1",
      }),
    );
    expect(mockInsertPartyRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        engagedParty: "ORG0000001",
        partyRoleSpecification: {},
        lastModifiedBy: "actor-1",
      }),
    );

    expect(mockInsertAuditEvent).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        eventType: "ORGANIZATION_CREATED",
        actorUserId: "actor-1",
        targetEntity: "ORGANIZATION",
        targetId: "ORG0000001",
        beforeData: null,
      }),
    );
    expect(mockInsertAuditEvent).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        eventType: "CUSTOMER_CREATED",
        actorUserId: "actor-1",
        targetEntity: "PARTY_ROLE",
        targetId: "PTRL00000001",
        beforeData: null,
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: { organizationId: "ORG0000001", partyRoleId: "PTRL00000001" },
    });
  });

  it("returns INVALID_SPECIFICATION for malformed JSON, opens no transaction, calls no repository", async () => {
    const result = await createCustomer(
      { ...BASE_INPUT, specificationRaw: "{not json" },
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "INVALID_SPECIFICATION" });
    expect(mockFindSimilarNames).not.toHaveBeenCalled();
    expect(mockInsertOrganization).not.toHaveBeenCalled();
    expect(mockInsertPartyRole).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("confirmed: false + findSimilarNames returns matches -> SIMILAR_NAMES_FOUND, nothing written", async () => {
    mockFindSimilarNames.mockResolvedValue(["Acme Corporation"]);

    const result = await createCustomer(
      { ...BASE_INPUT, confirmed: false },
      "actor-1",
    );

    expect(result).toEqual({
      ok: false,
      code: "SIMILAR_NAMES_FOUND",
      similarNames: ["Acme Corporation"],
    });
    expect(mockInsertOrganization).not.toHaveBeenCalled();
    expect(mockInsertPartyRole).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("confirmed: false + no similar names -> proceeds to create normally", async () => {
    mockFindSimilarNames.mockResolvedValue([]);

    const result = await createCustomer(
      { ...BASE_INPUT, confirmed: false },
      "actor-1",
    );

    expect(result.ok).toBe(true);
    expect(mockInsertOrganization).toHaveBeenCalled();
  });

  it("confirmed: true -> findSimilarNames not called at all, creation proceeds regardless", async () => {
    mockFindSimilarNames.mockResolvedValue(["Would have matched"]);

    const result = await createCustomer(
      { ...BASE_INPUT, confirmed: true },
      "actor-1",
    );

    expect(mockFindSimilarNames).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("maps a unique-violation on registration_number to DUPLICATE_REGISTRATION_NUMBER", async () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "organization_registration_number_unique",
    });
    mockInsertOrganization.mockRejectedValue(pgError);

    const result = await createCustomer(BASE_INPUT, "actor-1");

    expect(result).toEqual({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });
  });

  it("propagates any other thrown error unmapped (fail loud)", async () => {
    mockInsertOrganization.mockRejectedValue(new Error("db exploded"));

    await expect(createCustomer(BASE_INPUT, "actor-1")).rejects.toThrow(
      "db exploded",
    );
  });

  it("never takes initial status from input — the repository insert call carries no status field", async () => {
    await createCustomer(BASE_INPUT, "actor-1");

    const [, orgArgs] = mockInsertOrganization.mock.calls[0]!;
    expect(orgArgs).not.toHaveProperty("status");

    const [, roleArgs] = mockInsertPartyRole.mock.calls[0]!;
    expect(roleArgs).not.toHaveProperty("status");
  });
});
