import { beforeEach, describe, expect, it, vi } from "vitest";

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));

vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    findById: vi.fn(),
    compareAndUpdateSpecification: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { partyRoleRepository } from "@/db/repositories/party-role";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { updatePartyRoleSpecification } from "@/services/customer/update-party-role-specification";
import type { UpdatePartyRoleSpecificationInput } from "@/validation/customer/update-party-role-specification.schema";

const mockFindById = vi.mocked(partyRoleRepository.findById);
const mockCompareAndUpdateSpecification = vi.mocked(
  partyRoleRepository.compareAndUpdateSpecification,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const SUBMITTED_LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED_LOCK = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  specificationRaw: string,
): UpdatePartyRoleSpecificationInput {
  return {
    partyRoleId: "PTRL00000001",
    specificationRaw,
    lastModifiedDatetime: SUBMITTED_LOCK,
  };
}

function buildPartyRole(
  partyRoleSpecification: Record<string, unknown>,
  lastModifiedDatetime: Date = SUBMITTED_LOCK,
) {
  return {
    partyRoleId: "PTRL00000001",
    engagedParty: "ORG0000001",
    status: "INITIALIZED",
    statusReason: null,
    partyRoleSpecification,
    account: null,
    contactMedium: null,
    lastModifiedBy: "actor-1",
    createdDatetime: new Date(),
    lastModifiedDatetime,
  } as never;
}

beforeEach(() => {
  mockFindById.mockReset();
  mockCompareAndUpdateSpecification.mockReset();
  mockInsertAuditEvent.mockReset();
});

describe("updatePartyRoleSpecification", () => {
  it("malformed JSON -> INVALID_SPECIFICATION, no transaction", async () => {
    mockFindById.mockResolvedValue(buildPartyRole({}));

    const result = await updatePartyRoleSpecification(
      buildInput("{not valid json"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "INVALID_SPECIFICATION" });
    expect(mockCompareAndUpdateSpecification).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("an array or primitive at the top level -> INVALID_SPECIFICATION", async () => {
    mockFindById.mockResolvedValue(buildPartyRole({}));

    const result = await updatePartyRoleSpecification(
      buildInput("[1,2,3]"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "INVALID_SPECIFICATION" });
    expect(mockCompareAndUpdateSpecification).not.toHaveBeenCalled();
  });

  it("nonexistent partyRoleId -> PARTY_ROLE_NOT_FOUND, no transaction", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await updatePartyRoleSpecification(
      buildInput("{}"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "PARTY_ROLE_NOT_FOUND" });
    expect(mockCompareAndUpdateSpecification).not.toHaveBeenCalled();
  });

  it("compareAndUpdateSpecification returns null -> CONFLICT, no audit", async () => {
    mockFindById.mockResolvedValue(buildPartyRole({}));
    mockCompareAndUpdateSpecification.mockResolvedValue(null);

    const result = await updatePartyRoleSpecification(
      buildInput('{"CUST_TYPE":"enterprise"}'),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("valid object -> saved and audited (PARTY_ROLE_SPECIFICATION_UPDATED)", async () => {
    mockFindById.mockResolvedValue(buildPartyRole({ CUST_TYPE: "legacy" }));
    mockCompareAndUpdateSpecification.mockResolvedValue(
      buildPartyRole({ CUST_TYPE: "enterprise" }, BUMPED_LOCK),
    );

    const result = await updatePartyRoleSpecification(
      buildInput('{"CUST_TYPE":"enterprise"}'),
      "actor-1",
    );

    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
    expect(mockCompareAndUpdateSpecification).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      SUBMITTED_LOCK,
      {
        partyRoleSpecification: { CUST_TYPE: "enterprise" },
        lastModifiedBy: "actor-1",
      },
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "PARTY_ROLE_SPECIFICATION_UPDATED",
        actorUserId: "actor-1",
        targetEntity: "PARTY_ROLE",
        targetId: "PTRL00000001",
        beforeData: { partyRoleSpecification: { CUST_TYPE: "legacy" } },
        afterData: { partyRoleSpecification: { CUST_TYPE: "enterprise" } },
      }),
    );
  });
});
