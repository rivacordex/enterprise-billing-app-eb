import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ac17-spec §2.3/§3.3 — the module's CI grep gates: the static checks that
// can't be fully covered by a behavioural test, wired into the existing
// lint/CI harness the same way cm16 established for Customer Management
// (tests/guardrails/customer-module-boundaries.test.ts) and pm09 for
// Product Management. Pure `node:fs`/`node:path` + static-source
// assertions — no jsdom, no DB. Each gate is mapped to the invariant/
// standard it enforces and scans the real source tree (not a fixed file
// list), so a future file that violates the invariant fails this suite
// instead of silently slipping past.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function collectFiles(dir: string, extensions: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, extensions));
    } else if (extensions.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

// Application-source scan roots — deliberately excludes `tests/**` (a test
// asserting a literal copy of a canonical identifier for regression-locking
// isn't a forbidden call site) and `db/pgledger/**` (the vendored upstream
// SQL + transform script legitimately names every pgledger_* identifier —
// that's Inv. #14's concern, audited separately below, not Inv. #3/#4's).
const SOURCE_SCAN_DIRS = [
  "actions",
  "app",
  "components",
  "db",
  "services",
  "validation",
];

type SourceFile = { relative: string; content: string };

function collectSourceFiles(): SourceFile[] {
  return SOURCE_SCAN_DIRS.flatMap((dir) =>
    collectFiles(path.join(REPO_ROOT, dir), /\.(ts|tsx)$/),
  )
    .map((filePath) => ({
      relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
      content: fs.readFileSync(filePath, "utf8"),
    }))
    .filter(({ relative }) => !relative.startsWith("db/pgledger/"));
}

// Strips `//` line comments before matching, so a comment that happens to
// mention a restricted identifier by name (common throughout this module's
// heavily-annotated source — every unit's progress-tracker-style comments
// reference `pgledger_*` names in prose) isn't mistaken for a real call
// site. Line comments only (no block-comment stripping) — matches the actual
// comment style used throughout this codebase (verified: no module source
// file uses `/* */` for this kind of prose). String-aware: `//` inside a
// quoted string literal is preserved so URLs in strings aren't truncated.
// Cross-line state is carried across iterations so multiline template
// literals are handled correctly — a // on a continuation line is string
// content, not a comment. Template-literal ${...} interpolation is tracked
// so expressions inside ${} remain detectable as code.
function stripLineComments(content: string): string {
  // mode/interpDepth persist across lines for multiline template literals.
  let mode: "code" | "string" | "template" = "code";
  let stringChar = ""; // closing delimiter for mode === "string" (' or ")
  let interpDepth = 0; // ${...} nesting depth inside a template literal

  const lines = content.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    let cutAt = -1;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      const next = line[i + 1];

      if (mode === "string") {
        if (ch === "\\") {
          i++; // skip escaped character
          continue;
        }
        if (ch === stringChar) {
          mode = "code";
          stringChar = "";
        }
      } else if (mode === "template") {
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === "`") {
          mode = "code";
        } else if (ch === "$" && next === "{") {
          mode = "code";
          interpDepth = 1;
          i++; // consume "{"
        }
      } else {
        // code mode — outside any string, or inside a ${...} interpolation
        if (ch === "\\") {
          i++;
          continue;
        }
        if (interpDepth > 0) {
          if (ch === "{") {
            interpDepth++;
            continue;
          }
          if (ch === "}") {
            if (--interpDepth === 0) mode = "template";
            continue;
          }
        }
        if (ch === '"' || ch === "'") {
          mode = "string";
          stringChar = ch;
        } else if (ch === "`") {
          mode = "template";
        } else if (ch === "/" && next === "/") {
          cutAt = i;
          break;
        }
      }
    }

    result.push(cutAt >= 0 ? line.slice(0, cutAt) : line);
  }

  return result.join("\n");
}

const ALL_SOURCE_FILES = collectSourceFiles();

