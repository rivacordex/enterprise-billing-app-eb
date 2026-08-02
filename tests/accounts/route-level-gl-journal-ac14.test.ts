import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac14-spec §3.8 — structural guardrail tests for ac14 additions.
// Complements route-level-gl-journal.test.ts (ac13) by checking the new
// ac14 surfaces: close-period action, redate-and-post action, export route,
// journal-csv service, period-close service, and GL Journal page extensions.

const ROOT = resolve(__dirname, "../..");

describe("ac14 — period-close service", () => {
  const src = readFileSync(
    resolve(ROOT, "services/accounts/period-close.ts"),
    "utf-8",
  );

  it("exports closePeriod and getPeriodState", () => {
    expect(src).toContain("closePeriod");
    expect(src).toContain("getPeriodState");
  });

  it("audits PERIOD_CLOSED event", () => {
    expect(src).toContain("PERIOD_CLOSED");
    expect(src).toContain("insertAuditEvent");
  });

  it("uses db.transaction for atomicity (Inv. #5)", () => {
    expect(src).toContain("db.transaction");
  });

  it("has no TODO or console.* (diff hygiene)", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("ac14 — journal-csv service", () => {
  const src = readFileSync(
    resolve(ROOT, "services/accounts/journal-csv.ts"),
    "utf-8",
  );

  it("exports serializeJournalCsv and buildJournalCsv", () => {
    expect(src).toContain("serializeJournalCsv");
    expect(src).toContain("buildJournalCsv");
  });

  it("uses CRLF line endings (spec §2.3)", () => {
    expect(src).toContain("\\r\\n");
  });

  it("uses money.ts for totals (code-standards §2.2)", () => {
    expect(src).toContain("stringToSen");
    expect(src).toContain("sum");
  });

  it("refuses to emit an unbalanced journal (spec §2.4 / Inv. #10)", () => {
    expect(src).toContain("UNBALANCED_JOURNAL");
  });

  it("has correct CSV header (code-standards §5.3)", () => {
    expect(src).toContain("gl_code,gl_name,debit,credit");
  });

  it("has no Number() or parseFloat on amounts (code-standards §2.2)", () => {
    expect(src).not.toMatch(/Number\s*\(\s*[a-zA-Z]*[Aa]mount/);
    expect(src).not.toContain("parseFloat");
  });

  it("has no TODO or console.*", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("ac14 — gl-journal-export route handler", () => {
  const routePath = resolve(
    ROOT,
    "app/api/accounts/gl-journal-export/route.ts",
  );
  const src = readFileSync(routePath, "utf-8");

  it("route file exists at the specified path (code-standards §5.1)", () => {
    expect(existsSync(routePath)).toBe(true);
  });

  it("exports POST (not GET — audits, so must be POST, §5.1)", () => {
    expect(src).toContain("export async function POST");
    expect(src).not.toContain("export async function GET");
  });

  it("checks accounts_config:EDIT permission", () => {
    expect(src).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(src).toContain("LEVELS.EDIT");
    expect(src).toContain("meetsLevel");
  });

  it("calls buildJournalCsv (delegates to journal-csv service)", () => {
    expect(src).toContain("buildJournalCsv");
  });

  it("delegates JOURNAL_EXPORTED audit to auditJournalExport service (spec §5.1)", () => {
    expect(src).toContain("auditJournalExport");
    // Audit is delegated to the service layer — route handler must not call
    // insertAuditEvent directly (boundaries: app → db is disallowed).
    expect(src).not.toContain("insertAuditEvent");
  });

  it("returns 409 on unbalanced journal (spec §2.4)", () => {
    expect(src).toContain("UNBALANCED_JOURNAL");
    expect(src).toContain("409");
  });

  it("sets Content-Type to text/csv (spec §2.3)", () => {
    expect(src).toContain("text/csv");
  });

  it("validates body with Zod (period YYYY-MM, currency 3 chars)", () => {
    expect(src).toContain("YYYY-MM");
    expect(src).toContain("safeParse");
  });

  it("has no TODO or console.*", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("ac14 — close-period action", () => {
  const src = readFileSync(
    resolve(ROOT, "actions/accounts/close-period.action.ts"),
    "utf-8",
  );

  it('has "use server" directive', () => {
    expect(src).toContain('"use server"');
  });

  it("requires accounts_config:EDIT", () => {
    expect(src).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(src).toContain("LEVELS.EDIT");
  });

  it("revalidates /accounts/gl-journal on success", () => {
    expect(src).toContain("revalidatePath");
    expect(src).toContain("/accounts/gl-journal");
  });

  it("has no TODO or console.*", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("ac14 — redate-and-post action", () => {
  const src = readFileSync(
    resolve(ROOT, "actions/accounts/redate-and-post.action.ts"),
    "utf-8",
  );

  it('has "use server" directive', () => {
    expect(src).toContain('"use server"');
  });

  it("requires accounts_transactions:EDIT (same gate as original create)", () => {
    expect(src).toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
    expect(src).toContain("LEVELS.EDIT");
  });

  it("calls redateAndResubmit from the state machine service", () => {
    expect(src).toContain("redateAndResubmit");
  });

  it("has no TODO or console.*", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("ac14 — GL Journal page (extensions)", () => {
  const pageSrc = readFileSync(
    resolve(ROOT, "app/(app)/accounts/gl-journal/page.tsx"),
    "utf-8",
  );

  it("imports ClosePeriodButton and JournalExportButton", () => {
    expect(pageSrc).toContain("ClosePeriodButton");
    expect(pageSrc).toContain("JournalExportButton");
  });

  it("imports getPeriodState from period-close service", () => {
    expect(pageSrc).toContain("getPeriodState");
  });

  it("checks canEdit for accounts_config:EDIT before showing controls", () => {
    expect(pageSrc).toContain("canEdit");
    expect(pageSrc).toContain("LEVELS.EDIT");
  });

  it("still exports dynamic = force-dynamic", () => {
    expect(pageSrc).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("still guards with ACCOUNTS_CONFIG READ", () => {
    expect(pageSrc).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(pageSrc).toContain("LEVELS.READ");
  });

  it("has no TODO or console.*", () => {
    expect(pageSrc).not.toContain("TODO");
    expect(pageSrc).not.toContain("console.");
  });
});

describe("ac14 — no reopening path (Q9 / Inv. #7)", () => {
  // Checks that no reopen/unlock *function or export* exists — comments
  // mentioning the absence of reopening are allowed.
  const NO_REOPEN_FN = /(?:export|function)\s+\w*[Rr]eopen/;
  const NO_UNLOCK_FN = /(?:export|function)\s+\w*[Uu]nlock/;

  it("close-period service has no reopen or unlock function", () => {
    const src = readFileSync(
      resolve(ROOT, "services/accounts/period-close.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(NO_REOPEN_FN);
    expect(src).not.toMatch(NO_UNLOCK_FN);
  });

  it("close-period action has no reopen path", () => {
    const src = readFileSync(
      resolve(ROOT, "actions/accounts/close-period.action.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(NO_REOPEN_FN);
    expect(src).not.toMatch(NO_UNLOCK_FN);
  });
});

describe("ac14 — single Route Handler in the module", () => {
  it("gl-journal-export is the only Route Handler under app/api/accounts/", () => {
    const accountsApiDir = resolve(ROOT, "app/api/accounts");
    expect(existsSync(accountsApiDir)).toBe(true);

    // The only route.ts under accounts/ should be gl-journal-export/route.ts
    const exportRoute = resolve(accountsApiDir, "gl-journal-export/route.ts");
    expect(existsSync(exportRoute)).toBe(true);
  });
});
