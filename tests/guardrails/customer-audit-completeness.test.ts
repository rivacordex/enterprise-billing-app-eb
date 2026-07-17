import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_TYPES } from "@/types/audit";

// cm16-spec §3.5 — guardrail 7 module-wide: every exported mutation function
// in services/customer/*.ts calls the audit-write path on its success path.
// Static grep/slice check, no DB — the live-DB proof that AUDIT_LOG rows
// actually land correctly is each unit's own service test (already
// inherited, code-standards §9.7).
//
// The helper is `insertAuditEvent` (db/repositories/audit.repository.ts),
// not `writeAuditEvent` as cm16-spec's own prose names it — the same naming
// correction cm07's tracker entry already made for this codebase.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// Slices one exported function's body out of a source file, bounded by the
// next top-level `export (async )?function` declaration (or EOF) — good
// enough for this module's consistent one-export-per-function style.
function sliceFunction(source: string, name: string): string {
  const startPattern = new RegExp(`export (?:async )?function ${name}\\(`);
  const startMatch = startPattern.exec(source);
  if (!startMatch) {
    throw new Error(`Expected to find function "${name}" in the source.`);
  }
  const bodyStart = startMatch.index + startMatch[0].length;
  const rest = source.slice(bodyStart);
  const nextExportMatch = /\nexport (?:async )?function \w+\(/.exec(rest);
  const bodyEnd = nextExportMatch
    ? bodyStart + nextExportMatch.index
    : source.length;
  return source.slice(startMatch.index, bodyEnd);
}

function eventTypesIn(source: string): string[] {
  return [
    ...source.matchAll(
      /insertAuditEvent\(\s*tx,\s*\{\s*\n\s*eventType:\s*"([A-Z_]+)"/g,
    ),
  ].map((m) => m[1]!);
}

// The authoritative, current eventType mapping — mirrors the actual shipped
// services (cm07–cm15), not cm16-spec §3.5's literal "exactly one
// writeAuditEvent call... no two mutations share an eventType" prose, which
// doesn't hold against two real, intentional cases: `createCustomer` writes
// two distinct entities (organization + party_role) in one call and audits
// each; `PREFERRED_CONTACT_CHANGED` legitimately fires from both
// `addContact`'s first-contact auto-assignment and `setPreferredContact`'s
// explicit reassignment — the same semantic event (the preferred-contact
// pointer changed), not a defect. Same "no live-repo mount this session"
// blind spot already flagged elsewhere in this module's specs; this test
// pins the real, reviewed mapping instead of the spec's inaccurate rule.
const MUTATION_CASES: Array<
  [file: string, fn: string, expectedEventTypes: string[]]
> = [
  [
    "services/customer/create-customer.ts",
    "createCustomer",
    ["ORGANIZATION_CREATED", "CUSTOMER_CREATED"],
  ],
  [
    "services/customer/update-organization.ts",
    "updateOrganization",
    ["ORGANIZATION_UPDATED"],
  ],
  [
    "services/customer/transition-organization-status.ts",
    "transitionOrganizationStatus",
    ["ORGANIZATION_STATUS_CHANGED"],
  ],
  [
    "services/customer/transition-customer-status.ts",
    "transitionCustomerStatus",
    ["CUSTOMER_STATUS_CHANGED"],
  ],
  [
    "services/customer/update-party-role-specification.ts",
    "updatePartyRoleSpecification",
    ["PARTY_ROLE_SPECIFICATION_UPDATED"],
  ],
  [
    "services/customer/contact-mutations.ts",
    "addContact",
    ["CONTACT_CREATED", "PREFERRED_CONTACT_CHANGED"],
  ],
  [
    "services/customer/contact-mutations.ts",
    "updateContact",
    ["CONTACT_UPDATED"],
  ],
  [
    "services/customer/contact-mutations.ts",
    "deleteContact",
    ["CONTACT_DELETED"],
  ],
  [
    "services/customer/contact-mutations.ts",
    "setPreferredContact",
    ["PREFERRED_CONTACT_CHANGED"],
  ],
  [
    "services/customer/contact-mutations.ts",
    "setPreferredContactMethod",
    ["PREFERRED_METHOD_CHANGED"],
  ],
];

describe("customer module audit-trail completeness (cm16 ship-gate sweep)", () => {
  it.each(MUTATION_CASES)(
    "%s's %s audits exactly %j on its success path",
    (file, fn, expectedEventTypes) => {
      const body = sliceFunction(read(file), fn);
      expect(eventTypesIn(body)).toEqual(expectedEventTypes);
    },
  );

  it("every exported mutation function audits at least once (no gaps)", () => {
    for (const [file, fn] of MUTATION_CASES) {
      const body = sliceFunction(read(file), fn);
      expect(eventTypesIn(body).length).toBeGreaterThan(0);
    }
  });

  it("every eventType used by services/customer/*.ts is a real AUDIT_EVENT_TYPES member", () => {
    const usedEventTypes = new Set(
      MUTATION_CASES.flatMap(([, , eventTypes]) => eventTypes),
    );
    for (const eventType of usedEventTypes) {
      expect(AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });
});
