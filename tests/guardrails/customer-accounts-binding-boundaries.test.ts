import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// cm22-spec §3.1 / cm23-spec §3.12 (CM guardrail 11) — the Invoice Template
// Binding and Template Types guardrails. Turns the updates' negative-space
// rules into permanent CI facts: customer screens and the Accounts read
// services never import a mutation path or a Billing service/action (custmgmt
// Inv. #11, #22), Billing references billing_account's template TYPE column
// only in the run-start capture and template-types.ts (Inv. #19, billing
// Inv #54/#66), the dropped version column is referenced nowhere, one
// validator, and two Customer Management writers of the column. Pure
// node:fs/node:path static-source assertions — no jsdom, no DB. Same shape as
// customer-module-boundaries.test.ts.
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

// Check 3 (cm23, Inv. #19; CM guardrail 11). `billing_?account` with word
// boundaries matches the table / its repository, never a `billingAccountId` /
// `billing_account_id` key.
const BAN_TABLE = /\bbilling_?account(?:Repository)?\b/i;
const TEMPLATE_COLUMN =
  /\brefBillTemplateFamilyId\b|\bref_bill_template_family_id\b/i;
const BAN_TEMPLATE_PAIRINGS = [
  /\bbillingAccount\s*\.\s*refBillTemplateFamilyId\b/,
  /\bbilling_account"?\s*\.\s*"?ref_bill_template_family_id\b/i,
];
// bm82/bm83 (billing Inv #66) — the Bound BANs count and the retire switch
// read and write the BAN's type column; the whole file is exempt.
const TEMPLATE_TYPES_FILE =
  "services/billing/invoice-template/template-types.ts";
const CUSTOMER_BILL_STAMP_FILES = [
  "db/repositories/billing/customer-bill.repository.ts",
  "db/repositories/billing/invoice-render-input.ts",
];

// bm65 (billing Inv #54, D46) — the one sanctioned billing reader of the BAN
// template reference: the run-start capture SELECT (`listBanFamilies`). The
// exemption is that ONE function (Inv #54 names it), not the file: its body is
// cut out before the scan, and the rest of the file — which joins
// billingAccount for names and has bill_run_account's own same-named stamp
// column — is held to the direct-pairing rule, like the customer_bill stamp
// files. Posting files stay held to "never reads" (review fix, 2026-10-16).
const RUN_START_CAPTURE = {
  file: "db/repositories/billing/bill-run-account.repository.ts",
  fn: "listBanFamilies",
};

