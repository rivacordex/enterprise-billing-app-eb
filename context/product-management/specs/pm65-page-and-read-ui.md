# pm65 — Page + read UI

**Unit:** pm65 (Part 5). **Boundary:** `app/(app)/products/rate-card/{page,loading,error}.tsx` (new), `services/product/ratecard/{list-versions,get-version-rows}.ts` (new), `components/products/rate-card/{rate-card-status-badge,rate-card-version-table,rate-card-row-preview}.tsx` (new), the `NAV_REGISTRY` entry and its glyph, the four authz-matrix rows, and guardrail 40. **No mutating control is rendered at all** — pm66 builds every one of them.
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow steps 1, 6; _UI — `/products/rate-card`_) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7**, **D-A2, D-A7** · `prodmgmt-architecture.md` §4, Inv. **#59** · `prodmgmt-code-standards.md` §2.22, §3.15, §3.16, §3.17, §3.23, §4.3, §4.22, §4.23, §4.27, §4.29, §4.30, §4.31, §7.11, §8, guardrails 1/40 · `prodmgmt-ui-context.md` **§10** (all of it) · `prodmgmt-ai-workflow-rules.md` §3.11, §3.13, §4.4, §6.1, §6.6.
**Depends on:** **pm60**, **pm61** (something to list); **G-RC3** (the permission and the nav entry). Read UI lands **before** write UI (general §3.2).

**This unit settles C1 and C3, declines C4, and raises one new conflict (C9, D3).**

---

## Goal

Ship `/products/rate-card` as a read surface: the version list, a paged and filterable row preview, and the diff view — with every mutating control **absent, not disabled**, and the whole page uncached.

---

## Design

### D1. The page is a thin RSC orchestrator

`guard requirePermission('ratecard', 'READ')` → await `searchParams` → parse → `listVersions` / `getVersionRows` / `diffAgainstActive` → compose (§3.16). Ships `loading.tsx` and `error.tsx`, carries `export const dynamic = 'force-dynamic'`, and sets `metadata`; title and `H1` are both **"Rate Card"**.

`searchParams` are **parsed, never trusted** (§3.17). A `version` that matches no row renders the **empty-selection state** — not a 404 and not an error boundary. `version` is parsed against the `RCV` format schema before any repository call.

No client store, no `useState` mirror of the URL (§3.17).

### D2. C1 — the badge is `RateCardStatusBadge`

