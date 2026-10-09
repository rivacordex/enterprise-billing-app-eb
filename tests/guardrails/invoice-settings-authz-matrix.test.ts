import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSION_NAMES } from "@/types/rbac";

// bm55-spec §Tests — guardrail 56 (routes), code-standards Part 2 §8/§9 item
// 56: the Invoice Settings route × level matrix. Static-source style (the
// `ratecard-authz-matrix.test.ts` precedent): a server component / action /
// route handler can't be run under the App Router in vitest, so each surface's
// guard call is asserted. The behavioural proofs live in each surface's own
// test (the preview action and the files route). bm56–bm62 APPEND their rows
// (company profile, logo, save draft, activate, CSV) to `MATRIX` below.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

type MatrixRow = {
  surface: string;
  file: string;
  level: "READ" | "EDIT";
  // `page` / `action` guard with `requirePermission`; a `route` handler checks
  // the session's resolved map with `meetsLevel` (it cannot redirect).
  kind: "page" | "action" | "route";
  // Customer data: the surface ALSO requires billrun_view : READ.
  alsoBillrunView?: true;
};

const MATRIX: MatrixRow[] = [
  {
    surface: "/administration/invoice-settings (redirect only)",
    file: "app/(app)/administration/invoice-settings/page.tsx",
    level: "READ",
    kind: "page",
  },
  {
    surface: "Invoice Settings shell layout",
    file: "app/(app)/administration/invoice-settings/layout.tsx",
    level: "READ",
    kind: "page",
  },
  {
    surface: "/administration/invoice-settings/invoice-template",
    file: "app/(app)/administration/invoice-settings/invoice-template/page.tsx",
    level: "READ",
    kind: "page",
  },
  {
    surface: "GET …/invoice-template/versions/[versionId]/files/[file]",
    file: "app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]/route.ts",
    level: "READ",
    kind: "route",
  },
  {
    surface: "live preview (sample, or a bill with billrun_view)",
    file: "actions/billing/invoice-settings/preview-invoice-template.action.ts",
    level: "READ",
    kind: "action",
    alsoBillrunView: true,
  },
];

describe("invoice-settings authz matrix (bm55, guardrail 56 — routes)", () => {
  it.each(MATRIX)(
    "$surface guards on invoice_settings : $level",
    ({ file, level, kind }) => {
      const src = read(file);
      if (kind === "route") {
        expect(src).toMatch(
          /meetsLevel\(\s*permissionMap\[PERMISSIONS\.INVOICE_SETTINGS\],\s*LEVELS\.READ\s*\)/,
        );
        // 401 before 403 before any parse or read.
        expect(src.indexOf("status: 401")).toBeLessThan(
          src.indexOf("status: 403"),
        );
        expect(src.indexOf("status: 403")).toBeLessThan(
          src.indexOf("paramsSchema.safeParse"),
        );
      } else {
        const guard = src.match(
          /requirePermission\(\s*PERMISSIONS\.INVOICE_SETTINGS,\s*LEVELS\.(\w+)/,
        );
        expect(guard?.[1]).toBe(level);
      }
    },
  );

  it("no bm55 surface enforces EDIT — EDIT is only a hasLevel show/hide gate", () => {
    for (const { file } of MATRIX) {
      const src = read(file);
      expect(src).not.toMatch(/requirePermission\([^)]*LEVELS\.EDIT/);
      expect(src).not.toContain("LEVELS.DELETE");
      if (src.includes("LEVELS.EDIT")) {
        expect(src).toMatch(/hasLevel\([^)]*LEVELS\.EDIT/);
      }
    }
  });

  it("the preview of a posted bill also requires billrun_view : READ, checked before the service", () => {
    for (const { file } of MATRIX.filter((r) => r.alsoBillrunView)) {
      const src = read(file);
      const check = src.search(
        /hasLevel\(\s*principal\.permissionMap,\s*PERMISSIONS\.BILLRUN_VIEW,\s*LEVELS\.READ\s*\)/,
      );
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(src.indexOf("await previewInvoiceTemplate("));
    }
  });

  it("the preview action writes nothing: no revalidation, no audit, no blob write", () => {
    const src = read(
      "actions/billing/invoice-settings/preview-invoice-template.action.ts",
    );
    expect(src).not.toContain("revalidatePath");
    expect(src).not.toMatch(/insertAuditEvent|auditLogRepository/);
    expect(src).not.toContain("putObject");
    const service = read("services/billing/invoice-template/preview.ts");
    expect(service).not.toContain("putObject");
    expect(service).not.toMatch(/\.(insert|update|delete)\(/);
    expect(service).not.toMatch(/insertAuditEvent|auditLogRepository/);
  });

  it("the page offers posted bills only to billrun_view holders", () => {
    const src = read(
      "app/(app)/administration/invoice-settings/invoice-template/page.tsx",
    );
    expect(src).toMatch(
      /canPreviewBills = hasLevel\(\s*permissionMap,\s*PERMISSIONS\.BILLRUN_VIEW,\s*LEVELS\.READ,?\s*\)/,
    );
    expect(src).toContain(
      "recentBills={canPreviewBills ? await listRecentPostedBills() : []}",
    );
  });

  it("`invoice_settings` is a distinct PERMISSION_NAMES member, separate from billrun_* and system_config", () => {
    expect(PERMISSION_NAMES).toContain("invoice_settings");
    for (const { file } of MATRIX) {
      const src = read(file);
      expect(src).not.toContain("PERMISSIONS.SYSTEM_CONFIG");
      expect(src).not.toContain("PERMISSIONS.BILLRUN_OPERATE");
      expect(src).not.toContain("PERMISSIONS.BILLRUN_APPROVE");
    }
  });
});
