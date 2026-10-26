# CM19 — View Customer: Tab Shell (Profile · Contacts · Accounts)

- **Unit:** 19 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** APP.
- **Dependencies:** delivered `cm05` (`app/(app)/customers/view/[id]/page.tsx`, `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection`, `InconsistencyBanner`). No dependency on cm17/cm18; may be built alongside them (`custmgmt-ai-workflow-rules.md` §9.2).
- **Authorizing sections:** binding plan §7.1, D5; the binding update overview (folded into `custmgmt-project-overview.md`) *Core user flow 2*, *Features → View Customer tabs*; `custmgmt-architecture.md` §7.1, §7.2, Inv. #14; `custmgmt-ui-context.md` §9.1; `custmgmt-ai-workflow-rules.md` §9.3 items 8–9, §9.4 items 3–4.
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10.

> **Framing.** View Customer is today one server component that stacks three sections. This unit turns it into three URL-driven tabs without changing any section, the guard, the not-found state, or the banner rule. The Accounts tab is an empty placeholder here; cm20 fills it. The pattern is copied from the bill-run detail page (`app/(app)/billing/bill-runs/[runId]/page.tsx` + `components/billing/run-detail-tabs.tsx`): a Zod-parsed `?tab=` with a lenient fallback, and a server-rendered strip of plain `<Link>`s.

---

## 1. Goal

Render `/customers/view/[id]` as three tabs, **Profile** (Organization + Customer Role), **Contacts** (Contact Details) and **Accounts** (empty placeholder), selected by `?tab=profile|contacts|accounts` (default and fallback `profile`), with the `InconsistencyBanner` above the tab strip on every tab.

## 2. Design

**Structural decisions**

