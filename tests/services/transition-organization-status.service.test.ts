import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/update-organization.service.test.ts's mocking shape
// — mock `@/db/client` so importing it never triggers `lib/config`'s eager
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
    updateStatus: vi.fn(),
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
import { transitionOrganizationStatus } from "@/services/customer/transition-organization-status";
import { ORGANIZATION_TRANSITIONS } from "@/validation/customer/transitions";
import type { TransitionOrganizationStatusInput } from "@/validation/customer/transition-organization-status.schema";
import type { OrganizationStatus } from "@/types/customer";

const mockFindById = vi.mocked(organizationRepository.findById);
const mockUpdateStatus = vi.mocked(organizationRepository.updateStatus);
const mockCompareAndBumpLock = vi.mocked(
  partyRoleRepository.compareAndBumpLock,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const SUBMITTED_LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED_LOCK = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  targetStatus: OrganizationStatus,
): TransitionOrganizationStatusInput {
  return {
    organizationId: "ORG0000001",
    partyRoleId: "PTRL00000001",
    targetStatus,
    statusReason: "Customer confirmed active trading.",
    lastModifiedDatetime: SUBMITTED_LOCK,
  };
}

function buildOrganization(
  status: OrganizationStatus,
  statusReason: string | null,
) {
  return {
    organizationId: "ORG0000001",
    name: "Acme Corp",
    tradingName: null,
    organizationType: "COMPANY",
    registrationNumber: "REG-123",
    taxId: null,
    industry: null,
    status,
    statusReason,
    lastModifiedBy: "actor-1",
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  } as never;
}

beforeEach(() => {
  mockFindById.mockReset();
  mockUpdateStatus.mockReset();
  mockCompareAndBumpLock.mockReset();
  mockInsertAuditEvent.mockReset();

  mockCompareAndBumpLock.mockResolvedValue(BUMPED_LOCK);
});

describe("transitionOrganizationStatus", () => {
  it.each(
    Object.entries(ORGANIZATION_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => [from, to] as const),
    ),
  )("accepts the valid edge %s -> %s", async (from, to) => {
    mockFindById.mockResolvedValue(
      buildOrganization(from as OrganizationStatus, null),
    );
    mockUpdateStatus.mockResolvedValue(
      buildOrganization(
        to as OrganizationStatus,
        "Customer confirmed active trading.",
      ),
    );

    const result = await transitionOrganizationStatus(
      buildInput(to as OrganizationStatus),
      "actor-1",
    );

    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "ORG0000001",
      expect.objectContaining({
        status: to,
        statusReason: "Customer confirmed active trading.",
        lastModifiedBy: "actor-1",
      }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "ORGANIZATION_STATUS_CHANGED",
        actorUserId: "actor-1",
        targetEntity: "ORGANIZATION",
        targetId: "ORG0000001",
      }),
    );
  });

  const ALL_NON_EDGES = Object.entries(ORGANIZATION_TRANSITIONS).flatMap(
    ([from, targets]) =>
      (Object.keys(ORGANIZATION_TRANSITIONS) as OrganizationStatus[])
        .filter((to) => to !== from && !targets.includes(to))
        .map((to) => [from, to] as const),
  );

  it.each(ALL_NON_EDGES)(
    "rejects the non-edge %s -> %s with INVALID_TRANSITION before any lock/transaction call",
    async (from, to) => {
      mockFindById.mockResolvedValue(
        buildOrganization(from as OrganizationStatus, null),
      );

      const result = await transitionOrganizationStatus(
        buildInput(to as OrganizationStatus),
        "actor-1",
      );

      expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
      expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("compareAndBumpLock returns null -> CONFLICT; no status write, no audit", async () => {
    mockFindById.mockResolvedValue(buildOrganization("REGISTERED", null));
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await transitionOrganizationStatus(
      buildInput("ACTIVE"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("nonexistent organizationId -> ORGANIZATION_NOT_FOUND, no lock/transaction call", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await transitionOrganizationStatus(
      buildInput("ACTIVE"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it("happy path persists status_reason on the row and in the audit afterData", async () => {
    mockFindById.mockResolvedValue(buildOrganization("REGISTERED", null));
    const after = buildOrganization(
      "ACTIVE",
      "Customer confirmed active trading.",
    );
    mockUpdateStatus.mockResolvedValue(after);

    await transitionOrganizationStatus(buildInput("ACTIVE"), "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        beforeData: { status: "REGISTERED", statusReason: null },
        afterData: {
          status: "ACTIVE",
          statusReason: "Customer confirmed active trading.",
        },
      }),
    );
  });
});
