import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/transition-organization-status.service.test.ts's
// mocking shape — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));

vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    findById: vi.fn(),
    compareAndUpdateStatus: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { partyRoleRepository } from "@/db/repositories/party-role";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { transitionCustomerStatus } from "@/services/customer/transition-customer-status";
import { CUSTOMER_TRANSITIONS } from "@/validation/customer/transitions";
import type { TransitionCustomerStatusInput } from "@/validation/customer/transition-customer-status.schema";
import type { CustomerStatus } from "@/types/customer";

const mockFindById = vi.mocked(partyRoleRepository.findById);
const mockCompareAndUpdateStatus = vi.mocked(
  partyRoleRepository.compareAndUpdateStatus,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const SUBMITTED_LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED_LOCK = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  targetStatus: CustomerStatus,
): TransitionCustomerStatusInput {
  return {
    partyRoleId: "PTRL00000001",
    targetStatus,
    statusReason: "Validation checks completed.",
    lastModifiedDatetime: SUBMITTED_LOCK,
  };
}

function buildPartyRole(
  status: CustomerStatus,
  statusReason: string | null,
  lastModifiedDatetime: Date = SUBMITTED_LOCK,
) {
  return {
    partyRoleId: "PTRL00000001",
    engagedParty: "ORG0000001",
    status,
    statusReason,
    partyRoleSpecification: {},
    account: null,
    contactMedium: null,
    lastModifiedBy: "actor-1",
    createdDatetime: new Date(),
    lastModifiedDatetime,
  } as never;
}

beforeEach(() => {
  mockFindById.mockReset();
  mockCompareAndUpdateStatus.mockReset();
  mockInsertAuditEvent.mockReset();
});

describe("transitionCustomerStatus", () => {
  it.each(
    Object.entries(CUSTOMER_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => [from, to] as const),
    ),
  )("accepts the valid edge %s -> %s", async (from, to) => {
    mockFindById.mockResolvedValue(
      buildPartyRole(from as CustomerStatus, null),
    );
    mockCompareAndUpdateStatus.mockResolvedValue(
      buildPartyRole(
        to as CustomerStatus,
        "Validation checks completed.",
        BUMPED_LOCK,
      ),
    );

    const result = await transitionCustomerStatus(
      buildInput(to as CustomerStatus),
      "actor-1",
    );

    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
    expect(mockCompareAndUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      SUBMITTED_LOCK,
      {
        status: to,
        statusReason: "Validation checks completed.",
        lastModifiedBy: "actor-1",
      },
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "CUSTOMER_STATUS_CHANGED",
        actorUserId: "actor-1",
        targetEntity: "PARTY_ROLE",
        targetId: "PTRL00000001",
      }),
    );
  });

  const ALL_NON_EDGES = Object.entries(CUSTOMER_TRANSITIONS).flatMap(
    ([from, targets]) =>
      (Object.keys(CUSTOMER_TRANSITIONS) as CustomerStatus[])
        .filter((to) => to !== from && !targets.includes(to))
        .map((to) => [from, to] as const),
  );

  it.each(ALL_NON_EDGES)(
    "rejects the non-edge %s -> %s with INVALID_TRANSITION before any lock/transaction call",
    async (from, to) => {
      mockFindById.mockResolvedValue(
        buildPartyRole(from as CustomerStatus, null),
      );

      const result = await transitionCustomerStatus(
        buildInput(to as CustomerStatus),
        "actor-1",
      );

      expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
      expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
      expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects INITIALIZED -> ACTIVE directly (no skipping VALIDATED)", async () => {
    mockFindById.mockResolvedValue(buildPartyRole("INITIALIZED", null));

    const result = await transitionCustomerStatus(
      buildInput("ACTIVE"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("compareAndUpdateStatus returns null -> CONFLICT; no audit", async () => {
    mockFindById.mockResolvedValue(buildPartyRole("INITIALIZED", null));
    mockCompareAndUpdateStatus.mockResolvedValue(null);

    const result = await transitionCustomerStatus(
      buildInput("VALIDATED"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("nonexistent partyRoleId -> PARTY_ROLE_NOT_FOUND, no lock/transaction call", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await transitionCustomerStatus(
      buildInput("VALIDATED"),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "PARTY_ROLE_NOT_FOUND" });
    expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("happy path persists status_reason on the row and in the audit afterData", async () => {
    mockFindById.mockResolvedValue(buildPartyRole("INITIALIZED", null));
    const after = buildPartyRole("VALIDATED", "Validation checks completed.");
    mockCompareAndUpdateStatus.mockResolvedValue(after);

    await transitionCustomerStatus(buildInput("VALIDATED"), "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        beforeData: { status: "INITIALIZED", statusReason: null },
        afterData: {
          status: "VALIDATED",
          statusReason: "Validation checks completed.",
        },
      }),
    );
  });
});