`prodmgmt-code-standards.md` names it **`RateCardStatusBadge`** in four places (§4.22's token table, §4.23's binding list, the §7 file tree, and §8's permission map). `prodmgmt-ui-context.md` §10.1 calls the same thing `RateCardVersionBadge`. **Component names are a binding convention** (§8 notes, workflow §7.8), so one doc is wrong.

**Settled: `RateCardStatusBadge`.** Code-standards is the owning doc for component names (workflow §7.7), it says so in four places against ui-context's one, and the `§7` tree and the permission map both key off it. **C1 is already resolved in the tree — verify-only.** `prodmgmt-ui-context.md` §10.1 already reads `RateCardStatusBadge` (confirmed 2026-09-27); this unit **confirms** it rather than renaming it. If a stale `RateCardVersionBadge` resurfaces anywhere, correct it — otherwise nothing to change.

It is a **separate total `Record<RateCardVersionStatus, …>`, sharing no type with `LifecycleBadge`** (§4.22, §2.19, workflow §3.13). Four values; `DRAFT` takes **warning, not info** (ui-context §10.1 — the mockup is superseded here, because `DRAFT` must mean one thing app-wide and info is §1's `TESTING` hue). `REJECTED` gets a variant **for totality though it is unreachable in this delivery** (§1.42) — present so the union is closed, not because the phase writes it.

### D3. C9 — a ninth component name (`RateCardDiffBadge`) — **RESOLVED 2026-09-27**

`prodmgmt-ui-context.md` §10.2 specifies **`RateCardDiffBadge`** with a full four-row token table (hue + icon per diff category). `prodmgmt-code-standards.md` §4 item 23's binding-names list did **not** include it and read **"Eight, and no more"** (the earlier draft of this spec said "nine" — an off-by-one; the doc's list was eight, having double-counted `RateCardStatusBadge` across items 22 and 23).

**Resolution (Take A): admit it as the ninth binding name.** §10.2 defines a total four-value `Record` with a hue and an icon per value — precisely this module's definition of a badge (§2.2, §4.1); burying it inside `RateCardDiffPanel` would make it the module's only unnamed badge and invite a second, divergent chip later. So `RateCardDiffBadge` was **added** to code-standards §4 item 23 (now **"Nine, and no more"**), to the §7 file tree (`rate-card-diff-badge.tsx`), and item 22 was noted as one of **two** badges. `prodmgmt-ui-context.md` §10.2 already carried the name. Recorded in `pm00-build-plan.md` as **C9**. The component itself is built at **pm66** (it renders in the diff panel); this unit only settles the name.

### D4. C3 — the third search param, and why it is not a style question

`prodmgmt-ui-context.md` §10.5 makes the Rows / Diff vs Active / Validation tabs URL-driven (`?tab=`), _"matching the module's deep-link convention"_. `prodmgmt-ai-workflow-rules.md` §3.11 permits **no search param beyond `version` and `page`**, and code-standards §3.17 names the same two.

**Settled: amend §3.11 and §3.17 to admit `tab` as an enumerated third param.** The argument is the **query budget**, not the convention:

- §3.23 fixes the budget — first render is one versions query plus its count; selecting a version is one paged rows query plus its count; **requesting a diff is two full row reads**.
- If the tab is _not_ in the URL, the page either renders all three tabs server-side on every load — **paying the diff's two full reads every time anyone opens the page, whether or not they wanted a diff** — or fetches on the client, which this module does not do anywhere.
- So the param is what keeps §3.23 honest. Without it, the budget rule and the tab design contradict each other.

`tab` is parsed against a closed union (`rows` | `diff` | `validation`) and falls back to `rows`; an unknown value is ignored, not a 404 (§3.17). **Amend both docs in this change set with that reasoning written down** — the reasoning is the record of the decision, not commentary.

### D5. C4 — the export affordances are declined

`prodmgmt-ui-context.md` §10.6 lists four export affordances — _Download template_, _Export rows_, _Export diff_, _Export errors_. **No service, action, scope line or success criterion anywhere else mentions them**, and client-side file _generation_ is a surface nobody has scoped.

**Not built in this delivery.** Remove them from §10.6 or mark them explicitly deferred with an owner — do not leave four buttons specified that the page does not have. **Raise it if RevOps needs them**; it is a small unit on its own and a scope leak inside this one.

### D6. No page banner

Earlier drafts carried a page-level _"nothing consumes this yet"_ banner. **It is not built.** The table is stood up on the assumption it **will** be consumed — the rating usage is a following-sprint deliverable — so signage implying the page is inert is not warranted. The page is a plain read surface with no status banner.

### D7. The mockup's ghosted "Lookup exceptions" card is not built

`mockup-product-rate-card.html` shows it ghosted as context for reviewers. **Do not build a disabled placeholder** (ui-context §10.4) for a feature this delivery does not include. The page ships the read surface and nothing else.

### D8. Dates are ISO on this page — through the shared formatter, never inline

`snapshot_date` and `polygon_start_date` are **calendar dates**, typed `string` in `YYYY-MM-DD` end to end (§2.22), rendered **ISO throughout this page rather than localized** (ui-context §10.5) — `polygon_start_date` because it is a **descriptive date read out of the file**, `snapshot_date` because it is the **upload's calendar date**, stamped by the server in the app timezone (plan D-A8, pm61 D4) — neither is a human-facing schedule date. The `snapshot_date` label may read **"Snapshot date"** or **"Uploaded on"**; the value renders ISO either way, and it is never re-derived from `uploaded_at` on the page. `uploaded_at` and `activated_at` are instants and take the threaded `timezone` prop through `formatDatetime` (§4.30).

Getting this backwards **moves a `polygon_start_date` by a day at a zone boundary.**

**Do not fork a formatter** (workflow §3.13). Calendar dates go through `formatCalendarDate`. If the shared formatter cannot render ISO for this page, that is a **finding to raise** — not an inline `toISOString()` and not a second date helper. Resolve it before the table is written, since every column on this page depends on the answer.

### D9. The version list and the row preview

**Version list** (ui-context §10.5): one row per version, newest first — `RCV########` in `--font-mono`, the status badge, snapshot date, row count in `tabular-nums`, uploader / activator and timestamps. The selected row takes `--surface-selected`; a `SUPERSEDED` row renders muted. A _"One Active version per card"_ note sits in the card header in `--text-muted` with a `lock` icon — it states a **DB guarantee**, so it is informational, not a warning.

The version list shows **`row_count` only** — a version's rows are exactly its uploaded file (plan D-A7), so there is no second count to show and no `retired_at` date column.

**Row preview** (`RateCardRowPreview`): paged and filterable, **never 5,400 rows at once**, footer stating `Showing 1–n of N` in `--text-muted` (ui-context §10.7). Server component, reusing the **Administration table primitives** (§4.3) — no parallel table implementation, no per-row action cluster.

**The optional rate column** (ui-context §10.3): `rate_per_unit` is a plain nullable `numeric(18,6)`. Render its value when present; a null renders a plain `—` in `--text-muted`, like any other optional column on the page. It never goes through `formatCurrency` — there is no currency to call it with (§1.45).

**Mono / tabular conventions** per §4.29: `--font-mono` for `ratecard_version_id`, `lkp_subscriber_ref_id`, `card_name`, `service_code`, the three key columns and `file_checksum` (middle-truncated `a91f…3c02`); `tabular-nums` for `version_num`, the counts and every diff count.

### D10. Two distinct empty states

As §6 requires of the families table (ui-context §10.7):

- _No versions yet for this card_ — **"No versions yet. Upload a CSV to create the first one."**, pointing at the header button **without repeating it**.
- _No rows match this filter_ — **"No rows match "`<q>`""** plus a quiet "Clear filters".

These must read differently. A fresh-card state and a filtered-out state rendered as one blank grid is the failure §6 already names.

At this unit the header button does not exist yet (pm66). The first empty state still points at where it will be — write the copy as specified and let pm66 supply the control, rather than writing interim copy that pm66 then has to change.

### D11. Every mutating control is **absent, not disabled**

A `ratecard : READ` user sees the version list, the rows and the diff **in full**, and **every action in ui-context §10.6 is absent** (§10.7, the rule §7 already follows for non-editable panels). In this unit that is trivially true, because none of them is built. It is stated so pm66 inherits the rule rather than rediscovering it.

The nav entry is **hidden when `ratecard : READ` is denied, never shown locked** (ui-context §10.4, §8) — the existing `NAV_REGISTRY` convention. A denied user reaching the URL directly gets `/no-access` from the page guard.

### D12. No cache — guardrail 40 lands here

`export const dynamic = 'force-dynamic'`, and **no `unstable_cache`, no `revalidate`, no React `cache()`, no module-level store** wraps any card read (Inv. #59, §1.44). A cache **shows a stale version list or stale rows after an upload or activation, so the page contradicts the database it is meant to report**.

Guardrail 40 asserts exactly that, across the app and the services, and lands **with this unit** (workflow §2.2) rather than at the gate.

---

## Implementation

### I1. Route and services

`app/(app)/products/rate-card/{page,loading,error}.tsx` per D1. `services/product/ratecard/{list-versions,get-version-rows}.ts` as read models (§2.9 shapes in, parsed params out), framework-agnostic.

`loading.tsx` renders the **version-list skeleton only** — the row preview and diff have nothing to load until a version is selected (the §3.10 precedent from `manage-products`).

### I2. Components

`RateCardStatusBadge` (D2), `RateCardVersionTable` (D9, server, Administration primitives), `RateCardRowPreview` (D9, server, paged). Three of §4.23's list; the others (and C9's tenth) are pm66's.

`components/products/rate-card/**` is a **third sibling folder** beside `components/products/*.tsx` and `components/products/manage/**`. It imports `components/ui/**` and the shared table primitives and **nothing from `manage/`**; `manage/` imports nothing from it (§7.11). Guardrail 11's read-only assertion covers View Product and is **unaffected** — the card page is write-capable and is not part of that assertion. Say so, or someone will try to extend guardrail 11 here.

### I3. Nav, permission and the route manifest

`NAV_REGISTRY`'s **fifth** Products entry — `label: "Rate Card"`, `href: "/products/rate-card"`, `permission: "ratecard"`, `level: "READ"` — plus the lucide **`TableProperties`** glyph in `components/nav-icons.ts` (ui-context §10, the mockup's tabler `table-options`; no collision with `Package` / `PackagePlus` / `ClipboardList` / `Layers`).

