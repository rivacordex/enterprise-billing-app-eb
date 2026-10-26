import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { lockTemplateType: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: { findActive: vi.fn() },
}));

import type { Database } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { assertBindableTemplate } from "@/services/accounts/assert-bindable-template";

// cm23-spec D2 / §3.4 (Inv. #19, #20) — null needs no lock and no read; a type
// id is locked FOR SHARE in the caller's tx before its usability is read.
const mockLock = vi.mocked(billTemplateFamilyRepository.lockTemplateType);
const mockFindActive = vi.mocked(billTemplateVersionRepository.findActive);

const tx = { tag: "caller-tx" } as unknown as Database;

function buildType(
  overrides: Partial<{
    isDefault: boolean;
    retiredDatetime: Date | null;
  }> = {},
) {
  return {
    billTemplateFamilyId: "BTF00000002",
    name: "Wholesale",
    isDefault: false,
    retiredDatetime: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertBindableTemplate (cm23)", () => {
  it("accepts null (Standard) with no lock and no repository call", async () => {
    await expect(assertBindableTemplate(tx, null)).resolves.toEqual({
      ok: true,
      typeName: null,
    });
    expect(mockLock).not.toHaveBeenCalled();
    expect(mockFindActive).not.toHaveBeenCalled();
  });

  it("a usable type: locks FOR SHARE in the caller's tx before findActive, returns its name", async () => {
    mockLock.mockResolvedValue(buildType());
    mockFindActive.mockResolvedValue({ versionNo: 1 } as never);

    await expect(assertBindableTemplate(tx, "BTF00000002")).resolves.toEqual({
      ok: true,
      typeName: "Wholesale",
    });
    expect(mockLock).toHaveBeenCalledWith(tx, "BTF00000002", "share");
    expect(mockFindActive).toHaveBeenCalledWith(tx, {
      kind: "generated",
      familyId: "BTF00000002",
    });
    expect(mockLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindActive.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    ["Standard's explicit id (isDefault)", buildType({ isDefault: true })],
    ["an unknown id", null],
    ["a retired type", buildType({ retiredDatetime: new Date() })],
  ])("%s → TEMPLATE_NOT_BINDABLE", async (_name, locked) => {
    mockLock.mockResolvedValue(locked);
    mockFindActive.mockResolvedValue({ versionNo: 1 } as never);

    await expect(assertBindableTemplate(tx, "BTF00000002")).resolves.toEqual({
      ok: false,
      code: "TEMPLATE_NOT_BINDABLE",
    });
    expect(mockLock).toHaveBeenCalledWith(tx, "BTF00000002", "share");
  });

  it("a type with no ACTIVE settings version → TEMPLATE_NOT_BINDABLE", async () => {
    mockLock.mockResolvedValue(buildType());
    mockFindActive.mockResolvedValue(null);

    await expect(assertBindableTemplate(tx, "BTF00000002")).resolves.toEqual({
      ok: false,
      code: "TEMPLATE_NOT_BINDABLE",
    });
  });
});
