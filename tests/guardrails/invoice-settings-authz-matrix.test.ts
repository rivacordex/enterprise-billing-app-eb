import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// bm72 — the behavioural READ-user case below runs both template mutations
// under a guard that resolves a READ-only `invoice_settings` map with the real
// `meetsLevel`, redirecting as `requirePermission` does. The services are
// mocked so a call that slips past the guard is visible.
vi.mock("@/auth/guard", async () => {
  const { meetsLevel } = await import("@/types/permissions");
  return {
    requirePermission: vi.fn(async (name: string, level: string) => {
      const map: Record<string, string> = { invoice_settings: "READ" };
      if (!meetsLevel(map[name] as never, level as never)) {
        throw Object.assign(new Error("NEXT_REDIRECT"), {
          digest: "NEXT_REDIRECT;replace;/no-access;307;",
        });
      }
      return {
        userId: "reader-1",
        userEmail: "r@example.com",
        permissionMap: map,
      };
    }),
  };
});
vi.mock("@/services/billing/invoice-template/save-template-draft", () => ({
  saveTemplateDraft: vi.fn(),
}));
vi.mock("@/services/billing/invoice-template/activate-template", () => ({
  activateTemplate: vi.fn(),
}));
// bm78 — the upload service, so an upload that slips past the guard is visible.
vi.mock("@/services/billing/invoice-template/upload-layout-package", () => ({
  uploadLayoutPackage: vi.fn(),
}));
// bm79 — the discard service, so a discard that slips past the guard is visible.
vi.mock("@/services/billing/invoice-template/discard-template-draft", () => ({
  discardTemplateDraft: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { activateTemplateAction } from "@/actions/billing/invoice-settings/activate-template.action";
import { discardTemplateDraftAction } from "@/actions/billing/invoice-settings/discard-template-draft.action";
import { saveTemplateDraftAction } from "@/actions/billing/invoice-settings/save-template-draft.action";
import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { discardTemplateDraft } from "@/services/billing/invoice-template/discard-template-draft";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { PERMISSION_NAMES } from "@/types/rbac";

// bm55-spec §Tests — guardrail 56 (routes), code-standards Part 2 §8/§9 item
// 56: the Invoice Settings route × level matrix. Static-source style (the
// `ratecard-authz-matrix.test.ts` precedent): a server component / action /
// route handler can't be run under the App Router in vitest, so each surface's
// guard call is asserted. The behavioural proofs live in each surface's own
// test (the preview action and the files route). bm56–bm61 APPEND their rows
// (company profile, logo, save draft, activate) to `MATRIX` below; bm62's CSV
// route is a billrun_view surface, so it has its own case.
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

// bm77 — the editor moved to the template type detail page.
const TYPE_DETAIL_PAGE =
  "app/(app)/administration/invoice-settings/invoice-template/[typeId]/page.tsx";

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
    // bm77 — the invoice template TYPE list.
    surface: "/administration/invoice-settings/invoice-template",
    file: "app/(app)/administration/invoice-settings/invoice-template/page.tsx",
    level: "READ",
    kind: "page",
  },
  {
    // bm77 — a type's detail page (today's editor, per type).
    surface: "/administration/invoice-settings/invoice-template/[typeId]",
    file: TYPE_DETAIL_PAGE,
    level: "READ",
    kind: "page",
  },
  {
    surface: "create invoice template type (a mutation)",
    file: "actions/billing/invoice-settings/create-template-type.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    surface: "GET …/invoice-template/versions/[versionId]/files/[file]",
    file: "app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]/route.ts",
    level: "READ",
    kind: "route",
  },
  {
    // bm81 — export a version pair (READ; EDIT only shows a DRAFT pair).
    surface: "GET …/invoice-template/versions/[versionId]/export",
    file: "app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/export/route.ts",
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
    surface: "activate company profile (a mutation)",
    file: "actions/billing/invoice-settings/activate-profile.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    surface: "upload logo / import app logo (mutations)",
    file: "actions/billing/invoice-settings/upload-logo.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    // bm78 — upload a layout package as a new draft.
    surface: "upload layout package (a mutation)",
    file: "actions/billing/invoice-settings/upload-layout-package.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    // bm79 — discard a type's DRAFTs.
    surface: "discard template draft (a mutation)",
    file: "actions/billing/invoice-settings/discard-template-draft.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    // bm83 — retire a type with the bulk switch of its BANs.
    surface: "retire template type (a mutation)",
    file: "actions/billing/invoice-settings/retire-template-type.action.ts",
    level: "EDIT",
    kind: "action",
  },
  {
    // bm83 — the Retire dialog's "Show more" (only that EDIT dialog uses it).
    surface: "list bound BANs (the Retire dialog)",
    file: "actions/billing/invoice-settings/list-bound-bans.action.ts",
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

  it("while a working draft exists the draft is the only editable version, and the form adopts a newer draft token (bm57, bm72 review)", () => {
    const src = read(TYPE_DETAIL_PAGE);
    // Another version is editable only when there is no draft to overwrite.
    expect(src).toMatch(
      /editable=\{\s*editView &&\s*\(shownIsDraft \|\|\s*\(!draft &&/,
    );
    // The working copy keeps one form; a version opened from the history gets
    // its own (bm72 review: the post-save refresh no longer remounts it).
    expect(src).toContain(
      'key={viewingOther ? shown.billTemplateVersionId : "working"}',
    );
    // A token or draft the form does not already hold (a Reload after
    // DRAFT_CONFLICT, an activation) is adopted: the form reloads from it.
    const form = read(
      "components/billing/invoice-settings/invoice-structure-form.tsx",
    );
    expect(form).toContain("expectedDraftToken === draftToken");
    expect(form).toContain("setDraftToken(expectedDraftToken)");
    expect(form).toContain("reset(toFormValues(adopted))");
    // The Generated .hbs tab defaults to the current version, not the file-less draft.
    // bm78: an uploaded-but-not-activated type has no current version and
    // falls back to the shown draft (which then reports "no generated files").
    expect(src).toContain(
      "onGenerated && version === undefined ? (current ?? data.shown)",
    );
    // A READ user gets no View link on a DRAFT history row; bm83: nor does
    // anyone on a retired type (`editView` is EDIT on a non-retired type).
    expect(src).toContain("canViewDrafts={editView}");
    expect(src).toContain("const editView = canEdit && retiredAt === null;");
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

  it("activate-profile guards on EDIT first, validates the note, then runs the service, then revalidates; writes and audit live in the service (bm61)", () => {
    const src = read(
      "actions/billing/invoice-settings/activate-profile.action.ts",
    );
    const guard = src.indexOf("LEVELS.EDIT");
    const parse = src.indexOf("activateProfileInputSchema.safeParse");
    const service = src.indexOf("await activateProfile(");
    const revalidate = src.indexOf("revalidatePath(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(parse);
    expect(parse).toBeLessThan(service);
    expect(service).toBeLessThan(revalidate);
    expect(src).not.toMatch(/insertAuditEvent/);
    const svc = read("services/billing/invoice-profile/activate-profile.ts");
    expect(svc.match(/db\.transaction\(/g)).toHaveLength(1);
    // Retire BEFORE promote: two versions are never ACTIVE together.
    expect(svc.indexOf("retireActiveVersion(")).toBeLessThan(
      svc.indexOf("promoteDraftVersion("),
    );
    expect(svc.match(/eventType: "INVOICE_PROFILE_ACTIVATED"/g)).toHaveLength(
      1,
    );
    // No blob is written by activation.
    expect(svc).not.toMatch(/putObject|deleteBlob/);
  });

  it("the page offers posted bills only to billrun_view holders", () => {
    const src = read(TYPE_DETAIL_PAGE);
    expect(src).toMatch(
      /canPreviewBills = hasLevel\(\s*permissionMap,\s*PERMISSIONS\.BILLRUN_VIEW,\s*LEVELS\.READ,?\s*\)/,
    );
    // bm83 review fix — and never on a retired type (no bill can preview it).
    expect(src).toContain(
      "const canPreviewTypeBills = canPreviewBills && retiredAt === null;",
    );
    expect(src).toMatch(
      /recentBills=\{\s*canPreviewTypeBills \? await listRecentPostedBills\(\) : \[\]\s*\}/,
    );
  });

  // bm62 — the invoice CSV is bill data, not a setting: it is gated on
  // billrun_view : READ (the permission-map row), never invoice_settings.
  it("the invoice CSV route requires billrun_view : READ, checked before any parse; it stores and audits nothing (bm62)", () => {
    const src = read(
      "app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts",
    );
    expect(src).toMatch(
      /meetsLevel\(\s*permissionMap\[PERMISSIONS\.BILLRUN_VIEW\],\s*LEVELS\.READ\s*\)/,
    );
    expect(src).not.toContain("PERMISSIONS.INVOICE_SETTINGS");
    expect(src).not.toMatch(/PERMISSIONS\.BILLRUN_(OPERATE|APPROVE)/);
    // 401 before 403 before any ID parse or read.
    expect(src.indexOf("status: 401")).toBeLessThan(src.indexOf("status: 403"));
    expect(src.indexOf("status: 403")).toBeLessThan(
      src.indexOf("billRunIdSchema.safeParse"),
    );
    expect(src.indexOf("billRunIdSchema.safeParse")).toBeLessThan(
      src.indexOf("await getPostedInvoiceCsv("),
    );

    const svc = read("services/billing/invoice-template/invoice-csv.ts");
    for (const file of [src, svc]) {
      expect(file).not.toMatch(
        /insertAuditEvent|auditLogRepository|putObject|putInvoice|putReport|revalidatePath/,
      );
    }
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

// A READ-only user's mutation is refused server-side before any parse or
// service call (the hidden inputs, buttons and dialog triggers are show/hide
// only). bm72-spec §5: the footnote is an `invoice_settings : EDIT` write like
// the rest of the structure. bm78-spec §13: the layout upload. bm79: discard.
describe("invoice-settings authz matrix — a READ user's mutation is FORBIDDEN and runs no service", () => {
  const CHANGED = {
    sections: { payment: true },
    columns: {},
    footnote: ["Calculations are done in Mbps", "A READ user's edit"],
  };
  const TOKEN = "2026-10-10T01:02:03.123456Z";

  function layoutForm(): FormData {
    const form = new FormData();
    form.set("familyId", "BTF00000002");
    form.set(
      "file",
      new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], "layout.zip", {
        type: "application/zip",
      }),
    );
    return form;
  }

  it.each(
    [
      {
        surface: "bm72 — save draft carrying a changed footnote",
        call: () =>
          saveTemplateDraftAction({
            structure: CHANGED,
            expectedDraftToken: null,
          }),
        service: saveTemplateDraft,
        refused: { ok: false, code: "FORBIDDEN" },
      },
      {
        surface: "bm72 — activating a draft that carries a changed footnote",
        call: () =>
          activateTemplateAction({
            draftId: "BTV00000004",
            expectedDraftToken: TOKEN,
            changeNote: "Reword the footnote",
          }),
        service: activateTemplate,
        refused: { ok: false, code: "FORBIDDEN" },
      },
      {
        surface: "bm78 — a layout package upload",
        call: () => uploadLayoutPackageAction(layoutForm()),
        service: uploadLayoutPackage,
        refused: { ok: false, code: "FORBIDDEN", problems: [] },
      },
      {
        surface: "bm79 — discarding a draft",
        call: () =>
          discardTemplateDraftAction({
            familyId: "BTF00000002",
            draftId: "BTV00000004",
            expectedDraftToken: TOKEN,
          }),
        service: discardTemplateDraft,
        refused: { ok: false, code: "FORBIDDEN" },
      },
    ].map((c) => [c.surface, c] as const),
  )("%s is refused", async (_surface, { call, service, refused }) => {
    expect(await call()).toEqual(refused);
    expect(vi.mocked(service)).not.toHaveBeenCalled();
  });
});
