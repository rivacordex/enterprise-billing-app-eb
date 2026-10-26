import { beforeEach, describe, expect, it, vi } from "vitest";

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { findById: vi.fn(), setTemplateRef: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { findById: vi.fn() },
}));
vi.mock("@/services/accounts/assert-bindable-template", () => ({
  assertBindableTemplate: vi.fn(),
}));

import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { assertBindableTemplate } from "@/services/accounts/assert-bindable-template";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import type { SetBillingAccountTemplateInput } from "@/validation/accounts/set-billing-account-template.schema";

// cm21-spec §2 / cm23-spec D3 — the bind service, steps 1–7 in one
// transaction. The lock is the BAN's own last_modified; party_role is never
// touched (Inv. #17). The audit carries type id and name before and after.
const mockFindById = vi.mocked(billingAccountRepository.findById);
const mockSetTemplateRef = vi.mocked(billingAccountRepository.setTemplateRef);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockFindType = vi.mocked(billTemplateFamilyRepository.findById);
const mockGate = vi.mocked(assertBindableTemplate);

const LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  overrides: Partial<SetBillingAccountTemplateInput> = {},
): SetBillingAccountTemplateInput {
  return {
    partyRoleId: "PTRL00000001",
    billingAccountId: "BAN000001",
    typeId: null,
    lastModified: LOCK,
    ...overrides,
  };
}

function buildBan(
  overrides: Partial<{
    refPartyRoleId: string;
    state: string;
    lastModified: Date;
    refBillTemplateFamilyId: string | null;
  }> = {},
) {
  return {
    billingAccountId: "BAN000001",
    refPartyRoleId: "PTRL00000001",
    state: "active",
    lastModified: LOCK,
    refBillTemplateFamilyId: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGate.mockImplementation((_tx, typeId) =>
    Promise.resolve({
      ok: true,
      typeName: typeId === null ? null : "Wholesale",
    }),
  );
});

describe("setBillingAccountTemplate (cm23)", () => {
  it("a gate refusal → TEMPLATE_NOT_BINDABLE, no repository call", async () => {
    mockGate.mockResolvedValue({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000003" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });
    expect(mockGate).toHaveBeenCalledWith(txStub, "BTF00000003");
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a missing BAN → BAN_NOT_FOUND", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "BAN_NOT_FOUND" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
  });

  it("a BAN of another party role → BAN_NOT_FOUND (no cross-customer bind)", async () => {
    mockFindById.mockResolvedValue(
      buildBan({ refPartyRoleId: "PTRL00000002" }),
    );

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000002" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "BAN_NOT_FOUND" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a closed BAN → BAN_CLOSED", async () => {
    mockFindById.mockResolvedValue(buildBan({ state: "closed" }));

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000002" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "BAN_CLOSED" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
  });

  it("a stale lastModified → CONFLICT", async () => {
    mockFindById.mockResolvedValue(buildBan({ lastModified: BUMPED }));

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000002" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
  });

  it.each([
    ["Standard (null)", null],
    ["the same type", "BTF00000002"],
  ])(
    "an unchanged value (%s) → ok, changed: false, no write and no audit",
    async (_name, typeId) => {
      mockFindById.mockResolvedValue(
        buildBan({ refBillTemplateFamilyId: typeId }),
      );

      const result = await setBillingAccountTemplate(
        buildInput({ typeId }),
        "actor-1",
      );

      expect(result).toEqual({
        ok: true,
        value: {
          billingAccountId: "BAN000001",
          changed: false,
          lastModified: LOCK,
        },
      });
      expect(mockSetTemplateRef).not.toHaveBeenCalled();
      expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("Standard → a type writes via CAS and audits type ids and names", async () => {
    mockFindById.mockResolvedValueOnce(buildBan()).mockResolvedValueOnce(
      buildBan({
        lastModified: BUMPED,
        refBillTemplateFamilyId: "BTF00000002",
      }),
    );
    mockSetTemplateRef.mockResolvedValue("updated");

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000002" }),
      "actor-1",
    );

    expect(result).toEqual({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: true,
        lastModified: BUMPED,
      },
    });
    expect(mockSetTemplateRef).toHaveBeenCalledWith(
      txStub,
      "BAN000001",
      LOCK,
      "BTF00000002",
      "actor-1",
    );
    expect(mockFindType).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(txStub, {
      eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED",
      actorUserId: "actor-1",
      targetEntity: "BILLING_ACCOUNT",
      targetId: "BAN000001",
      beforeData: {
        refBillTemplateFamilyId: null,
        typeName: "Standard (default)",
      },
      afterData: {
        refBillTemplateFamilyId: "BTF00000002",
        typeName: "Wholesale",
      },
    });
  });

  it("a type → Standard writes NULL and names the old type from the repository", async () => {
    mockFindById
      .mockResolvedValueOnce(
        buildBan({ refBillTemplateFamilyId: "BTF00000002" }),
      )
      .mockResolvedValueOnce(buildBan({ lastModified: BUMPED }));
    mockSetTemplateRef.mockResolvedValue("updated");
    mockFindType.mockResolvedValue({ name: "Wholesale" } as never);

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result.ok).toBe(true);
    expect(mockSetTemplateRef).toHaveBeenCalledWith(
      txStub,
      "BAN000001",
      LOCK,
      null,
      "actor-1",
    );
    expect(mockFindType).toHaveBeenCalledWith(txStub, "BTF00000002");
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        beforeData: {
          refBillTemplateFamilyId: "BTF00000002",
          typeName: "Wholesale",
        },
        afterData: {
          refBillTemplateFamilyId: null,
          typeName: "Standard (default)",
        },
      }),
    );
    const payload = mockInsertAuditEvent.mock.calls[0]?.[1] as object;
    expect(payload).not.toHaveProperty("reason");
  });

  it("a lost CAS race → CONFLICT, no audit", async () => {
    mockFindById.mockResolvedValue(buildBan());
    mockSetTemplateRef.mockResolvedValue("conflict");

    const result = await setBillingAccountTemplate(
      buildInput({ typeId: "BTF00000002" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
