import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@/auth/permission-constants";
import { PERMISSION_NAMES } from "@/types/rbac";
import { PERMISSION_DISPLAY_NAMES } from "@/types/roles";

// bm50-spec §Design D7, Tests — the invoice_settings permission moves as one
// set. This DB-free half asserts the constant, the name union and the display
// map all carry it (the migration row + seeded role grants are asserted in the
// DB-gated invoice-template-catalog suite). OptionalPermissionName is a type,
// so its membership is proven at compile time (types/permissions.ts) rather
// than here.
describe("invoice_settings permission registry (bm50 D7)", () => {
  it("PERMISSIONS.INVOICE_SETTINGS resolves to 'invoice_settings'", () => {
    expect(PERMISSIONS.INVOICE_SETTINGS).toBe("invoice_settings");
  });

  it("PERMISSION_NAMES includes invoice_settings exactly once", () => {
    expect(
      PERMISSION_NAMES.filter((n) => n === "invoice_settings"),
    ).toHaveLength(1);
  });

  it("has a display label", () => {
    expect(PERMISSION_DISPLAY_NAMES.invoice_settings).toBe("Invoice Settings");
  });
});
