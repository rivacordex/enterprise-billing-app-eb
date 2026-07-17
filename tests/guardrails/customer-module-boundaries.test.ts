import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// cm16-spec §3.4 — the module's ship-gate guardrail sweep, mirroring
// product's `pm09` sweep shape. Turns the negative-space invariants built by
// cm01–cm15 into permanent, executable CI facts re-asserted module-wide at
// the ship gate, rather than trusted to have survived nine mutation units
// unbroken. Pure node:fs/node:path + static-source assertions — no jsdom,
// no DB.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

// Production-source scan roots — deliberately excludes `tests/` itself, so
// a test file that legitimately asserts a literal copy of a canonical
// map/list for regression-locking (e.g. tests/validation/transitions.test.ts
// comparing against ORGANIZATION_TRANSITIONS) isn't mistaken for a
// forbidden redeclaration.
const SOURCE_SCAN_DIRS = [
  "actions",
  "app",
  "components",
  "db",
  "services",
  "validation",
];

function collectSourceFiles(): { relative: string; content: string }[] {
  return SOURCE_SCAN_DIRS.flatMap((dir) =>
    collectFiles(path.join(REPO_ROOT, dir)),
  ).map((filePath) => ({
    relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
    content: fs.readFileSync(filePath, "utf8"),
  }));
}

describe("customer module boundaries (cm16 ship-gate sweep)", () => {
  // Module Inv. #6 / code-standards §6.9 — one lock column for the whole
  // customer scope. `organization` and `contact_medium` each also carry
  // their own `last_modified_datetime` column (general provenance
  // convention — set on every write as a plain "last updated" timestamp),
  // so the invariant isn't "the column only exists once in the schema" (it
  // doesn't — db/schema/customer.ts declares it on all three tables); it's
  // that only `party_role.last_modified_datetime` is ever compared in a
  // WHERE clause as a compare-and-bump lock predicate. Asserted directly
  // against the repositories, since that's where the invariant actually
  // lives.
  it("last_modified_datetime is used as a compare-and-bump lock predicate only on party_role, never on organization or contact_medium", () => {
    const partyRoleRepo = read("db/repositories/party-role.ts");
    const organizationRepo = read("db/repositories/organization.ts");
    const contactMediumRepo = read("db/repositories/contact-medium.ts");

    expect(partyRoleRepo).toMatch(/eq\(partyRole\.lastModifiedDatetime/);
    expect(organizationRepo).not.toMatch(
      /eq\(organization\.lastModifiedDatetime/,
    );
    expect(contactMediumRepo).not.toMatch(
      /eq\(contactMedium\.lastModifiedDatetime/,
    );
  });

  // code-standards §7.3 — contact-mutation logic (preferred-pointer
  // maintenance included) lives in exactly one file; every other file only
  // imports these functions, never redefines them.
  it("addContact/updateContact/deleteContact/setPreferredContact/setPreferredContactMethod are defined only in services/customer/contact-mutations.ts", () => {
    const OWN_FILE = "services/customer/contact-mutations.ts";
    const FUNCTION_NAMES = [
      "addContact",
      "updateContact",
      "deleteContact",
      "setPreferredContact",
      "setPreferredContactMethod",
    ];
    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const fnName of FUNCTION_NAMES) {
      const definitionPattern = new RegExp(
        `export (?:async )?function ${fnName}\\(`,
      );
      const definedIn = files
        .filter(({ content }) => definitionPattern.test(content))
        .map(({ relative }) => relative);
      expect(definedIn).toEqual([OWN_FILE]);
    }
  });

  // code-standards §7 note 2 / §2.2 — the transition maps are declared in
  // exactly one file; no page/component/action re-declares a status's
  // valid next-states as an inline literal.
  it("no source file outside validation/customer/transitions.ts inline-redeclares a status transition-edges object", () => {
    const OWN_FILE = "validation/customer/transitions.ts";
    // Matches an object-literal entry whose key is a known status and whose
    // value starts with an array of quoted strings — the transition-map
    // shape (`REGISTERED: ['ACTIVE', ...]`) — without false-positiving on
    // unrelated uses of the same status names (e.g. a Tailwind arbitrary
    // value like `"bg-[color:...]"`, or a CSS-class lookup keyed by status).
    const TRANSITION_EDGE_PATTERN =
      /(REGISTERED|INITIALIZED|ACTIVE|INACTIVE|SUSPENDED|DISSOLVED|MERGED|VALIDATED|CLOSED)\s*:\s*\[\s*['"]/;

    const offenders = collectSourceFiles()
      .filter(({ relative }) => relative !== OWN_FILE)
      .filter(({ content }) => TRANSITION_EDGE_PATTERN.test(content))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  // cm13-spec §3.3 / code-standards §6.7, re-asserted module-wide at the
  // ship gate (cm16-spec §3.4 point 4) — same grep-based approach as
  // tests/structure/contact-medium-delete-callers.test.ts, so a later
  // change to this file doesn't silently stop covering the invariant this
  // sweep re-checks independently.
  it("contactMediumRepository.deleteById is referenced from nowhere but its own definition and deleteContact", () => {
    const OWN_DEFINITION = "db/repositories/contact-medium.ts";
    const SANCTIONED_CALLER = "services/customer/contact-mutations.ts";

    const offenders = collectSourceFiles()
      .filter(({ relative }) => relative !== OWN_DEFINITION)
      .filter(({ relative }) => relative !== SANCTIONED_CALLER)
      .filter(({ content }) =>
        content.includes("contactMediumRepository.deleteById"),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  // code-standards §7's file tree — all ten actions/customer/*.ts files
  // exist. Ten, not nine: `update-party-role-specification.ts` (cm10) was
  // missing from code-standards §7's original file-tree listing — a
  // genuine doc gap found during this unit's §3.6 verification pass and
  // fixed in the same change set, not silently worked around here (see
  // custmgmt-progress-tracker.md's cm16 entry).
  it("all ten actions/customer/*.ts files exist, matching code-standards §7's file tree", () => {
    const EXPECTED_FILES = [
      "create-customer.ts",
      "update-organization.ts",
      "transition-organization-status.ts",
      "transition-customer-status.ts",
      "update-party-role-specification.ts",
      "add-contact.ts",
      "update-contact.ts",
      "delete-contact.ts",
      "set-preferred-contact.ts",
      "set-preferred-contact-method.ts",
    ];

    for (const file of EXPECTED_FILES) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, "actions", "customer", file)),
      ).toBe(true);
    }

    const actualFiles = fs
      .readdirSync(path.join(REPO_ROOT, "actions", "customer"))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(actualFiles).toEqual([...EXPECTED_FILES].sort());
  });

  // code-standards §8 / build-plan note — no DELETE permission level is
  // ever seeded for `customers`; "delete" is a status transition gated at
  // customers:EDIT (contact hard-delete is also EDIT-gated), not a separate
  // delete permission.
  it("no DELETE permission level is seeded for customers", () => {
    const seedSource = read("db/seeds/customer.ts");
    expect(seedSource).not.toMatch(/"DELETE"/);

    const migrationSource = read("db/migrations/0009_customer.sql");
    expect(migrationSource).not.toMatch(/'customers'[\s\S]{0,80}DELETE/i);
  });
});
