import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// custmgmt Inv. #11 (cm20-spec verification checklist) — the customer screens
// read accounting data one-directionally and read-only. No file under
// app/(app)/customers/** or components/customers/** may import an Accounts
// mutation action, post-document, a pgledger wrapper, the Accounts module's
// reversal UI (documents-table / reversal-dialog / reverse-deposit-panel), a
// billing action, or the posting-time template resolver.
//
// Every import form is checked — `from "…"`, side-effect `import "…"`,
// dynamic `import("…")` and `require("…")` — with `@/` and relative
// specifiers normalised to a repo path before matching.
//
// The sanctioned Accounts action uses are the onboarding wizard (ac04 /
// cm18), which calls the onboarding action and its options read, and the
// Manage Customer Billing account panel's template reset (cm21).
const ALLOWED_ACCOUNTS_ACTIONS: Record<string, string[]> = {
  "components/customers/onboard-accounts-wizard.tsx": [
    "actions/accounts/get-wizard-options",
    "actions/accounts/onboard-customer-accounts",
  ],
  "components/customers/billing-account-panel.tsx": [
    "actions/accounts/set-billing-account-template",
  ],
  // cm23 — type-only: BIND_FAILURE_MESSAGES is keyed by the action's codes.
  "components/customers/billing-account-messages.ts": [
    "actions/accounts/set-billing-account-template",
  ],
};

const ROOT = process.cwd();
const SCANNED_DIRS = ["app/(app)/customers", "components/customers"];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const IMPORT_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  return IMPORT_PATTERNS.flatMap((re) =>
    [...code.matchAll(re)].map((m) => m[1]!),
  );
}

// "@/x/y" → "x/y"; "./x" / "../x" → repo-relative path; packages unchanged.
function normaliseSpecifier(spec: string, fromFile: string): string {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith(".")) {
    return relative(ROOT, resolve(dirname(fromFile), spec))
      .split(sep)
      .join("/");
  }
  return spec;
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/(^|\/)post-document(\.ts)?$/, "post-document"],
  [/pgledger/i, "a pgledger function or wrapper"],
  [/^db\/repositories\/accounts\/ledger\.repository/, "the ledger repository"],
  [
    /^components\/accounts\/(documents-table|reversal-dialog|reverse-deposit-panel)/,
    "the Accounts reversal UI",
  ],
  [/^actions\/billing\//, "a billing action"],
  [/(^|\/)resolve-template(\.ts)?$/, "the posting-time template resolver"],
];

function violations(file: string): string[] {
  const rel = relative(ROOT, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const spec of importSpecifiers(source)) {
    const target = normaliseSpecifier(spec, file);
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(target)) found.push(`${rel} imports ${what} (${spec})`);
    }
    if (
      target.startsWith("actions/accounts/") &&
      !(ALLOWED_ACCOUNTS_ACTIONS[rel] ?? []).includes(
        target.replace(/\.tsx?$/, ""),
      )
    ) {
      found.push(`${rel} imports an Accounts action (${spec})`);
    }
  }
  if (
    /\b(resolveTemplate|resolveVersionsForPosting)\b/.test(
      stripComments(source),
    )
  ) {
    found.push(`${rel} references the posting-time template resolver`);
  }
  return found;
}

describe("customer screens read accounts data read-only (custmgmt Inv. #11)", () => {
  const files = SCANNED_DIRS.flatMap((d) => walk(resolve(ROOT, d)));

  it("scans the customer page and component trees", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("customer-accounts-tab.tsx"))).toBe(
      true,
    );
  });

  it("no customer file imports an Accounts mutation, post-document, pgledger or reversal UI", () => {
    expect(files.flatMap(violations)).toEqual([]);
  });

  it("the allowlist only names files that exist and still use those actions", () => {
    for (const [file, actions] of Object.entries(ALLOWED_ACCOUNTS_ACTIONS)) {
      const full = resolve(ROOT, file);
      const targets = importSpecifiers(readFileSync(full, "utf8")).map((s) =>
        normaliseSpecifier(s, full),
      );
      for (const action of actions) expect(targets).toContain(action);
    }
  });
});

describe("import extraction (guardrail self-test)", () => {
  const from = resolve(ROOT, "components/customers/example.tsx");

  it("finds static, side-effect, dynamic and require imports", () => {
    const specs = importSpecifiers(
      [
        `import { a } from "@/actions/accounts/reverse";`,
        `import "../../services/accounts/post-document";`,
        `const m = await import("@/db/repositories/accounts/ledger.repository");`,
        `const r = require("../accounts/documents-table");`,
        `// import { x } from "@/actions/accounts/commented-out";`,
      ].join("\n"),
    );
    expect(specs.sort()).toEqual(
      [
        "@/actions/accounts/reverse",
        "../../services/accounts/post-document",
        "@/db/repositories/accounts/ledger.repository",
        "../accounts/documents-table",
      ].sort(),
    );
  });

  it("normalises @/ and relative specifiers to repo paths", () => {
    expect(normaliseSpecifier("@/actions/accounts/x", from)).toBe(
      "actions/accounts/x",
    );
    expect(normaliseSpecifier("../accounts/documents-table", from)).toBe(
      "components/accounts/documents-table",
    );
    expect(normaliseSpecifier("../../actions/accounts/x", from)).toBe(
      "actions/accounts/x",
    );
    expect(normaliseSpecifier("react", from)).toBe("react");
  });
});