**`tests/app/route-manifest.test.ts`'s `ROUTE_MANIFEST` is a strict set-equality check against every real `app/**/page.tsx`** — the new page **404-fails that test until its literal URL is added**. This is a known recurring ripple, not a surprise; add it in the same commit.

### I4. Guardrail 1 — four rows, and the sentence that must not be inherited

The authz matrix gains **four** `/products/rate-card` rows in **both directions** (§9, §8): `READ` reaches the list, rows and diff and is **refused all three mutations at the action guard**; `EDIT` reaches all three.

**The pricing update's "this update adds no row" sentence must not be carried forward** (§9, workflow §7.5). This update **does** add rows, and pm68 must say how many explicitly.

At this unit the three mutations exist (pm61/pm63/pm64) but their UI does not. The refusal rows are asserted **at the action guard**, which is where they belong anyway — the matrix tests actions, not buttons.

Also assert: **`ratecard` carries no grant overlap with `products`, `product_orders` or `product_inventory` in either direction**; holding `products : DELETE` grants nothing here (§8 notes). The full sweep is pm68's; the rows land here.

### I5. Documentation

1. **`prodmgmt-ui-context.md` §10.1** — renamed to `RateCardStatusBadge` throughout (**C1**).
2. **`prodmgmt-ui-context.md` §10.5** and **workflow §3.11** and **code-standards §3.17** — `tab` admitted as an enumerated third param, with D4's query-budget reasoning written down (**C3**).
3. **`prodmgmt-ui-context.md` §10.6** — the four export affordances removed or marked deferred with an owner (**C4**).
4. **`prodmgmt-code-standards.md` §4.23** — amended to ten names, `RateCardDiffBadge` included (**C9**, option A), and the new conflict recorded in `pm00-build-plan.md`'s C-table.
5. **`prodmgmt-code-standards.md` §7 tree and §8** — the page, the four components, the two read services and the nav entry marked landed under **pm65**; §8's Rate Card rows confirmed against what shipped.
6. **`prodmgmt-architecture.md` §4** — the route × level matrix row confirmed; **architecture §4 and code-standards §8 are updated in the same change set** (workflow §7.6).
7. **Appendix A row A14** — annotated and **left open** (D6); its clearing condition is a consumer shipping.

