# AC18 — Accounts Nav Order + Selection-Context Handoff

- **Unit:** 18 of 23 (`ac00-build-plan.md`) — first unit of the Transactions revision
- **Dependencies:** `ac05` (the Accounts `NAV_SECTIONS` entry and `parseAccountsContext` exist), `ac07` (the Transactions page exists to link to). Both delivered. No dependency on any later revision unit — ac18 ships standalone against the current app.
- **Authorizing sections:** `acctmgmt-update-overview.md` §Goals 7, §Core user flow steps 1–2, §In scope (`components/admin-nav.tsx`), §Success criteria **SC2, SC3**; `_updatemodule-accounts-transactions-plan.md` §Navigation (decisions **D6** single-caption reorder, **D7** preserve everywhere) and §"The blocker this reordering exposes"; `acctmgmt-architecture.md` §1 (nav context propagation row), §2 (cross-page contract), §6 **inv. #17**; `acctmgmt-code-standards.md` §3.1 (context is URL state, one parser); `acctmgmt-ai-workflow-rules.md` §7 (front-end permission mapping unchanged).
- **Codebase verification performed for this spec:** `components/admin-nav.tsx` is already `"use client"` and imports `usePathname`; `NavItem = { label, href, icon, requiredPermission? }`, `NavSection = { caption, items }`; the Accounts section currently orders Overview → Ledger Explorer → Transactions → Chart of Accounts → GL Journal; `isActive` is derived from `item.href`; `key={item.href}` is used in **both** the locked `<span>` and the `<Link>` branches; `app/(app)/layout.tsx` is `force-dynamic`; `parseAccountsContext` is pure regex with no server-only imports. Three test files render `AdminNav` and mock `next/navigation` with `usePathname` only — see §3.5.

---

## 1. Goal

Reorder the Accounts nav section to Overview → **Transactions** → Ledger Explorer → Chart of Accounts → GL Journal under a single "Accounts" caption (D6), and make all five Accounts nav links carry the live `?party&fa&ban` selection (D7) — so a RevOps user who selects a customer in Accounts Overview and clicks **Transactions** in the sidebar arrives with the context strip populated instead of "No selection". Done when every Accounts nav link round-trips the selection, malformed ids are dropped rather than forwarded, and no non-Accounts link is affected.

## 2. Design

**Boundary: `components/admin-nav.tsx` only.** No page, service, repository, schema, migration, permission or style change. This is the smallest unit in the revision and the only one that touches a platform-shared component, so it is deliberately isolated: nothing else in ac19–ac23 edits this file.

### 2.1 Why the two changes ship together (D6 + D7)

The reorder alone is cosmetic; the context fix alone is invisible. Together they are the unit: moving Transactions directly under Overview makes the sidebar the obvious next click, which **surfaces** the existing context-dropping defect rather than leaving it latent behind the in-page "Go to Transactions ↗" affordance people currently use. Shipping the reorder without the handoff would make the product measurably worse. Per `ac00` sequencing notes they are one unit, not two.

### 2.2 Nav order (D6)

Single `caption: "Accounts"` retained — **no second section**, no "Accounts — Configuration" header. Items reorder to:

| Position | Item | Route | Permission | Context role |
|---|---|---|---|---|
| 1 | Accounts Overview | `/accounts/overview` | `accounts_view : READ` | **Establishes** the selection |
| 2 | **Transactions** | `/accounts/transactions` | `accounts_transactions : READ` | **Consumes** it — unusable without an FA |
| 3 | Ledger Explorer | `/accounts/ledger` | `accounts_view : READ` | Optional — has its own account picker |
| 4 | Chart of Accounts | `/accounts/chart-of-accounts` | `accounts_config : READ` | None — global |
| 5 | GL Journal | `/accounts/gl-journal` | `accounts_config : READ` | None — global |

Ordering principle: context-establishing → context-consuming → context-optional → global. Ledger Explorer drops to 3 because its own page copy calls it "a read-only forensic window over the ledger" — it traces any ledger account including `sys.*`, with or without a customer selected. Today it sits *between* the page that sets context and the page that needs it, splitting the primary workflow across an unrelated tool.