- **URL state on a server component (Inv. #14).** The page reads `searchParams`, parses `tab` with a lenient Zod enum (`.catch("profile")`), and renders only the active tab's content. No `"use client"`, no client tab state, no `components/ui` tabs primitive (none exists; do not add one).
- **Copy the run-detail precedent.** Tab values live in `validation/customer/` (as `RUN_DETAIL_TABS` does in `validation/billing/run-detail.schema.ts`); the strip is a server component of plain `<Link href="?tab=…">` with `aria-current="page"` on the active tab, styled with the exact classes `run-detail-tabs.tsx` uses (`custmgmt-ui-context.md` §9.1).
- **Sections unchanged.** `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection`, `CustomerNotFound`, `metadata.title` and the `isStatusInconsistent` rule are reused as they are (§9.3 item 9).
- **Order on the page:** header (`h1` organization name + "Customer PTRL…") → `InconsistencyBanner` (when inconsistent) → tab strip → active tab panel.
- **Guard-first, all-or-nothing not-found unchanged.** `requirePermission(CUSTOMERS, READ)` still runs first; a malformed or unknown id still renders `CustomerNotFound` without the tab strip. `getCustomerDetail` is still called once per request (it feeds the header and banner on every tab).
- **Accounts placeholder renders nothing** (an empty `div` with an `aria-label`), so cm20 can fill it without touching the shell. The tab link is shown to every viewer; access to its content is decided in cm20 (`accounts_view : READ`).
- **Tab labels:** "Profile", "Contacts", "Accounts". Navigation semantics: `<nav aria-label="Customer detail tabs">`.

## 3. Implementation

### 3.1 Validation — `validation/customer/search-params.schema.ts` (extend)

```ts
// cm19 (custmgmt Inv. #14) — View Customer detail tabs. Lenient: an unknown or
// stale ?tab= falls back to "profile" (run-detail.schema.ts idiom).
export const CUSTOMER_DETAIL_TABS = ["profile", "contacts", "accounts"] as const;
export type CustomerDetailTab = (typeof CUSTOMER_DETAIL_TABS)[number];

export const customerDetailSearchParamsSchema = z.object({
  tab: z.enum(CUSTOMER_DETAIL_TABS).catch("profile"),
});
```

### 3.2 Tab strip — `components/customers/customer-detail-tabs.tsx` (new)

Server component, no data access. Props: `{ activeTab: CustomerDetailTab }`. Renders `<nav aria-label="Customer detail tabs" className="flex gap-1 border-b border-border">` with one `<Link key href={`?tab=${tab}`} aria-current={active ? "page" : undefined}>` per `CUSTOMER_DETAIL_TABS` entry, using the active / inactive class strings from `components/billing/run-detail-tabs.tsx` lines 98–101. Labels from a `Record<CustomerDetailTab, string>`: `profile: "Profile"`, `contacts: "Contacts"`, `accounts: "Accounts"`.

### 3.3 Page — `app/(app)/customers/view/[id]/page.tsx` (extend)

- Signature gains `searchParams: Promise<{ tab?: string | string[] }>`.
- After the not-found check, parse: `const { tab } = customerDetailSearchParamsSchema.parse({ tab: firstValue((await searchParams).tab) });` (`firstValue` from `@/lib/search-params`).
- Replace the `<div className="space-y-6">` section stack with:

```tsx
      <CustomerDetailTabs activeTab={tab} />

      {tab === "profile" && (
        <div className="space-y-6">
          <OrganizationSection … />   {/* props unchanged */}
          <CustomerRoleSection … />   {/* props unchanged */}
        </div>
      )}
      {tab === "contacts" && <ContactDetailsSection contacts={detail.contacts} />}
      {tab === "accounts" && <div aria-label="Accounts" />}{/* filled in cm20 */}
```

- The header and `InconsistencyBanner` block stay above `CustomerDetailTabs`, unchanged.

### 3.4 Tests

**`tests/app/customers-view-detail-page.test.tsx` (rewrite in this unit — regression, CRITICAL).** Every existing call `CustomerDetailPage({ params })` gains `searchParams: Promise.resolve({})` (or a `tab`). Keep the guard, no-access, malformed-id, unknown-id and banner cases. Replace "happy path: renders all three section titles" with:

1. Default (no `tab`): `h1` = organization name; "Party – Organization" and "Role – Customer" render; "Customer – Contact Details" does **not**; the Profile link has `aria-current="page"`.
2. `?tab=contacts`: "Customer – Contact Details" renders; the two Profile section titles do not.
3. `?tab=accounts`: none of the three section titles render; the Accounts link is current.
4. `?tab=bogus` and `?tab=["contacts","profile"]` (array): falls back / takes the first value as `firstValue` does.
5. Banner renders above the strip on `profile`, `contacts` and `accounts` for a conflicting pair, and on none for an ordinary pair.
6. Not-found (malformed and unknown id) renders `CustomerNotFound` with **no** tab strip.

**`tests/components/customer-detail-tabs.test.tsx` (new):** three links with `href` `?tab=profile|contacts|accounts`; exactly one has `aria-current="page"`; labels match.

**`tests/validation/customer-search-params.schema.test.ts` (new or extend):** valid values parse; unknown → `"profile"`; `undefined` → `"profile"`.

### 3.5 Explicitly NOT in this unit

- Any Accounts tab content, read service or permission check for it (cm20).
- Any change to the section components, `getCustomerDetail`, Manage Customer, or the nav registry (the detail route's nav entry is unchanged).

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] `/customers/view/<id>` opens on Profile; Contacts and Accounts tabs switch by `?tab=` and deep-link.
- [ ] Unknown or missing `tab` falls back to Profile; array values take the first value.
- [ ] Banner shows above the strip on every tab for a conflicting status pair, never for an ordinary one.
- [ ] Malformed / unknown id → `CustomerNotFound` without the tab strip; guard still runs first.
- [ ] The page is still a server component; no `"use client"` added; no `components/ui` file added or changed.
- [ ] Section components, `CustomerNotFound`, `metadata.title` unchanged (diff check).
- [ ] Rewritten `customers-view-detail-page.test.tsx` and the new tests green.
- [ ] `npm run typecheck`, `npm run lint`, Prettier clean.
- [ ] Docs in the same change set: `custmgmt-code-standards.md` §4/§7 file tree list `CustomerDetailTabs`; `cm05` spec and `custmgmt-project-overview.md` *Features* describe the tabs (`custmgmt-ai-workflow-rules.md` §9.7 items 2–3); `custmgmt-progress-tracker.md` updated.