describe("grep gate — pgledger_create_transfer(s) called only from the document-posting path (code-standards §1.1, Inv. #3)", () => {
  const OWN_FILES = new Set([
    "services/accounts/post-document.ts",
    "db/repositories/accounts/ledger.repository.ts",
  ]);
  const CALL_PATTERN =
    /\bpgledger_create_transfers?\b|\.pgledgerCreateTransfers\(/;

  it("no source file outside post-document.ts / ledger.repository.ts calls pgledger_create_transfer(s)", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) => !OWN_FILES.has(relative),
    )
      .filter(({ content }) => CALL_PATTERN.test(stripLineComments(content)))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("post-document.ts is the only service that reaches ledgerRepository.pgledgerCreateTransfers", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) =>
        relative.startsWith("services/accounts/") &&
        relative !== "services/accounts/post-document.ts",
    )
      .filter(({ content }) =>
        stripLineComments(content).includes("pgledgerCreateTransfers"),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });
});

describe("grep gate — pgledger functions/views referenced only under db/repositories/accounts/ (code-standards §6.3, Inv. #4)", () => {
  // The five literal identifiers the pgledger fork exposes to callers
  // (architecture §1, code-standards §6.3), matched only in their real
  // invocation shape — every genuine call site in this codebase qualifies
  // the view/function with `billing.` and, for the two functions, follows
  // immediately with `(` (real SQL invocation syntax). This deliberately
  // does NOT match a bare `pgledger_` prefix: that also appears throughout
  // the module's prose comments (explaining *why* a repository is the sole
  // caller) and inside a runtime error-message string in post-document.ts
  // ("pgledger_create_transfers returned N transfers...") — neither is a
  // call site, and a bare-prefix gate would flag both as false positives.
  const PGLEDGER_SURFACE =
    /\bbilling\.pgledger_(accounts_view|transfers_view|entries_view|create_account\(|create_transfers\()/;

  it("no source file outside db/repositories/accounts/ references a pgledger function or view", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) => !relative.startsWith("db/repositories/accounts/"),
    )
      .filter(({ content }) =>
        PGLEDGER_SURFACE.test(stripLineComments(content)),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("db/repositories/accounts/ledger.repository.ts genuinely does reference the pgledger surface (the gate isn't vacuously passing)", () => {
    const src = read("db/repositories/accounts/ledger.repository.ts");
    expect(PGLEDGER_SURFACE.test(stripLineComments(src))).toBe(true);
  });
});

describe("grep gate — money arithmetic only in services/accounts/money.ts (code-standards §2.2)", () => {
  const OWN_FILE = "services/accounts/money.ts";
  // `parseFloat` on any amount is a blanket ban outside money.ts. `Number(`
  // is scoped to calls whose argument looks like an amount/money value
  // (contains "amount", case-insensitive, immediately after the paren) —
  // the same precedent regex route-level-gl-journal.test.ts and
  // v06b/ac14's journal-csv checks already established, chosen specifically
  // to avoid false-positiving on the module's many legitimate non-money
  // `Number(...)` calls (pagination totals, unmapped-account counts, config
  // limits).
  const PARSE_FLOAT_PATTERN = /\bparseFloat\(/;
  const NUMBER_ON_AMOUNT_PATTERN = /\bNumber\(\s*[a-zA-Z.?[\]]*[Aa]mount/;

  // Documented, reviewed carve-out (pm31, user-confirmed 2026-08-12): the
  // order review panel computes a **display-only** Δ% between an order's list
  // and negotiated price to help a manager judge an override at approval time.
  // It is not money arithmetic in the sense this gate guards — it never
  // produces a monetary value and is never a rating/billing source (product
  // Inv. #7/#16: bills are reconstructed only from immutable price + override
  // rows, never from a rendered percentage). The pm31 spec mandates the Δ%
  // column explicitly; this is the single sanctioned `Number(<amount>)` call
  // site outside money.ts, allow-listed here rather than dodged by renaming.
  const NUMBER_ON_AMOUNT_ALLOWED = new Set<string>([
    "components/products/ordering/order-review-panel.tsx",
  ]);

  it("no source file outside money.ts calls parseFloat(", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) => relative !== OWN_FILE,
    )
      .filter(({ content }) =>
        PARSE_FLOAT_PATTERN.test(stripLineComments(content)),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("no source file outside money.ts calls Number( on an amount-named value", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) =>
        relative !== OWN_FILE && !NUMBER_ON_AMOUNT_ALLOWED.has(relative),
    )
      .filter(({ content }) =>
        NUMBER_ON_AMOUNT_PATTERN.test(stripLineComments(content)),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("the Number(<amount>) allow-list is not vacuous — each entry genuinely trips the pattern", () => {
    // Guards the carve-out from silently rotting: if the review panel ever
    // stops doing the Δ% computation, drop it from the allow-list rather than
    // leaving a dead exception behind.
    for (const relative of NUMBER_ON_AMOUNT_ALLOWED) {
      const entry = ALL_SOURCE_FILES.find((f) => f.relative === relative);
      expect(entry, `${relative} should exist`).toBeDefined();
      expect(
        NUMBER_ON_AMOUNT_PATTERN.test(stripLineComments(entry!.content)),
        `${relative} should still contain the allow-listed Number(<amount>) call`,
      ).toBe(true);
    }
  });
});

describe("grep gate — no raw < 0 / > 0 comparison on a balance string outside the signed-balance helpers (code-standards §2.3)", () => {
  const OWN_FILE = "services/accounts/money.ts";
  // Matches an identifier containing "balance" (case-insensitive) directly
  // compared against a numeric literal — `balance < 0`, `balance.foo > 0`,
  // `0 <= someBalance`, etc. Scoped to the word "balance" specifically
  // (rather than "amount", which money.ts's own compare()-based callers use
  // constantly for non-sign purposes) since that's the code-standards §2.3
  // wording: "never a raw < 0 comparison on a balance string."
  //
  // A comparison against a `0n`-style BigInt literal is deliberately
  // excluded: TypeScript's `string`/`number` relational-operator check means
  // a *string* balance can never reach a bare `< 0` in the first place
  // without an unconverted `Number()`/`parseFloat()` first (already its own
  // gate, above) — every real `< 0n` in this module (e.g.
  // `rounding-adjustment.ts`'s `balanceSen < 0n ? -balanceSen : balanceSen`)
  // operates on a `bigint` already produced by `money.stringToSen()`, which
  // *is* the sanctioned encapsulation the invariant asks for, just inlined
  // rather than wrapped in a third named helper.
  const RAW_BALANCE_COMPARISON_PATTERN =
    /(\w*[Bb]alance\w*)\s*([<>]=?)\s*(-?\d+n?)|(-?\d+n?)\s*([<>]=?)\s*(\w*[Bb]alance\w*)/g;

  function hasRawBalanceComparison(content: string): boolean {
    for (const match of content.matchAll(RAW_BALANCE_COMPARISON_PATTERN)) {
      const numericLiteral = match[3] ?? match[4] ?? "";
      if (numericLiteral.endsWith("n")) continue; // BigInt literal — sanctioned.
      return true;
    }
    return false;
  }

  it("no source file outside money.ts raw-compares a balance-named value against a numeric (non-BigInt) literal", () => {
    const offenders = ALL_SOURCE_FILES.filter(
      ({ relative }) => relative !== OWN_FILE,
    )
      .filter(({ content }) =>
        hasRawBalanceComparison(stripLineComments(content)),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("money.ts's own signed-balance helpers (openReceivable/isHeldLiability) are the only place a balance's sign is interpreted", () => {
    const src = read(OWN_FILE);
    expect(src).toContain("export function openReceivable");
    expect(src).toContain("export function isHeldLiability");
  });
});

describe("grep gate — no delete function on any billing.* table (code-standards §1.3, Inv. #11)", () => {
  const REPO_DIR = path.join(REPO_ROOT, "db/repositories/accounts");
  const repoFiles = collectFiles(REPO_DIR, /\.ts$/);

  it.each(repoFiles.map((f) => path.relative(REPO_ROOT, f)))(
    "%s has no .delete(/DROP/DELETE FROM billing.* call",
    (relativePath) => {
      const src = stripLineComments(
        fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
      );
      expect(src).not.toContain(".delete(");
      expect(src).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    },
  );

  it("at least one repository file was actually scanned (the gate isn't vacuously passing)", () => {
    expect(repoFiles.length).toBeGreaterThan(0);
  });
});

describe("grep gate — no monetary balance column in any billing module table (Inv. #2)", () => {
  const SCHEMA_DIR = path.join(REPO_ROOT, "db/schema/billing");
  const schemaFiles = collectFiles(SCHEMA_DIR, /\.ts$/);

  // Drizzle column declarations look like `numeric("balance", ...)` or
  // `balance: numeric(...)` — matches either the property key or the
  // physical column-name string literal, case-insensitive, word-bounded so
  // `openingBalanceOverride`-style unrelated fields aren't swept in by
  // accident (none exist today, but the pattern stays precise either way).
  const BALANCE_COLUMN_PATTERN =
    /\bbalance\s*:\s*(numeric|integer|bigint)\(|numeric\(\s*["']balance["']/i;

  it.each(schemaFiles.map((f) => path.relative(REPO_ROOT, f)))(
    "%s declares no stored balance column",
    (relativePath) => {
      const src = stripLineComments(
        fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
      );
      expect(src).not.toMatch(BALANCE_COLUMN_PATTERN);
    },
  );

  it("at least one schema file was actually scanned (the gate isn't vacuously passing)", () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
  });
});

describe("grep gate — pgledger:transform is in sync (Inv. #14, Q10)", () => {
  // The re-run-reproduces-byte-for-byte proof already lives beside the
  // vendored fork (ac01-spec §3.7); this gate audits that the enforcing
  // test itself still exists and still asserts sync, rather than
  // duplicating the transform re-run here (transform.test.ts already runs
  // as part of the same `npm run test` gate this file runs under).
  it("tests/pgledger/transform.test.ts exists and asserts the generated file is in sync", () => {
    const filePath = path.join(REPO_ROOT, "tests/pgledger/transform.test.ts");
    expect(fs.existsSync(filePath)).toBe(true);
    const src = fs.readFileSync(filePath, "utf8");
    expect(src).toContain("is in sync");
    expect(src).toContain("buildGeneratedSql");
  });
});

describe("grep gate — no --ai-*/gradient tokens on any /accounts/** or accounts-settings surface (ui-context §5)", () => {
  const SCAN_ROOTS = [
    path.join(REPO_ROOT, "app/(app)/accounts"),
    path.join(REPO_ROOT, "app/(app)/administration/accounts-settings"),
    path.join(REPO_ROOT, "components/accounts"),
  ];
  const AI_GRADIENT_PATTERN = /--ai-|--gradient-/;

  const surfaceFiles = SCAN_ROOTS.flatMap((root) =>
    collectFiles(root, /\.(ts|tsx)$/),
  );

  it.each(surfaceFiles.map((f) => path.relative(REPO_ROOT, f)))(
    "%s has no --ai-*/--gradient-* token",
    (relativePath) => {
      const src = stripLineComments(
        fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
      );
      expect(src).not.toMatch(AI_GRADIENT_PATTERN);
    },
  );

  it("at least one Accounts surface file was actually scanned (the gate isn't vacuously passing)", () => {
    expect(surfaceFiles.length).toBeGreaterThan(0);
  });
});

describe("grep gate — inv. #20: ten create-panel files export their component and import no Dialog (wrapper shell moved outward, ac19)", () => {
  // The dialog shell is in TransactionsActionBar, not inside the panel files.
  // Any Dialog import in a panel file would mean the abstraction leaked inward
  // and inv. #20 (panels remain standalone-renderable) would be violated.
  const PANEL_ENTRIES: [string, string][] = [
    ["components/accounts/capture-payment-panel.tsx", "CapturePaymentPanel"],
    ["components/accounts/allocate-payment-panel.tsx", "AllocatePaymentPanel"],
    ["components/accounts/payment-refund-panel.tsx", "PaymentRefundPanel"],
    ["components/accounts/raise-credit-note-panel.tsx", "RaiseCreditNotePanel"],
    ["components/accounts/raise-debit-note-panel.tsx", "RaiseDebitNotePanel"],
    ["components/accounts/capture-deposit-panel.tsx", "CaptureDepositPanel"],
    ["components/accounts/reverse-deposit-panel.tsx", "ReverseDepositPanel"],
    ["components/accounts/refund-deposit-panel.tsx", "RefundDepositPanel"],
    ["components/accounts/write-off-panel.tsx", "WriteOffPanel"],
    [
      "components/accounts/rounding-adjustment-panel.tsx",
      "RoundingAdjustmentPanel",
    ],
  ];

  it.each(PANEL_ENTRIES)(
    "%s exports %s and contains no Dialog import",
    (relativePath, exportName) => {
      const src = read(relativePath);
      expect(src).toContain(`export function ${exportName}`);
      expect(src).not.toMatch(/from\s+["']@\/components\/ui\/dialog["']/);
    },
  );

  it("Dialog is imported only by the action-bar shell and the ac22 reversal dialog (each a legitimate owner)", () => {
    // ac19 established TransactionsActionBar as the create-panel Dialog owner;
    // ac22 adds reversal-dialog.tsx, the document-bound reversal Dialog. The
    // ten create-panels still import no Dialog (asserted above) — the shell
    // stays outward of them. These two are the only sanctioned Dialog importers.
    const DIALOG_IMPORT = /from\s+["']@\/components\/ui\/dialog["']/;
    const accountsComponents = ALL_SOURCE_FILES.filter(({ relative }) =>
      relative.startsWith("components/accounts/"),
    );
    const dialogImporters = accountsComponents
      .filter(({ content }) => DIALOG_IMPORT.test(content))
      .map(({ relative }) => relative)
      .sort();
    expect(dialogImporters).toEqual([
      "components/accounts/reversal-dialog.tsx",
      "components/accounts/transactions-action-bar.tsx",
    ]);
  });
});

describe("grep gate — ac22 SC10: reversal always starts from a document, never a free-text doc-ID input", () => {
  // The retired ReversalsPanel started reversal from a free-typed document ID.
  // ac22 makes every reversal document-bound (the dialog receives a documentId
  // prop from the row/drawer). This gate locks that in: the panel file is gone,
  // and no reversal surface carries a free-text input primed with a document-ID
  // example (the tell-tale of a type-the-ID-yourself control).
  //
  // "Reversal surface" = a component that imports the reverse-document action.
  // Scoping to that import is what keeps the gate precise: the documents-table
  // search box and the allocate panel's settled-document field both legitimately
  // exemplify a document ID, but neither drives a reversal, so neither is swept
  // in — only a file that both reverses AND types a doc-ID would fail.
  const REVERSAL_ACTION_IMPORT =
    /from\s+["']@\/actions\/accounts\/reverse-document["']/;
  const DOC_ID_INPUT_PATTERN =
    /placeholder=\s*["'][^"']*(PAY|DEP|CRN|DBN|ADJ)\d{2}/;

  it("reversals-panel.tsx no longer exists", () => {
    const panelPath = path.join(
      REPO_ROOT,
      "components/accounts/reversals-panel.tsx",
    );
    expect(fs.existsSync(panelPath)).toBe(false);
  });

  it("no reversal surface has a free-text document-ID input", () => {
    const offenders = ALL_SOURCE_FILES.filter(({ relative }) =>
      relative.startsWith("components/accounts/"),
    )
      .filter(({ content }) => REVERSAL_ACTION_IMPORT.test(content))
      .filter(({ content }) =>
        DOC_ID_INPUT_PATTERN.test(stripLineComments(content)),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("the reversal dialog is document-bound (documentId is a prop, not typed input)", () => {
    const src = read("components/accounts/reversal-dialog.tsx");
    // The dialog and its trigger both take documentId as a prop.
    expect(src).toContain("documentId: string");
    // It imports the reverse-document action (the reversal surface) …
    expect(REVERSAL_ACTION_IMPORT.test(src)).toBe(true);
    // … yet exposes no document-ID example input of its own.
    expect(DOC_ID_INPUT_PATTERN.test(stripLineComments(src))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// ac23-spec §2.3/§3.2 — the Transactions-revision static gates. Each maps to a
// module invariant added by the revision (architecture §6 #15–#21) or to the
// §9 Result-code catalog, and scans the real source tree so a *future*
// violating file fails the suite. inv. #20 (panels-unwrapped) and SC10
// (no free-text reversal id) already have their gates above (ac19/ac22); the
// six below complete the eight-gate set in ac23-spec §2.3.
// ────────────────────────────────────────────────────────────────────────

describe("grep gate — inv. #15: the workbench read path never writes", () => {
  // list-transaction-documents.ts, get-transaction-document-detail.ts and the
  // repository's listForContext method issue SELECTs only — no INSERT/UPDATE/
  // DELETE, no transaction, no pgledger function call (architecture inv. #15).
  const WRITE_CALL = /\.(insert|update|delete)\(/;
  const TRANSACTION_CALL = /\.transaction\(/;
  const PGLEDGER = /\bpgledger_/;

  const READ_SERVICES = [
    "services/accounts/list-transaction-documents.ts",
    "services/accounts/get-transaction-document-detail.ts",
  ];

  it.each(READ_SERVICES)(
    "%s issues no write, transaction or pgledger call",
    (relativePath) => {
      const src = stripLineComments(read(relativePath));
      expect(src).not.toMatch(WRITE_CALL);
      expect(src).not.toMatch(TRANSACTION_CALL);
      expect(src).not.toMatch(PGLEDGER);
    },
  );

  it("document.repository.ts listForContext (the read method) issues no write, transaction or pgledger call", () => {
    // Slice from the method's start to the end of the file: listForContext is
    // the last method on the repository object, so the slice captures only it —
    // the file's write methods (insert/updateEventAt/compareAndUpdateState) live
    // above it and are correctly excluded.
    const full = stripLineComments(
      read("db/repositories/accounts/document.repository.ts"),
    );
    const start = full.indexOf("async listForContext(");
    expect(start).toBeGreaterThanOrEqual(0); // method exists — gate not vacuous
    const body = full.slice(start);
    expect(body).not.toMatch(WRITE_CALL);
    expect(body).not.toMatch(TRANSACTION_CALL);
    expect(body).not.toMatch(PGLEDGER);
  });
});

describe("grep gate — inv. #16: BAN-scoped document queries admit FA-level docs", () => {
  // Any source narrowing documents by billing account under an FA constraint
  // must also admit `ref_billing_account_id IS NULL` — a bare `= :ban`
  // predicate silently hides payment captures and all deposits (inv. #16).
  const FA_CONSTRAINT = /ref_financial_account_id|refFinancialAccountId/;
  // A BAN *narrowing* predicate: raw-SQL equality on the snake_case column, or a
  // Drizzle eq() on the camelCase column. Excludes writes (`refBillingAccountId:`
  // / `refBillingAccountId,`), which carry no `=`/eq() comparison.
  const BAN_NARROWING =
    /ref_billing_account_id\s*=(?!=)|eq\(\s*\w+\.refBillingAccountId\b/;
  const NULL_ADMISSION =
    /ref_billing_account_id\s+IS\s+NULL|isNull\(\s*\w+\.refBillingAccountId/i;
  // inv. #16 is a `document`/`document_line`-table invariant. Scope the gate to
  // files that actually query those tables — a file that narrows a DIFFERENT
  // table (`customer_bill`, `bill_run_account`, …) by BAN under an FA constraint
  // is not a document query and is not subject to this rule. Without this scope
  // the bare column-name regexes false-positive on billing repositories that
  // merely reference both column names. The primary, alias-proof signal is the
  // schema import: any drizzle query against the document/document_line table
  // MUST import it from `@/db/schema/billing/documents`, so an aliased
  // (`alias(document, "d")`) or renamed usage is still caught. The from/join and
  // raw `billing.document` alternatives are belt-and-suspenders for raw SQL.
  const DOCUMENT_TABLE =
    /schema\/billing\/documents\b|\b(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*document(?:Line)?[\s,)]|billing\.document(?:_line)?\b/;

  it("no source narrows documents by BAN without admitting ref_billing_account_id IS NULL", () => {
    const offenders = ALL_SOURCE_FILES.filter(({ content }) => {
      const src = stripLineComments(content);
      return (
        DOCUMENT_TABLE.test(src) &&
        FA_CONSTRAINT.test(src) &&
        BAN_NARROWING.test(src) &&
        !NULL_ADMISSION.test(src)
      );
    }).map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("document.repository.ts genuinely narrows by BAN and admits the FA-level NULL (the gate isn't vacuously passing)", () => {
    const src = stripLineComments(
      read("db/repositories/accounts/document.repository.ts"),
    );
    expect(BAN_NARROWING.test(src)).toBe(true);
    expect(NULL_ADMISSION.test(src)).toBe(true);
  });
});

describe("grep gate — inv. #17: selection context is URL-derived and nav-preserved", () => {
  // party/fa/ban live only in search params (parsed through
  // parseAccountsContext); they are never held in component state, storage, or a
  // context provider — and every Accounts nav link propagates them (inv. #17, D7).
  const ACCOUNTS_UI_ROOTS = [
    path.join(REPO_ROOT, "app/(app)/accounts"),
    path.join(REPO_ROOT, "components/accounts"),
  ];
  const uiFiles = ACCOUNTS_UI_ROOTS.flatMap((root) =>
    collectFiles(root, /\.(ts|tsx)$/),
  ).map((filePath) => ({
    relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
    content: fs.readFileSync(filePath, "utf8"),
  }));
  const FORBIDDEN_HOLDER = /\b(localStorage|sessionStorage|createContext)\b/;
  // inv. #17 also forbids holding the selection context in component state. Match
  // a React state tuple whose first binding is exactly party/fa/ban (the trailing
  // `\s*,` keeps `banner`/`fallback` out), or a useState initialised from the
  // parsed context — either would be a URL-context copy living in state.
  const CONTEXT_IN_STATE =
    /\[\s*(?:party|fa|ban)\s*,[^\]]*\]\s*=\s*useState|useState\s*(?:<[^>]*>)?\s*\([^)]*parseAccountsContext/;

  it("at least one Accounts UI file was scanned (the gate isn't vacuously passing)", () => {
    expect(uiFiles.length).toBeGreaterThan(0);
  });

  it("no Accounts page or component holds context in storage, a context provider, or component state", () => {
    const offenders = uiFiles
      .filter(({ content }) => {
        const src = stripLineComments(content);
        return FORBIDDEN_HOLDER.test(src) || CONTEXT_IN_STATE.test(src);
      })
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("the Accounts nav section carries the selection context onto every link (D7)", () => {
    const nav = read("components/admin-nav.tsx");
    // The Accounts section is flagged and its links are built from the parsed
    // context; parseAccountsContext remains the sole parser (code-standards §3.1).
    expect(nav).toContain("carriesAccountsContext: true");
    expect(nav).toContain("parseAccountsContext");
    expect(nav).toMatch(/carriesAccountsContext && ctxQuery/);
  });
});

describe("grep gate — inv. #18: reversal eligibility is derived once, never re-copied into a component", () => {
  // The `state === "posted"` + unreversed-line predicate is derived once, in
  // ac20's read service (list-transaction-documents.ts). Components consume the
  // resulting `reversible`/`partiallyReversed` flags — they never recompute the
  // conjunction (architecture inv. #18). The drawer's per-line `reversedByLineId
  // !== null` *display* flag is not the eligibility conjunction and is not matched.
  const POSTED = /===\s*["']posted["']/;
  const UNREVERSED =
    /reversedByLineId\s*===\s*null|unreversedLineCount\s*>\s*0/;

  it("list-transaction-documents.ts holds the derivation (the gate isn't vacuously passing)", () => {
    const src = read("services/accounts/list-transaction-documents.ts");
    expect(POSTED.test(src)).toBe(true);
    expect(UNREVERSED.test(src)).toBe(true);
  });

  it("no components/accounts file re-derives the posted + unreversed-line conjunction", () => {
    const offenders = ALL_SOURCE_FILES.filter(({ relative }) =>
      relative.startsWith("components/accounts/"),
    )
      .filter(({ content }) => {
        const src = stripLineComments(content);
        return POSTED.test(src) && UNREVERSED.test(src);
      })
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });
});

describe("grep gate — inv. #19: the document types are closed (no invented type in a component)", () => {
  // No filter option, badge, or label under components/accounts/** names a
  // document *type* outside PAY/DEP/CRN/DBN/ADJ/INV (bm09 added INV as a real
  // schema-level type, not a component-invented one). The forbidden literals
  // are matched only in a doc-type position (a line that also references
  // `doc_type`/`docType`), so the action-bar's legitimate `write_off`
  // *ActionKey* (a launcher id) and the drawer's `refund` *line-kind* label —
  // neither a doc type — are not mis-flagged (architecture inv. #19).
  const DOC_TYPE_LINE = /doc[_]?type/i;
  const FORBIDDEN_LITERAL = /["'](reversal|refund|write_off)["']/;

  it("types/accounts.ts DOC_TYPES is exactly the six (source of truth, gate not vacuous)", () => {
    const src = read("types/accounts.ts");
    expect(src).toMatch(
      /DOC_TYPES\s*=\s*\[\s*"PAY",\s*"DEP",\s*"CRN",\s*"DBN",\s*"ADJ",\s*"INV",?\s*\]/,
    );
  });

  it("no components/accounts file uses a forbidden literal in a doc-type position", () => {
    const offenders = ALL_SOURCE_FILES.filter(({ relative }) =>
      relative.startsWith("components/accounts/"),
    )
      .filter(({ content }) =>
        stripLineComments(content)
          .split("\n")
          .some(
            (line) => DOC_TYPE_LINE.test(line) && FORBIDDEN_LITERAL.test(line),
          ),
      )
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });
});

describe("grep gate — code-standards §9: the Result-code catalog is current", () => {
  // Every `code: "…"` literal under services/accounts/** and actions/accounts/**
  // appears in §9 of acctmgmt-code-standards.md — the reconciled 49-code catalog
  // (§9.8.3: "adding a code is a doc change"). This is the one doc assertion that
  // is machine-checkable, so it stays reconciled as new codes land.
  const CODE_LITERAL = /code:\s*["']([A-Z][A-Z0-9_]+)["']/g;

  function codesIn(dir: string): Set<string> {
    const found = new Set<string>();
    for (const file of collectFiles(path.join(REPO_ROOT, dir), /\.ts$/)) {
      const src = stripLineComments(fs.readFileSync(file, "utf8"));
      for (const match of src.matchAll(CODE_LITERAL)) found.add(match[1]!);
    }
    return found;
  }

  const sourceCodes = new Set<string>([
    ...codesIn("services/accounts"),
    ...codesIn("actions/accounts"),
  ]);

  function catalogCodes(): Set<string> {
    const doc = read(
      "context/accounting-management/acctmgmt-code-standards.md",
    );
    const start = doc.indexOf("## 9. Result Error Code Catalog");
    if (start < 0) return new Set<string>();
    // Bound the scan to §9 only — from its heading to the next top-level "## "
    // heading (or EOF if §9 is last) — so a future §10 can't leak codes in.
    const after = doc.slice(start);
    const nextHeading = after.indexOf("\n## ");
    const section = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
    const codes = new Set<string>();
    for (const match of section.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      codes.add(match[1]!);
    }
    return codes;
  }

  it("§9 of the code-standards doc is present and lists Result codes (gate not vacuous)", () => {
    const catalog = catalogCodes();
    expect(catalog.size).toBeGreaterThanOrEqual(40);
  });

  it("collected a non-trivial number of shipped Result codes (gate not vacuous)", () => {
    expect(sourceCodes.size).toBeGreaterThanOrEqual(40);
  });

  it("every shipped Result code is documented in §9", () => {
    const catalog = catalogCodes();
    const undocumented = [...sourceCodes]
      .filter((code) => !catalog.has(code))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("the shipped catalog is exactly 51 codes (§9 header — locks drift)", () => {
    expect(sourceCodes.size).toBe(51);
  });
});

describe("stripLineComments — multiline template literal regression", () => {
  it("preserves URL content after :// on a continuation line of a template literal", () => {
    const src = ["const x = `", "  https://api.example.com", "`;"].join("\n");
    const stripped = stripLineComments(src);
    // Per-line state (broken): line 2 resets to code mode, sees //, strips to
    // "  https:". Cross-line state (fixed): line 2 is inside the template
    // literal, // is string content, full URL is preserved.
    expect(stripped).toContain("https://api.example.com");
  });

  it("exposes forbidden calls hidden after :// in a multiline template URL (false-negative regression)", () => {
    const src = [
      "const msg = `",
      "  https://api.example.com/data.delete(id)/docs",
      "`;",
    ].join("\n");
    const stripped = stripLineComments(src);
    // :// was treated as a // comment, stripping the rest of the line and
    // hiding the .delete( call that follows in the same URL path.
    expect(stripped).toContain(".delete(id)");
    expect(stripped).toContain("https://api.example.com");
  });

  it("exposes ${...} interpolation expressions even when preceded by :// on the same template line", () => {
    const src = [
      "const x = `",
      "  https://api.example.com/${accounts.delete(id)}",
      "`;",
    ].join("\n");
    const stripped = stripLineComments(src);
    expect(stripped).toContain("accounts.delete(id)");
    expect(stripped).toContain("https://api.example.com/");
  });
});
