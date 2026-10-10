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
    surface: "/administration/invoice-settings/company-profile",
    file: "app/(app)/administration/invoice-settings/company-profile/page.tsx",
    level: "READ",
    kind: "page",
  },
  {
    surface: "GET …/company-profile/logo/[assetVersionId]",
    file: "app/(app)/administration/invoice-settings/company-profile/logo/[assetVersionId]/route.ts",
    level: "READ",
    kind: "route",
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
  {
    surface: "activate template (a mutation)",
    file: "actions/billing/invoice-settings/activate-template.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    surface: "save template draft (a mutation)",
    file: "actions/billing/invoice-settings/save-template-draft.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    surface: "save company profile draft (a mutation)",
    file: "actions/billing/invoice-settings/save-profile-draft.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    surface: "upload logo / import app logo (mutations)",
    file: "actions/billing/invoice-settings/upload-logo.action.ts",
    level: "EDIT",
    kind: "action",
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

  it("no read surface enforces EDIT — EDIT is only a hasLevel show/hide gate", () => {
    for (const { file } of MATRIX.filter((r) => r.level === "READ")) {
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

  it("save-template-draft guards on EDIT first, then validates, then calls the service, then revalidates", () => {
    const src = read(
      "actions/billing/invoice-settings/save-template-draft.action.ts",
    );
    const guard = src.indexOf("LEVELS.EDIT");
    const parse = src.indexOf("saveTemplateDraftInputSchema.safeParse");
    const service = src.indexOf("await saveTemplateDraft(");
    const revalidate = src.indexOf("revalidatePath(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(parse);
    expect(parse).toBeLessThan(service);
    expect(service).toBeLessThan(revalidate);
    // Audit lives in the service transaction, never in the action.
    expect(src).not.toMatch(/insertAuditEvent|auditLogRepository/);
    const svc = read(
      "services/billing/invoice-template/save-template-draft.ts",
    );
    expect(svc).toContain("db.transaction(");
    // One audit write per branch (update / insert), each in the transaction.
    expect(
      svc.match(/eventType: "INVOICE_TEMPLATE_DRAFT_SAVED"/g),
    ).toHaveLength(2);
    // No blob write, no activation: a DRAFT has no files (bm57).
    expect(svc).not.toContain("putObject");
    expect(svc).not.toMatch(/ACTIVE.*status|activate/i);
  });

  it("while a working draft exists the draft is the only editable version, and the form reloads per draft token (bm57)", () => {
    const src = read(
      "app/(app)/administration/invoice-settings/invoice-template/page.tsx",
    );
    // Another version is editable only when there is no draft to overwrite.
    expect(src).toMatch(
      /editable=\{\s*canEdit &&\s*\(shownIsDraft \|\|\s*\(!draft &&/,
    );
    // A new token (own save, or Reload after DRAFT_CONFLICT) remounts the form.
    expect(src).toMatch(
      /key=\{`\$\{shown\.billTemplateVersionId\}:\$\{draft\?\.token \?\? "none"\}`\}/,
    );
    // The Generated .hbs tab defaults to the current version, not the file-less draft.
    expect(src).toContain("onGenerated && version === undefined ? current");
    // A READ user gets no View link on a DRAFT history row.
    expect(src).toContain("canViewDrafts={canEdit}");
  });

  it("activate-template guards on EDIT first, validates the note, then runs the service, then revalidates; its audit and writes live in the service (bm58)", () => {
    const src = read(
      "actions/billing/invoice-settings/activate-template.action.ts",
    );
    const guard = src.indexOf("LEVELS.EDIT");
    const parse = src.indexOf("activateTemplateInputSchema.safeParse");
    const service = src.indexOf("await activateTemplate(");
    const revalidate = src.indexOf("revalidatePath(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(parse);
    expect(parse).toBeLessThan(service);
    expect(service).toBeLessThan(revalidate);
    expect(src).not.toMatch(/insertAuditEvent|putObject/);
    const svc = read("services/billing/invoice-template/activate-template.ts");
    // One audit write, inside the single step-8 transaction, after the promote.
    expect(svc.match(/eventType: "INVOICE_TEMPLATE_ACTIVATED"/g)).toHaveLength(
      1,
    );
    expect(svc.match(/db\.transaction\(/g)).toHaveLength(1);
    // Retire BEFORE promote (btv_one_active_uq is checked per statement).
    expect(svc.indexOf("retireActive(")).toBeLessThan(
      svc.indexOf("promoteDraft("),
    );
    // The blob writes (step 7) come before the transaction (step 8).
    expect(svc.indexOf("blobStore.putObject(")).toBeLessThan(
      svc.indexOf("db.transaction("),
    );
    // Write-once, never overwritten.
    expect(svc).toMatch(/writeOnce:\s*true/);
    expect(svc).not.toMatch(/deleteBlob|writeOnce:\s*false/);
  });

  it("save-profile-draft guards on EDIT first, then validates, then calls the service, then revalidates; its writes and audit live in the service (bm59)", () => {
    const src = read(
      "actions/billing/invoice-settings/save-profile-draft.action.ts",
    );
    const guard = src.indexOf("LEVELS.EDIT");
    const parse = src.indexOf("saveProfileDraftInputSchema.safeParse");
    const service = src.indexOf("await saveProfileDraft(");
    const revalidate = src.indexOf("revalidatePath(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(parse);
    expect(parse).toBeLessThan(service);
    expect(service).toBeLessThan(revalidate);
    expect(src).not.toMatch(/insertAuditEvent|auditLogRepository/);
    const svc = read("services/billing/invoice-profile/save-profile-draft.ts");
    expect(svc).toContain("db.transaction(");
    // One audit write per branch (update / insert), each in the transaction.
    expect(svc.match(/eventType: "INVOICE_PROFILE_DRAFT_SAVED"/g)).toHaveLength(
      2,
    );
    // No activation, no logo upload, no meta.* write (bm60 / bm61).
    expect(svc).not.toMatch(/"ACTIVE"|"RETIRED"|putObject|"meta\./);
  });

  it("while a profile draft exists it is the only editable version, and the form reloads per draft token (bm59)", () => {
    const src = read(
      "app/(app)/administration/invoice-settings/company-profile/page.tsx",
    );
    expect(src).toMatch(
      /canEdit && \(shownIsDraft \|\| \(!draft && shown\?\.status === "ACTIVE"\)\)/,
    );
    expect(src).toMatch(
      /key=\{`\$\{shown\.version\}:\$\{draft\?\.token \?\? "none"\}`\}/,
    );
  });

  it("upload-logo guards both actions on EDIT before parsing; the service checks, writes write-once, then audits in one transaction (bm60)", () => {
    const src = read("actions/billing/invoice-settings/upload-logo.action.ts");
    // One shared guard, awaited first by each exported action.
    expect(src.match(/LEVELS\.EDIT/g)).toHaveLength(1);
    for (const [fn, parse, service] of [
      ["uploadLogoAction(", "logoUploadSchema.safeParse", "await uploadLogo("],
      [
        "importAppLogoAction(",
        "importAppLogoSchema.safeParse",
        "await importAppLogo(",
      ],
    ] as const) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const guard = body.indexOf("await guardEdit()");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.indexOf(parse));
      expect(body.indexOf(parse)).toBeLessThan(body.indexOf(service));
      expect(body.indexOf(service)).toBeLessThan(
        body.indexOf("revalidatePath("),
      );
    }
    expect(src).not.toMatch(/insertAuditEvent|putObject/);
    const svc = read("services/billing/invoice-profile/upload-logo.ts");
    // The checks run before anything is written.
    expect(svc.indexOf("checkLogo(input.bytes")).toBeLessThan(
      svc.indexOf("blobStore.putObject("),
    );
    expect(svc).toMatch(/writeOnce:\s*true/);
    expect(svc).not.toMatch(/deleteBlob|writeOnce:\s*false/);
    // The blob write precedes the one transaction that records it.
    expect(svc.indexOf("blobStore.putObject(")).toBeLessThan(
      svc.indexOf("insertVersion("),
    );
    expect(svc.match(/eventType: "INVOICE_LOGO_UPLOADED"/g)).toHaveLength(1);
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
