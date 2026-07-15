import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/create-customer.service.test.ts's mocking shape —
// mock `@/db/client` so importing it never triggers `lib/config`'s eager
// env validation.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));

vi.mock("@/db/repositories/organization", () => ({
  organizationRepository: {
    findById: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    compareAndBumpLock: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { updateOrganization } from "@/services/customer/update-organization";
import type { UpdateOrganizationInput } from "@/validation/customer/update-organization.schema";

const mockFindById = vi.mocked(organizationRepository.findById);
const mockUpdate = vi.mocked(organizationRepository.update);
const mockCompareAndBumpLock = vi.mocked(
  partyRoleRepository.compareAndBumpLock,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const SUBMITTED_LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED_LOCK = new Date("2026-01-01T00:00:01.000Z");

const BASE_INPUT: UpdateOrganizationInput = {
  organizationId: "ORG0000001",
  partyRoleId: "PTRL00000001",
  lastModifiedDatetime: SUBMITTED_LOCK,
  name: "Acme Corp",
  tradingName: null,
  organizationType: "COMPANY",
  registrationNumber: "REG-123",
  taxId: null,
  industry: null,
};

const BEFORE_ORG_FIELDS = {
  organizationId: "ORG0000001",
  name: "Old Name",
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
};

const BEFORE_ORG = BEFORE_ORG_FIELDS as never;

const AFTER_ORG = {
  ...BEFORE_ORG_FIELDS,
  name: "Acme Corp",
} as never;

beforeEach(() => {
  mockFindById.mockReset();
  mockUpdate.mockReset();
  mockCompareAndBumpLock.mockReset();
  mockInsertAuditEvent.mockReset();

  mockFindById.mockResolvedValue(BEFORE_ORG);
  mockCompareAndBumpLock.mockResolvedValue(BUMPED_LOCK);
  mockUpdate.mockResolvedValue(AFTER_ORG);
});

describe("updateOrganization", () => {
  it("happy path: compareAndBumpLock called with the exact submitted partyRoleId/lastModifiedDatetime; organization update + audit write both happen; result carries the new timestamp", async () => {
    const result = await updateOrganization(BASE_INPUT, "actor-1");

    expect(mockCompareAndBumpLock).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      SUBMITTED_LOCK,
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      txStub,
      "ORG0000001",
      expect.objectContaining({
        name: "Acme Corp",
        registrationNumber: "REG-123",
        lastModifiedBy: "actor-1",
      }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "ORGANIZATION_UPDATED",
        actorUserId: "actor-1",
        targetEntity: "ORGANIZATION",
        targetId: "ORG0000001",
        beforeData: BEFORE_ORG,
        afterData: AFTER_ORG,
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("compareAndBumpLock returns null -> CONFLICT; organization update and audit write are not called", async () => {
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await updateOrganization(BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("nonexistent organizationId -> ORGANIZATION_NOT_FOUND, no transaction opened", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await updateOrganization(BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("maps a unique-violation on registration_number to DUPLICATE_REGISTRATION_NUMBER", async () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "organization_registration_number_unique",
    });
    mockUpdate.mockRejectedValue(pgError);

    const result = await updateOrganization(BASE_INPUT, "actor-1");

    expect(result).toEqual({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });
  });

  it("propagates any other thrown error unmapped (fail loud)", async () => {
    mockUpdate.mockRejectedValue(new Error("db exploded"));

    await expect(updateOrganization(BASE_INPUT, "actor-1")).rejects.toThrow(
      "db exploded",
    );
  });

  it("never submits a status field on the organization update call", async () => {
    await updateOrganization(BASE_INPUT, "actor-1");

    const [, , updateArgs] = mockUpdate.mock.calls[0]!;
    expect(updateArgs).not.toHaveProperty("status");
  });
});