// The text of `async <name>(…) { … }` — from the declaration through its
// matching closing brace — or `null` when the file has no such method.
function methodBody(code: string, name: string): string | null {
  const start = code.search(new RegExp(`\\basync\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  // The body's brace follows the parameter list or the return type (`) {` /
  // `> {`), never a type literal's (`<{ … }>`).
  const brace = /[)>]\s*\{/.exec(code.slice(start));
  if (!brace) return null;
  const open = start + brace.index + brace[0].length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

function readsBanTemplateColumn(relative: string, code: string): boolean {
  if (relative === TEMPLATE_TYPES_FILE) return false;
  if (relative === RUN_START_CAPTURE.file) {
    const body = methodBody(code, RUN_START_CAPTURE.fn);
    const rest = body === null ? code : code.replace(body, "");
    return BAN_TEMPLATE_PAIRINGS.some((re) => re.test(rest));
  }
  if (BAN_TEMPLATE_PAIRINGS.some((re) => re.test(code))) return true;
  if (CUSTOMER_BILL_STAMP_FILES.includes(relative)) return false;
  return BAN_TABLE.test(code) && TEMPLATE_COLUMN.test(code);
}

// Check 5. A write whose column list the scan cannot see: a spread, a
// pre-built object passed to the repository's generic `insert`, or a Drizzle
// `.values(…)` / `.set(…)` that is not an inline object literal.
function hidesColumns(
  chain: string,
  viaRepository: boolean,
  method: string,
): boolean {
  if (/\.\.\.\s*[\w$(]/.test(chain)) return true;
  if (viaRepository) {
    return method === "insert" && !/^\(\s*[\w.]+\s*,\s*\{/.test(chain);
  }
  return /\.\s*(?:values|set)\s*\(\s*(?!\[?\s*\{)/.test(chain);
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
  // Accounts services are held to Inv. #11's two read services: a page that
  // imported a mutation service (e.g. close-billing-account) directly would
  // skip the action's permission checks.
  it("customer screens import no Accounts mutation path, post-document, Accounts reversal UI or billing service", () => {
    const ALLOWED_ACCOUNTS_ACTIONS = [
      "actions/accounts/onboard-customer-accounts",
      "actions/accounts/set-billing-account-template",
      "actions/accounts/get-wizard-options",
    ];
    const ALLOWED_ACCOUNTS_SERVICES = [
      "services/accounts/get-customer-accounts-summary",
      "services/accounts/list-customer-billing-accounts",
      // cm23 (Inv. #22) — the type select's options.
      "services/accounts/list-bindable-template-types",
    ];
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/^services\/accounts\/post-document(\.ts)?$/, "post-document"],
      [/^components\/accounts\/reversal-dialog(\.tsx?)?$/, "reversal-dialog"],
      [/^components\/accounts\/documents-table(\.tsx?)?$/, "documents-table"],
      [/^services\/billing(\/|$)/, "a billing service"],
      [
        /^db\/repositories\/(accounts|billing)(\/|$)/,
        "an Accounts/Billing repository",
      ],
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
        if (
          /^services\/accounts(\/|$)/.test(target) &&
          !ALLOWED_ACCOUNTS_SERVICES.includes(target.replace(/\.ts$/, ""))
        ) {
          offenders.push(
            `${relative} → ${target} (not an Inv. #11 read service)`,
          );
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

  // 2. The Accounts read services behind the customer screens (cm20, cm21,
  // cm23) stay reads: no action, no posting, no ledger transfer, no
  // posting-time template resolver — and no other write call either (the
  // ledger repository they read through also creates accounts).
  it("the new Accounts read services import no mutation path", () => {
    const READ_SERVICES = [
      "services/accounts/get-customer-accounts-summary.ts",
      "services/accounts/list-customer-billing-accounts.ts",
      "services/accounts/resolve-ban-template-label.ts",
      "services/accounts/list-bindable-template-types.ts",
    ];
    const WRITE_CALLS: Array<[RegExp, string]> = [
      [/\.\s*(?:transaction|insert|update|delete)\s*\(/, "a Drizzle write"],
      [
        /Repository\s*\.\s*(?:insert\w*|update\w*|delete\w*|create\w*|close|setTemplateRef)\s*\(/,
        "a repository write",
      ],
      [/\binsertAuditEvent\b/, "an audit write"],
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
        "resolveCurrentVersionsForFamily",
      ]) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          offenders.push(`${file} references ${name}`);
        }
      }
      for (const [pattern, what] of WRITE_CALLS) {
        if (pattern.test(code)) offenders.push(`${file} calls ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 3. custmgmt Inv. #19 / CM guardrail 11 — Billing references
  // billing_account.ref_bill_template_family_id only in `listBanFamilies`
  // (read) and template-types.ts (count, retire switch). Spec rule: no other
  // scanned file names the column together with billingAccount /
  // billing_account, so a read through a row variable or SQL alias
  // (`ban.refBillTemplateFamilyId`, `ba.ref_bill_template_family_id`) is
  // caught. The two files that join billingAccount for name/currency next to
  // customer_bill's own same-named stamp are held to the direct-pairing rule
  // instead (cm22 deviation), as is the rest of bill-run-account.repository.ts.
  it("Billing references the BAN template type column only in the capture read and template-types.ts", () => {
    const files = [
      ...collectRelative(["services/billing", "db/repositories/billing"]),
      ...collectRelative(
        ["workflow-management"],
        /\.(ts|tsx|js|mjs|py|sql|ya?ml)$/,
      ),
    ].map((file) => ({
      ...file,
      code: /\.(ts|tsx|js|mjs)$/.test(file.relative)
        ? stripComments(file.content)
        : file.content,
    }));
    expect(files.length).toBeGreaterThan(20);

    const offenders = files
      .filter(({ relative, code }) => readsBanTemplateColumn(relative, code))
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);

    // The exemptions name scanned files that still need them.
    for (const exempt of CUSTOMER_BILL_STAMP_FILES) {
      const file = files.find(({ relative }) => relative === exempt);
      expect(file, exempt).toBeDefined();
      expect(
        BAN_TABLE.test(file!.code) && TEMPLATE_COLUMN.test(file!.code),
        exempt,
      ).toBe(true);
    }

    // bm65 — the run-start capture exemption is scanned, the exempt function
    // exists and itself reads the column (not vacuous), and posting is still
    // held to "never reads".
    const capture = files.find(
      ({ relative }) => relative === RUN_START_CAPTURE.file,
    );
    expect(capture, RUN_START_CAPTURE.file).toBeDefined();
    const captureBody = methodBody(capture!.code, RUN_START_CAPTURE.fn);
    expect(captureBody, RUN_START_CAPTURE.fn).not.toBeNull();
    expect(
      BAN_TABLE.test(captureBody!) && TEMPLATE_COLUMN.test(captureBody!),
      `${RUN_START_CAPTURE.fn} reads billing_account.ref_bill_template_family_id`,
    ).toBe(true);
    expect(
      files.some(({ relative }) => relative === TEMPLATE_TYPES_FILE),
      TEMPLATE_TYPES_FILE,
    ).toBe(true);
    const postRun = files.find(
      ({ relative }) => relative === "services/billing/post-run.ts",
    );
    expect(postRun).toBeDefined();
    expect(readsBanTemplateColumn(postRun!.relative, postRun!.code)).toBe(
      false,
    );

    // Not vacuous: the allowed customer_bill stamp is in the scanned set.
    expect(
      files.some(({ content }) =>
        content.includes("customerBill.refBillTemplateFamilyId"),
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

  // 5. Two writers (cm18, cm21, cm23) — the column is written by onboarding's BAN
  // insert and by `setTemplateRef`, nowhere else. Every billing_account write
  // site outside db/schema and db/migrations is inspected: repository write
  // calls, and direct Drizzle `.insert(billingAccount)` / `.update(billingAccount)`
  // chains. A write that hides its column list (spread, pre-built object) is
  // listed separately: only the repository's own generic `insert(tx, data)`
  // may do that, and its callers are then held to inline literals.
  it("only onboarding's BAN insert and setTemplateRef write the template reference", () => {
    const files = productionSource().filter(
      ({ relative }) =>
        !relative.startsWith("db/schema/") &&
        !relative.startsWith("db/migrations/"),
    );

    const WRITE_SITES: Array<[RegExp, boolean]> = [
      [
        /\bbillingAccountRepository\s*\.\s*(insert|update\w*|setTemplateRef|close)\s*\(/g,
        true,
      ],
      [/\.\s*(insert|update)\s*\(\s*billingAccount\s*\)/g, false],
    ];

    const writers: string[] = [];
    const opaque: string[] = [];
    for (const { relative, code } of files) {
      for (const [re, viaRepository] of WRITE_SITES) {
        for (const m of code.matchAll(re)) {
          const openParen = m.index! + m[0].indexOf("(");
          const chain = chainText(code, openParen);
          const site = `${relative}#${enclosingFunction(code, m.index!) ?? "?"}:${m[1]}`;
          if (/\brefBillTemplateFamilyId\b/.test(chain)) writers.push(site);
          else if (hidesColumns(chain, viaRepository, m[1]!)) opaque.push(site);
        }
      }
      if (
        /\b(?:insert\s+into|update)\s+(?:"?billing"?\s*\.\s*)?"?billing_account\b[\s\S]{0,400}?\bref_bill_template_family_id\b/i.test(
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
    expect(opaque).toEqual([
      "db/repositories/accounts/billing-account.repository.ts#insert:insert",
    ]);

    const setTemplateRefCallers = files
      .filter(({ code }) =>
        /\bbillingAccountRepository\s*\.\s*setTemplateRef\s*\(/.test(code),
      )
      .map(({ relative }) => relative);
    expect(setTemplateRefCallers).toEqual([
      "services/accounts/set-billing-account-template.ts",
    ]);
  }, 30_000);

  // 6. cm23 (Inv. #19, CM guardrail 11) — the dropped version column
  // (`0054`) is referenced on billing_account by no code or test. Proximity
  // pairings, not file level: other tables (customer_bill, bill_run_account,
  // bill_template_version) keep a same-named column, and many files mention
  // billing_account for other reasons. The two migrations that add and drop
  // the column, and the two DB suites that assert it is gone, are exempt.
  it("no file references ref_bill_template_version_id on billing_account", () => {
    const EXEMPT = [
      "db/migrations/0050_billing_account_template_ref.sql",
      "db/migrations/0054_billing_account_template_type.sql",
      "tests/db/billing-account-template-column.integration.test.ts",
      "tests/db/billing-account-template-type-migration.integration.test.ts",
      "tests/guardrails/customer-accounts-binding-boundaries.test.ts",
    ];
    const OLD_COLUMN_ON_BAN = [
      /\bbillingAccount\s*\.\s*refBillTemplateVersionId\b/,
      /\bbilling_account"?\s*\.\s*"?ref_bill_template_version_id\b/i,
      // `ba` is the BAN alias throughout the SQL in this repo.
      /\bba\s*\.\s*"?ref_bill_template_version_id\b/i,
      // A Drizzle chain or raw statement on the BAN table naming the column.
      /\(\s*billingAccount\s*\)[^;]{0,400}?\brefBillTemplateVersionId\b/,
      /\bbilling_account\b"?[^;]{0,400}?\bref_bill_template_version_id\b/i,
      // A BAN write or fixture through the repository naming the column.
      /\bbillingAccountRepository\s*\.\s*\w+\s*\([^;]{0,400}?\brefBillTemplateVersionId\b/,
    ];
    const files = collectRelative(
      [...SOURCE_SCAN_DIRS, "tests", "workflow-management"],
      /\.(ts|tsx|js|mjs|py|sql|ya?ml)$/,
    ).filter(({ relative }) => !EXEMPT.includes(relative));
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter(({ relative, content }) => {
        const code = /\.(ts|tsx|js|mjs)$/.test(relative)
          ? stripComments(content)
          : content;
        return OLD_COLUMN_ON_BAN.some((re) => re.test(code));
      })
      .map(({ relative }) => relative)
      .sort();
    expect(offenders).toEqual([]);
  }, 30_000);

  // 7. cm23 (Inv. #11, #22; code-standards §10 General rule 4) — the customer
  // tree reads Billing through repositories only.
  it("no customer-tree file imports services/billing or actions/billing", () => {
    const files = collectRelative([
      "services/accounts",
      "app/(app)/customers",
      "components/customers",
    ]);
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const { relative, content } of files) {
      for (const target of importTargets(content, relative)) {
        if (/^(services|actions)\/billing(\/|$)/.test(target)) {
          offenders.push(`${relative} → ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 8. cm23 (code-standards §10 Styling rule 5) — the removed copy is gone.
  it("none of the four removed template strings remains in components, services or app", () => {
    const REMOVED = [
      "Reset to follow active template",
      "Already following the active template",
      "Follows active template (currently:",
      "Template reference not supported yet",
    ];
    const files = collectRelative(["components", "services", "app"]);
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.flatMap(({ relative, content }) =>
      REMOVED.filter((text) => content.includes(text)).map(
        (text) => `${relative}: "${text}"`,
      ),
    );
    expect(offenders).toEqual([]);
  });
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