Accepted trade (recorded in `acctmgmt-architecture.md` §2): permissions become interleaved (`accounts_view`, `accounts_transactions`, `accounts_view`, `accounts_config`, `accounts_config`) where they are currently contiguous. Not a functional problem — the nav filters per item via `requiredPermission` and renders unauthorized items locked, so no user sees a broken sequence. The grouping becomes workflow-aligned rather than RBAC-aligned, which is the intent.

Icons, labels, routes and `requiredPermission` values are **unchanged**; only array order changes.

### 2.3 Context propagation (D7) — three structural decisions

**(a) A section-level flag, not path-sniffing.** `NavSection` gains `carriesAccountsContext?: boolean`, set `true` on the Accounts section only. Rejected alternative: `item.href.startsWith("/accounts")` — string-sniffing a route to infer behaviour is exactly the kind of implicit coupling that breaks when a route moves. One explicit flag covers exactly the five items.

**Administration → Accounts Settings does NOT carry context**, deliberately. It lives in the Administration section, is global `accounts_config` configuration, and D7's scope is the Accounts section's five items. Recorded here so it reads as a decision, not an oversight.

**(b) Allowlist exactly three keys — never forward the whole query string.** Only `party`, `fa`, `ban` propagate. Blindly forwarding `searchParams` would carry Ledger Explorer's `?account`, `?transfer`, `?page`, `?sort`, `?q` and (after ac20) the Transactions filter state onto unrelated pages — a real bug, not a theoretical one, since `ledger-explorer-search-params.schema.ts` and `gl-journal-search-params.schema.ts` already define overlapping generic keys like `page` and `q`.

**(c) Values are validated before propagation, reusing the single parser.** The nav routes values through `parseAccountsContext` (code-standards §3.1 — "the only parser"), so `?fa=garbage` is dropped rather than laundered onto the next page. `useSearchParams()` returns `ReadonlyURLSearchParams`, not the server's `Record`, so the adapter uses `sp.get(key)` — which returns the **first** value for a repeated key, matching the parser's own `first()` helper semantics exactly. Do not use `Object.fromEntries(sp.entries())`: it takes the **last** value for duplicates and would silently diverge from server-side parsing.

### 2.4 The `isActive` trap — keep `item.href` a bare pathname

`isActive` is currently derived as ``pathname === item.href || pathname.startsWith(`${item.href}/`)``, and `key={item.href}` is used in both render branches. **Putting query params into `item.href` breaks active-state highlighting on every Accounts page** (`/accounts/overview` never equals `/accounts/overview?fa=FIN000001`).

Therefore: `NavItem.href` stays the bare pathname and remains the source for `isActive` and `key`. The context-carrying URL is computed separately at render time into a local `linkHref`, used **only** as the `<Link href>`. This keeps the change to one line in the JSX plus one helper.

### 2.5 Locked items need no handling

The locked branch renders a `<span role="link" aria-disabled="true">` with **no `href` at all**, so an unauthorized item cannot leak context regardless. No change to that branch. Fail-closed behaviour (cm03-spec §2.3.2) is untouched.

### 2.6 Empty-context and determinism

- No selection → `linkHref` is the bare pathname. Never emit a trailing `?` or `?party=&fa=&ban=`.
- Params are appended in fixed order `party`, `fa`, `ban` regardless of their order in the incoming URL, so hrefs are deterministic across renders and stable for assertions.
- Partial context (e.g. `party` + `fa`, no `ban`) propagates the present keys only.

### 2.7 Rendering safety

`app/(app)/layout.tsx` declares `export const dynamic = "force-dynamic"`, so the whole `(app)` subtree renders dynamically and `useSearchParams()` needs **no `Suspense` boundary** — the static-render build error does not apply. Record the coupling: if a future page under `(app)` opts into static rendering, `AdminNav` must be wrapped in `Suspense` or it will fail the build. No hydration mismatch is possible for the same reason — server and client both see the real params.

