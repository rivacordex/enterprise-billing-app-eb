# CM05 — View Customer: Read-Only Detail Page

- **Unit:** 5 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm04` (selection wiring — the row link that reaches this page, and the guard/parse/`useTransition` conventions this page reuses) and `cm02` (`getCustomerDetail`, `CustomerDetail`/`OrganizationDetail`/`CustomerRoleDetail`/`ContactRow` read models) verified and merged.
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* step 10, *Features* ("Search and viewing" — "three read-only sections," "inconsistency warning banner"); `custmgmt-architecture.md` §2 (`app/(app)/customers/view/` row), §4; `custmgmt-code-standards.md` §3.1, §3.7, §4.1, §4.3, §4.5; `custmgmt-ui-context.md` §3 (`OrganizationTypeBadge`), §4 (`PreferredIndicator`), §5 (`InconsistencyBanner`), §6 (contact-method icons), §7 (mono IDs, fixed section order); platform `architecture.md` §2 (thin orchestrator), §5 (guard); general `code-standards.md` §1.5, §3.6, §3.11.
- **Note on codebase verification:** no live-repo mount this session (as `cm01`–`cm04`). This unit's closest precedent, Product's `pm06` (offering detail section), isn't in this planning folder as a separate spec file the way `pm02`/`pm03`/`pm05` are (only `pm00`, `pm02`–`pm09` exist — `pm06`-`pm09` were read for `cm00`'s build-plan research but not re-read line-by-line here); this spec is built directly from the Customer module's own docs, which are unusually explicit for this page (exact colors/icons in `custmgmt-ui-context.md`, exact component names in `custmgmt-code-standards.md` §7).

---

## 1. Goal

Build `app/(app)/customers/view/[id]/page.tsx` as a thin RSC orchestrator, same `customers:READ` guard as `cm04`, that parses the route param as a `party_role_id`, calls `getCustomerDetail` (`cm02`), and renders the three fixed-order read-only sections — `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection` — plus an `InconsistencyBanner` when the organization's and customer's statuses conflict by the rule this unit defines (§2.2, deferred by `cm02`). An unknown, malformed, or not-found ID renders a "customer not found" state, never a crash. Visible result: opening a search result or a direct `/customers/view/[id]` deep link shows the full read-only profile — organization identity, lifecycle + specification, and contacts with preferred markers — with the mismatch banner firing exactly when the two statuses genuinely conflict.

## 2. Design

### 2.1 Boundary & composition

Frontend only: the RSC page plus five new `components/customers/**` files (three sections, one badge, one indicator, one banner — `custmgmt-code-standards.md` §7's exact names). The page stays a thin orchestrator: guard, parse the `[id]` param, one call to `getCustomerDetail`, compose components — no repository, no raw SQL, no mutation (code-standards §3.7: the three sections "stay server components on the View page").

### 2.2 The `InconsistencyBanner` rule — authored here (deferred by `cm02` §2.2.10)

`cm02` deliberately left "which status combinations count as inconsistent" undecided, since it's a display-only, no-cascade warning (architecture: "warn only, no cascade") rather than a lifecycle rule, and the module docs give exactly one worked example ("ACTIVE customer on a SUSPENDED organization"). This unit fixes the rule, generalized just enough to stay defensible without inventing an opinionated full cross-product matrix:

```ts
export function isStatusInconsistent(
  organizationStatus: OrganizationStatus,
  customerStatus: CustomerStatus,
): boolean {
  // Rule 1 — the overview's literal example, generalized: a billable customer
  // sitting on an organization that isn't in good trading standing.
  if (customerStatus === 'ACTIVE' && organizationStatus !== 'ACTIVE') return true

  // Rule 2 — a terminated organization (DISSOLVED/MERGED) with an engagement
  // that hasn't been wound down (anything other than CLOSED).
  if ((organizationStatus === 'DISSOLVED' || organizationStatus === 'MERGED') && customerStatus !== 'CLOSED') return true

  return false
}
```

- **Rule 1** covers the overview's exact worked example (`ACTIVE` + `SUSPENDED`) and every other non-`ACTIVE` organization status paired with an `ACTIVE` customer — a customer can only be billing "in force" cleanly against a trading organization.
- **Rule 2** covers the case Rule 1 doesn't: an organization that has been dissolved or merged away (terminal, "never physically deleted" but gone in substance) while its customer engagement is still open at any non-terminal status — a different, arguably more severe mismatch than Rule 1's.
- **Deliberately not flagged:** every other pairing (e.g. `INITIALIZED`/`VALIDATED`/`SUSPENDED` customer against a `REGISTERED`/`INACTIVE`/`SUSPENDED` organization) — these are ordinary states of an engagement still being onboarded or paused, not contradictions. Widening this rule later is a design-doc change (architecture §6 territory, since it's describing user-facing lifecycle semantics), not a silent edit to this function.
- This function is exported from `components/customers/inconsistency-banner.tsx` alongside the component itself (the check and its only consumer live together — no separate `lib/` utility for a two-branch, module-specific rule with one caller).
- **Recorded here per workflow §4.4** so no later unit re-derives or silently narrows/widens it — a future unit changing this rule must update this spec and `custmgmt-project-overview.md`'s *Features* section in the same change (docs-in-sync discipline already established by `cm01`–`cm04`).

### 2.3 Other decisions

1. **`[id]` is parsed against `partyRoleIdSchema` (`cm02`, `/^PTRL\d{8}$/`) before anything else.** A malformed param **never reaches `getCustomerDetail`** — it short-circuits straight to the not-found state, saving a DB round trip for garbage input (general code-standards §1.5, parse at the edge). A well-formed-but-unknown ID *does* call `getCustomerDetail`, which returns `null` (`cm02` §2.2.7) — same rendered outcome (not-found), different code path, both tested (§3.6).
2. **One not-found state for the whole page**, not per-section — a customer either exists (all three sections render) or it doesn't (a single "Customer not found" card, no partial page). This mirrors `cm02`'s own "unknown ID ⇒ `null`, no further queries" all-or-nothing contract; there's no scenario where the organization resolves but the role doesn't (the FK guarantees it, `cm01` §3.2).
3. **`OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection` render in fixed order, always** (code-standards §4.5) — Party–Organization, Role–Customer, Customer–Contact Details, top to bottom. This unit implements the mandatory vertical stack; the doc's "optionally side-by-side on `lg:` and up" is exactly that — optional — and is not built in this pass (nothing in the overview or success criteria requires it; revisit only if explicitly requested).
4. **`CustomerRoleSection`'s specification display is read-only, and deliberately does NOT reuse `SpecificationEditor`.** `SpecificationEditor` (code-standards §4.4, ui-context §6) is an edit affordance — a textarea with client-side JSON-parse feedback — built for Manage Customer (`cm07`/`cm08`), not View. This section instead renders `JSON.stringify(specification, null, 2)` in a plain `<pre>` block (`--font-mono`, `--surface-sunken`, ui-context §6's "Default" textarea chrome tokens reused for visual consistency without pulling in an editable component). No client-side interactivity, no parse feedback — there's nothing to parse, it's already a validated object from the service.
5. **`OrganizationTypeBadge` and `PreferredIndicator` are built now, first-consumed here** (same "build at first consumer" precedent `cm04` used for the two status badges): `OrganizationTypeBadge` for `OrganizationSection`'s `organizationType` field; `PreferredIndicator` for `ContactDetailsSection`, used identically at the contact level (marking the one contact `party_role.contact_medium` points to) and the method level (marking `contact_medium.preferred_contact_method`) — code-standards §4.1's "never a different icon per context" is the one rule this component exists to enforce, so both usages import the exact same component, no per-site variant.
6. **Contact method rows use plain inline icons, not a new named component.** `custmgmt-ui-context.md` §6 documents phone/email/address icon+color but doesn't name a shared component for them (unlike the badges/indicator/banner, which code-standards §4 names explicitly) — `Phone`/`Mail`/`MapPin` from `lucide-react` are used inline in `ContactDetailsSection` at `neutral-600`, no color-coding by type (ui-context §6: "none carries status meaning").
7. **`lastModifiedByName` and `lastModifiedDatetime` render on both `OrganizationSection` and `CustomerRoleSection`** (both are already resolved by `cm02`'s `getCustomerDetail`) — formatted via the existing `lib/formatters.formatDatetime(date, locale, timezone)` helper with `locale`/`timezone` resolved server-side and threaded as props (the same `um28`/`um29`-established pattern `pm05` cited — client components never read config directly).
8. **`metadata.title` is the fixed string `"View Customer"`**, not a dynamic per-organization title — `custmgmt-code-standards.md` §3.9 fixes this literally per route group, not per record; this unit follows it as written rather than "improving" it unasked.
9. **No `StatusTransitionControl` anywhere on this page** — that component only ever appears on Manage Customer (`cm09`/`cm10`); View is read-only end to end, statuses render as badges only, never as an editable dropdown.

### 2.4 What this unit explicitly does NOT do

No edit affordance, no CTA, no `actions/customer/*`. No `SpecificationEditor`, `StatusTransitionControl`, or `ContactManagerPanel` (all Manage-only, later units). No side-by-side responsive variant of the three-section stack (§2.3.3). No authz-matrix file (`cm16`). No widening of the `isStatusInconsistent` rule beyond §2.2 without a doc update.

## 3. Implementation

### 3.1 Page — `app/(app)/customers/view/[id]/page.tsx` (new)

```tsx
import type { Metadata } from 'next'

import { requirePermission } from '@/auth/guard'
import { LEVELS, PERMISSIONS } from '@/auth/permission-constants'
import { OrganizationSection } from '@/components/customers/organization-section'
import { CustomerRoleSection } from '@/components/customers/customer-role-section'
import { ContactDetailsSection } from '@/components/customers/contact-details-section'
import { InconsistencyBanner, isStatusInconsistent } from '@/components/customers/inconsistency-banner'
import { getCustomerDetail } from '@/services/customer/get-customer-detail'
import { partyRoleIdSchema } from '@/validation/customer/party-role.schema'
import { getAppLocale, getAppTimezone } from '@/services/system-config/app-config-read.service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'View Customer' }

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ)

  const { id } = await params
  const idResult = partyRoleIdSchema.safeParse(id)

  const detail = idResult.success ? await getCustomerDetail(idResult.data) : null

  if (detail === null) {
    return <CustomerNotFound />
  }

  const [locale, timezone] = await Promise.all([getAppLocale(), getAppTimezone()])
  const inconsistent = isStatusInconsistent(detail.organization.status, detail.customerRole.status)

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">{detail.organization.name}</h1>
        <p className="mt-1 text-body text-muted-foreground">Customer {detail.customerRole.partyRoleId}</p>
      </header>

      {inconsistent && (
        <InconsistencyBanner
          organizationStatus={detail.organization.status}
          customerStatus={detail.customerRole.status}
        />
      )}

      <div className="space-y-6">
        <OrganizationSection organization={detail.organization} locale={locale} timezone={timezone} />
        <CustomerRoleSection customerRole={detail.customerRole} locale={locale} timezone={timezone} />
        <ContactDetailsSection contacts={detail.contacts} />
      </div>
    </main>
  )
}
```

- **Guard first, same as `cm04`.** `idResult.success === false` short-circuits before `getCustomerDetail` is ever called (§2.3.1).
- The page `<h1>` uses the organization's name (a nicety distinct from `metadata.title`, which per §2.3.8 stays the fixed `"View Customer"` string — the visible heading and the `<title>` tag are allowed to differ, only the latter is doc-fixed).
- `CustomerNotFound` is a small local component (or inline JSX) — muted card, `search-x` icon, "Customer not found," a link back to `/customers/view` (mirrors `cm04`'s empty-results-state styling for visual consistency, not a shared component since it's a one-line JSX block, not worth extracting).

### 3.2 `components/customers/organization-section.tsx` (new, Server Component)

Props: `organization: OrganizationDetail`, `locale: string`, `timezone: string`.

Renders a `--surface-card` on `--surface-app`, `--border-default` card (ui-context §7) titled "Party – Organization," with a definition-list-style grid: Name, Trading Name (`—` if null), Type (`OrganizationTypeBadge`), Registration Number (`—` if null, `--font-mono` if present — it's a business identifier, not a sequence ID, but mono keeps it visually distinct from prose per the module's general "mono for identifiers" convention), Tax ID (`—` if null), Industry (`—` if null), Status (`OrganizationStatusBadge`, already built `cm04`), Status Reason (`—` if null), Last Modified By (`lastModifiedByName`), Last Modified (`formatDatetime(lastModifiedDatetime, locale, timezone)`).

### 3.3 `components/customers/customer-role-section.tsx` (new, Server Component)

Props: `customerRole: CustomerRoleDetail`, `locale: string`, `timezone: string`.

Same card treatment, titled "Role – Customer": Customer ID (`partyRoleId`, `--font-mono`), Status (`CustomerStatusBadge`), Status Reason (`—` if null), Account (`customerRole.account ?? '—'`, plain text — display-only per Module Inv. #9, no link, no styling implying it's interactive), Specification — the read-only `<pre>` block (§2.3.4):

```tsx
<pre className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-3 font-mono text-body-sm overflow-x-auto">
  {JSON.stringify(customerRole.specification, null, 2)}
</pre>
```

Last Modified By / Last Modified same as `OrganizationSection`.

### 3.4 `components/customers/contact-details-section.tsx` (new, Server Component)

Props: `contacts: ContactRow[]`.

Card titled "Customer – Contact Details." Empty state (`contacts.length === 0`): "No contacts on file," muted — a brand-new customer has zero contacts until `cm11` ships and a MANAGER adds one; View Customer must render this gracefully, not assume ≥ 1 row.

Otherwise, one row/card per contact:

- Contact name + `contactRole` (`—` if null) as the row header; `<PreferredIndicator />` rendered **next to the name** when `contact.isPreferredContact` (contact-level usage, §2.3.5).
- Phone: `Phone` icon + `phoneNumber` (or nothing if null) + `<PreferredIndicator />` immediately after **only if** `preferredMethod === 'PHONE'` (method-level usage — same component, same icon, per code-standards §4.1).
- Email: `Mail` icon + `emailAddress` (or nothing if null) + `<PreferredIndicator />` iff `preferredMethod === 'EMAIL'`.
- Address: `MapPin` icon + the formatted `address` (`line1`, `line2` if present, `city, stateProvince postalCode`, `country` — standard multi-line postal block; nothing rendered if `address === null`) + `<PreferredIndicator />` iff `preferredMethod === 'ADDRESS'`.
- If a contact has no populated method at all (theoretically only possible before `cm11`'s auto-preferred logic exists, i.e. never in practice once that unit ships, but this section must not crash on it): render "No contact method on file" muted, no `PreferredIndicator` anywhere on that contact.

### 3.5 `components/customers/organization-type-badge.tsx` (new)

`cva`-based, same construction as `cm04`'s status badges, keyed by `OrganizationType`, per `custmgmt-ui-context.md` §3: `COMPANY` → primary family + `building-2` icon; `GOVERNMENT` → cyan-600 family + `landmark` icon. Confirm `--color-cyan-600`/`--color-cyan-700`/`--color-cyan-50` exist in `globals.css` (a new family not yet used by any prior badge in this module or Product's `LifecycleBadge`); add them from the literal hexes in ui-context §3 (`#00899A`/`#006975`/`#E2F8FA`) if missing, never inline hex in the component (code-standards §4.3).

### 3.6 `components/customers/preferred-indicator.tsx` (new)

```tsx
export function PreferredIndicator({ label }: { label?: string }) {
  return (
    <Star
      size={14}
      className="fill-current text-[color:var(--preferred-fg)]"
      aria-label={label ?? 'Preferred'}
    />
  )
}
```

`fill-current` gives the "filled star" look ui-context §4 calls for (lucide icons are stroke-only by default); `--preferred-fg` is the one new CSS variable this unit adds to `globals.css` (`#E6007E` accent-500, per ui-context §4) — **the only accent-scale usage in the whole module** (ui-context §8), so nothing else in Customer Management may reach for this token. `aria-label` since the icon alone conveys no text for assistive tech; an optional `label` prop lets a caller override the generic "Preferred" with "Preferred contact" / "Preferred phone" etc. if a future unit wants more specific announcement text — `cm05`'s two call sites (§3.4) can pass nothing and rely on the generic default, since the surrounding row context (a phone icon next to it, or the contact's name) already disambiguates visually.

### 3.7 `components/customers/inconsistency-banner.tsx` (new)

Exports both `isStatusInconsistent` (§2.2) and the component:

```tsx
export function InconsistencyBanner({
  organizationStatus,
  customerStatus,
}: {
  organizationStatus: OrganizationStatus
  customerStatus: CustomerStatus
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border-l-4 p-3 text-body-sm"
      style={{
        borderColor: 'var(--banner-warning-border)',
        backgroundColor: 'var(--banner-warning-bg)',
        color: 'var(--banner-warning-fg)',
      }}
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        This customer's status (<strong>{customerStatus}</strong>) and its organization's status (
        <strong>{organizationStatus}</strong>) don't line up — this is a warning only; nothing was
        changed automatically.
      </span>
    </div>
  )
}
```

`role="status"` (not `role="alert"`) since this is informational, not an urgent interruption — consistent with "warn only, never blocking/destructive" (ui-context §5). The three `--banner-warning-*` tokens are new additions to `globals.css` from the literal hexes in ui-context §5 (`#E08600` border / `#FEF4E6` bg / `#8A5200` fg — the same warning family already used by `REGISTERED`/`INITIALIZED` badges, so likely already defined; confirm before adding a duplicate).

### 3.8 Guardrail tests owned by this unit

- `tests/app/customers-view-detail-page.test.tsx` — mock `requirePermission`, `getCustomerDetail`:
  - **Guard blocks no-grant.**
  - **Malformed ID short-circuits**: `id: 'not-a-real-id'` → `getCustomerDetail` **not called**, "Customer not found" renders.
  - **Well-formed but unknown ID**: `getCustomerDetail` mocked to `null` → same not-found render, this time *after* the service call (both paths produce the identical visible outcome, per §2.3.2).
  - **Happy path**: a full `CustomerDetail` fixture renders all three section titles and the organization name in the `<h1>`.
- `tests/lib/is-status-inconsistent.test.ts` (or colocated with the banner test) — table-driven over every `(OrganizationStatus, CustomerStatus)` pair relevant to §2.2's two rules: `('SUSPENDED','ACTIVE')` → `true` (the overview's literal example); `('ACTIVE','ACTIVE')` → `false`; `('REGISTERED','ACTIVE')` → `true`; `('DISSOLVED','INITIALIZED')` → `true`; `('DISSOLVED','CLOSED')` → `false`; `('MERGED','SUSPENDED')` → `true`; a handful of "ordinary, not inconsistent" pairs (`('REGISTERED','INITIALIZED')`, `('ACTIVE','SUSPENDED')`, `('INACTIVE','VALIDATED')`) → `false`.
- `tests/components/inconsistency-banner.test.tsx` — renders both statuses in the message; `role="status"` present; icon `aria-hidden`; never renders a destructive/blocking visual treatment (no red/danger classes).
- `tests/components/organization-type-badge.test.tsx` — both types render label + icon, correct classes.
- `tests/components/preferred-indicator.test.tsx` — renders a filled star with the accent color class and an `aria-label`; a passed `label` prop overrides the default.
- `tests/components/contact-details-section.test.tsx` — zero contacts → empty state; a contact with all three methods populated shows exactly one `PreferredIndicator` (next to the method named by `preferredMethod`) plus one more next to the contact's name if `isPreferredContact`; a contact with `address: null` renders no address row and no crash; a contact with no populated method at all renders "No contact method on file" and no `PreferredIndicator` anywhere on that row.
- `tests/components/customer-role-section.test.tsx` — the specification `<pre>` block renders pretty-printed JSON matching `JSON.stringify(spec, null, 2)` exactly (not a compacted single-line dump); `account: null` renders `—`.

No existing test assertions change — new route, new components.

### 3.9 Explicitly NOT in this unit

No Manage Customer page/component (`cm06`+). No `SpecificationEditor`, `StatusTransitionControl`, or `ContactManagerPanel`. No mutation, no `actions/customer/*`. No responsive side-by-side section layout (§2.3.3, optional and deferred). No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.** `lucide-react` (`Star`, `AlertTriangle`, `Phone`, `Mail`, `MapPin`, `Building2`, `Landmark`), `class-variance-authority`, Zod, vitest + Testing Library all already installed. No DB/schema change.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `app/(app)/customers/view/[id]/page.tsx` (new), `components/customers/organization-section.tsx` + `customer-role-section.tsx` + `contact-details-section.tsx` + `organization-type-badge.tsx` + `preferred-indicator.tsx` + `inconsistency-banner.tsx` (all new), any new `globals.css` tokens (`--preferred-fg`, `--color-cyan-*` if missing, `--banner-warning-*` if missing), the new test files. Nothing else.
- [ ] No `services/**`, `db/**`, `actions/**`, `app/api/**` change.
- [ ] Page is a thin orchestrator; no repository/DB import.
- [ ] Guard is the first statement; malformed IDs never reach `getCustomerDetail` (§2.3.1, tested).
- [ ] No `SpecificationEditor` or `StatusTransitionControl` import anywhere in this diff (View is read-only, §2.3.4/§2.3.9).
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] Opening a search result or a direct `/customers/view/<id>` deep link renders all three sections in fixed order with correct data.
- [ ] Malformed and well-formed-but-unknown IDs both render "Customer not found," never a crash or 500.
- [ ] The inconsistency banner appears exactly for the two rules in §2.2 and never for an ordinary status pairing; it never blocks rendering of the sections underneath.
- [ ] `PreferredIndicator` renders identically (same icon, same color) at both the contact-name and the contact-method call sites.
- [ ] A brand-new customer with zero contacts (pre-`cm11`) renders the "No contacts on file" empty state without crashing.
- [ ] The specification block shows pretty-printed JSON exactly as stored (no reformatting/reordering of keys beyond `JSON.stringify`'s default behavior).

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm05` complete and records the `isStatusInconsistent` rule (§2.2) as now-authoritative, cross-linked from `custmgmt-project-overview.md`'s *Features* section if that doc is touched in the same change (recording, not necessarily editing, since the overview's existing wording already permits this generalization — confirm at implementation time whether the overview needs an explicit rule citation or the existing "e.g." example already suffices).

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm06` (Manage Customer search page) is independent and may proceed in parallel (it reuses `cm04`'s components, not `cm05`'s); `cm08` (Manage Customer edit page) will reuse `OrganizationTypeBadge`/`PreferredIndicator`/`InconsistencyBanner` built here.
