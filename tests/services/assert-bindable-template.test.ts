import { describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { assertBindableTemplate } from "@/services/accounts/assert-bindable-template";

// cm18-spec §3.6 — v1 NULL-only rule (Inv. #18, D13). The tx stub throws on
// any property access, proving the v1 validator makes no DB call.
const throwingTx = new Proxy(
  {},
  {
    get(): never {
      throw new Error("assertBindableTemplate must not touch the DB in v1");
    },
  },
) as Database;

describe("assertBindableTemplate", () => {
  it("accepts null (follow the active template)", async () => {
    await expect(assertBindableTemplate(throwingTx, null)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects a non-null id with TEMPLATE_NOT_BINDABLE", async () => {
    await expect(
      assertBindableTemplate(throwingTx, "BTV00000002"),
    ).resolves.toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });
  });
});
