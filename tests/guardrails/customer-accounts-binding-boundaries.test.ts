import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// cm22-spec §3.1 — the Invoice Template Binding update's ship-gate guardrails.
// Turns the update's negative-space rules into permanent CI facts: customer
// screens and the new Accounts read services never import a mutation path
// (custmgmt Inv. #11), posting never reads billing_account's template
// reference (Inv. #18), one validator, and two writers of the column. Pure
// node:fs/node:path static-source assertions over production source (never
// tests/) — no jsdom, no DB. Same shape as customer-module-boundaries.test.ts.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const SKIPPED_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__"]);

function collectFiles(dir: string, extensions = /\.(ts|tsx)$/): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...collectFiles(entryPath, extensions));
      }
    } else if (extensions.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function toRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function collectRelative(
  dirs: string[],
  extensions?: RegExp,
): { relative: string; content: string }[] {
  return dirs
    .flatMap((dir) => collectFiles(path.join(REPO_ROOT, dir), extensions))
    .map((filePath) => ({
      relative: toRelative(filePath),
      content: fs.readFileSync(filePath, "utf8"),
    }));
}

// Production-source roots — deliberately excludes tests/.
const SOURCE_SCAN_DIRS = [
  "actions",
  "app",
  "auth",
  "components",
  "db",
  "lib",
  "services",
  "types",
  "validation",
];

const IMPORT_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Every import specifier, with `@/` and relative paths normalised to a
// repo-relative path ("@/actions/x" → "actions/x").
function importTargets(source: string, fromRelative: string): string[] {
  const code = stripComments(source);
  return IMPORT_PATTERNS.flatMap((re) =>
    [...code.matchAll(re)].map((m) => m[1]!),
  ).map((spec) => {
    if (spec.startsWith("@/")) return spec.slice(2);
    if (spec.startsWith(".")) {
      return path.posix.normalize(
        path.posix.join(path.posix.dirname(fromRelative), spec),
      );
    }
    return spec;
  });
}

// Text of a call starting at `openParen` (the index of its "("), through the
// matching ")" and any chained `.method(...)` calls after it.
function chainText(source: string, openParen: number): string {
  let i = openParen;
  for (;;) {
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    const next = /^\s*\.\s*\w+\s*(?:<[^>]*>)?\s*\(/.exec(source.slice(i + 1));
    if (!next) return source.slice(openParen, i + 1);
    i = i + 1 + next[0].length - 1;
  }
}

// Name of the closest `async name(` / `function name(` before `index`.
function enclosingFunction(source: string, index: number): string | null {
  const re = /\b(?:async\s+|function\s+)(\w+)\s*\(/g;
  let name: string | null = null;
  for (const m of source.slice(0, index).matchAll(re)) name = m[1]!;
  return name;
}

// The production tree is read and comment-stripped once, then shared by
// checks 4 and 5 (re-reading it per check timed out under full-suite load).
let sourceFiles:
  | { relative: string; content: string; code: string }[]
  | undefined;
function productionSource() {
  sourceFiles ??= collectRelative(SOURCE_SCAN_DIRS).map((file) => ({
    ...file,
    code: stripComments(file.content),
  }));
  return sourceFiles;
}

describe("Invoice Template Binding boundaries (cm22 ship gate)", () => {
  // 1. custmgmt Inv. #11 — customer screens read accounting data read-only.
  // The two sanctioned customer-screen writes are onboarding (ac04/cm18) and
  // the template reset (cm21). The wizard's `get-wizard-options` read action
  // is also allowed: it is a read, not a mutation path (deviation from the
  // spec's literal list, recorded in custmgmt-progress-tracker.md cm22).
  it("customer screens import no Accounts mutation path, post-document, Accounts reversal UI or billing service", () => {
    const ALLOWED_ACCOUNTS_ACTIONS = [
      "actions/accounts/onboard-customer-accounts",
      "actions/accounts/set-billing-account-template",
      "actions/accounts/get-wizard-options",
    ];
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/^services\/accounts\/post-document(\.ts)?$/, "post-document"],
      [/^components\/accounts\/reversal-dialog(\.tsx?)?$/, "reversal-dialog"],
      [/^components\/accounts\/documents-table(\.tsx?)?$/, "documents-table"],
      [/^services\/billing\//, "a billing service"],
    ];

    const files = collectRelative([
      "app/(app)/customers",
      "components/customers",
    ]);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const { relative, content } of files) {
      for (const target of importTargets(content, relative)) {
        if (
          target.startsWith("actions/accounts/") &&
          !ALLOWED_ACCOUNTS_ACTIONS.includes(target.replace(/\.tsx?$/, ""))
        ) {
          offenders.push(`${relative} → ${target}`);
        }
        for (const [pattern, what] of FORBIDDEN) {
          if (pattern.test(target)) {
            offenders.push(`${relative} → ${target} (${what})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 2. The three Accounts read services behind the customer screens (cm20,
  // cm21) stay reads: no action, no posting, no ledger transfer, no
  // posting-time template resolver.
  it("the new Accounts read services import no mutation path", () => {
    const READ_SERVICES = [
      "services/accounts/get-customer-accounts-summary.ts",
      "services/accounts/list-customer-billing-accounts.ts",
      "services/accounts/resolve-ban-template-label.ts",
    ];

    const offenders: string[] = [];
    for (const file of READ_SERVICES) {
      const source = read(file);
      const code = stripComments(source);
      for (const target of importTargets(source, file)) {
        if (target.startsWith("actions/"))
          offenders.push(`${file} → ${target}`);
        if (/(^|\/)post-document(\.ts)?$/.test(target)) {
          offenders.push(`${file} → ${target}`);
        }
      }
      for (const name of [
        "pgledgerCreateTransfers",
        "resolveTemplate",
        "resolveVersionsForPosting",
      ]) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          offenders.push(`${file} references ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 3. custmgmt Inv. #18 (binding plan D4) — posting never reads
  // billing_account.ref_bill_template_version_id. The check keys on the table
  // pairing: customer_bill's own stamp (`customerBill.refBillTemplateVersionId`,
  // `customer_bill.ref_bill_template_version_id`) stays allowed even in a file
  // that also joins billingAccount for name/currency (customer-bill.repository,
  // invoice-render-input).
  it("posting never reads the billing_account template reference", () => {
    const files = [
      ...collectRelative(["services/billing", "db/repositories/billing"]),
      ...collectRelative(
        ["workflow-management"],
        /\.(ts|tsx|js|mjs|py|sql|ya?ml)$/,
      ),
    ];
    expect(files.length).toBeGreaterThan(20);

    const PAIRINGS = [
      /\bbillingAccount\s*\.\s*refBillTemplateVersionId\b/,
      /\bbilling_account\s*\.\s*ref_bill_template_version_id\b/i,
    ];
    const offenders = files
      .filter(({ content }) => PAIRINGS.some((re) => re.test(content)))
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);

    // Not vacuous: the allowed customer_bill stamp is in the scanned set.
    expect(
      files.some(({ content }) =>
        content.includes("customerBill.refBillTemplateVersionId"),
      ),
    ).toBe(true);
  });

  // 4. One validator (cm18) — defined once, used by the two writers only.
  it("assertBindableTemplate is defined in one file and used only by the two writers", () => {
    const OWN_FILE = "services/accounts/assert-bindable-template.ts";
    const CALLERS = [
      "services/accounts/onboard-customer-accounts.ts",
      "services/accounts/set-billing-account-template.ts",
    ];
    const files = productionSource();

    const definedIn = files
      .filter(({ content }) =>
        /export (?:async )?function assertBindableTemplate\(/.test(content),
      )
      .map(({ relative }) => relative);
    expect(definedIn).toEqual([OWN_FILE]);

    const referencedIn = files
      .filter(({ relative }) => relative !== OWN_FILE)
      .filter(({ code }) => /\bassertBindableTemplate\b/.test(code))
      .map(({ relative }) => relative)
      .sort();
    expect(referencedIn).toEqual([...CALLERS].sort());
  }, 30_000);

  // 5. Two writers (cm18, cm21) — the column is written by onboarding's BAN
  // insert and by `setTemplateRef`, nowhere else. Every billing_account write
  // site outside db/schema and db/migrations is inspected: repository write
  // calls, and direct Drizzle `.insert(billingAccount)` / `.update(billingAccount)`
  // chains.
  it("only onboarding's BAN insert and setTemplateRef write the template reference", () => {
    const files = productionSource().filter(
      ({ relative }) =>
        !relative.startsWith("db/schema/") &&
        !relative.startsWith("db/migrations/"),
    );

    const WRITE_SITES = [
      /\bbillingAccountRepository\s*\.\s*(insert|update\w*|setTemplateRef|close)\s*\(/g,
      /\.\s*(insert|update)\s*\(\s*billingAccount\s*\)/g,
    ];

    const writers: string[] = [];
    for (const { relative, code } of files) {
      for (const re of WRITE_SITES) {
        for (const m of code.matchAll(re)) {
          const openParen = m.index! + m[0].indexOf("(");
          if (/\brefBillTemplateVersionId\b/.test(chainText(code, openParen))) {
            writers.push(
              `${relative}#${enclosingFunction(code, m.index!) ?? "?"}:${m[1]}`,
            );
          }
        }
      }
      if (
        /\b(?:insert\s+into|update)\s+(?:billing\.)?billing_account\b[\s\S]{0,400}?\bref_bill_template_version_id\b/i.test(
          code,
        )
      ) {
        writers.push(`${relative} (raw SQL)`);
      }
    }

    expect(writers.sort()).toEqual(
      [
        "db/repositories/accounts/billing-account.repository.ts#setTemplateRef:update",
        "services/accounts/onboard-customer-accounts.ts#onboardCustomerAccounts:insert",
      ].sort(),
    );

    const setTemplateRefCallers = files
      .filter(({ code }) =>
        /\bbillingAccountRepository\s*\.\s*setTemplateRef\s*\(/.test(code),
      )
      .map(({ relative }) => relative);
    expect(setTemplateRefCallers).toEqual([
      "services/accounts/set-billing-account-template.ts",
    ]);
  }, 30_000);
});

describe("binding-boundary helpers (guardrail self-test)", () => {
  it("chainText follows a Drizzle chain through nested parens", () => {
    const src = `tx.update(billingAccount).set({ a: f(1) }).where(eq(x, y)).returning(); next()`;
    expect(chainText(src, src.indexOf("("))).toBe(
      "(billingAccount).set({ a: f(1) }).where(eq(x, y)).returning()",
    );
  });

  it("importTargets normalises @/ and relative specifiers", () => {
    expect(
      importTargets(
        [
          `import { a } from "@/actions/accounts/x";`,
          `import b from "../accounts/documents-table";`,
          `// import c from "@/services/billing/commented";`,
        ].join("\n"),
        "components/customers/example.tsx",
      ),
    ).toEqual(["actions/accounts/x", "components/accounts/documents-table"]);
  });

  it("enclosingFunction names the nearest method", () => {
    const src = `const r = {\n  async insert(tx) { a(); },\n  async setTemplateRef(tx) { HERE },\n};`;
    expect(enclosingFunction(src, src.indexOf("HERE"))).toBe("setTemplateRef");
  });
});
