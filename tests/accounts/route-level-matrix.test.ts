import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac17-spec §2.1 / §3.1 — the module's single route × level completeness
// matrix (code-standards §8). Every individual page already carries its own
// structural guardrail test (route-level-{overview,ledger,transactions,
// chart-of-accounts,gl-journal,accounts-settings}.test.ts); this file is the
// one canonical place that walks the full six-page + export-route table from
// code-standards §8 in a single pass, plus the two cross-cutting properties
// that are not permission levels at all: the workflow rules (threshold
// routing, approver ≠ creator) and the dual-permission onboarding action
// (ac04). Static-source-analysis style, same precedent as every other
// route-level-*.test.ts file — Next.js server components can't be rendered
// in vitest without the full App Router runtime.
const ROOT = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

type MatrixCase = {
  surface: string;
  file: string;
  permission: string;
  level: string;
};

// code-standards §8's table, "READ (view)" column — every page's minimum
// gate to render at all.
const VIEW_GATE_MATRIX: MatrixCase[] = [
  {
    surface: "/accounts/overview",
    file: "app/(app)/accounts/overview/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_VIEW",
    level: "LEVELS.READ",
  },
  {
    surface: "/accounts/ledger",
    file: "app/(app)/accounts/ledger/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_VIEW",
    level: "LEVELS.READ",
  },
  {
    surface: "/accounts/transactions",
    file: "app/(app)/accounts/transactions/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_TRANSACTIONS",
    level: "LEVELS.READ",
  },
  {
    surface: "/accounts/chart-of-accounts",
    file: "app/(app)/accounts/chart-of-accounts/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.READ",
  },
  {
    surface: "/accounts/gl-journal",
    file: "app/(app)/accounts/gl-journal/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.READ",
  },
  {
    surface: "/administration/accounts-settings/flows",
    file: "app/(app)/administration/accounts-settings/flows/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.READ",
  },
];

describe("Route × level matrix — view gate (ac17-spec §2.1, code-standards §8)", () => {
  it.each(VIEW_GATE_MATRIX)(
    "$surface guards on $permission : $level via requirePermission",
    ({ file, permission, level }) => {
      const src = read(file);
      expect(src).toContain("requirePermission");
      expect(src).toContain(permission);
      expect(src).toContain(level);
    },
  );
});

// code-standards §8's "EDIT" column — the write-affordance gate, additional
// to (never instead of) the view gate above.
const EDIT_GATE_MATRIX: MatrixCase[] = [
  {
    surface:
      "/accounts/transactions (draft, submit, post within limit, approve)",
    file: "app/(app)/accounts/transactions/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_TRANSACTIONS",
    level: "LEVELS.EDIT",
  },
  {
    surface: "/accounts/chart-of-accounts (codes, mappings)",
    file: "app/(app)/accounts/chart-of-accounts/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.EDIT",
  },
  {
    surface: "/accounts/gl-journal (export, close)",
    file: "app/(app)/accounts/gl-journal/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.EDIT",
  },
  {
    surface:
      "/administration/accounts-settings (reason codes, bill cycles, defaults)",
    file: "app/(app)/administration/accounts-settings/page.tsx",
    permission: "PERMISSIONS.ACCOUNTS_CONFIG",
    level: "LEVELS.EDIT",
  },
];

describe("Route × level matrix — edit gate (ac17-spec §2.1, code-standards §8)", () => {
  it.each(EDIT_GATE_MATRIX)(
    "$surface additionally checks $permission : $level before rendering a write affordance",
    ({ file, permission, level }) => {
      const src = read(file);
      expect(src).toContain(permission);
      expect(src).toContain(level);
    },
  );

  it("/administration/accounts-settings/flows never reaches EDIT (read-only doc page)", () => {
    const src = read(
      "app/(app)/administration/accounts-settings/flows/page.tsx",
    );
    expect(src).not.toContain("LEVELS.EDIT");
  });
});

describe("Route × level matrix — export route (ac17-spec §2.1)", () => {
  const src = read("app/api/accounts/gl-journal-export/route.ts");

  it("POST /api/accounts/gl-journal-export guards on accounts_config:EDIT (code-standards §5.1)", () => {
    expect(src).toContain("export async function POST");
    expect(src).not.toContain("export async function GET");
    expect(src).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(src).toContain("LEVELS.EDIT");
    expect(src).toContain("meetsLevel");
  });
});

