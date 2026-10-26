import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: { tag: "db" } }));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { listUsable: vi.fn() },
}));

import { db } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { listBindableTemplateTypes } from "@/services/accounts/list-bindable-template-types";

// cm23-spec §3.8 (TS rule 2, Inv. #22) — Standard (null) first, then the
// usable types in listUsable's order (by name).
const mockListUsable = vi.mocked(billTemplateFamilyRepository.listUsable);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listBindableTemplateTypes (cm23)", () => {
  it("returns Standard first, then the usable types in listUsable's order", async () => {
    mockListUsable.mockResolvedValue([
      { billTemplateFamilyId: "BTF00000003", name: "Retail" },
      { billTemplateFamilyId: "BTF00000002", name: "Wholesale" },
    ]);

    await expect(listBindableTemplateTypes()).resolves.toEqual([
      { typeId: null, name: "Standard (default)" },
      { typeId: "BTF00000003", name: "Retail" },
      { typeId: "BTF00000002", name: "Wholesale" },
    ]);
    expect(mockListUsable).toHaveBeenCalledWith(db);
  });

  it("with no usable types, offers Standard only", async () => {
    mockListUsable.mockResolvedValue([]);

    await expect(listBindableTemplateTypes()).resolves.toEqual([
      { typeId: null, name: "Standard (default)" },
    ]);
  });
});
