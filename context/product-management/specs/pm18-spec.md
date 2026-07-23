# PM18 — Manage Products Page Shell

- **Unit:** 18 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm17 (nav entry to reach the page from) and Units pm10–pm16 (so real family/version/status data exists to display). **Boundary, per the build plan's own words: "Frontend (RSC page + `components/products/manage/manage-offering-table.tsx`) — consumes existing read services only, no new backend code."** This spec honors that boundary with one narrow, explicitly flagged exception — see Design §2.2.
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` Core User Flow step 3 ("one row per family (its current `ACTIVE` version, or its latest `DRAFT` if the family has never gone live), with an option to expand and see every version") and Navigation & shell; `prodmgmt-architecture-phase2.md` §2 (`app/(app)/products/manage-products/` row: "the CRUD page: family-grouped offering list, row actions, create/edit/activate/retire/discard dialogs... Structurally independent of `product-offering/`"), §4 (permission table: `products:EDIT` for the page, `products:DELETE` for retire/discard); `prodmgmt-code-standards-phase2.md` §2 ("New read model needed for the Manage Products list: a family-grouped row shape... do not invent it speculatively before Unit 8 of the implementation guide" — **this unit is that Unit 8**), §3 (new rule: "the Manage Products page follows the same 'thin RSC orchestrator' discipline as View Product — guard, parse, fetch, compose"), §7 (file tree: `app/(app)/products/manage-products/{page,loading,error}.tsx`, `components/products/manage/manage-offering-table.tsx`), §8 (permission map), §9 guardrail 11 ("View stays read-only... imports nothing from... `components/products/manage/`"); `prodmgmt-ui-context-phase2.md` §5 (`--action-cta-bg` reserved for "New offering," "the only accent-filled primary action on that page") and the "Manage Products — Component Wiring" section (row-action icon/color/visibility table, version-family grouping/expand behavior, RETIRED-row muted treatment); `mockup-product_module_manage_products.html` (concrete layout: ID/Name/Status/Version/Actions columns, chevron-free flat list with one row per family including a fully-`RETIRED` example row, icon-only 28px action buttons); `pm99-build-plan-phase2.md` Unit pm18 (this unit's literal contract); `_change-product-crud-plan.md` "Open items" ("Whether the Manage Products table's grouped list needs its own read path, or can reuse `listOfferings` with a family-aware post-filter — a build-time call, not a design fork" — resolved in Design §2.2); `pm05-spec.md` / `pm06-spec.md` (the "seam" convention this unit's row-action buttons and CTA button continue: render real, correctly-labeled UI now, wire the behavior in a later unit); `app/(app)/customers/manage/page.tsx` (the closest existing "Manage X" page precedent: guard → parse → fetch → compose, header CTA as a plain element, `loading.tsx`/`error.tsx` siblings).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped:** Unit pm10 (`product_offering.family_offering_id` column + `product_offering_family_idx` index + the `family_offering_id <> product_offering_id` check, all present in `db/schema/product.ts`), Unit pm11 (`insertOffering` in `db/repositories/product-offering.ts`, `services/product/create-offering.ts`, `PRODUCT_OFFERING_CREATED` in `types/audit.ts`), Unit pm12 (`branchOfferingAsDraft` + its private `resolveNextVersion` helper, same file).
  - **Not yet shipped:** Units pm13 (`updateOfferingDraftInPlace`, `services/product/update-offering.ts`), pm14 (specification write services), pm15 (`insertPrice`, `services/product/insert-price.ts`), pm16 (`activateOffering`, `retireOffering`, `findActiveInFamily`, their services), and pm17 (`admin-nav.tsx` still shows a single "Product Offering" item — no "View Product"/"Manage Products" split yet). `services/product/` today contains exactly three files: `create-offering.ts`, `get-offering-detail.ts`, `list-offerings.ts`. `components/products/manage/` exists as an empty directory. `tests/guardrails/product-module-boundaries.test.ts`'s `PRODUCT_WRITE_SERVICE_FILES` set currently contains only `"create-offering.ts"`, confirming no other write service exists yet.
  - **This spec is written assuming pm13–pm17 will exist by the time pm18's implementation lands**, per pm99's own dependency line — but pm18's *code* never calls any pm13–pm16 export. The dependency is about **data**, not imports: pm18 needs offerings in more than one lifecycle status and more than one version per family to render anything beyond a single flat, single-row-per-family table. See Design §2.2 and Verification's "Fixture data" note for how to produce that data before pm19 (Create UI) ships a real "New offering" flow.
  - `types/product.ts`'s `OfferingListRow` today is `{ productOfferingId, name, lifecycleStatus, version, isSellable, lastModified }` — **no `familyOfferingId` field**. `db/repositories/product-offering.ts`'s `findList` SELECT does not select `familyOfferingId` either, nor does `findDetailById`. Nothing in the current read surface exposes family lineage. This is the gap Design §2.2 resolves.
  - `services/product/list-offerings.ts`'s `listOfferings(params)` resolves `pageSize` internally from `core.SYSTEM_CONFIG` (`products`/`offering_list_page_size`, default `5`, no caller override) and always returns `{ rows, total, page, pageSize }`. `status: null` includes both `DRAFT` and `ACTIVE`, excludes `RETIRED`; a specific status filters to exactly that status.
  - `db/seeds/product.ts` currently seeds single-version, single-row offerings only (no seeded row has a non-null `family_offering_id`, and no seeded family has more than one version) — manual verification of the expand affordance needs supplemental fixture data (see Verification).

---

## 1. Goal

Ship `/products/manage-products` as a thin RSC page, guarded by `products:EDIT`, that fetches every offering across every lifecycle status, groups the rows by resolved version family (one row per family by default — its `ACTIVE` version, or its highest-version row if no version is currently `ACTIVE`), and renders them through a new `ManageOfferingTable` client component with a working expand/collapse version-history affordance, a "New offering" CTA, and status-appropriate row-action buttons — Edit/Add price/Activate/Discard for `DRAFT`, Edit/Add price/Retire for `ACTIVE`, none for `RETIRED` — all present and correctly labeled, none yet wired to real behavior (that's Units pm19–pm23).

## 2. Design

### 2.1 Boundary & composition

Boundary is **frontend only**, matching `prodmgmt-architecture-phase2.md` §2's description of this folder and the "thin RSC orchestrator" discipline code-standards-phase2 §3 explicitly extends to this page: guard → parse (nothing to parse — see §2.7) → fetch → compose. The page calls **only** `services/product` exports, never a repository directly (platform architecture.md §2's inward-only dependency rule), and composes exactly one new client component. No `actions/product/`, no `services/product/*-write.service.ts`, no `db/migrations/`, no Server Action of any kind is added by this unit — that discipline is what keeps `tests/guardrails/product-module-boundaries.test.ts`'s "no `actions/product/` folder" assertion (still expected to hold until pm19) green.

### 2.2 The family-grouped read model — the build-time call this unit has to make

`_change-product-crud-plan.md`'s own "Open items" section flagged this rather than resolving it: *"Whether the Manage Products table's grouped-by-family list needs its own paginated/sortable read path, or can reuse `listOfferings` with a family-aware post-filter — a build-time call, not a design fork."* `prodmgmt-code-standards-phase2.md` §2 is more pointed still: *"New read model needed for the Manage Products list... do not invent it speculatively before Unit 8 of the implementation guide"* — this unit **is** Unit 8. The call has to be made now, not deferred again.

**The blocker:** grouping by family requires knowing each row's resolved family root. `family_offering_id` exists in the schema (pm10) but is exposed **nowhere** in the current read surface — not in `OfferingListRow` (`listOfferings`'s return shape), not in `OfferingDetail` (`getOfferingDetail`'s return shape). Grouping by `name` instead was explicitly discussed and rejected when `family_offering_id` was designed (`prodmgmt-architecture-phase2.md` §3: *"names change, and two unrelated offerings can legitimately share one... the alternative, no schema change at all, was considered and rejected for that fragility"*) — falling back to a name-match here would silently reintroduce the exact fragility that column was added to eliminate. There is no way to build a correct family-grouped list without exposing `family_offering_id` somewhere in a list-shaped read model.

**Resolution — flagged, not silently assumed, per the same "not blocking, but not to be assumed silently" convention the crud-plan itself uses for its own open items:**

1. **Add `familyOfferingId: string | null` to `OfferingListRow`** (`types/product.ts`) and **add `familyOfferingId` to `findList`'s existing `SELECT`** (`db/repositories/product-offering.ts`). This is a one-column, purely additive change to an *existing* exported function's return shape — no new repository method, no new file, no new service, no behavior change for the one existing caller (`OfferingTable` on View Product simply doesn't destructure the new field; its rendering, sort, and filter behavior are untouched — confirmed in Verification). This is read the build plan's "no new backend code" line to mean *no new mutation surface* (that's the discipline actually being protected — see the "Codebase state" note above: `actions/product/` must stay absent until pm19), not "the existing read path may never gain a column that already exists in the table." Code-standards-phase2 §2 anticipated exactly this need ("New field on the `ProductOffering` read/insert types: `familyOfferingId`... mirroring the new column") — it just didn't spell out that `OfferingListRow` specifically needs it too, because that dependency only becomes concrete here, at Unit 8.
2. **No new repository method, no new service file.** `listOfferings(params)`'s signature, behavior, and export are unchanged apart from the one extra selected column flowing through. `services/product/list-offerings.ts` gains no new export.
3. **The grouping itself — a pure, private helper living in the page file, not a service.** `app/(app)/products/manage-products/page.tsx` is allowed a private, non-exported helper the same way `app/(app)/products/product-offering/page.tsx` already has its own private `firstValue` — this isn't a new "backend" file, it's page-local orchestration logic, exactly the "parse, fetch, compose" the thin-RSC-orchestrator discipline already permits. Two private functions:
   - `fetchAllOfferingRows(): Promise<OfferingListRow[]>` — because `listOfferings` hides `RETIRED` under `status: null` and paginates under a server-configured `pageSize` the caller can't override, and because the version-history expansion needs *every* row in a family including retired ones, this helper calls the existing, unmodified `listOfferings` export twice — once with `status: null` (fetches `DRAFT` + `ACTIVE`), once with `status: "RETIRED"` — looping `page` upward each time using the `total`/`pageSize` the response already returns, until every row across every page has been collected. A hard ceiling (1000 combined rows) guards against a pathological loop; exceeding it throws (caught by this unit's `error.tsx`), the same "throw on an unexpected condition rather than silently misbehave" discipline `insertOffering`/`branchOfferingAsDraft` already use for their own `if (!row)` guards. This is orchestration over an *existing, unmodified* service export — not a new backend read path.
   - `groupIntoFamilies(rows: OfferingListRow[]): OfferingFamilyRow[]` — resolves each row's family root as `row.familyOfferingId ?? row.productOfferingId` (architecture-phase2 §3's one-hop convention), groups by that root, and per family picks the **primary** row: the `ACTIVE` row if one exists (Inv. 13 guarantees at most one), otherwise the row with the highest `version` (which, since `RETIRED` is a real terminal case, may itself be `RETIRED` — see §2.3). Returns each family's full row set (`versions`, sorted by `version` descending) alongside the chosen `primary`, sorted overall by `primary.name` ascending (matching View Product's default sort, for consistency across the module's two pages).
4. **Why not a real backend list-all method instead:** the catalog this module manages is an internal, ops-curated set (no documented scale target beyond the existing configurable `offering_list_page_size`, default `5`, max `100`) — page-looping over the already-guarded, already-tested `listOfferings` export is adequate for this phase and adds zero new surface for the guardrail suite to have to reason about. If the catalog grows to a size where this becomes a real performance concern, that is a call for a later phase, not this one — flagged here so it isn't lost, not treated as this unit's problem to pre-solve.

```ts
// types/product.ts — addition (types leaf module; no runtime/DB code)
export type OfferingFamilyRow = {
  familyId: string; // resolved root id — row.familyOfferingId ?? row.productOfferingId
  primary: OfferingListRow;
  versions: OfferingListRow[]; // every row in the family, primary included, version desc
};
```

### 2.3 RETIRED-primary families are shown, not hidden — a deliberate divergence from View Product

View Product hides `RETIRED` rows by default (pm02/pm03 Design #5, unchanged). Manage Products does **not** do this at the family level: the mockup's own fixture data includes `PRDOFR000004 "Legacy 4G Add-On" — RETIRED, v3` rendered as an ordinary primary row (muted, "No actions — retired," per ui-context-phase2's row-action table), not filtered out of the list entirely. This makes sense for an *operations* surface — Billing Operations needs to see a product's full lifecycle including ones that ended in retirement, not just the currently-billable subset View Product curates for. So: **every family appears in the Manage Products list, regardless of its primary row's status.** Only the row-*action* visibility (§2.6), not row *visibility*, changes with status.

### 2.4 Page layout & where the CTA lives

Header (`<h1>` "Manage Products" + one-line subtitle, matching the mockup's copy: *"One row per product family. Editing a live version always creates a new draft — it never changes what's active."*) is rendered directly by `page.tsx`, the same split `product-offering/page.tsx` and `customers/manage/page.tsx` already use. The **"New offering" CTA** (`--action-cta-bg`, per ui-context-phase2 §5 — "the only accent-filled primary action on that page") is rendered **inside `ManageOfferingTable`**, not the page header, following pm99's own literal wording for this unit ("The table renders the expand/collapse version-history affordance and the 'New offering' CTA button") and the precedent `OfferingTable` (View Product) already set of owning its own top control bar (search/filter there; the create action here) rather than pushing every table-adjacent control up into the page. This is a page-header-vs-table-header placement call with no functional consequence either way; it's called out explicitly so a reviewer doesn't read it as an oversight relative to the `customers/manage` CTA-in-page-header precedent — that page's CTA is a `Link` to a sub-route (`/customers/manage/new`); this page's CTA opens a dialog (pm19), which is a table-level interaction, not a navigation.

### 2.5 Expand/collapse version history

Purely client-side, local `useState<Set<string>>` of expanded family ids inside `ManageOfferingTable` — no URL state, unlike View Product's table (there is no pagination, sort, or filter UI on this page in this unit; see §2.7). A family with `versions.length === 1` renders **no** chevron at all (ui-context-phase2 §6: *"a family with only one row shows no expand chevron at all, rather than an expand control that reveals nothing"*) — not a disabled chevron, no chevron element in the DOM. A family with more than one version renders a `chevron-right`/`chevron-down` toggle (`lucide-react` `ChevronRight`/`ChevronDown`, `--text-muted`, rotates on expand — matching the existing disclosure convention, no new pattern invented per ui-context-phase2). Expanded, the family's other versions render as indented sub-rows directly beneath the primary row, each with its own `LifecycleBadge`, its own `version` value, and its own row actions per §2.6 — on a subtly recessed background, `--surface-sunken` (the same token the empty-panel states already use), to visually subordinate them without a new surface token.

### 2.6 Row actions — status matrix, and the seam pattern this unit exists to establish

Exactly the matrix `pm99-build-plan-phase2.md` states for this unit, matching `prodmgmt-ui-context-phase2.md`'s icon/color table one-for-one:

| Status | Actions shown | Icon (lucide-react) | Color role |
|---|---|---|---|
| `DRAFT` | Edit, Add price, Activate, Discard | `Pencil`, `CircleDollarSign`, `Check`, `Trash2` | Edit/Add price/Activate: `--text-secondary` (quiet — Activate is deliberately **not** accent; ui-context-phase2 reserves the one accent button on this page for "New offering"). Discard: `--text-danger`. |
| `ACTIVE` | Edit, Add price, Retire | `Pencil`, `CircleDollarSign`, `Archive` | Edit/Add price: `--text-secondary`. Retire: `--text-danger`. |
| `RETIRED` | none | — | Plain `--text-muted` text, "No actions — retired" (mockup's exact copy), replacing the button row entirely — not an empty space, not disabled buttons. |

`Archive` doubles as both the `RETIRED` `LifecycleBadge` glyph (already shipped, pm05 §3.2) and the "Retire" action icon — this mirrors the mockup's own choice (`ti-archive` used for both the status badge and the retire button) rather than inventing a second glyph for the same real-world action of "this becomes retired."

**Every button in this matrix renders now, with its real icon, its real `aria-label` (e.g. `"Edit ${offering.name}"`, `"Add price to ${offering.name}"`, `"Activate ${offering.name}"`, `"Discard ${offering.name}"`, `"Retire ${offering.name}"` — never color-only meaning, per ui-context-phase2's inherited icon+label rule), 28px square, `0.5px solid var(--border)` — and does nothing when clicked.** This is the exact "seam" discipline `pm05`→`pm06`→`pm07`→`pm08` used for the View Product detail page's three placeholder sections: land the real, correctly-shaped UI surface now; wire the behavior later, one seam at a time. Concretely, each button is a plain `<button type="button">` with no `onClick` handler bound to anything yet — an inline comment marks which future unit fills it in (`{/* pm20 seam: onClick opens OfferingForm in edit mode */}`, `{/* pm22 seam */}`, `{/* pm23 seam */}`), and the "New offering" CTA carries the equivalent `{/* pm19 seam: onClick opens CreateOfferingDialog */}`. No button is `disabled` — a `DRAFT`/`ACTIVE` row's buttons are fully rendered, focusable, and clickable, they simply have no attached behavior yet, matching pm99's own phrasing ("do nothing yet") rather than a disabled/greyed treatment that would misrepresent the eventual permission-gated behavior.

### 2.7 What pm18 explicitly does NOT do

- No search box, status filter, column sort, or pagination controls on this page — the mockup shows none, `pm99`'s contract for this unit names only the family list, the expand affordance, the CTA, and the row-action seams, and none of the five prior units' patterns (`OfferingTable`'s URL-driven controls) are cited as something this unit inherits. If catalog size later demands them, that's a follow-up unit's job, flagged, not pre-built speculatively here.
- No dialog, no form, no `"use server"` action, no Server Action file of any kind (pm19–pm23).
- No change to `app/(app)/products/product-offering/**` or any of its components — that page's own `H1`/`metadata.title` rename to "View Product" belongs to pm17 §2.6 (already flagged there as foldable into pm17 or deferred; if deferred, it is **not** silently picked up here — re-confirm which way pm17 resolved it before assuming the label is already "View Product" when this unit lands).
- No new audit event type, no `insertAuditEvent` import anywhere in this unit's files (this page performs no mutation — the "no product read path imports the audit-log write path" guardrail must keep passing unmodified for every file this unit touches).
- No repository *method* addition, no new service *file* — only the one-column `SELECT`/type addition described in §2.2, which is the unit's one deliberate, flagged exception to an otherwise strict "reuse, don't add" boundary.

## 3. Implementation

### 3.1 Read model — `types/product.ts` (edit)

```ts
export type OfferingListRow = {
  productOfferingId: string;
  name: string;
  lifecycleStatus: LifecycleStatus;
  version: number;
  isSellable: boolean;
  lastModified: Date;
  familyOfferingId: string | null; // new — architecture-phase2 §3 lineage column, surfaced for family grouping (pm18 §2.2)
};

// New — backs the Manage Products page only (pm18 §2.2). Not consumed by
// View Product or getOfferingDetail.
export type OfferingFamilyRow = {
  familyId: string;
  primary: OfferingListRow;
  versions: OfferingListRow[]; // version desc, primary included
};
```

### 3.2 Repository — `db/repositories/product-offering.ts` (edit — one field added to one existing SELECT)

In `findList`'s row-select object, add the one column:

```ts
const rows = await db
  .select({
    productOfferingId: productOffering.productOfferingId,
    name: productOffering.name,
    lifecycleStatus: productOffering.lifecycleStatus,
    version: productOffering.version,
    isSellable: productOffering.isSellable,
    lastModified: productOffering.lastModified,
    familyOfferingId: productOffering.familyOfferingId, // new
  })
  .from(productOffering)
  // ...unchanged WHERE/ORDER BY/LIMIT/OFFSET
```

No other line in `findList` changes. `findDetailById`, `insertOffering`, `branchOfferingAsDraft` are untouched — confirm this explicitly in the diff, not just by assumption.

### 3.3 Service layer — `services/product/list-offerings.ts` (unchanged)

No edits. `listOfferings`'s signature, JSDoc-equivalent comment, and behavior are identical; it simply now returns one extra field per row because the repository call underneath it does. No new export added to this file (§2.2 point 2).

### 3.4 Page — `app/(app)/products/manage-products/page.tsx` (new)

```tsx
import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ManageOfferingTable } from "@/components/products/manage/manage-offering-table";
import { listOfferings } from "@/services/product/list-offerings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import type { LifecycleStatus, OfferingFamilyRow, OfferingListRow } from "@/types/product";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage Products — Enterprise Billing",
};

const MAX_COMBINED_ROWS = 1000; // defensive ceiling — see pm18-spec §2.2

// Loops the existing, unmodified `listOfferings` export across every page
// for one status bucket. Two calls (null, "RETIRED") together cover every
// lifecycle status — `listOfferings` itself never accepts "give me
// everything" in one call (pm18-spec §2.2).
async function fetchAllForStatus(
  status: LifecycleStatus | null,
): Promise<OfferingListRow[]> {
  const collected: OfferingListRow[] = [];
  let page = 1;
  for (;;) {
    const result = await listOfferings({
      q: "",
      status,
      sort: "name",
      page,
      offering: null,
    });
    collected.push(...result.rows);
    if (
      collected.length >= result.total ||
      result.rows.length === 0 ||
      collected.length > MAX_COMBINED_ROWS
    ) {
      break;
    }
    page += 1;
  }
  if (collected.length > MAX_COMBINED_ROWS) {
    throw new Error(
      "fetchAllForStatus: exceeded the combined-row safety ceiling",
    );
  }
  return collected;
}

async function fetchAllOfferingRows(): Promise<OfferingListRow[]> {
  const [nonRetired, retired] = await Promise.all([
    fetchAllForStatus(null),
    fetchAllForStatus("RETIRED"),
  ]);
  return [...nonRetired, ...retired];
}

function resolveFamilyId(row: OfferingListRow): string {
  return row.familyOfferingId ?? row.productOfferingId;
}

function selectPrimary(versions: OfferingListRow[]): OfferingListRow {
  const active = versions.find((row) => row.lifecycleStatus === "ACTIVE");
  if (active) return active;
  return versions.reduce((highest, row) =>
    row.version > highest.version ? row : highest,
  );
}

function groupIntoFamilies(rows: OfferingListRow[]): OfferingFamilyRow[] {
  const byFamily = new Map<string, OfferingListRow[]>();
  for (const row of rows) {
    const familyId = resolveFamilyId(row);
    const existing = byFamily.get(familyId);
    if (existing) {
      existing.push(row);
    } else {
      byFamily.set(familyId, [row]);
    }
  }

  const families: OfferingFamilyRow[] = [];
  for (const [familyId, versions] of byFamily) {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    families.push({ familyId, primary: selectPrimary(sorted), versions: sorted });
  }

  return families.sort((a, b) => a.primary.name.localeCompare(b.primary.name));
}

export default async function ManageProductsPage(): Promise<React.JSX.Element> {
  // products:EDIT gates the whole page (architecture-phase2 §4); retire/
  // discard's additional products:DELETE check happens per-action in pm23's
  // Server Actions, not here — this page never itself performs a mutation.
  await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT);

  const [rows, locale, timezone] = await Promise.all([
    fetchAllOfferingRows(),
    getAppLocale(),
    getAppTimezone(),
  ]);
  const families = groupIntoFamilies(rows);

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Manage Products
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          One row per product family. Editing a live version always creates a
          new draft — it never changes what&apos;s active.
        </p>
      </header>

      <Suspense>
        <ManageOfferingTable
          families={families}
          locale={locale}
          timezone={timezone}
        />
      </Suspense>
    </main>
  );
}
```

Notes on this file: no `searchParams` prop at all (§2.7 — nothing to parse in this unit); `dynamic = "force-dynamic"` matches every other authenticated page in this module (permissions and family state resolve live, never cached — platform Inv. #2/#15). `fetchAllForStatus`/`fetchAllOfferingRows`/`resolveFamilyId`/`selectPrimary`/`groupIntoFamilies` are private to this file, not exported — the same "page-local helper" precedent `firstValue` already sets in the sibling `product-offering/page.tsx`.

### 3.5 `app/(app)/products/manage-products/loading.tsx` (new)

Mirrors `app/(app)/customers/manage/loading.tsx`'s shape exactly (`Skeleton` primitives, no data dependency):

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading(): React.JSX.Element {
  return (
    <div className="space-y-5 p-5">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-9 w-32" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
```

### 3.6 `app/(app)/products/manage-products/error.tsx` (new)

Mirrors `app/(app)/customers/manage/error.tsx`'s shape exactly, copy adjusted:

```tsx
"use client";

import { useEffect } from "react";

import { reportError } from "@/lib/logger";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="rounded-md border border-border bg-card p-8 text-center shadow-md">
        <h2 className="text-h3 font-semibold text-foreground">
          Unable to load products
        </h2>
        <p className="mt-2 text-body text-muted-foreground">
          Something went wrong loading the product catalog. Please try again.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-4 rounded-sm bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/80"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
```

### 3.7 Component — `components/products/manage/manage-offering-table.tsx` (new)

`"use client"`. Props:

```ts
interface ManageOfferingTableProps {
  families: OfferingFamilyRow[];
  locale: string;
  timezone: string;
}
```

Structure:

1. **Header row** inside the table's card container (same `rounded-md bg-card shadow-sm` wrapper `OfferingTable` uses, for visual consistency across the two product pages): the "New offering" CTA button, right-aligned, `bg-[color:var(--action-cta-bg)]`, `Plus` icon (matching `customers/manage`'s CTA styling), `aria-label="New offering"`. `{/* pm19 seam: onClick opens CreateOfferingDialog */}` — no `onClick` bound in this unit.
2. **Empty state** (zero families total): centered `PackageSearch` icon + "No offerings yet — create one to get started," `--text-muted` on `--surface-sunken`, mirroring `OfferingTable`'s empty-row treatment.
3. **Table** — columns `ID`, `Name`, `Status`, `Version`, `Actions` (matching the mockup's column set and widths exactly — `ID` fixed narrow mono column, `Name` flexible, `Status` fixed for the badge, `Version` fixed narrow mono, `Actions` fixed wide enough for four 28px buttons plus gaps).
4. **Per-family primary row:**
   - Leading cell: chevron toggle (`ChevronRight`/`ChevronDown`, `--text-muted`, `aria-expanded`, `aria-label="Show other versions of ${primary.name}"` / `"Hide other versions of ${primary.name}"`) **only when** `versions.length > 1`; otherwise no chevron element at all (§2.5).
   - `productOfferingId` in `font-mono`/`tabular-nums`, matching `OfferingTable`'s convention.
   - `name`.
   - `LifecycleBadge` (reused as-is, no visual changes — ui-context-phase2 §1).
   - `version`, `font-mono`/`tabular-nums`.
   - Action buttons per §2.6's matrix, keyed off `primary.lifecycleStatus`.
   - A `RETIRED`-primary row (§2.3) gets the same muted row treatment `OfferingTable` already applies to a `RETIRED` row (`text-[color:var(--text-muted)]`, reduced opacity) — reused, not reinvented.
5. **Expanded sub-rows** (only rendered when that family's chevron is toggled open, and only for the `versions` other than `primary` — or, simpler and less error-prone, all of `versions` including `primary` re-rendered in version order beneath a lighter primary summary; **this spec picks showing all `versions` including the primary when expanded**, each on `--surface-sunken`, indented one level, so the expanded state reads as a complete, literal version history rather than "primary plus the rest" — matches ui-context-phase2's framing, "reveals the family's other versions as indented sub-rows," most literally read as the full list once expanded). Each sub-row: same five columns, same `LifecycleBadge`, same action matrix keyed off *that row's own* `lifecycleStatus` (a `DRAFT` sibling still gets Edit/Add price/Activate/Discard even though the family's primary is `ACTIVE`, and vice versa).
6. **`locale`/`timezone`** are accepted as props (matching `OfferingTable`'s signature) for forward-compatibility with a future "last modified" column on this table, even though this unit's column set (per the mockup) doesn't render one — passing them through now avoids a prop-signature churn in a later unit. If a reviewer prefers to omit unused props rather than pre-thread them, that is an acceptable alternative; note whichever way this is resolved in the commit message.

No `useRouter`/`useSearchParams`/`usePathname` — this component has no URL state (§2.7). Only `useState<Set<string>>` for the set of expanded family ids, toggled by the chevron's `onClick`.

### 3.8 View Product page heading — explicitly out of scope here

If pm17's §2.6 decision deferred the "View Product" `H1`/`metadata.title` rename to this unit instead of folding it into pm17, **that deferred work is not picked up by this spec** — pm18 touches nothing under `app/(app)/products/product-offering/`. Re-check pm17's shipped commit message / progress-tracker entry before starting this unit; if the rename was deferred, flag it as still outstanding rather than silently leaving it undone a second time.

### 3.9 Tests

- `tests/app/manage-products-page.test.tsx` (new) — guard-first (unpermitted → redirect to `/no-access`, no `listOfferings` call attempted afterward — mock `requirePermission` to assert this the same way the existing `product-offering-page.test.tsx` verifies its own guard); a permitted `products:EDIT` render calls `listOfferings` (mocked) with `status: null` and `status: "RETIRED"` at least once each; a multi-page fixture (mocked `listOfferings` returning `total` greater than one page) confirms `fetchAllForStatus` loops until every row is collected; a fixture with two rows sharing a `familyOfferingId` (one `ACTIVE`, one `DRAFT`) collapses to one family row in the rendered output with the `ACTIVE` row as primary; a fixture with no `ACTIVE` row in a family resolves the highest-`version` row as primary regardless of its status (covering the `RETIRED`-primary case, §2.3).
- `tests/components/manage-offering-table.test.tsx` (new) — renders each of the three status action-button sets and asserts the exact button set/labels per §2.6's table; asserts a single-version family renders no chevron; asserts an expand click reveals the family's other versions with their own independent action sets; asserts every action button and the "New offering" CTA are present, focusable, and have no attached behavior that changes any observable state on click (a `fireEvent.click` on each produces no callback invocation, no navigation, no state change beyond the component's own local expand/collapse state) — this is the executable form of the "seam, not real yet" claim, not just a comment trusted at face value.
- `tests/guardrails/product-module-boundaries.test.ts` — no edit expected in this unit (pm24 owns the guardrail rewrites); run the existing suite and confirm it still passes unmodified, in particular the "no product read path imports the audit-log write path" check now also scanning this unit's two new page files and its one new component.

### 3.10 Commit

One commit. Contents: `types/product.ts` (edit — two additions), `db/repositories/product-offering.ts` (edit — one field added to `findList`'s SELECT only), `app/(app)/products/manage-products/page.tsx` (new), `app/(app)/products/manage-products/loading.tsx` (new), `app/(app)/products/manage-products/error.tsx` (new), `components/products/manage/manage-offering-table.tsx` (new), the two new test files. Explicitly **not** in this commit: `actions/product/**`, any `*-write.service.ts`, any file under `app/(app)/products/product-offering/` (unless §3.8 applies), `components/admin-nav.tsx` (pm17's own file), any migration.

## 4. Dependencies

**No new npm packages.** `lucide-react` (already installed, `^1.20.0`) supplies every icon this unit needs: `ChevronRight`, `ChevronDown` (expand affordance — not yet imported by `manage-offering-table.tsx` since the file is new, but already used elsewhere in this codebase for the identical chevron pattern), `Pencil`, `CircleDollarSign`, `Check`, `Trash2`, `Archive` (row actions — `Archive` already imported by `lifecycle-badge.tsx`; this unit imports it again locally in the new file, no shared-import refactor needed), `Plus` (CTA, already used by `customers/manage/page.tsx`), `PackageSearch` (empty state, already used by `offering-table.tsx`). `Skeleton` (`components/ui/skeleton.tsx`) and the existing `Button`/`cn` primitives are reused as-is. No Zod, Drizzle, or Postgres-driver version change — this unit adds one column to one existing SELECT, no schema/migration change.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.10 — nothing under `actions/`, `services/product/*-write.service.ts`, `db/migrations/`, `db/schema/`, or `components/admin-nav.tsx`.
- [ ] `db/repositories/product-offering.ts`'s diff is exactly one added line inside `findList`'s `SELECT` object — `findDetailById`, `insertOffering`, `branchOfferingAsDraft` are byte-identical to before this unit.
- [ ] `types/product.ts`'s diff is exactly the `familyOfferingId` field on `OfferingListRow` plus the new `OfferingFamilyRow` type — no other exported type touched.
- [ ] No `actions/product/` directory exists after this unit.
- [ ] No `TODO`, commented-out code, or `console.*` introduced — the pm19–pm23 seams are marked with plain, descriptive comments (`{/* pm19 seam: ... */}`), not `TODO`.

**Backend correctness — the one flagged read-model change**
- [ ] `listOfferings` called against a fixture with a non-null `family_offering_id` on at least one row returns that value unchanged in `familyOfferingId` on the corresponding `OfferingListRow`.
- [ ] `listOfferings` called against a seeded root row (`family_offering_id IS NULL`) returns `familyOfferingId: null` for it.
- [ ] Every existing `list-offerings` unit test (pm03/pm05-era) still passes unmodified — the new field is additive and does not change any existing assertion's expected shape unless that assertion does an exact deep-equality check on the full row object (if so, update only the expected-shape literal to include the new field, not the test's actual logic).
- [ ] `app/(app)/products/product-offering/page.tsx` and `components/products/offering-table.tsx` are untouched by this unit's diff and continue to render identically — confirmed by re-running (not just re-reading) their existing test suite.

**Behavior — the point of the unit**
- [ ] An unpermitted user (no `products` grant, or `products:READ` only) hitting `/products/manage-products` is redirected to `/no-access` before any data fetch is attempted.
- [ ] A `products:EDIT` user reaches a rendered family-grouped table.
- [ ] A family with two or more versions shows exactly one primary row plus a chevron; toggling it reveals every version in that family (including the primary, per §3.7's resolved reading), each with its own status badge and independently-computed action set.
- [ ] A family with exactly one row shows no chevron in the DOM at all.
- [ ] A family whose highest-version row is `RETIRED` (no `ACTIVE`, no `DRAFT` in that family) still appears in the list as a normal, visible (not hidden) row, muted, with "No actions — retired" in place of buttons.
- [ ] Every `DRAFT` row shows exactly Edit, Add price, Activate, Discard, in that order, with the icons/colors from §2.6's table.
- [ ] Every `ACTIVE` row shows exactly Edit, Add price, Retire, in that order.
- [ ] Every `RETIRED` row (primary or expanded sub-row) shows no action buttons, only the muted "No actions — retired" text.
- [ ] Clicking any row action button or the "New offering" CTA does nothing observable — no navigation, no dialog, no network call, no error — confirmed by the seam test in §3.9, not just visual inspection.
- [ ] Every action button has a distinct, descriptive `aria-label` naming both the action and the offering (not just an icon with no accessible name).

**Fixture data for manual verification (no UI to create it yet)**
- [ ] Because pm19 (Create UI) and pm13/pm16 (update/activate services) haven't shipped, seeded data alone (single-version, single-status offerings only) cannot exercise the expand affordance or the `RETIRED`-primary case. Before manually walking through this unit, insert temporary multi-version fixtures directly via `productOfferingRepository.insertOffering`/`branchOfferingAsDraft` in a throwaway script or an integration-test `beforeEach` (the same "populate through real repository calls, not raw SQL" discipline pm13-spec.md already establishes) — do not hand-write raw `INSERT` statements against `product_offering` for this purpose, and do not leave any such throwaway script committed.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — all pre-existing product-module tests plus this unit's two new test files.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy) gets a pm18 entry with the commit reference, and explicitly records which way §3.8's "View Product heading" question landed (already done by pm17, done here, or still outstanding) so pm24's ship-gate sweep doesn't have to re-derive it.

**Pipeline**
- [ ] CI green end-to-end. This unit adds exactly one new route (`/products/manage-products`) with no mutation surface behind it yet — the SAST/DAST baseline should show no new finding beyond the expected new-route entry pm24 will formally add to the frozen route manifest.

Any failing item means the unit is not done. Units pm19–pm23 each depend on this unit's specific seam markers existing in specific, predictable places (the CTA's `{/* pm19 seam */}`, each row action's own future-unit comment) — do not start any of them until every item above passes and the seam comments are in place exactly where this spec locates them.