---

## 3. Implementation

### 3.1 `NavItem` / `NavSection` types

Add one optional field to `NavSection`:

```ts
type NavSection = {
  caption: string;
  items: ReadonlyArray<NavItem>;
  // D7: only this section's items carry the ?party&fa&ban selection.
  carriesAccountsContext?: boolean;
};
```

`NavItem` is unchanged.

### 3.2 `NAV_SECTIONS` — Accounts section

Set `carriesAccountsContext: true` on the Accounts section and reorder `items` per §2.2 (move the Transactions entry from index 2 to index 1). Nothing else in the array changes; Products, Customer and Administration sections are untouched.

### 3.3 Context helper (module-private to `admin-nav.tsx`)

```ts
const CONTEXT_KEYS = ["party", "fa", "ban"] as const; // fixed order (§2.6)

function accountsContextQuery(sp: ReadonlyURLSearchParams): string {
  // `sp.get` returns the FIRST value for a repeated key — matches
  // parseAccountsContext's `first()` helper (§2.3c).
  const ctx = parseAccountsContext({
    party: sp.get("party") ?? undefined,
    fa: sp.get("fa") ?? undefined,
    ban: sp.get("ban") ?? undefined,
  });
  const qs = new URLSearchParams();
  for (const k of CONTEXT_KEYS) if (ctx[k]) qs.set(k, ctx[k]);
  return qs.toString(); // "" when no valid context
}
```

Kept in `admin-nav.tsx` rather than exported: it is nav-render concern, and `parseAccountsContext` remains the only *parser* (code-standards §3.1).

### 3.4 Render wiring

In `AdminNav`: add `const searchParams = useSearchParams();` beside the existing `usePathname()`. Compute the query **once per render**, not per item:

```ts
const ctxQuery = accountsContextQuery(searchParams);
```

Inside the item map, for the `<Link>` branch only:

```ts
const linkHref =
  section.carriesAccountsContext && ctxQuery
    ? `${item.href}?${ctxQuery}`
    : item.href;
```

`<Link href={linkHref}>`. `key`, `isActive`, `aria-current`, `title`, `className` and the locked branch all continue to use `item.href` (§2.4/§2.5).

### 3.5 Test-harness repair — required, not optional

Adding `useSearchParams` breaks every test that renders `AdminNav` against a `next/navigation` mock exposing only `usePathname`. Verified blast radius — **exactly three files**, all of which must gain a `useSearchParams` mock in the same change set:

| File | Why it breaks |
|---|---|
| `tests/components/admin-nav.test.tsx` | Renders `AdminNav` directly (18 tests) |
| `tests/components/admin-sidebar.test.tsx` | Renders `AdminSidebar` → `AdminNav` |
| `tests/app/admin-layout.test.tsx` | Renders the layout → `AdminSidebar` → `AdminNav` |

Extend each existing mock, e.g.:

```ts
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));
```

The ~18 other test files that mock `next/navigation` do **not** render the nav and must not be touched — verified.

### 3.6 New test — `tests/components/admin-nav-accounts-context.test.tsx`

Follows the existing `tests/components/admin-nav.test.tsx` harness (Testing Library + `next/navigation` mock). Descriptive filename per the repo's convention (`vNN-*` is reserved for the V-series; see code-standards §7.1):

