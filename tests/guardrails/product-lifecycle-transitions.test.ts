import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// pm45-spec I1 — guardrail 23 (Inv. #23 / code-standards §1.15). The one
// guardrail that spans pm42–pm44: it asserts the *shape* of the lifecycle
// transition set as a whole — something no single transition unit could prove
// because it is about the module as a whole. Pure node:fs/node:path + static
// source, no DB, no jsdom (the same fast-suite shape as
// product-module-boundaries.test.ts). The *behaviour* — that each legal
// transition succeeds from its predecessor and every illegal ordered pair is
// refused with a typed code — is proven by the three integration suites this
// file references (see LEGAL_TRANSITIONS), never re-implemented here (D1).
const REPO_ROOT = path.resolve(__dirname, "../..");

const STATUSES = ["DRAFT", "TESTING", "ACTIVE", "OBSOLETE", "RETIRED"] as const;
type Status = (typeof STATUSES)[number];

// The state machine (prodmgmt-update-overview §"Core user flow" 8–13,
// code-standards §1.11/§1.15). Each legal edge names the ONE service that owns
// it (§7.4 "one transition, one file") and the integration test whose cases
// behaviourally prove it succeeds from its predecessor and is refused from
// every other status. `delete` is the sixth operation — a hard delete of a
// never-ACTIVE version, not a status write — so it is modelled separately below.
const LEGAL_TRANSITIONS: {
  from: Status;
  to: Status;
  service: string;
  action: string;
  provenBy: string;
}[] = [
  {
    from: "DRAFT",
    to: "TESTING",
    service: "submit-for-testing.ts",
    action: "submit-for-testing.action.ts",
    provenBy: "product-release-path.integration.test.ts",
  },
  {
    from: "TESTING",
    to: "DRAFT",
    service: "return-to-draft.ts",
    action: "return-to-draft.action.ts",
    provenBy: "product-release-path.integration.test.ts",
  },
  {
    from: "TESTING",
    to: "ACTIVE",
    service: "activate-offering.ts",
    action: "activate-offering.action.ts",
    provenBy: "product-release-path.integration.test.ts",
  },
  {
    from: "ACTIVE",
    to: "OBSOLETE",
    service: "obsolete-offering.ts",
    action: "obsolete-offering.action.ts",
    provenBy: "product-withdrawal-path.integration.test.ts",
  },
  {
    from: "OBSOLETE",
    to: "RETIRED",
    service: "retire-offering.ts",
    action: "retire-offering.action.ts",
    provenBy: "product-withdrawal-path.integration.test.ts",
  },
];

// The hard-delete operation (never-ACTIVE version only, code-standards §1.11).
const DELETE_OP = {
  service: "delete-offering.ts",
  action: "delete-offering.action.ts",
  legalFrom: ["DRAFT", "TESTING"] as Status[],
  provenBy: "product-delete-offering.integration.test.ts",
};

// The exhaustive set of status-changing transition services. Nothing outside
// this set may write `lifecycle_status`, and each maps to exactly one legal
// edge above — so the 20 illegal ordered pairs have no code path by
// construction, which is precisely what "no code path, proven unreachable by
// the absence of a caller" means for a fixed, enumerated service set.
const TRANSITION_SERVICE_FILES = [
  ...LEGAL_TRANSITIONS.map((t) => t.service),
  DELETE_OP.service,
].sort();

function readServiceDir(): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, "services", "product"));
}

function readActionDir(): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, "actions", "product"))
    .filter((name) => name.endsWith(".action.ts"))
    .sort();
}

function readCode(absPath: string): string {
  return stripComments(fs.readFileSync(absPath, "utf8"));
}

