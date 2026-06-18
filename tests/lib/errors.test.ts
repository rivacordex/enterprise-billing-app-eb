import { describe, expect, it } from "vitest";

import {
  AppError,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/lib/errors";
import { toHttpResponse } from "@/lib/http";

describe("AppError", () => {
  it("carries a code and a safe message", () => {
    const error = new AppError(
      "FORBIDDEN",
      "You do not have permission to do this.",
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("You do not have permission to do this.");
  });

  it("factory helpers produce the expected code", () => {
    expect(forbidden().code).toBe("FORBIDDEN");
    expect(notFound().code).toBe("NOT_FOUND");
    expect(conflict().code).toBe("CONFLICT");
    expect(validationFailed().code).toBe("VALIDATION_FAILED");
  });
});

describe("toHttpResponse", () => {
  const cases: Array<[ConstructorParameters<typeof AppError>[0], number]> = [
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
    ["VALIDATION_FAILED", 422],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["INTERNAL", 500],
  ];

  it.each(cases)("maps %s to status %i", async (code, status) => {
    const response = toHttpResponse(new AppError(code, "safe message"));
    expect(response.status).toBe(status);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body).toEqual({ error: { code, message: "safe message" } });
  });

  it("coerces an unknown error to INTERNAL with a generic message", async () => {
    const response = toHttpResponse(new Error("raw internal detail"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("raw internal detail");
  });
});
