import { beforeEach, describe, expect, it, vi } from "vitest";

// cm20-spec §3.8 — the BAN invoice-template label (D11, Inv. #18).
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findActive: vi.fn(),
    findDefault: vi.fn(),
    findById: vi.fn(),
  },
}));
vi.mock("@/services/billing/invoice-template/resolve-template", () => ({
  resolveTemplate: vi.fn(),
  resolveVersionsForPosting: vi.fn(),
}));

import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  banTemplateLabel,
  resolveCurrentTemplateLabel,
} from "@/services/accounts/resolve-ban-template-label";
import * as resolver from "@/services/billing/invoice-template/resolve-template";

const mockFindActive = vi.mocked(billTemplateVersionRepository.findActive);
const mockFindDefault = vi.mocked(billTemplateVersionRepository.findDefault);
const mockFindById = vi.mocked(billTemplateVersionRepository.findById);

const db = {} as Database;

const LAYOUT = {
  billTemplateVersionId: "BTV00000001",
  kind: "layout",
  layoutCode: "INVTPL-STD-A4",
} as BillTemplateVersion;

function generated(versionNo: number, isDefault: boolean): BillTemplateVersion {
  return {
    billTemplateVersionId: `BTV0000000${versionNo + 1}`,
    kind: "generated",
    versionNo,
    isDefault,
    refLayoutVersionId: "BTV00000001",
  } as BillTemplateVersion;
}

async function labelFor(ref: string | null): Promise<string> {
  return banTemplateLabel(ref, await resolveCurrentTemplateLabel(db));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(LAYOUT);
});

describe("BAN template label", () => {
  it("NULL + only the default ACTIVE → follows INVTPL-STD-A4 v1", async () => {
    mockFindActive.mockResolvedValue(null);
    mockFindDefault.mockResolvedValue(generated(1, true));

    await expect(labelFor(null)).resolves.toBe(
      "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
    );
    expect(mockFindActive).toHaveBeenCalledWith(db, { kind: "generated" });
    expect(mockFindDefault).toHaveBeenCalledWith(db, { kind: "generated" });
    expect(mockFindById).toHaveBeenCalledWith(db, "BTV00000001");
  });

  it("NULL + a non-default ACTIVE v2 → follows v2", async () => {
    mockFindActive.mockResolvedValue(generated(2, false));

    await expect(labelFor(null)).resolves.toBe(
      "Follows active template (currently: INVTPL-STD-A4 v2), as of now",
    );
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  it("non-NULL → 'Template reference not supported yet'", () => {
    expect(banTemplateLabel("BTV00000002", "INVTPL-STD-A4 v1")).toBe(
      "Template reference not supported yet",
    );
  });

  it("never calls resolveTemplate or resolveVersionsForPosting", async () => {
    mockFindActive.mockResolvedValue(null);
    mockFindDefault.mockResolvedValue(generated(1, true));

    await labelFor(null);
    banTemplateLabel("BTV00000002", "x");

    expect(vi.mocked(resolver.resolveTemplate)).not.toHaveBeenCalled();
    expect(
      vi.mocked(resolver.resolveVersionsForPosting),
    ).not.toHaveBeenCalled();
  });
});
