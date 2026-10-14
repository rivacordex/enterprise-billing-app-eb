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

import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import type { SetBillingAccountTemplateInput } from "@/validation/accounts/set-billing-account-template.schema";

// cm21-spec §2/§3.4 — the reset service, steps 1–7 in one transaction. The
// lock is the BAN's own last_modified; party_role is never touched (Inv. #17).
const mockFindById = vi.mocked(billingAccountRepository.findById);
const mockSetTemplateRef = vi.mocked(billingAccountRepository.setTemplateRef);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  overrides: Partial<SetBillingAccountTemplateInput> = {},
): SetBillingAccountTemplateInput {
  return {
    partyRoleId: "PTRL00000001",
    billingAccountId: "BAN000001",
    billTemplateVersionId: null,
    lastModified: LOCK,
    ...overrides,
  };
}

function buildBan(
  overrides: Partial<{
    refPartyRoleId: string;
    state: string;
    lastModified: Date;
    refBillTemplateVersionId: string | null;
  }> = {},
) {
  return {
    billingAccountId: "BAN000001",
    refPartyRoleId: "PTRL00000001",
    state: "active",
    lastModified: LOCK,
    refBillTemplateVersionId: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setBillingAccountTemplate (cm21-spec §2)", () => {
  it("a non-NULL template id → TEMPLATE_NOT_BINDABLE, no repository call", async () => {
    const result = await setBillingAccountTemplate(
      buildInput({ billTemplateVersionId: "BTV00000002" }),
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });
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

  it("a BAN of another party role → BAN_NOT_FOUND (no cross-customer reset)", async () => {
    mockFindById.mockResolvedValue(
      buildBan({
        refPartyRoleId: "PTRL00000002",
        refBillTemplateVersionId: "BTV00000002",
      }),
    );

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "BAN_NOT_FOUND" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a closed BAN → BAN_CLOSED", async () => {
    mockFindById.mockResolvedValue(
      buildBan({ state: "closed", refBillTemplateVersionId: "BTV00000002" }),
    );

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "BAN_CLOSED" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
  });

  it("a stale lastModified → CONFLICT", async () => {
    mockFindById.mockResolvedValue(
      buildBan({
        lastModified: BUMPED,
        refBillTemplateVersionId: "BTV00000002",
      }),
    );

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockSetTemplateRef).not.toHaveBeenCalled();
  });

  it("an unchanged NULL → ok, changed: false, no write and no audit", async () => {
    mockFindById.mockResolvedValue(buildBan());

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

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
  });

  it("non-NULL → NULL writes via CAS and audits before/after in the same transaction", async () => {
    mockFindById
      .mockResolvedValueOnce(
        buildBan({ refBillTemplateVersionId: "BTV00000002" }),
      )
      .mockResolvedValueOnce(buildBan({ lastModified: BUMPED }));
    mockSetTemplateRef.mockResolvedValue("updated");

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

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
      null,
      "actor-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(txStub, {
      eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED",
      actorUserId: "actor-1",
      targetEntity: "BILLING_ACCOUNT",
      targetId: "BAN000001",
      beforeData: { refBillTemplateVersionId: "BTV00000002" },
      afterData: { refBillTemplateVersionId: null },
    });
  });

  it("a lost CAS race → CONFLICT, no audit", async () => {
    mockFindById.mockResolvedValue(
      buildBan({ refBillTemplateVersionId: "BTV00000002" }),
    );
    mockSetTemplateRef.mockResolvedValue("conflict");

    const result = await setBillingAccountTemplate(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
