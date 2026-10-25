import { beforeEach, describe, expect, it, vi } from "vitest";

// bm78-spec §8: `uploadLayoutPackageAction`. Guard first (EDIT): a READ user is
// FORBIDDEN and a non-redirect guard failure SERVER_ERROR, both with no problems
// and no service call; a malformed form is VALIDATION_ERROR; a file over
// LAYOUT_PACKAGE_MAX_BYTES is LAYOUT_REJECTED / ZIP_TOO_LARGE before any read;
// the service result is returned as-is and only a success revalidates; a thrown
// service error is logged and SERVER_ERROR.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-template/upload-layout-package", () => ({
  uploadLayoutPackage: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { logger } from "@/lib/logger";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { principal, redirectError } from "@/tests/helpers/action-guard";
import { LAYOUT_PACKAGE_MAX_BYTES } from "@/types/billing";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(uploadLayoutPackage);
const mockRevalidate = vi.mocked(revalidatePath);

const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

function form(
  overrides: { familyId?: string; expectedDraft?: string; file?: File } = {},
): FormData {
  const f = new FormData();
  f.set("familyId", overrides.familyId ?? "BTF00000002");
  f.set("expectedDraft", overrides.expectedDraft ?? "none");
  f.set(
    "file",
    overrides.file ??
      new File([ZIP], "layout.zip", { type: "application/zip" }),
  );
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue(principal({ invoice_settings: "EDIT" }));
});

describe("uploadLayoutPackageAction (bm78)", () => {
  it("guards on invoice_settings : EDIT", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: false,
    });
    await uploadLayoutPackageAction(form());
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it.each([
    ["a READ user (the guard redirects)", "FORBIDDEN", redirectError()],
    ["a non-redirect guard failure", "SERVER_ERROR", new Error("db down")],
  ] as const)(
    "%s → %s, with no problems and no service call",
    async (_c, code, error) => {
      mockGuard.mockRejectedValue(error);
      expect(await uploadLayoutPackageAction(form())).toEqual({
        ok: false,
        code,
        problems: [],
      });
      expect(mockService).not.toHaveBeenCalled();
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a malformed familyId", form({ familyId: "wholesale" })],
    ["a malformed expectedDraft", form({ expectedDraft: "{not json" })],
  ])("%s → VALIDATION_ERROR before the service", async (_c, input) => {
    expect(await uploadLayoutPackageAction(input)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      problems: [],
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("a file over the upload limit is LAYOUT_REJECTED / ZIP_TOO_LARGE before the service", async () => {
    const big = new File(
      [new Uint8Array(LAYOUT_PACKAGE_MAX_BYTES + 1)],
      "big.zip",
      { type: "application/zip" },
    );
    const result = await uploadLayoutPackageAction(form({ file: big }));
    expect(result).toMatchObject({
      ok: false,
      code: "LAYOUT_REJECTED",
      problems: [{ file: "big.zip", code: "ZIP_TOO_LARGE" }],
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("on success passes the bytes and actor to the service and revalidates the Invoice Settings layout", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: false,
    });
    expect(await uploadLayoutPackageAction(form())).toEqual({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: false,
    });
    expect(mockService).toHaveBeenCalledWith(
      { familyId: "BTF00000002", zip: ZIP, expectedDraft: { none: true } },
      "actor-1",
    );
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it("returns a service refusal as-is without revalidating", async () => {
    const refused = {
      ok: false as const,
      code: "LAYOUT_REJECTED" as const,
      problems: [
        {
          file: "(render)",
          code: "LAYOUT_EXTERNAL_FETCH" as const,
          message: "the layout tried to fetch 1 URL: http://x/a.png",
        },
      ],
    };
    mockService.mockResolvedValue(refused);
    expect(await uploadLayoutPackageAction(form())).toEqual(refused);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("a service throw is logged and SERVER_ERROR with no problems", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    expect(await uploadLayoutPackageAction(form())).toEqual({
      ok: false,
      code: "SERVER_ERROR",
      problems: [],
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