### I6. Tests

1. A `ratecard : READ` user opens the page, sees the version list, selects a version, and pages and filters its rows.
2. **No mutating control is rendered at all** — absent, not disabled. Assert by querying for each of §10.6's controls and finding none.
3. A denied user gets `/no-access`; the **nav entry is hidden, never shown locked**.
4. A `version` matching no row renders the empty-selection state — not a 404, not an error boundary.
5. An unknown `tab` value falls back to `rows`.
6. **The query budget holds** (§3.23): one versions query plus its count on first render; one paged rows query plus its count on selection; **two full reads and nothing more** for a diff. Assert counts.
7. A present `rate_per_unit` renders its value; a null renders a plain `—` — no italic, no "base rate" treatment.
8. `formatCurrency` is called **nowhere** on this page.
9. The version list shows `row_count` as its only count; no `carried_row_count` figure and no `retired_at` column is rendered.
10. Calendar dates render ISO and do not shift at a zone boundary; instants take the threaded timezone.
11. **Both empty states** render, and they read differently.
12. **Guardrail 40**: no cache wrapper anywhere in the page or the read services; the page is `force-dynamic`.
13. **Guardrail 1**: the four authz rows, both directions; no grant overlap with the other three permissions.
14. `components/products/rate-card/**` imports nothing from `manage/`, and `manage/` imports nothing from it.
15. The **"Lookup exceptions"** card does not exist in the DOM in any form (D7).