- **Order (SC3):** within the Accounts caption, links appear Overview, Transactions, Ledger Explorer, Chart of Accounts, GL Journal; exactly one "Accounts" caption exists.
- **Propagation (SC2):** with `?party=PTRL00000001&fa=FIN000001&ban=BAN000001`, **all five** Accounts hrefs carry all three params — explicitly including Chart of Accounts and GL Journal.
- **Scope:** Products / Customer / Administration hrefs carry **no** context params, including Administration → Accounts Settings (§2.3a).
- **Allowlist:** with `?fa=FIN000001&page=3&transfer=pglt_x&q=foo`, Accounts hrefs carry `fa` only — `page`, `transfer`, `q` are absent (§2.3b).
- **Validation:** `?fa=garbage&party=PTRL00000001` propagates `party` only; the malformed `fa` is dropped (§2.3c).
- **Empty context:** with no params, hrefs are bare pathnames with no trailing `?` (§2.6).
- **Determinism:** given `?ban=…&fa=…&party=…` the emitted query is ordered `party`, `fa`, `ban` (§2.6).
- **Active state (regression for §2.4):** on `/accounts/transactions?fa=FIN000001`, the Transactions item still resolves `aria-current="page"` — the assertion that would fail if query params leaked into `item.href`.
- **Locked items:** an item locked by `requiredPermission` still renders as `<span aria-disabled="true">` with no `href` (§2.5).

### 3.7 Explicitly NOT in this unit

No change to the Transactions page itself (ac19+), no documents table (ac20), no drawer (ac21), no reversal control (ac22). No new permission, migration, table, column, service, repository method, or validation schema. No `Tabs` primitive (D1 — Account Lifecycle is deferred, so no page needs tabs). `ClosurePanel` untouched. No change to the Administration section or to Accounts Settings behaviour. No styling or token change — `acctmgmt-ui-context.md` needs no edit for this unit.

---

## 4. Dependencies (packages to install)

**None — zero new npm packages, zero shadcn components.** `next/navigation`'s `useSearchParams` is already available (Next 16.2.9); `parseAccountsContext` already exists from ac05; `lucide-react` icons are unchanged. The unified `radix-ui` package is already a dependency but is not needed by this unit.

## 5. Verification checklist

**Diff hygiene**

- [ ] Changed: `components/admin-nav.tsx` (types + `NAV_SECTIONS` order + `carriesAccountsContext` flag + helper + `useSearchParams` + `linkHref`); the three test files in §3.5; one new test file in §3.6; `context/accounting-management/acctmgmt-progress-tracker.md` (ac18 complete, Next Up → ac19). **Nothing else.**
- [ ] `NavItem.href` values are still bare pathnames — grep the file for `href: "` and confirm no `?` in any entry (§2.4).
- [ ] Icons, labels, routes and `requiredPermission` values are byte-identical to before; only array order changed.
- [ ] No `TODO`/`console.*`; no `--ai-*` or gradient tokens introduced.

**Build gates**

- [ ] `npm run typecheck` · `npm run lint` · `npm run format:check` · `npm run test` all green.
- [ ] Permission-count assertions **do not move** — this unit adds no permission.

**Behavior — the point of the unit**

- [ ] **SC3:** Transactions is the second item under a single "Accounts" caption.
- [ ] **SC2:** select a customer + FA + BAN in `/accounts/overview`, click **Transactions** in the sidebar → the page opens with the context strip populated and action panels enabled; no return trip to Overview needed.
- [ ] The same round-trip holds via Ledger Explorer, Chart of Accounts and GL Journal — navigate out to GL Journal and back to Transactions; the selection survives (D7).
- [ ] A malformed `?fa=garbage` is not propagated to any nav link.
- [ ] Filter/drawer params (`page`, `transfer`, `q`, `sort`, `account`) are never propagated.
- [ ] Active-state highlighting still works on every Accounts route while context params are present (§2.4 regression).
- [ ] A user lacking `accounts_transactions` still sees Transactions locked, with no `href` and therefore no context leak.

**Invariants**

- [ ] **Inv. #17** holds: `party`/`fa`/`ban` live only in search params — no component state, session storage, cookie or context provider was introduced; every Accounts nav link propagates them.
- [ ] `parseAccountsContext` remains the only parser; no second regex or id-validation path was added (code-standards §3.1).

**Docs in sync**

- [ ] `acctmgmt-progress-tracker.md`: `ac18` complete, "Next Up" → `ac19`.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline (no new route added — DAST surface unchanged).

Any failing item means the unit isn't done. **ac19** (action launcher + dialog shells) is next and depends on this unit only for testability — it restructures `/accounts/transactions` itself, and does not re-open `admin-nav.tsx`.