describe("all six matrix pages + export route exist (completeness base check)", () => {
  it.each([
    "app/(app)/accounts/overview/page.tsx",
    "app/(app)/accounts/ledger/page.tsx",
    "app/(app)/accounts/transactions/page.tsx",
    "app/(app)/accounts/chart-of-accounts/page.tsx",
    "app/(app)/accounts/gl-journal/page.tsx",
    "app/(app)/administration/accounts-settings/page.tsx",
    "app/(app)/administration/accounts-settings/flows/page.tsx",
    "app/api/accounts/gl-journal-export/route.ts",
  ])("%s exists", (file) => {
    expect(existsSync(resolve(ROOT, file))).toBe(true);
  });
});

// project-overview §"Success criteria" #6, verbatim: "a user with only
// `accounts-view` can trace a transaction from Accounts Overview to its GL
// line without any write affordance visible." Overview and Ledger are the
// only two surfaces gated on accounts_view alone (the GL line itself lives
// on GL Journal, gated on accounts_config:READ, not accounts_view — the
// trace crosses permissions but never needs a higher level than READ on
// any of them). This re-asserts, in one place, that neither accounts_view
// page carries any EDIT-level check or write affordance of any kind.
describe("accounts_view-only user has zero write affordance (project-overview success criterion #6)", () => {
  it.each([
    "app/(app)/accounts/overview/page.tsx",
    "app/(app)/accounts/ledger/page.tsx",
  ])(
    "%s has no server action, no POST form, and no EDIT-level or write-permission check",
    (file) => {
      const src = read(file);
      expect(src).not.toContain('"use server"');
      expect(src).not.toContain("'use server'");
      expect(src).not.toMatch(/method\s*=\s*["']post["']/i);
      expect(src).not.toContain("LEVELS.EDIT");
      expect(src).not.toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
      expect(src).not.toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    },
  );
});

// code-standards §8's last paragraph: "MANAGER-vs-USER approval routing is
// not a permission level — both hold accounts_transactions:EDIT; the
// threshold/role check (Q20) is a service-layer workflow rule on top of
// RBAC." Asserted here as a cross-cutting property, independent of the
// permission-level matrix above (behaviourally covered live against a DB by
// v11-document-state-machine.integration.test.ts; this is the structural
// proof that the checks live in the service layer, not gated by a
// permission constant, so no permission grant can bypass them).
describe("workflow rules that are not permission levels (code-standards §8, Module Inv. #6)", () => {
  const src = read("services/accounts/document-state-machine.ts");

  it("threshold routing: submitDocument compares doc.totalAmount against the reason code's auto_post_limit (Q20)", () => {
    expect(src).toContain(
      "money.compare(doc.totalAmount, reason.autoPostLimit)",
    );
    expect(src).toContain("pending_approval");
  });

  it("approver ≠ creator: approveDocument rejects actorId === doc.createdBy with SELF_APPROVAL (Inv. #6)", () => {
    expect(src).toContain(
      'if (actorId === doc.createdBy) return { ok: false, code: "SELF_APPROVAL" };',
    );
  });

  it("neither check is gated by a permission constant — a USER or MANAGER both holding accounts_transactions:EDIT are equally subject to them", () => {
    expect(src).not.toContain("PERMISSIONS.");
    expect(src).not.toContain("requirePermission");
  });
});

// ac04-spec §2.6 / §3.3, code-standards §8's onboarding-wizard row: "requires
// accounts_transactions:EDIT and the Customer module's own transition
// permission — both checked in the action."
describe("dual-permission onboarding action (ac04-spec §2.6/§3.3)", () => {
  const src = read("actions/accounts/onboard-customer-accounts.ts");

  it("requires PERMISSIONS.CUSTOMERS:EDIT via requirePermission (the primary guard)", () => {
    expect(src).toContain("requirePermission");
    expect(src).toContain("PERMISSIONS.CUSTOMERS");
  });

  it("additionally requires PERMISSIONS.ACCOUNTS_TRANSACTIONS:EDIT via meetsLevel (the second, independent check)", () => {
    expect(src).toContain("meetsLevel");
    expect(src).toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
  });

  it("both permissions are checked at EDIT — neither is satisfied by a lower level", () => {
    const editOccurrences = src.match(/LEVELS\.EDIT/g) ?? [];
    expect(editOccurrences.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain("LEVELS.READ");
  });

  it("returns FORBIDDEN (not a silent pass-through) when either check fails", () => {
    expect(src).toContain('{ ok: false, code: "FORBIDDEN" }');
  });
});
