import { describe, expect, it } from "vitest";

import { toInvoiceRenderResponse } from "@/lib/http";

// bm66-spec §5 (general §5 rule 7) — the one mapping of an invoice render
// failure to its HTTP envelope: 422, the typed code, and the safe text for the
// code and its reason. Never the internal message.
describe("toInvoiceRenderResponse", () => {
  it("returns 422 with the code and the D55 copy for the D55 reason", async () => {
    const response = toInvoiceRenderResponse({
      code: "TEMPLATE_VERSION_NOT_FOUND",
      detail: {
        reason: "FAMILY_HAS_NO_ACTIVE_VERSION",
        familyId: "BTF00000099",
      },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: {
        code: "TEMPLATE_VERSION_NOT_FOUND",
        message:
          "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("BTF00000099");
  });

  it("returns the generic text for any other cause", async () => {
    const response = toInvoiceRenderResponse({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      detail: { versionId: "BTV00000002" },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "TEMPLATE_CHECKSUM_MISMATCH",
        message: "Could not render the draft invoice. Please try again.",
      },
    });
  });
});
