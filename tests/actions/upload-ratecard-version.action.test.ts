import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/ratecard/upload-version", () => ({
  uploadRatecardVersion: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { uploadRatecardVersionAction } from "@/actions/product/upload-ratecard-version.action";
import * as uploadVersionService from "@/services/product/ratecard/upload-version";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUploadRatecardVersion = vi.mocked(
  uploadVersionService.uploadRatecardVersion,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function csvParseError(code: string): Error & { code: string } {
  const error = new Error("bad csv") as Error & { code: string };
  error.code = code;
  return error;
}

function csvFile(
  name = "card.csv",
  content = "a,b\n1,2\n",
  type = "text/csv",
): File {
  return new File([content], name, { type });
}

function formDataWith(overrides: {
  cardName?: string | null;
  file?: File | null;
}): FormData {
  const formData = new FormData();
  if (overrides.cardName !== null) {
    formData.set("cardName", overrides.cardName ?? "SEEDED_CARD");
  }
  if (overrides.file !== null) {
    formData.set("file", overrides.file ?? csvFile());
  }
  return formData;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUploadRatecardVersion.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "revops@example.com",
    permissionMap: { ratecard: "EDIT" } as never,
  });
});

describe("uploadRatecardVersionAction", () => {
  it("requires ratecard:EDIT before anything else", async () => {
    mockUploadRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000001",
      rowCount: 2,
      warnings: [],
    });

    await uploadRatecardVersionAction(formDataWith({}));

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.RATECARD,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN and takes no further action when the guard redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await uploadRatecardVersionAction(formDataWith({}));

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the guard throws something other than a redirect", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    const result = await uploadRatecardVersionAction(formDataWith({}));

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns CARD_NAME_REQUIRED for a missing or blank cardName, before touching the file", async () => {
    const missing = await uploadRatecardVersionAction(
      formDataWith({ cardName: null }),
    );
    expect(missing).toEqual({ ok: false, code: "CARD_NAME_REQUIRED" });

    const blank = await uploadRatecardVersionAction(
      formDataWith({ cardName: "   " }),
    );
    expect(blank).toEqual({ ok: false, code: "CARD_NAME_REQUIRED" });

    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns NO_FILE when no file is attached", async () => {
    const result = await uploadRatecardVersionAction(
      formDataWith({ file: null }),
    );

    expect(result).toEqual({ ok: false, code: "NO_FILE" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns NO_FILE for a zero-byte file", async () => {
    const result = await uploadRatecardVersionAction(
      formDataWith({ file: csvFile("empty.csv", "") }),
    );

    expect(result).toEqual({ ok: false, code: "NO_FILE" });
  });

  it("returns INVALID_FILE_TYPE for a non-.csv extension, before parsing", async () => {
    const result = await uploadRatecardVersionAction(
      formDataWith({ file: csvFile("card.txt") }),
    );

    expect(result).toEqual({ ok: false, code: "INVALID_FILE_TYPE" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns INVALID_FILE_TYPE for a disallowed MIME type, before parsing", async () => {
    const result = await uploadRatecardVersionAction(
      formDataWith({
        file: csvFile("card.csv", "a,b\n1,2\n", "application/json"),
      }),
    );

    expect(result).toEqual({ ok: false, code: "INVALID_FILE_TYPE" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns FILE_TOO_LARGE for a file over the byte-size ceiling, before parsing", async () => {
    const oversized = new File(
      [new Uint8Array(4 * 1024 * 1024 + 1)],
      "huge.csv",
      { type: "text/csv" },
    );

    const result = await uploadRatecardVersionAction(
      formDataWith({ file: oversized }),
    );

    expect(result).toEqual({ ok: false, code: "FILE_TOO_LARGE" });
    expect(mockUploadRatecardVersion).not.toHaveBeenCalled();
  });

  it("calls the service with cardName trimmed, the file's bytes/name, the actor and a fresh Date, then revalidates and returns ok:true", async () => {
    mockUploadRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000001",
      rowCount: 2,
      warnings: [],
    });
    const before = Date.now();

    const result = await uploadRatecardVersionAction(
      formDataWith({ cardName: "  SEEDED_CARD  ", file: csvFile() }),
    );

    expect(mockUploadRatecardVersion).toHaveBeenCalledTimes(1);
    const call = mockUploadRatecardVersion.mock.calls[0]![0];
    expect(call.cardName).toBe("SEEDED_CARD");
    expect(call.sourceFile).toBe("card.csv");
    expect(call.uploadedBy).toBe("user-1");
    expect(Buffer.isBuffer(call.bytes)).toBe(true);
    expect(call.bytes.toString("utf8")).toBe("a,b\n1,2\n");
    expect(call.uploadedAt).toBeInstanceOf(Date);
    expect(call.uploadedAt.getTime()).toBeGreaterThanOrEqual(before);

    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/rate-card");
    expect(result).toEqual({
      ok: true,
      versionId: "RCV00000001",
      rowCount: 2,
      warnings: [],
    });
  });

  it("returns the service's structural violation result unchanged and never revalidates", async () => {
    mockUploadRatecardVersion.mockResolvedValue({
      ok: false,
      code: "DUPLICATE_ROW_KEY",
      issues: [
        {
          violation: "DUPLICATE_ROW_KEY",
          line: 3,
          column: null,
          value: null,
          reason: "duplicate",
        },
      ],
    });

    const result = await uploadRatecardVersionAction(formDataWith({}));

    expect(result).toEqual({
      ok: false,
      code: "DUPLICATE_ROW_KEY",
      issues: [
        {
          violation: "DUPLICATE_ROW_KEY",
          line: 3,
          column: null,
          value: null,
          reason: "duplicate",
        },
      ],
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns UNPARSEABLE_FILE when the service call throws a csv-parse-shaped error", async () => {
    mockUploadRatecardVersion.mockRejectedValue(
      csvParseError("CSV_RECORD_INCONSISTENT_FIELDS_LENGTH"),
    );

    const result = await uploadRatecardVersionAction(formDataWith({}));

    expect(result).toEqual({ ok: false, code: "UNPARSEABLE_FILE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service call throws an unrelated error", async () => {
    mockUploadRatecardVersion.mockRejectedValue(new Error("connection reset"));

    const result = await uploadRatecardVersionAction(formDataWith({}));

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