---

## Dependencies

**Packages to install: none.** Existing `components/ui/` vendor layer (**composed, never edited** — workflow §6.1), the shared Administration table primitives, the existing nav registry, lucide icons already in the tree.

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run test`, `npx tsc --noEmit`, `npm run lint`, `next build`.

**Prerequisites:** pm60, pm61 merged. **G-RC3** for the permission and the nav entry.

---

## Verification checklist

Conflicts settled

- [ ] **C1** — the component is `RateCardStatusBadge`; ui-context §10.1 corrected in this change set.
- [ ] **C3** — `tab` admitted as an enumerated third param in workflow §3.11 **and** code-standards §3.17, with the query-budget reasoning recorded.
- [ ] **C4** — the four export affordances removed or deferred with an owner; none is built.
- [ ] **C9** — recorded as a new conflict and resolved to ten binding names; `RateCardDiffBadge` belongs to **pm66**.

Page

- [ ] Thin RSC orchestrator; guard first; `loading.tsx` and `error.tsx` ship; `force-dynamic`; title and `H1` are "Rate Card".
- [ ] `version` parsed against the `RCV` schema; a non-matching value renders the empty-selection state.
- [ ] `loading.tsx` renders the version-list skeleton only.
- [ ] `ROUTE_MANIFEST` updated in the same commit.

Read surface

- [ ] Version list newest-first with mono ids, `tabular-nums` counts, muted `SUPERSEDED` rows and the DB-guarantee note.
- [ ] `row_count` is the version list's only count; no `carried_row_count` figure, no `retired_at` column (D-A7).
- [ ] The row preview is paged and filterable and never renders 5,400 rows at once.
- [ ] A present `rate_per_unit` renders its value; a null renders a plain `—` — no italic, no "base rate" treatment.
- [ ] `formatCurrency` is never called on this page.
- [ ] Calendar dates are ISO through the shared formatter — **no inline `toISOString()`, no second date helper**; instants take the threaded timezone.
- [ ] Both empty states exist and read differently.

Absences

- [ ] No status banner is rendered (the page is a plain read surface).
- [ ] The **"Lookup exceptions"** card is not built in any form.
- [ ] **Every mutating control is absent, not disabled.**

Authorization and cache

- [ ] Nav is the fifth Products entry with the `TableProperties` glyph, hidden when denied.
- [ ] Guardrail **1** gains four rows in both directions; `ratecard` overlaps `products`, `product_orders` and `product_inventory` in neither direction.
- [ ] Guardrail **40** landed: no cache anywhere in the page or the read services.
- [ ] The query budget holds, asserted by count.

Boundaries

- [ ] `components/products/rate-card/**` imports nothing from `manage/`; the converse holds; guardrail 11 is unchanged and untouched.
- [ ] `components/ui/` is composed, never edited.
- [ ] `tsc --noEmit`, ESLint, Prettier, the suite and `next build` green.

**Definition of done:** Revenue Operations can open Products → Rate Card, read every version the system has, and page through five thousand rows — with every mutating control absent and the whole page uncached.
