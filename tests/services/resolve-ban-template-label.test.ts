import { beforeEach, describe, expect, it, vi } from "vitest";

// cm23-spec D4/D5 (Inv. #21, #22) — the BAN invoice template type label.
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: {
    findDefault: vi.fn(),
    findById: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findActive: vi.fn(),
    findDefault: vi.fn(),
  },
}));
vi.mock("@/services/billing/invoice-template/resolve-template", () => ({
  resolveTemplate: vi.fn(),
  resolveCurrentVersionsForFamily: vi.fn(),
}));

import type { Database } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import {
  resolveBanTemplateLabels,
  templateLabelFor,
} from "@/services/accounts/resolve-ban-template-label";
import * as resolver from "@/services/billing/invoice-template/resolve-template";

const mockFamilyDefault = vi.mocked(billTemplateFamilyRepository.findDefault);
const mockFamilyById = vi.mocked(billTemplateFamilyRepository.findById);
const mockFindActive = vi.mocked(billTemplateVersionRepository.findActive);
const mockFindDefault = vi.mocked(billTemplateVersionRepository.findDefault);

const db = {} as Database;

const STANDARD = {
  billTemplateFamilyId: "BTF00000001",
  name: "Standard",
  isDefault: true,
  retiredDatetime: null,
} as never;

function type(
  id: string,
  name: string,
  retiredDatetime: Date | null = null,
): never {
  return {
    billTemplateFamilyId: id,
    name,
    isDefault: false,
    retiredDatetime,
  } as never;
}

function version(versionNo: number): never {
  return { versionNo } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFamilyDefault.mockResolvedValue(STANDARD);
  mockFindActive.mockResolvedValue(null);
  mockFindDefault.mockResolvedValue(version(1));
});

describe("resolveBanTemplateLabels (cm23)", () => {
  it("NULL on Standard's default v1 → STANDARD 'Standard (default) · v1'", async () => {
    const labels = await resolveBanTemplateLabels(db, [null]);

    expect(labels.get(null)).toEqual({
      kind: "STANDARD",
      text: "Standard (default) · v1",
      name: "Standard (default)",
      versionNo: 1,
    });
    // Standard is found by lookup, never by id.
    expect(mockFamilyDefault).toHaveBeenCalledWith(db);
    expect(mockFindActive).toHaveBeenCalledWith(db, {
      kind: "generated",
      familyId: "BTF00000001",
    });
    expect(mockFindDefault).toHaveBeenCalledWith(db, {
      kind: "generated",
      familyId: "BTF00000001",
    });
  });

  it("NULL with Standard on an ACTIVE v2 → 'Standard (default) · v2'", async () => {
    mockFindActive.mockResolvedValue(version(2));

    const labels = await resolveBanTemplateLabels(db, [null]);

    expect(labels.get(null)?.text).toBe("Standard (default) · v2");
    expect(labels.get(null)?.versionNo).toBe(2);
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  it("a missing Standard row → STANDARD 'Standard (default)', versionNo null", async () => {
    mockFamilyDefault.mockResolvedValue(null);

    const labels = await resolveBanTemplateLabels(db, [null]);

    expect(labels.get(null)).toEqual({
      kind: "STANDARD",
      text: "Standard (default)",
      name: "Standard (default)",
      versionNo: null,
    });
  });

  it("a usable type → TYPE '{name} · v{N}' from its ACTIVE settings version", async () => {
    mockFamilyById.mockResolvedValue(type("BTF00000002", "Wholesale"));
    mockFindActive.mockResolvedValue(version(3));

    const labels = await resolveBanTemplateLabels(db, ["BTF00000002"]);

    expect(labels.get("BTF00000002")).toEqual({
      kind: "TYPE",
      text: "Wholesale · v3",
      name: "Wholesale",
      versionNo: 3,
    });
    expect(mockFindActive).toHaveBeenCalledWith(db, {
      kind: "generated",
      familyId: "BTF00000002",
    });
  });

  it.each([
    ["retired", type("BTF00000002", "Wholesale", new Date()), version(1)],
    ["with no ACTIVE settings", type("BTF00000002", "Wholesale"), null],
  ])(
    "a type %s → NOT_USABLE '{name} · not usable'",
    async (_name, family, active) => {
      mockFamilyById.mockResolvedValue(family);
      mockFindActive.mockResolvedValue(active);

      const labels = await resolveBanTemplateLabels(db, ["BTF00000002"]);

      expect(labels.get("BTF00000002")).toEqual({
        kind: "NOT_USABLE",
        text: "Wholesale · not usable",
        name: "Wholesale",
        versionNo: null,
      });
    },
  );

  it("one read per distinct type, however many BANs share it", async () => {
    mockFamilyById.mockImplementation((_db, id) =>
      Promise.resolve(type(id, id === "BTF00000002" ? "Wholesale" : "Retail")),
    );
    mockFindActive.mockResolvedValue(version(1));

    const labels = await resolveBanTemplateLabels(db, [
      null,
      "BTF00000002",
      null,
      "BTF00000003",
      "BTF00000002",
    ]);

    expect(labels.size).toBe(3);
    expect(mockFamilyDefault).toHaveBeenCalledTimes(1);
    expect(mockFamilyById).toHaveBeenCalledTimes(2);
    expect(mockFamilyById).toHaveBeenCalledWith(db, "BTF00000002");
    expect(mockFamilyById).toHaveBeenCalledWith(db, "BTF00000003");
    // One findActive for Standard + one per distinct type.
    expect(mockFindActive).toHaveBeenCalledTimes(3);
  });

  it("templateLabelFor returns the BAN's label and throws for a missing key", async () => {
    const labels = await resolveBanTemplateLabels(db, [null]);

    expect(templateLabelFor(labels, null).kind).toBe("STANDARD");
    expect(() => templateLabelFor(labels, "BTF00000009")).toThrow(
      "no template label for BTF00000009",
    );
  });

  it("never calls resolveTemplate or resolveCurrentVersionsForFamily", async () => {
    mockFamilyById.mockResolvedValue(type("BTF00000002", "Wholesale"));

    await resolveBanTemplateLabels(db, [null, "BTF00000002"]);

    expect(vi.mocked(resolver.resolveTemplate)).not.toHaveBeenCalled();
    expect(
      vi.mocked(resolver.resolveCurrentVersionsForFamily),
    ).not.toHaveBeenCalled();
  });
});
