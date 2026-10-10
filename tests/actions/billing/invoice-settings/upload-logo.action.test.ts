import { beforeEach, describe, expect, it, vi } from "vitest";

// bm60-spec §Tests: `uploadLogoAction` / `importAppLogoAction`. Guard first
// (EDIT); a READ user is FORBIDDEN with nothing written; a 4.9 MB body that
// fits `bodySizeLimit` is still refused by the service's 500 KB check
// (`size`), and so is a declared type outside the three (`mime`). The REAL
// service runs; only its I/O is mocked, and a rejection never reaches it.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: {
    findDraftVersion: vi.fn(),
    setDraftLogo: vi.fn(),
  },
}));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: { digest: vi.fn(), putObject: vi.fn() },
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getBrandingLogo: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import {
  importAppLogoAction,
  uploadLogoAction,
} from "@/actions/billing/invoice-settings/upload-logo.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { db } from "@/db/client";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { blobStore } from "@/services/billing/blob-store";
import { getBrandingLogo } from "@/services/system-config/app-config-read.service";
import { png } from "@/tests/helpers/logo-fixtures";

const mockGuard = vi.mocked(requirePermission);
const TOKEN = "2026-10-10T01:02:03.123456Z";

// A `Buffer` as a `BlobPart` (its `buffer` may be a SharedArrayBuffer type).
function part(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function redirectError(): Error & { digest: string } {
  const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
  e.digest = "NEXT_REDIRECT;replace;/no-access;307;";
  return e;
}

function form(file: File | string | null, token: string | null = TOKEN) {
  const fd = new FormData();
  if (file !== null) fd.set("file", file);
  if (token !== null) fd.set("expectedDraftToken", token);
  return fd;
}

function expectNothingWritten(): void {
  expect(invoiceProfileRepository.findDraftVersion).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(blobStore.putObject).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue({
    userId: "actor-1",
    userEmail: "a@example.com",
    permissionMap: { invoice_settings: "EDIT" },
  } as never);
});

describe("uploadLogoAction", () => {
  it("guards on invoice_settings : EDIT", async () => {
    await uploadLogoAction(form(null));
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user (the guard redirects) with FORBIDDEN, writing nothing", async () => {
    mockGuard.mockRejectedValue(redirectError());
    const file = new File([part(png(400, 400))], "logo.png", {
      type: "image/png",
    });
    expect(await uploadLogoAction(form(file))).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expectNothingWritten();
  });

  it("a 4.9 MB body within bodySizeLimit is rejected as size by the service", async () => {
    const bytes = png(400, 400, 4_900_000);
    const file = new File([part(bytes)], "huge.png", { type: "image/png" });
    expect(await uploadLogoAction(form(file))).toEqual({
      ok: false,
      code: "LOGO_REJECTED",
      reason: "size",
      detail: { byteSize: 4_900_000, maxBytes: 512_000 },
    });
    expectNothingWritten();
  });

  it("a declared type outside PNG/JPEG/SVG is rejected as mime", async () => {
    const file = new File([part(png(400, 400))], "logo.gif", {
      type: "image/gif",
    });
    expect(await uploadLogoAction(form(file))).toMatchObject({
      ok: false,
      code: "LOGO_REJECTED",
      reason: "mime",
      detail: { declared: "image/gif" },
    });
    expectNothingWritten();
  });

  it.each([
    ["no file", form(null)],
    ["a string instead of a file", form("not-a-file")],
    [
      "a malformed token",
      form(
        new File([part(png(400, 400))], "l.png", { type: "image/png" }),
        "x",
      ),
    ],
  ])("%s is VALIDATION_ERROR", async (_label, fd) => {
    expect(await uploadLogoAction(fd)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expectNothingWritten();
  });
});

describe("importAppLogoAction (D8)", () => {
  it("refuses a READ user", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(await importAppLogoAction({ expectedDraftToken: TOKEN })).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(getBrandingLogo).not.toHaveBeenCalled();
  });

  it("runs the same checks: the shipped brand logo is refused, nothing written", async () => {
    vi.mocked(getBrandingLogo).mockResolvedValue({
      src: "/brand/logo.svg",
      alt: "x",
    });
    const result = await importAppLogoAction({ expectedDraftToken: TOKEN });
    expect(result).toMatchObject({ ok: false, code: "LOGO_REJECTED" });
    expectNothingWritten();
  });

  it("a configured path outside /brand/ is APP_LOGO_UNAVAILABLE", async () => {
    vi.mocked(getBrandingLogo).mockResolvedValue({
      src: "/brand/../../package.json",
      alt: "x",
    });
    expect(await importAppLogoAction({ expectedDraftToken: TOKEN })).toEqual({
      ok: false,
      code: "APP_LOGO_UNAVAILABLE",
    });
  });
});
