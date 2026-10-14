import { beforeEach, describe, expect, it, vi } from "vitest";

// cm21-spec §2/§3.6 (custmgmt Inv. #16) — the reset action requires
// customers:EDIT AND accounts_transactions:EDIT, Zod-parses the payload and
// revalidates both customer pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/accounts/set-billing-account-template", () => ({
  setBillingAccountTemplate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { setBillingAccountTemplateAction } from "@/actions/accounts/set-billing-account-template";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";

const mockRequirePermission = vi.mocked(requirePermission);
const mockService = vi.mocked(setBillingAccountTemplate);
const mockRevalidatePath = vi.mocked(revalidatePath);

const LOCK = new Date("2026-01-01T00:00:00.000Z");

const VALID_INPUT = {
  partyRoleId: "PTRL00000001",
  billingAccountId: "BAN000001",
  billTemplateVersionId: null,
  lastModified: LOCK.toISOString(),
};

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function grant(accountsTransactions: "READ" | "EDIT" | null) {
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {
      customers: "EDIT",
      accounts_transactions: accountsTransactions,
    } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grant("EDIT");
});

describe("setBillingAccountTemplateAction (cm21-spec §3.6)", () => {
  it("guards on customers:EDIT", async () => {
    mockService.mockResolvedValue({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: false,
        lastModified: LOCK,
      },
    });

    await setBillingAccountTemplateAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    );
  });

  it("FORBIDDEN without customers:EDIT (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await setBillingAccountTemplateAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it.each([null, "READ"] as const)(
    "FORBIDDEN with customers:EDIT but accounts_transactions:%s",
    async (level) => {
      grant(level);

      const result = await setBillingAccountTemplateAction(VALID_INPUT);

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
      expect(mockService).not.toHaveBeenCalled();
    },
  );

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(setBillingAccountTemplateAction(VALID_INPUT)).rejects.toThrow(
      "db down",
    );
  });

  it("VALIDATION_ERROR on bad ids, service not called", async () => {
    const result = await setBillingAccountTemplateAction({
      ...VALID_INPUT,
      partyRoleId: "nope",
      billingAccountId: "FIN000001",
      billTemplateVersionId: "BTV1",
    });

    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    if (result.ok || result.code !== "VALIDATION_ERROR") return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual([
      "billTemplateVersionId",
      "billingAccountId",
      "partyRoleId",
    ]);
    expect(mockService).not.toHaveBeenCalled();
  });

  it("on success, calls the service with the parsed input and revalidates both customer pages", async () => {
    mockService.mockResolvedValue({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: true,
        lastModified: LOCK,
      },
    });

    await setBillingAccountTemplateAction(VALID_INPUT);

    expect(mockService).toHaveBeenCalledWith(
      {
        partyRoleId: "PTRL00000001",
        billingAccountId: "BAN000001",
        billTemplateVersionId: null,
        lastModified: LOCK,
      },
      "user-1",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/customers/manage/PTRL00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/customers/view/PTRL00000001",
    );
  });

  it("does not revalidate on a service failure", async () => {
    mockService.mockResolvedValue({ ok: false, code: "CONFLICT" });

    const result = await setBillingAccountTemplateAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