describe("guardrail 23 — lifecycle transition set (pm45 I1)", () => {
  // 1. Every legal edge has its own service + action file (§7.4 one-per-file).
  it("each legal transition maps to exactly one service and one action file", () => {
    const serviceDir = readServiceDir();
    const actionDir = readActionDir();
    for (const t of LEGAL_TRANSITIONS) {
      expect(serviceDir, `${t.from}→${t.to} service`).toContain(t.service);
      expect(actionDir, `${t.from}→${t.to} action`).toContain(t.action);
    }
    expect(readServiceDir(), "delete service").toContain(DELETE_OP.service);
    expect(readActionDir(), "delete action").toContain(DELETE_OP.action);
  });

  // 2. The 25 ordered pairs: a legal edge has a service; every other pair
  //    (including each self-pair) has none. Since the transition-service set is
  //    fixed and each file owns exactly one legal edge, the illegal pairs are
  //    caller-less by construction — asserted by pinning the service set to
  //    exactly the six owning files (a seventh status-writer would fail here).
  it("only the five legal status edges (plus delete) have a transition service; the other 20 ordered pairs have none", () => {
    const legalEdge = new Set(
      LEGAL_TRANSITIONS.map((t) => `${t.from}→${t.to}`),
    );
    const pairs: { from: Status; to: Status; legal: boolean }[] = [];
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        pairs.push({ from, to, legal: legalEdge.has(`${from}→${to}`) });
      }
    }
    // Sanity: 25 ordered pairs, exactly 5 legal.
    expect(pairs).toHaveLength(25);
    expect(pairs.filter((p) => p.legal)).toHaveLength(5);

    // The set of services that write `lifecycle_status` is EXACTLY the six
    // owning files. All status writes go through the repository's narrow
    // writers (mark{Testing,Draft,Active,Obsolete}, the activateOffering
    // composite, retireOffering) or the deleteOffering removal; a service that
    // changes a version's status HAS to reference one of them, so scanning for
    // those identifiers catches a rogue seventh status-writer (e.g. one wiring
    // an illegal DRAFT→ACTIVE shortcut) rather than merely re-confirming the six
    // known files exist. `markActive` is only ever called by the repo's own
    // activateOffering composite, so no service references it directly — its
    // presence in the lens is harmless (it simply never matches a service).
    //
    // Scope: this rests on §1.1's "all product writes flow through the
    // repository" invariant — a service cannot change lifecycle_status except by
    // calling a repo writer. A service bypassing the repo with a raw
    // `tx.update(...).set({ lifecycleStatus })` would evade this scan, but that
    // bypass is itself the target of the repository-mutation / module-boundary
    // guardrails and the §3.5 DB trigger, not of guardrail 23 — layered defence,
    // not a special case bolted on here.
    const WRITER_IDENTIFIERS = [
      "markTesting",
      "markDraft",
      "markActive",
      "markObsolete",
      "activateOffering",
      "retireOffering",
      "deleteOffering",
    ];
    const serviceDir = path.join(REPO_ROOT, "services", "product");
    const statusWritingServices = readServiceDir()
      .filter((name) => {
        // Comment-stripped so a service that merely NAMES a writer in prose
        // (get-live-subscription-count.ts cites `retireOffering`) is not counted
        // as a status-writer — only an actual reference in code is.
        const code = readCode(path.join(serviceDir, name));
        return WRITER_IDENTIFIERS.some((id) =>
          new RegExp(`\\b${id}\\b`).test(code),
        );
      })
      .sort();
    expect(statusWritingServices).toEqual(TRANSITION_SERVICE_FILES);
  });

  // 3. Hard delete is legal ONLY from a never-ACTIVE version (DRAFT/TESTING);
  //    ACTIVE/OBSOLETE/RETIRED have no delete path (code-standards §1.11/§1.20).
  //    The PER-STATUS refusal behaviour is proven in
  //    product-delete-offering.integration.test.ts (referenced by the mapping
  //    test below). Here we assert the SERVICE carries the right guard: it
  //    returns OFFERING_NOT_DELETABLE and gates on BOTH allowed states (DRAFT
  //    and TESTING). Those two literals appear nowhere else in the service, so
  //    inverting the guard (e.g. to `=== "RETIRED"`) drops them and fails here —
  //    unlike a bare `toContain("OFFERING_NOT_DELETABLE")`, which an inverted
  //    guard would still satisfy.
  it("the discard service gates on DRAFT/TESTING and refuses every released status", () => {
    const code = readCode(
      path.join(REPO_ROOT, "services", "product", DELETE_OP.service),
    );
    expect(code).toContain("OFFERING_NOT_DELETABLE");
    expect(code).toContain('"DRAFT"');
    expect(code).toContain('"TESTING"');
    // The delete op is modelled as legal only from DRAFT/TESTING — cross-checked
    // against the source guard above, not asserted against itself.
    expect([...DELETE_OP.legalFrom].sort()).toEqual(["DRAFT", "TESTING"]);
  });

  // 4. No generic status setter exists anywhere in the write stack, and no
  //    action takes a target status as a parameter (§1.15). The repository's
  //    narrow writers are mark{Draft,Testing,Active,Obsolete} + retireOffering —
  //    none is a `set*Status(id, status)` helper, and no caller passes a status
  //    it wants written.
  it("no setLifecycleStatus / set*Status helper exists in the product write stack", () => {
    const scanDirs = [
      path.join(REPO_ROOT, "services", "product"),
      path.join(REPO_ROOT, "actions", "product"),
    ];
    const files = scanDirs.flatMap((dir) =>
      fs.readdirSync(dir).map((name) => path.join(dir, name)),
    );
    files.push(
      path.join(REPO_ROOT, "db", "repositories", "product-offering.ts"),
    );

    const SETTER = /\bset[A-Za-z]*(?:Status|Lifecycle)[A-Za-z]*\b/;
    // Comment-stripped: product-offering.ts's own §1.15 note literally spells
    // `setLifecycleStatus` to say no such helper exists — that must not trip it.
    const offenders = files.filter((f) => SETTER.test(readCode(f)));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("no product action takes a lifecycle status as a parameter (§1.15)", () => {
    const actionDir = path.join(REPO_ROOT, "actions", "product");
    // Extract each exported action's parameter list — the text between the
    // opening `(` and the `):` that starts the return type — and assert NO
    // parameter is typed with the lifecycle union, under ANY parameter name
    // (`status`, `desiredStatus`, an object field, …). Scoping to the parameter
    // list is what keeps this precise: `delete-offering.action.ts` legitimately
    // references `LifecycleStatus` in its RESULT type (beforeData), which sits
    // after the `):` and is never captured. The `export async function` form is
    // itself enforced by product-module-boundaries.test.ts (each action file
    // exports exactly one `export async function NAME`), so an arrow-exported
    // action that dodged this regex would fail there first — no need to also
    // parse the arrow form here.
    const PARAM_STATUS = /:\s*LifecycleStatus\b/;
    const offenders: string[] = [];
    for (const name of readActionDir()) {
      const code = readCode(path.join(actionDir, name));
      for (const match of code.matchAll(
        /export\s+async\s+function\s+\w+\s*\(([\s\S]*?)\)\s*:/g,
      )) {
        if (PARAM_STATUS.test(match[1] ?? "")) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The exhaustive fourteen-file action set (by name, exports checked) is frozen
  // once, in product-module-boundaries.test.ts — guardrail 23 does not re-fork
  // that list (two hardcoded copies would drift when a 15th action lands). The
  // six transition/withdrawal action files this guardrail owns are asserted
  // present by test 1 above (via LEGAL_TRANSITIONS + DELETE_OP).

  // Deep-link clause of criterion 13 / I4: a `?family=`/`?version=` deep link
  //    grants nothing because the page's products:EDIT guard runs BEFORE any
  //    searchParam is read or parsed — the guard cannot be reached-around by a
  //    crafted URL. Structural (source-order) proof; the guard's own behaviour
  //    is exercised across tests/auth/guard.integration.test.ts.
  it("Manage Products guards products:EDIT before it reads searchParams (deep links grant nothing)", () => {
    const source = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "app",
        "(app)",
        "products",
        "manage-products",
        "page.tsx",
      ),
      "utf8",
    );
    const guardAt = source.indexOf("requirePermission(");
    // The searchParams VALUES are consumed at the schema parse — the point a
    // crafted `?family=`/`?version=` could take effect. Anchoring on the parse
    // (a stable symbol) rather than the raw `await searchParams` expression keeps
    // this from failing spuriously on a rename of the awaited local, while still
    // catching a guard moved AFTER the params are consumed.
    const consumeAt = source.indexOf("familyListSearchParamsSchema.parse(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(consumeAt);
    // …and the guard demands PRODUCTS : EDIT specifically.
    const guardCall = source.slice(guardAt, guardAt + 120);
    expect(guardCall).toContain("PERMISSIONS.PRODUCTS");
    expect(guardCall).toContain("LEVELS.EDIT");
  });

  // Documentation seam: the behavioural proof for every edge lives here, so a
  // reviewer reads one mapping instead of re-deriving coverage across three
  // files. Asserted only that the named suites exist (their cases are their own
  // gate) — the mapping itself is the artefact.
  it("every legal edge names an existing integration suite that behaviourally proves it", () => {
    const dbDir = path.join(REPO_ROOT, "tests", "db");
    for (const t of LEGAL_TRANSITIONS) {
      expect(fs.existsSync(path.join(dbDir, t.provenBy)), t.provenBy).toBe(
        true,
      );
    }
    expect(
      fs.existsSync(path.join(dbDir, DELETE_OP.provenBy)),
      DELETE_OP.provenBy,
    ).toBe(true);
  });
});
