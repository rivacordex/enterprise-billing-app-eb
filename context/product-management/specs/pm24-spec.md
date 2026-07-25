# PM24 — Ship Gate: Guardrails, Authz Matrix, Full Sweep

- **Unit:** 24 of 24 (`pm99-build-plan-phase2.md`) — the phase's **ship gate**, same role `pm09` played for Phase 1.
- **Dependencies:** Units pm10–pm23, **all of them**, verified and merged (`pm99-build-plan-phase2.md` dependency graph: every arrow terminates at `pm24`). Concretely pm24 assumes: the `family_offering_id` column + index (pm10); `insertOffering`/`createOffering` (pm11); `branchOfferingAsDraft` (pm12); `updateOfferingDraftInPlace`/`updateOffering` (pm13); `insertSpecification`/`updateSpecification`/`deleteSpecification` + their three services (pm14); `insertPrice` + its service (pm15); `activateOffering`/`retireOffering`/`findActiveInFamily` + their services (pm16); the nav relabel + "Manage Products" entry (pm17); the `/products/manage-products` page shell with row-action seams (pm18); and all eight Server Actions + their dialogs/forms (pm19–pm23: `create-offering.action.ts`, `update-offering.action.ts`, `create-specification.action.ts`, `update-specification.action.ts`, `delete-specification.action.ts`, `insert-price.action.ts`, `activate-offering.action.ts`, `retire-offering.action.ts`). pm24 must not start until pm23 is merged and green.
- **Authorizing sections:** build-plan *Unit pm24* (literal contract) and `pm09-spec.md` (the structural precedent this unit follows almost line-for-line); `prodmgmt-project-overview-phase2.md` *Success Criteria* (the twelve observable proofs) and *In Scope/Out of Scope*; `prodmgmt-architecture-phase2.md` §2 (folder ownership deltas — `actions/product/`, `components/products/manage/`), §3 (schema supersession — `family_offering_id` is the *only* new column), §4 (permission table — `products:EDIT` for create/edit/branch/activate, `products:DELETE` for retire/discard), §6 (Inv. 8 superseded, Inv. 2/6/11 amended, Inv. 13/14 new); `prodmgmt-code-standards-phase2.md` §1 (rules 9–12), §7 (the concrete Phase 2 file tree — this is the literal list pm24's rewritten assertion 1 checks against), §8 (permission map table), **§9 (guardrails 8–14 — the checklist this unit closes, on top of v1's seven)**; `prodmgmt-ui-context-phase2.md` (row-action affordances, referenced only to confirm the manual walkthrough exercises real UI, not to re-test styling); general `code-standards.md` §10 (CI gates, SAST + DAST); `prodmgmt-ai-workflow-rules-phase2.md` (module verification pass); general `ai-workflow-rules.md` §8 (verification-before-ship checklist).
- **Codebase state assumed at start (re-verify before implementing — this spec is written prospectively, ahead of pm14–pm23 landing):**
  - **Shipped as of 2026-07-22:** pm10 (`family_offering_id` + `product_offering_family_idx` + the `family_offering_id <> product_offering_id` check — all in `db/schema/product.ts`), pm11 (`insertOffering`, `services/product/create-offering.ts`, `PRODUCT_OFFERING_CREATED`), pm12 (`branchOfferingAsDraft` + private `resolveNextVersion`, same file as pm11), pm13 (`updateOfferingDraftInPlace`, `services/product/update-offering.ts`, `PRODUCT_OFFERING_UPDATED`/`PRODUCT_OFFERING_BRANCHED`).
  - **Not yet shipped (assumed complete by the time pm24 executes):** pm14–pm23 in full — no `actions/product/` folder exists yet; `components/products/manage/` is an empty directory; `admin-nav.tsx` still renders a single "Product Offering" item (no "View Product"/"Manage Products" split); `app/(app)/products/manage-products/` does not exist; `db/repositories/product-offering.ts` has no `activateOffering`/`retireOffering`/`findActiveInFamily`; `db/repositories/product-specification.ts` exports only `findByOfferingId`; `db/repositories/product-offering-price.ts` exports only `findByOfferingIdWithDerivedEnd`.
  - **`tests/guardrails/product-module-boundaries.test.ts` today** (pm09's file) has five assertions: (1) no `actions/product/` folder, (2) no `app/api/product*` path, (3) price repo exports no `update*`/`delete*` (`insertPrice` excepted), (4) no product read path imports the audit-log write path — already scoped via a `PRODUCT_WRITE_SERVICE_FILES` set currently containing exactly `"create-offering.ts"` and `"update-offering.ts"` (pm11/pm13 added themselves to it), (5) the frozen route manifest contains `"/products/product-offering"` exactly once. Assertions 2, 3, 5 need **no change** in pm24 (see §2.2 ledger). Assertions 1 and 4 are the ones this unit touches.
  - **`tests/app/route-manifest.test.ts`'s `ROUTE_MANIFEST`** currently lists 14 routes ending in `/customers/manage/[id]`; it does not yet contain `/products/manage-products`.
  - **`tests/auth/guard.integration.test.ts`** already seeds and grants the `products` permission at `DELETE` (⊃ EDIT ⊃ READ) to a single `adminUserId`, and already has `it.each` rows proving `PRODUCTS:READ/EDIT/DELETE` are satisfied for that admin and that a no-grants user is denied `PRODUCTS:READ`. It has **no** principal holding `products:EDIT` without `products:DELETE`, and no test that calls any `actions/product/*` file directly — both because those actions don't exist yet. The file already contains a directly-analogous pattern for another module: a `customerManagerUserId` (customers:EDIT only) / `customerUserRoleUserId` (customers:READ only) split, plus a `describe("direct Server Action calls reject a USER (bypassing the nav)")` block that dynamically imports every `actions/customer/*.ts` export and asserts each rejects a `customers:READ`-only caller. **pm24 mirrors this exact pattern for `products`**, not the abstract v1 `it.each` loop, because the split we need to prove is EDIT-vs-DELETE, not READ-vs-nothing.
  - **`db/schema/product.ts`'s current column set** (needed as the frozen Phase-1 baseline for the schema-diff assertion, §2.5): `productOffering` = `{productOfferingId, name, isBundle, isSellable, billingOnly, lifecycleStatus, version, lastModified, lastEditedBy}` **plus** the already-landed `familyOfferingId` (pm10) — so the *Phase-1* baseline (pre-pm10) is that set **minus** `familyOfferingId`. `productSpecifications` = `{productSpecId, refProductOfferingId, name, isMandatory, isDefault, defaultValue, productSpecCharacteristics}` — untouched, frozen as-is. `productOfferingPrice` = `{productOfferingPriceId, productOfferingId, name, priceType, recurringChargePeriodLength, recurringChargePeriodType, unitOfMeasure, amount, currency, glCode, pricingModel, policy, pricingCharacteristics, startDateTime, createdAt}` — untouched, frozen as-is.
  - `prodmgmt-code-standards-phase2.md` §9 guardrail 11's prose ("`*-write.service.ts`") and its own §7 file tree disagree: the file tree — and every write-service file actually landed so far (`create-offering.ts`, `update-offering.ts`) — uses **plain names with no `-write.service` suffix**. See Design §2.4 for how pm24 resolves this without inventing a rename no other unit performs.

---

## 1. Goal

Close Phase 2 by rewriting the module's guardrail sweep (`tests/guardrails/product-module-boundaries.test.ts`) so its negative-space assertions match the phase's actual, now-mutable shape — `actions/product/` must exist and export exactly this phase's eight actions, `components/products/*.tsx` outside `manage/` must stay provably read-only, the route manifest must include `/products/manage-products`, and `db/schema/product.ts` must diff from Phase 1 by exactly one column and one index — then extend the platform authz matrix (`tests/auth/guard.integration.test.ts`) with real, direct-call mutation-path proofs that `products:EDIT` and `products:DELETE` are two different gates, not one. Close with the full workflow §8 verification pass, including the concrete manual walkthrough pm99 names: create → add spec → add price → activate → edit-while-active → activate-the-new-draft (confirms the old one auto-retires) → discard an abandoned draft elsewhere. Visible result: **CI green with all seven Phase 1 guardrails still passing plus all seven Phase 2 guardrails** (single-active-per-family, branch-not-mutate, spec-delete-unreachable-on-ACTIVE, view-stays-read-only, route manifest, schema-diff, price-immutability-behavioral) — the phase's ship gate.

## 2. Design

### 2.1 Boundary — Tests / CI only

Identical discipline to `pm09-spec.md` §2.1: pm24 writes and edits **`tests/**` files only**. It adds no `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, or `infra/**` file. Every Phase 2 guardrail behaviour was **built** by the unit that owns the code it guards (pm10–pm23); pm24 either **inherits** a guardrail that already ships and passes, or **adds the one remaining test** the earlier units deliberately deferred to the ship gate (per their own specs' explicit forward-references — e.g. pm13-spec §3.5: *"the guardrail test's 'no `actions/product/` folder' assertion... to be rewritten in pm24"*; pm14-spec's closing line: *"Unit pm24 depends on this unit's guardrail-10 behavior holding, whether asserted structurally by then or only by construction"*). If pm24 discovers a guardrail is missing **runtime enforcement** (not just a test), that is a defect in the owning unit, fixed there — pm24 does not paper over it with a test-only workaround.

### 2.2 The fourteen-guardrail ownership ledger

`prodmgmt-code-standards-phase2.md` §9 names seven Phase 2 guardrails (numbered 8–14, continuing v1's 1–7). Most Phase 2 guardrails are delivered by the units that own the behaviour; pm24's net-new code is only the four unshaded rows below. This ledger is the design's backbone, exactly as it was for pm09.

| # | Guardrail | Owning unit / file | pm24 action |
|---|---|---|---|
| 1–7 | (v1, unchanged — authz matrix, price immutability structural, overlap constraint, derived effectivity, JSONB validation, deep link, rename invariance) | pm09 (Phase 1) | **INHERIT** — audit present & green; assertions 2/3/5 in the sweep file need no edit (§3.1) |
| 8 | **Single-active-per-family** — activating a version retires any sibling `ACTIVE` version in the same transaction; under two near-simultaneous activations on siblings, exactly one wins | pm16 (`tests/db/product-repositories.integration.test.ts`) | **INHERIT** — audit present & green |
| 9 | **Branch-not-mutate** — editing any field/spec/price on an `ACTIVE` offering leaves that row and its exact children byte-identical and produces exactly one new sibling `DRAFT` | pm13 (offering fields), pm14 (specs), pm15 (prices) — all in `tests/db/product-repositories.integration.test.ts` | **INHERIT** — audit present & green across all three |
| 10 | **Spec-delete unreachable on `ACTIVE`** — no code path calls `deleteSpecification` against an offering whose current status is `ACTIVE` | pm14 (true by construction: `deleteSpecification`'s only callers branch-first) | **INHERIT + one net-new structural backstop** (§2.8) — pm14's own spec explicitly left open whether this becomes "asserted directly" or stays "by construction"; pm24 closes that open item |
| 11 | **View stays read-only** — `app/(app)/products/product-offering/**` and `components/products/*.tsx` (excluding `manage/`) import nothing from `actions/product/`, `components/products/manage/`, or any write-service file | **pm24 — net-new** | **ADD** (§3.3) |
| 12 | **Route manifest extended** — `/products/manage-products` appears exactly once alongside `/products/product-offering` | pm17/pm18 may extend `ROUTE_MANIFEST` themselves (same "own its consciously-versioned edit" convention pm01 established); pm24 **re-asserts** module-wide | **VERIFY, extend if not already done** (§3.4) |
| 13 | **Schema-diff check** — `db/schema/product.ts` differs from Phase 1 by exactly `family_offering_id` + its index; `product_specifications`/`product_offering_price` byte-identical | **pm24 — net-new** | **ADD** (§3.5) |
| 14 | **Price immutability, behavioral** — inserting a successor price leaves the old row untouched; offering `version` unchanged when the target was already `DRAFT` | pm15 (`tests/db/product-repositories.integration.test.ts`) | **INHERIT** — audit present & green; pm24's assertion 3 (structural, unchanged since pm09) remains the module-wide companion |

pm24's genuinely net-new test code is: the **rewritten assertion 1** (existence + exact export set, §2.3), the **View-stays-read-only assertion** (guardrail 11), the **schema-diff assertion** (guardrail 13), the **route-manifest verification/extension** (guardrail 12), the **`PRODUCT_WRITE_SERVICE_FILES` extension** (supports guardrails 4 and 11 both), the optional **guardrail-10 structural backstop**, and the **authz-matrix mutation-path extension**. Everything else is audit-and-verify.

### 2.3 Rewriting assertion 1 — `actions/product/` existence and exact export set

v1's assertion 1 asserted the folder's **absence**. Phase 2 inverts it: the folder must exist and contain **exactly** this phase's eight action files, no more, no fewer, each exporting exactly the one function named in its own spec. Per `prodmgmt-code-standards-phase2.md` §7's file tree and the pm19–pm23 specs, the frozen set is:

| File | Exported function |
|---|---|
| `create-offering.action.ts` | `createOfferingAction` |
| `update-offering.action.ts` | `updateOfferingAction` |
| `create-specification.action.ts` | `createSpecificationAction` |
| `update-specification.action.ts` | `updateSpecificationAction` |
| `delete-specification.action.ts` | `deleteSpecificationAction` |
| `insert-price.action.ts` | `insertPriceAction` |
| `activate-offering.action.ts` | `activateOfferingAction` |
| `retire-offering.action.ts` | `retireOfferingAction` |

The rewritten assertion (a) lists `actions/product/`'s directory contents and asserts the set of `.ts` files (excluding any `.test.ts`) is exactly these eight, sorted, compared with `toEqual` — not merely "contains" or "at least" — so a stray ninth action file (e.g. a forgotten scratch file, or a premature Phase 3 addition) fails the build; (b) for each file, greps its source for `export async function <ExpectedName>(` and asserts exactly one match — proving the file exports what its own spec promised, not just that a same-named file exists. This is the same "structural, string-level, no jsdom, no DB" style the rest of the sweep file already uses (pm09-spec §3.3), just inverted from a negative assertion to a positive, closed-set one.

### 2.4 The write-service naming tension — resolved via an explicit set, not a glob

`prodmgmt-code-standards-phase2.md` §9's guardrail 11 prose says the read-only components must import nothing from "any `*-write.service.ts`" — but no file in the actual Phase 2 file tree (same document, §7) or in the two write services already shipped (`create-offering.ts`, `update-offering.ts`) uses that suffix. Renaming eight already-planned (and two already-shipped) files to satisfy a guardrail's prose, when no owning unit's spec calls for that rename, would be exactly the kind of undocumented scope creep pm24's own boundary (§2.1) forbids. **Resolution:** pm24 does not implement a `*-write.service.ts` glob (it would silently match zero files and the guardrail would pass vacuously — worse than not having it). Instead it defines one explicit, named set of write-service basenames — the same pattern the sweep file already uses for its `PRODUCT_WRITE_SERVICE_FILES` (guardrail 4), just extended to completeness and reused by guardrail 11 too:

```ts
// The eight write-service files this phase ships (prodmgmt-code-standards-
// phase2 §7's file tree). Guardrail 4 excludes these from the "no product
// read path imports the audit-log write path" scan (they legitimately
// audit). Guardrail 11 (new) excludes the same set's *importers* from
// components/products/*.tsx outside manage/ — i.e. the read-only View
// Product surface must import none of these. One set, two guardrails;
// code-standards-phase2 §9's literal "*-write.service.ts" wording doesn't
// match any real filename in this codebase (no file uses that suffix) —
// this named set is the faithful implementation of that rule's *intent*.
const PRODUCT_WRITE_SERVICE_FILES = new Set([
  "create-offering.ts",
  "update-offering.ts",
  "add-specification.ts",
  "update-specification.ts",
  "delete-specification.ts",
  "insert-price.ts",
  "activate-offering.ts",
  "retire-offering.ts",
]);
```

### 2.5 Schema-diff — static source assertion against a frozen Phase-1 baseline

No git-history diffing (CI checkout depth is not guaranteed, and pm09's precedent never relies on `git log`). Instead, pm24 hardcodes the frozen Phase-1 column-name baselines directly in the test (captured in the "Codebase state" header above) and asserts, by parsing `db/schema/product.ts`'s source text with the same regex-per-table-block technique the file would need anyway:

- `productOffering`'s column set = the frozen Phase-1 set **∪** `{"family_offering_id"}` — exactly, no more.
- `productSpecifications`'s column set = its frozen set, **exactly unchanged**.
- `productOfferingPrice`'s column set = its frozen set, **exactly unchanged**.
- `product_offering_family_idx` appears in `productOffering`'s index array (a simple substring check on the table's third-argument callback block).

This is deliberately narrower than "diff the whole file" — it only re-asserts the three things `prodmgmt-architecture-phase2.md` §3 and code-standards-phase2 guardrail 13 actually promise (one column, one index, two tables untouched), the same way pm09's guardrails assert specific invariants rather than "nothing changed anywhere."

### 2.6 Route manifest — verify-first, extend only if needed

Per pm01's own precedent (each unit "consciously" edits the frozen manifest when it ships a route) and pm09-spec §3.3.5's identical wording, pm18 (page shell) is the unit most likely to have already added `/products/manage-products` to `tests/app/route-manifest.test.ts`'s `ROUTE_MANIFEST`. pm24 **audits first** (§3.1); if the entry is present, no edit is needed there — only the sweep file's guardrail-12 assertion (checking the manifest's *content*, not adding the route itself) is net-new. If the audit finds pm18 did not add it, pm24 makes that one addition itself, the same fallback pm09-spec §3.3.5 designed for its own guardrail 7.

### 2.7 Authz-matrix mutation-path extension — mirroring the existing `customers` precedent, not inventing a new one

`tests/auth/guard.integration.test.ts` already solved this exact shape of problem for the `customers` permission (cm16-spec §3.2): a `customerManagerUserId` (EDIT only) / `customerUserRoleUserId` (READ only) principal pair, plus a `describe("direct Server Action calls reject a USER (bypassing the nav)")` block that dynamically imports every `actions/customer/*.ts` export and calls each directly with a placeholder payload, asserting rejection for an under-permissioned caller. `products` needs the same proof, but with a real EDIT-vs-DELETE split (customers only ever tested EDIT-vs-READ — there is no `customers:DELETE`-gated action to compare against). Concretely, pm24 adds:

- **One new principal**, `productsManagerUserId`, granted `products:EDIT` **only** (not `DELETE`) — the products analogue of `customerManagerUserId`. The existing `adminUserId` (already `products:DELETE`, which satisfies EDIT and DELETE both per level-rank) is not sufficient to prove the split exists, exactly as `pm23-spec §2.3` itself observes: *"a `products:EDIT`-only user must be able to activate but not discard/retire."*
- **Two `it.each` loops**, mirroring the customer block exactly:
  - The seven `products:EDIT`-gated actions (`createOfferingAction`, `updateOfferingAction`, `createSpecificationAction`, `updateSpecificationAction`, `deleteSpecificationAction`, `insertPriceAction`, `activateOfferingAction`), called directly for `productsManagerUserId` (has EDIT) — asserted to **not** return `{ok: false, code: "FORBIDDEN"}` and **not** redirect to `/no-access` (they may still fail on validation or business-rule grounds against placeholder ids — that failure mode is out of scope here; only the *permission* gate is under test).
  - All eight actions, called directly for `noGrantsUserId` — asserted to reject (either `{ok: false, code: "FORBIDDEN"}` or a `/no-access` redirect, matching the two co-existing "acceptable rejected outcomes" the customer block already documents).
  - The one action that actually distinguishes the split — `retireOfferingAction` — called directly for `productsManagerUserId` (EDIT, no DELETE): **must** reject. This single case is the concrete, executable proof that `products:EDIT` and `products:DELETE` are two different gates, not one — the literal thing pm99 asks this unit to check ("real mutation-path checks... for both `EDIT` and `DELETE`").
- No change to the existing `it.each` loop that proves `PRODUCTS:READ/EDIT/DELETE` are satisfied for `adminUserId`, nor to the no-grants `PRODUCTS:READ` denial loop — both already exist and stay as-is.

### 2.8 Guardrail 10 — closing pm14's own open item

pm14-spec's closing line explicitly left open whether "spec-delete unreachable on `ACTIVE`" gets "asserted structurally" or stays "by construction." pm24 closes it with one small, static, net-new assertion in the sweep file: grep `services/product/**` and `components/products/**` (excluding `delete-specification.ts` itself) for any call site referencing `productSpecificationRepository.deleteSpecification` or a bare `deleteSpecification(` — if any exists outside `services/product/delete-specification.ts`, the guardrail fails. This does not re-verify the *behavior* (pm14's integration test already does that, §2.2 row 10) — it verifies the **shape**: there is exactly one call site for the repository's delete method, and it is the one file whose branch-first routing makes `ACTIVE` targets structurally unreachable. Optional in the sense that pm14 didn't mandate it, but cheap, static, and it is exactly what "asserted directly, not just trusted from construction" (code-standards-phase2 §9, guardrail 10's own wording) calls for.

### 2.9 No new runtime behaviour

As with pm09 §2.4: pm24 adds zero application behavior. Every assertion here turns an already-true (or about-to-be-true, once pm10–pm23 land) architectural fact into a permanent, executable CI check. If any assertion in this spec turns out **false** against the real, merged pm10–pm23 code, that is a defect in the owning unit — pm24 stops, reports it, and does not adjust the assertion to make it pass.

## 3. Implementation

### 3.1 Pre-flight guardrail audit (do first, non-optional)

Before writing anything, confirm each inherited guardrail (ledger rows 1–9, 14) actually exists and is green on the integration branch, and record the exact file/test name. Command sketch:

```
cat tests/guardrails/product-module-boundaries.test.ts             # v1 assertions 2/3/5 — should be unchanged
grep -n "PRODUCT_WRITE_SERVICE_FILES" tests/guardrails/product-module-boundaries.test.ts
grep -rn "single.active\|findActiveInFamily\|SUPERSEDED" tests/db/product-repositories.integration.test.ts   # guardrail 8
grep -rn "byte-identical\|branch.*mutate\|ACTIVE.*untouched" tests/db/product-repositories.integration.test.ts # guardrail 9
grep -n "manage-products" tests/app/route-manifest.test.ts          # guardrail 12 — already added by pm17/pm18?
grep -n "family_offering_id" db/schema/product.ts                   # guardrail 13 baseline check
cat actions/product/*.ts | grep "export async function"             # confirm exactly 8 exports exist
```

If any inherited guardrail (rows 1–9, 14 of the ledger) is missing or red, stop: it is the owning unit's defect, fix it there, re-verify — do not invent a replacement test in pm24 (§2.1).

### 3.2 Rewrite assertion 1 — `tests/guardrails/product-module-boundaries.test.ts` (edit)

Replace the existing "has no actions/product/ folder" test with:

```ts
const PRODUCT_ACTION_FILES: Record<string, string> = {
  "create-offering.action.ts": "createOfferingAction",
  "update-offering.action.ts": "updateOfferingAction",
  "create-specification.action.ts": "createSpecificationAction",
  "update-specification.action.ts": "updateSpecificationAction",
  "delete-specification.action.ts": "deleteSpecificationAction",
  "insert-price.action.ts": "insertPriceAction",
  "activate-offering.action.ts": "activateOfferingAction",
  "retire-offering.action.ts": "retireOfferingAction",
};

// Phase 2 (prodmgmt-code-standards-phase2 §7): actions/product/ now exists
// and exports exactly this phase's eight mutations — no more, no fewer.
// Inverts pm09's "must not exist" assertion now that the CRUD fast-follow
// (Inv. #11, restated as present-tense fact) has shipped.
it("actions/product/ exists and exports exactly this phase's action set", () => {
  const actionsDir = path.join(REPO_ROOT, "actions", "product");
  expect(fs.existsSync(actionsDir)).toBe(true);

  const actualFiles = fs
    .readdirSync(actionsDir)
    .filter((name) => name.endsWith(".action.ts"))
    .sort();
  expect(actualFiles).toEqual(Object.keys(PRODUCT_ACTION_FILES).sort());

  for (const [fileName, exportName] of Object.entries(PRODUCT_ACTION_FILES)) {
    const source = fs.readFileSync(path.join(actionsDir, fileName), "utf8");
    const exportedFunctionNames = [
      ...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g),
    ].map((match) => match[1]);
    expect(exportedFunctionNames).toEqual([exportName]);
  }
});
```

### 3.3 Add "View stays read-only" — `tests/guardrails/product-module-boundaries.test.ts` (new assertion)

```ts
const WRITE_SURFACE_DIRS = [
  path.join(REPO_ROOT, "actions", "product"),
  path.join(REPO_ROOT, "components", "products", "manage"),
].map((p) => p.replace(/\\/g, "/"));
const WRITE_SURFACE_SERVICE_FILES = [...PRODUCT_WRITE_SERVICE_FILES].map(
  (f) =>
    path
      .join(REPO_ROOT, "services", "product", f)
      .replace(/\.ts$/, "")
      .replace(/\\/g, "/"),
);

// Extracts every module specifier a file references — static
// import/export-from declarations and dynamic import() calls alike —
// instead of scanning raw text for a substring, so a barrel re-export or an
// unrelated string that happens to contain a forbidden substring is handled
// correctly either way.
function extractImportSpecifiers(source: string): string[] {
  const re =
    /(?:import|export)(?:(?!from)[^'";])*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(re)].map((match) => match[1] ?? match[2] ?? "");
}

// Resolves a specifier the way the app's own module resolution would
// (`@/*` alias to repo root, `.`/`..` relative to the importing file) —
// null for bare package specifiers, which can never point at this
// codebase's own write surface.
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("@/")) {
    return path.join(REPO_ROOT, specifier.slice(2)).replace(/\\/g, "/");
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier).replace(/\\/g, "/");
  }
  return null;
}

function targetsWriteSurface(resolvedPath: string): boolean {
  const noExt = resolvedPath.replace(/\.(ts|tsx)$/, "");
  if (
    WRITE_SURFACE_DIRS.some((dir) => noExt === dir || noExt.startsWith(`${dir}/`))
  ) {
    return true;
  }
  return WRITE_SURFACE_SERVICE_FILES.includes(noExt);
}

// Guardrail 11 (code-standards-phase2 §9). View Product's own components
// (components/products/*.tsx, excluding the manage/ subfolder — that's
// write-capable UI by design, prodmgmt-architecture-phase2 §2) and the
// View Product page tree must import nothing that could mutate product
// data.
it("View Product imports nothing from the write surface", () => {
  const viewProductPageFiles = collectFiles(
    path.join(REPO_ROOT, "app", "(app)", "products", "product-offering"),
  );
  const readOnlyComponentFiles = fs
    .readdirSync(path.join(REPO_ROOT, "components", "products"), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) =>
      path.join(REPO_ROOT, "components", "products", entry.name),
    );

  const filesToScan = [...viewProductPageFiles, ...readOnlyComponentFiles];
  expect(filesToScan.length).toBeGreaterThan(0);

  const offending = filesToScan.filter((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return extractImportSpecifiers(content).some((specifier) => {
      const resolved = resolveSpecifier(specifier, filePath);
      return resolved !== null && targetsWriteSurface(resolved);
    });
  });

  expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
});
```

Note the deliberate use of `fs.readdirSync` (non-recursive) rather than `collectFiles` for `components/products/*.tsx` — the guardrail's own wording (code-standards-phase2 §9, guardrail 11) scopes to `components/products/*.tsx`, i.e. direct children only, explicitly excluding the `manage/` subdirectory; a recursive walk would need an explicit exclusion instead, which is more fragile than simply not recursing.

### 3.4 Route manifest — verify, extend if needed (edit, conditional)

Per Design §2.6: first check whether pm17/pm18 already added `/products/manage-products` to `tests/app/route-manifest.test.ts`'s `ROUTE_MANIFEST` array. If yes, no edit there. Either way, extend the sweep file's guardrail-12 assertion:

```ts
it('the frozen route manifest includes "/products/manage-products" exactly once', () => {
  const routeManifestSource = fs.readFileSync(
    path.join(REPO_ROOT, "tests", "app", "route-manifest.test.ts"),
    "utf8",
  );
  const manifestMatch = routeManifestSource.match(
    /const ROUTE_MANIFEST = \[([\s\S]*?)\] as const;/,
  );
  expect(manifestMatch).not.toBeNull();

  const occurrences = (
    manifestMatch?.[1]?.match(/"\/products\/manage-products"/g) ?? []
  ).length;
  expect(occurrences).toBe(1);
});
```

(The existing `/products/product-offering` assertion from pm09 is untouched — this is an addition, not a replacement.)

### 3.5 Schema-diff assertion — `tests/guardrails/product-module-boundaries.test.ts` (new)

```ts
// Guardrail 13. Frozen Phase-1 baselines (prodmgmt-architecture-phase2 §3:
// family_offering_id is the *only* schema addition this phase makes).
const PHASE1_OFFERING_COLUMNS = [
  "productOfferingId", "name", "isBundle", "isSellable", "billingOnly",
  "lifecycleStatus", "version", "lastModified", "lastEditedBy",
].sort();
const SPECIFICATIONS_COLUMNS = [
  "productSpecId", "refProductOfferingId", "name", "isMandatory",
  "isDefault", "defaultValue", "productSpecCharacteristics",
].sort();
const PRICE_COLUMNS = [
  "productOfferingPriceId", "productOfferingId", "name", "priceType",
  "recurringChargePeriodLength", "recurringChargePeriodType",
  "unitOfMeasure", "amount", "currency", "glCode", "pricingModel",
  "policy", "pricingCharacteristics", "startDateTime", "createdAt",
].sort();

// Isolates the full `product.table("...", { ... }, (t) => [ ... ]);` call
// for one table — both the column-def object and the index/check callback
// — so the index assertion below can be scoped to that one table's block
// instead of a repository-wide `source.toContain`, which a comment or an
// unrelated table's index could also satisfy.
function extractTableBlock(source: string, tableVarName: string): string {
  const tableMatch = source.match(
    new RegExp(`export const ${tableVarName} = product\\.table\\(\\s*"[a-z_]+",[\\s\\S]*?\\n\\);`),
  );
  expect(tableMatch).not.toBeNull();
  return tableMatch?.[0] ?? "";
}

function extractTableColumnNames(source: string, tableVarName: string): string[] {
  const tableMatch = source.match(
    new RegExp(`export const ${tableVarName} = product\\.table\\(\\s*"[a-z_]+",\\s*\\{([\\s\\S]*?)\\n  \\},`),
  );
  expect(tableMatch).not.toBeNull();
  return [...(tableMatch?.[1] ?? "").matchAll(/^\s{4}(\w+):/gm)]
    .map((m) => m[1] ?? "")
    .sort();
}

it("db/schema/product.ts diffs from Phase 1 by exactly family_offering_id + its index", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "db", "schema", "product.ts"),
    "utf8",
  );

  const offeringColumns = extractTableColumnNames(source, "productOffering");
  expect(offeringColumns).toEqual(
    [...PHASE1_OFFERING_COLUMNS, "familyOfferingId"].sort(),
  );

  expect(extractTableColumnNames(source, "productSpecifications")).toEqual(
    SPECIFICATIONS_COLUMNS,
  );
  expect(extractTableColumnNames(source, "productOfferingPrice")).toEqual(
    PRICE_COLUMNS,
  );

  const offeringTableBlock = extractTableBlock(source, "productOffering");
  expect(offeringTableBlock).toContain("product_offering_family_idx");
});
```

Adjust the extraction regex to the schema file's exact formatting during implementation (the header's "Codebase state" section captures the current shape as of pm10's landing; re-verify it hasn't reformatted before wiring the regex).

### 3.6 Extend `PRODUCT_WRITE_SERVICE_FILES` — `tests/guardrails/product-module-boundaries.test.ts` (edit)

```ts
const PRODUCT_WRITE_SERVICE_FILES = new Set([
  "create-offering.ts",
  "update-offering.ts",
  "add-specification.ts",
  "update-specification.ts",
  "delete-specification.ts",
  "insert-price.ts",
  "activate-offering.ts",
  "retire-offering.ts",
]);
```

This set already exists (currently containing only the first two entries, added by pm11/pm13 per their own specs' "extend `PRODUCT_WRITE_SERVICE_FILES` only" instruction — e.g. pm14-spec §3.8). If pm14/pm15/pm16 already extended it themselves as they shipped, this step is a **verify**, not an edit; add only whatever entries the audit (§3.1) finds missing. This same set backs both the existing guardrail-4 audit-path exclusion and the new guardrail-11 forbidden-import list (§2.4) — one set, referenced twice, not duplicated.

### 3.7 Guardrail-10 structural backstop (new, optional per Design §2.8)

```ts
it("productSpecificationRepository.deleteSpecification has exactly one call site (delete-specification.ts)", () => {
  const expectedFile = path.join(
    REPO_ROOT,
    "services",
    "product",
    "delete-specification.ts",
  );
  expect(fs.existsSync(expectedFile)).toBe(true);

  const countCallSites = (filePath: string): number =>
    (
      fs
        .readFileSync(filePath, "utf8")
        .match(/productSpecificationRepository\.deleteSpecification\(/g) ?? []
    ).length;

  expect(countCallSites(expectedFile)).toBe(1);

  const scanRoots = [
    path.join(REPO_ROOT, "services", "product"),
    path.join(REPO_ROOT, "components", "products"),
    path.join(REPO_ROOT, "actions", "product"),
  ];
  const offending = scanRoots
    .flatMap(collectFiles)
    .filter((f) => f !== expectedFile)
    .filter((f) => countCallSites(f) > 0);

  expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
});
```

Turns pm14's "true by construction" claim into an executable fact: if a future change calls the repository's delete method from anywhere but its own branch-first service, this fails the build instead of silently reintroducing a direct-mutate path against `ACTIVE`.

### 3.8 Authz-matrix mutation-path extension — `tests/auth/guard.integration.test.ts` (edit)

Per Design §2.7, inside the existing `describe.skipIf(!databaseUrl)` block:

1. **New principal.** Add `productsManagerUserId` alongside the existing `customerManagerUserId`/`customerUserRoleUserId` declarations; insert the user in `beforeAll`, create (or reuse, if one already exists for `EDIT`-only grants generically) a role granted `products:EDIT` only, and assign it — mirroring the `customerManagerRole` block exactly, substituting `products` for `customers`.
2. **Dynamic imports.** Alongside the existing `Promise.all([...import("@/actions/customer/...")])` block, add a second `Promise.all` importing all eight `@/actions/product/*.action` modules, collected into a `productActions: Record<string, (...) => Promise<unknown>>` map the same shape as `customerActions`.
3. **New `describe` block**, `"direct Server Action calls reject an under-permissioned caller (products)"`, containing:
   - `it.each` over the seven EDIT-gated action names, asserting `productActions[name](...)` called as `productsManagerUserId` does **not** resolve to `{ok: false, code: "FORBIDDEN"}` and does not redirect to `/no-access` (call with placeholder positional args matching each action's real arity — e.g. `createOfferingAction({})`, `updateOfferingAction("PRDOFR000001", {})`, `deleteSpecificationAction("PRDSMD000001", "PRDOFR000001")` — the guard runs before any argument is used, so placeholder values are safe).
   - `it.each` over all eight action names, asserting rejection for `noGrantsUserId` (mirrors the customer block's second loop exactly).
   - One dedicated `it`, `"retireOfferingAction rejects a products:EDIT-only caller (products:DELETE required)"`, calling `retireOfferingAction` as `productsManagerUserId` and asserting rejection — the single case that proves the EDIT/DELETE split is real, not just asserted in prose.

No change to the existing `it.each([PRODUCTS, READ/EDIT/DELETE])` admin-satisfaction loop or the no-grants `PRODUCTS:READ` denial loop (§2.7, last bullet).

### 3.9 Doc / permission-map verification (verify; edit only if a gap is found)

Confirm, per pm09-spec §3.4's identical convention: `prodmgmt-architecture-phase2.md` §4 and `prodmgmt-code-standards-phase2.md` §8 already carry the `/products/manage-products → products:EDIT` (mutations) / `products:DELETE` (retire/discard) rows — they do, as of this spec's writing. No new permission constant is needed; `PERMISSIONS.PRODUCTS` and `LEVELS.EDIT`/`LEVELS.DELETE` already exist (v1). If the audit finds a gap, fix it in the owning unit's doc, not here.

### 3.10 Full verification pass (workflow §8)

- `npm run typecheck`, `npm run lint`, `npm run format:check` — clean.
- `npm run test` — **both** vitest configs green: unit suite (sweep test, now with 8 assertions) and integration suite (`guard.integration.test.ts` with the new principal/describe block, `product-repositories.integration.test.ts` with all of pm12–pm16's cases). Integration stage must have `DATABASE_URL` set — a `skipIf`-skipped ship gate proves nothing (pm09-spec's own words, still true).
- **Regression** — every Phase 1 guardrail (1–7) and every pre-existing Administration/Customer authz case still passes unchanged.
- **Security scan** — SAST + OWASP ZAP DAST baseline against the staging revision with `/products/manage-products` now live: no high/critical finding; confirm unauthenticated → `/login`, authenticated-without-EDIT → `/no-access`.
- **Manual walkthrough** (dev server, per pm99's literal sequence and the overview's Success Criteria): sign in as a `products:EDIT`+`DELETE` user → create a new offering → add a mandatory specification → add a flat price → activate it (reaches `ACTIVE`, appears correctly on View Product) → edit the now-`ACTIVE` offering (produces a new sibling `DRAFT`, original untouched) → activate that new draft (confirm the previously-active sibling auto-retires in the same action, audited as `PRODUCT_OFFERING_SUPERSEDED`) → separately, start a second draft and discard it before it ever goes live (confirm it disappears from View Product's default filter and is audited as `PRODUCT_OFFERING_DISCARDED`, distinct from `_RETIRED`).

### 3.11 Commit

One commit, e.g. `product module phase 2 ship gate: guardrails + authz matrix + full sweep (pm24)`. Contents: `tests/guardrails/product-module-boundaries.test.ts` (rewritten assertion 1, new assertions for guardrails 11/13, extended guardrail-12 check, extended `PRODUCT_WRITE_SERVICE_FILES`, optional guardrail-10 backstop), `tests/auth/guard.integration.test.ts` (edit — new `productsManagerUserId` principal + direct-call describe block), and — only if the audit found it missing — `tests/app/route-manifest.test.ts` (manifest extension). Explicitly **not** in this commit: any `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, or `infra/**` change; no dependency/lockfile change; no doc edit unless §3.9's audit found a genuine gap.

## 4. Dependencies

**No new npm packages.** Everything needed — `vitest`, `drizzle-orm`/`postgres`, `node:fs`/`node:path` — is already installed and already used by the exact files pm24 edits. No DB extension, no schema/migration/validation/service/component change (pm24 is tests + CI only). Requires pm10–pm23 merged and green — in particular pm18's family-grouped read model (so the manual walkthrough has real UI to click through), pm19–pm23's eight action files (so the rewritten assertion 1 and the authz-matrix extension have something real to check), and pm14/pm15/pm16's integration tests (so guardrails 8/9/10/14 are inherited-green, not missing). The CI integration stage must provide `DATABASE_URL` so the extended `guard.integration.test.ts` block actually runs.

## 5. Verification checklist

**The fourteen guardrails (all must be green)**

- [ ] Guardrails 1–7 (Phase 1, `pm09`) — unchanged, still green.
- [ ] Guardrail 8 (single-active-per-family) — `product-repositories.integration.test.ts` proves activating a sibling auto-retires the prior `ACTIVE` row in the same transaction; a near-simultaneous double-activation leaves exactly one winner.
- [ ] Guardrail 9 (branch-not-mutate) — editing an `ACTIVE` offering's fields, specs, or prices leaves the original row and its children byte-identical and produces exactly one new sibling `DRAFT`.
- [ ] Guardrail 10 (spec-delete unreachable on `ACTIVE`) — pm14's behavioral test green; pm24's structural backstop (§3.7) finds exactly one call site for `deleteSpecification`.
- [ ] Guardrail 11 (View stays read-only) — new sweep assertion green; `components/products/*.tsx` (excluding `manage/`) and `app/(app)/products/product-offering/**` import nothing from `actions/product/`, `components/products/manage/`, or any of the eight write-service files.
- [ ] Guardrail 12 (route manifest) — `/products/manage-products` appears exactly once in the frozen manifest; `/products/product-offering`'s existing entry is untouched.
- [ ] Guardrail 13 (schema-diff) — `productOffering`'s column set is the frozen Phase-1 set plus exactly `familyOfferingId`; `productSpecifications`/`productOfferingPrice` column sets are byte-identical to Phase 1; `product_offering_family_idx` is present.
- [ ] Guardrail 14 (price immutability, behavioral) — inserting a successor price via `insertPrice` leaves the old row untouched; `version` unaffected when the target was already `DRAFT`.

**Rewritten/new sweep assertions (net-new pm24 code)**

- [ ] Assertion 1 rewritten: `actions/product/` exists; its `.action.ts` file set is exactly the eight named files, sorted, `toEqual`; each exports exactly one matching `export async function <Name>(`.
- [ ] `PRODUCT_WRITE_SERVICE_FILES` contains all eight write-service basenames (not just the two pm11/pm13 added).
- [ ] View-stays-read-only assertion added and green.
- [ ] Schema-diff assertion added and green.
- [ ] Route-manifest guardrail-12 assertion added (or confirmed already present) and green.
- [ ] Optional guardrail-10 structural backstop added and green.

**Authz-matrix mutation-path extension**

- [ ] `productsManagerUserId` principal exists, granted `products:EDIT` only (no `DELETE`).
- [ ] All eight `actions/product/*` action functions, called directly bypassing the nav, reject `noGrantsUserId`.
- [ ] The seven EDIT-gated actions do not reject `productsManagerUserId` on permission grounds.
- [ ] `retireOfferingAction` **does** reject `productsManagerUserId` (EDIT without DELETE) — the concrete proof the EDIT/DELETE split is real.
- [ ] Existing `PRODUCTS:READ/EDIT/DELETE` admin-satisfaction loop and no-grants `PRODUCTS:READ` denial loop unchanged and still green.

**Diff hygiene**

- [ ] `git status` shows only: `tests/guardrails/product-module-boundaries.test.ts`, `tests/auth/guard.integration.test.ts`, and — only if needed — `tests/app/route-manifest.test.ts`. Nothing else.
- [ ] No `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, or `infra/**` change; no dependency/lockfile change; no doc edit unless §3.9 found a real gap.
- [ ] No pre-existing test assertion changed except the ones this spec names. No `TODO`, commented-out code, no `console.*`.

**Build gates (workflow §8.7)**

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — both configs; integration suite runs with `DATABASE_URL` set (not `skipIf`-skipped).

**Docs in sync (verify, don't duplicate)**

- [ ] `prodmgmt-architecture-phase2.md` §4 and `prodmgmt-code-standards-phase2.md` §8 already carry the `/products/manage-products` permission rows (EDIT for mutations, DELETE for retire/discard) — confirmed, not re-authored.
- [ ] `prodmgmt-progress-tracker.md` marks Unit pm24 complete with commit ref, guardrail-audit results, and the phase's ship-gate sign-off.

**Pipeline (workflow §8.7; code-standards §10)**

- [ ] CI green end-to-end: typecheck, lint, format, unit + integration suites, secret scan, SAST + OWASP ZAP DAST baseline (no high/critical; `/products/manage-products` exercised as authenticated-only, EDIT/DELETE-gated).
- [ ] Manual walkthrough (§3.10) completed and recorded: create → add spec → add price → activate → edit-while-active → activate-new-draft (old one auto-retires) → discard an abandoned draft elsewhere.

Any failing item means Phase 2 is not shipped (workflow §8). With pm24 verified and merged, the Product Management module's CRUD fast-follow is complete and gated.
