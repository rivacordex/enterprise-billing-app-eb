# CM07 — Create Customer (Organization + Party Role) + Add-New Page

- **Unit:** 7 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm06` (Manage search page — supplies the "Add new customer" entry point), `cm02` (validation schemas, `organizationRepository`/`partyRoleRepository` read finders to extend), `cm01` (sequences, `registration_number` unique constraint, `customers:EDIT`).
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* steps 3–6, *Features* ("Data integrity and audit" — similar-name warning, registration-number uniqueness); `custmgmt-architecture.md` §2 (`actions/customer/create-customer.ts`, `services/customer/create-customer.ts`), §5 (audit event types: "organization/party_role create"), Module Invariants #7, #8; `custmgmt-code-standards.md` §1.1, §1.8, §2.3, §3.4, §3.6, §4.4, §6.4, §6.8, §6.11, §7 (file tree); `custmgmt-ui-context.md` §6 (`SpecificationEditor`), §7 (`--action-cta-bg`); general `code-standards.md` §1.7, §2.9, §3.4, §6.5, §6.18.
- **Note on codebase verification:** no live-repo mount this session. The mutation/audit/transaction shape below is reconstructed from `um11-spec.md` (Edit user details — the closest verified precedent for "Server Action → service → repository, one transaction, `writeAuditEvent`"), the only difference being this unit **creates** rows (no before-snapshot, no optimistic lock — nothing exists yet to be stale) where `um11` **updates** one.

---

## 1. Goal

Ship the first mutation in the module: `create-customer` (Server Action + service + write-repository functions on `organization`/`party_role`) and `app/(app)/customers/manage/new/page.tsx` (`NewCustomerPage` → `NewCustomerForm`). A MANAGER fills organization fields and a specification JSON payload; the customer is created at the locked initial statuses `REGISTERED`/`INITIALIZED` with `ORG…`/`PTRL…` IDs generated from `cm01`'s sequences, a duplicate `registration_number` is blocked with a clear error, and a similar-name match warns without blocking (resolved as a two-step confirm, §2.2). On success the form redirects to `/customers/manage/[partyRoleId]` (`cm08`, not yet built — accepted interim 404). Visible result: a MANAGER creates a customer that appears in search at `REGISTERED`/`INITIALIZED`; both audit rows (`ORGANIZATION_CREATED`, `CUSTOMER_CREATED`) exist.

## 2. Design

### 2.1 The mutation shape — established here for the whole module

Every mutation unit from here on (`cm07`–`cm15`) follows the same shape, first landed in this unit:

1. **Server Action** (`'use server'`): resolve the principal + confirm `customers:EDIT` via `requirePermission`, parse `rawInput` with a Zod schema (`safeParse`, never trust the client), call exactly one service function, map the service's typed result to an action result, `revalidatePath` the affected route(s). No DB access in the action (general code-standards §3.4/§6.1).
2. **Service** (`services/customer/*`): pure orchestration — validate anything Zod can't express (registration-number/similar-name checks here; optimistic-lock compare-and-bump from `cm08` onward), open one Drizzle transaction, call repository write function(s) + `writeAuditEvent` inside it, return a typed result. Framework-agnostic, no `next/*`.
3. **Repository** (`db/repositories/*`): the only place SQL lives; every write function takes the transaction handle (`tx`) as its first argument, so the caller composes it inside the service's one transaction — never opens its own.
4. **Typed result**, following the established flatter shape (`um11` precedent, not the more abstract `Result<T>`/`AppError` wrapper): `{ ok: true; value: T } | { ok: false; code: '<SPECIFIC_CODE>' }` — a small closed set of string codes per action, not a generic `AppError`.

This unit's result type:

```ts
type CreateCustomerResult =
  | { ok: true; value: { organizationId: string; partyRoleId: string } }
  | { ok: false; code: 'INVALID_SPECIFICATION' }
  | { ok: false; code: 'DUPLICATE_REGISTRATION_NUMBER' }
  | { ok: false; code: 'SIMILAR_NAMES_FOUND'; similarNames: string[] }
  | { ok: false; code: 'FORBIDDEN' }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
```

### 2.2 The similar-name warning — resolved as a two-step confirm

The overview places the "similar names exist, warning shows but does not block" behavior at the *form-filling* step, before "Click Create customer," and doesn't specify the interaction mechanics beyond "warns, doesn't block." This unit resolves it as an explicit **two-step confirm**, all within one action and one form (no separate live/debounced-search endpoint, which isn't otherwise called for anywhere in the docs):

1. First submission (`confirmed: false`, the form's default): the service checks for similar names *before* inserting anything. A match ⇒ returns `{ ok: false, code: 'SIMILAR_NAMES_FOUND', similarNames }` — **nothing is written**. The form renders the matched names in a non-blocking warning and swaps its submit button to **"Create anyway"**, which resubmits the exact same values with `confirmed: true`.
2. `confirmed: true` (either because no similar names existed, or the user explicitly proceeded past the warning): the similar-name check is skipped and the row is created.
3. **The `registration_number` uniqueness check is never skippable** — it's a real DB constraint (`cm01`), checked on every submission (confirmed or not) by catching the unique-violation and mapping it to `DUPLICATE_REGISTRATION_NUMBER`. Blocking here means *actually* blocking — the overview's own wording ("creation is blocked") — unlike the similar-name case.

**Similar-name matching, extension-free** (architecture: no new DB extensions): split the submitted `name` into words ≥ 3 characters (skip noise words like "a"/"of"/"the" only by the length filter — no stopword list, keep it simple), `ILIKE`-escape each word (`cm02`'s established `replace(/[%_\\]/g, '\\$&')` helper) and match against `organization.name` **or** `organization.trading_name`, `LIMIT 5`. This is a real, if simple, SQL filter — not a full-table scan compared in application code — and needs no `pg_trgm`/fuzzy-matching extension. `organizationRepository.findSimilarNames(db, name, excludeOrganizationId)` is written generically (the `excludeOrganizationId` parameter is unused at create time — always `null` here — but is reused as-is by `cm08`'s update-organization, which excludes the record being edited).

### 2.3 Other decisions

1. **Two audit rows, one transaction** — `ORGANIZATION_CREATED` (`targetEntity: 'ORGANIZATION'`) and `CUSTOMER_CREATED` (`targetEntity: 'PARTY_ROLE'`), matching architecture §5's "organization/party_role create & update" (discriminated per entity, not one combined event) and this module's own `create-customer.ts` naming ("create org + role" — two rows, one action file, one transaction).
2. **IDs are DB-generated, never assembled in the service.** The `INSERT ... RETURNING *` from `cm01`'s sequence-backed column defaults is the only place `ORG…`/`PTRL…` values come from (general code-standards §6.18) — the service reads them off the returned row for the audit `targetId` and the action's success `value`.
3. **Initial statuses are never client-supplied.** `organizationFieldsSchema` (`cm02`) has no `status` field at all, and the party-role insert hard-codes `status: 'INITIALIZED'` — there is no code path, not even a malformed direct action call, that can create a customer at any status other than `REGISTERED`/`INITIALIZED` (overview: "no way to pick a different initial status").
4. **`SpecificationEditor` is built now, first consumed here** (code-standards §4.4: "the one component for editing `party_role_specification`... a raw JSON textarea with client-side JSON.parse feedback mirroring the server's well-formedness-only check"). Client-side feedback only *mirrors* `cm02`'s `parseSpecificationInput` — the server call is still the actual gate (general code-standards §1.2, client checks are UX only).
5. **No optimistic lock in this unit.** There is nothing to compare against yet — `party_role.last_modified_datetime` is set once, at insert, by the DB default; the compare-and-bump pattern (Module Inv. #6) starts at `cm08`, the first unit to *edit* an existing row.
6. **Post-create navigation is a client-side `router.push`, not a server `redirect()`.** The action returns the typed result; `NewCustomerForm`'s submit handler calls `router.push(`/customers/manage/${result.value.partyRoleId}`)` on `ok: true` — keeps the action thin and route-shape-agnostic (mirrors `um11`'s pattern of navigation/state handled by the calling component, not baked into the action).
7. **`tradingName`/`registrationNumber`/`taxId`/`industry` are optional** per `cm02`'s `organizationFieldsSchema` — the form renders them as optional fields, no client-side "required" styling on any of the four.

### 2.4 What this unit explicitly does NOT do

No edit of an existing customer (`cm08`). No status transitions (`cm09`/`cm10` — the new customer starts and stays at `REGISTERED`/`INITIALIZED` until a later unit progresses it). No contact creation (`cm11` — overview step 7 happens on the edit page, after this unit's redirect). No optimistic locking. No `StatusTransitionControl` (statuses render as fixed badges here, never a dropdown).

## 3. Implementation

### 3.1 Repository — `db/repositories/organization.ts` (extend `cm02`'s file)

```ts
async function insert(tx: DrizzleTransaction, data: OrganizationInsert): Promise<Organization> {
  const [row] = await tx.insert(organization).values(data).returning()
  return row
}

async function findSimilarNames(
  db: Database,
  name: string,
  excludeOrganizationId: string | null,
): Promise<string[]> {
  const words = name.split(/\s+/).filter((w) => w.length >= 3)
  if (words.length === 0) return []
  const patterns = words.map((w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`)
  // WHERE (name ILIKE ANY(patterns) OR trading_name ILIKE ANY(patterns))
  //   AND ($excludeOrganizationId IS NULL OR organization_id != $excludeOrganizationId)
  // LIMIT 5, projecting a display string: COALESCE(trading_name, name)
}
```

`insert` never sets `organization_id`, `status`, or `last_modified_datetime` — all DB defaults (`cm01`).

### 3.2 Repository — `db/repositories/party-role.ts` (extend `cm02`'s file)

```ts
async function insert(tx: DrizzleTransaction, data: PartyRoleInsert): Promise<PartyRole> {
  const [row] = await tx
    .insert(partyRole)
    .values({ ...data, status: 'INITIALIZED' }) // hard-coded, never from caller input (§2.3.3)
    .returning()
  return row
}
```

`data` carries `engagedParty` (the just-inserted organization's ID), `partyRoleSpecification`, `lastModifiedBy` — never `status` (overwritten regardless of what's passed, belt-and-suspenders against a future caller mistake).

### 3.3 Validation — `validation/customer/create-customer.schema.ts` (new)

```ts
export const createCustomerSchema = organizationFieldsSchema.extend({
  specificationRaw: z.string().default('{}'),
  confirmed: z.boolean().default(false),
})
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>
```

Reuses `organizationFieldsSchema` verbatim (`cm02`) — no re-declared field shape (code-standards §1.4's spirit).

### 3.4 Service — `services/customer/create-customer.ts` (new)

```ts
export async function createCustomer(
  input: CreateCustomerInput,
  actorId: string,
): Promise<CreateCustomerResult> {
  const specResult = parseSpecificationInput(input.specificationRaw)
  if (!specResult.ok) return { ok: false, code: 'INVALID_SPECIFICATION' }

  if (!input.confirmed) {
    const similarNames = await organizationRepository.findSimilarNames(db, input.name, null)
    if (similarNames.length > 0) return { ok: false, code: 'SIMILAR_NAMES_FOUND', similarNames }
  }

  try {
    return await db.transaction(async (tx) => {
      const org = await organizationRepository.insert(tx, {
        name: input.name,
        tradingName: input.tradingName,
        organizationType: input.organizationType,
        registrationNumber: input.registrationNumber,
        taxId: input.taxId,
        industry: input.industry,
        lastModifiedBy: actorId,
        // status defaults 'REGISTERED' at the DB (cm01) — not set here either
      })

      await writeAuditEvent(tx, {
        eventType: 'ORGANIZATION_CREATED',
        actorUserId: actorId,
        targetEntity: 'ORGANIZATION',
        targetId: org.organizationId,
        beforeData: null,
        afterData: org,
      })

      const role = await partyRoleRepository.insert(tx, {
        engagedParty: org.organizationId,
        partyRoleSpecification: specResult.value,
        lastModifiedBy: actorId,
      })

      await writeAuditEvent(tx, {
        eventType: 'CUSTOMER_CREATED',
        actorUserId: actorId,
        targetEntity: 'PARTY_ROLE',
        targetId: role.partyRoleId,
        beforeData: null,
        afterData: role,
      })

      return { ok: true, value: { organizationId: org.organizationId, partyRoleId: role.partyRoleId } }
    })
  } catch (err) {
    if (isUniqueViolation(err, 'organization_registration_number')) {
      return { ok: false, code: 'DUPLICATE_REGISTRATION_NUMBER' }
    }
    throw err // anything else is a genuine, unexpected failure — fail loud (general §1.12)
  }
}
```

`isUniqueViolation(err, constraintName)` is a small `lib/` helper checking a Postgres error's `code === '23505'` and `constraint === constraintName` — introduced here, first needed; reused by `cm08` for the same constraint on update.

### 3.5 Server Action — `actions/customer/create-customer.ts` (new)

```ts
export async function createCustomerAction(rawInput: unknown): Promise<CreateCustomerActionResult> {
  let actorId: string
  try {
    ;({ userId: actorId } = await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT))
  } catch {
    return { ok: false, code: 'FORBIDDEN' }
  }

  const parsed = createCustomerSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const result = await createCustomer(parsed.data, actorId)
  if (result.ok) revalidatePath('/customers/manage')
  return result
}
```

No DB access — delegates entirely to `createCustomer` (§3.4), matching `um11`'s action shape exactly.

### 3.6 Page — `app/(app)/customers/manage/new/page.tsx` (new)

```tsx
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Manage Customer' } // fixed per route group, code-standards §3.9

export default async function NewCustomerPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT)

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Add New Customer</h1>
        <p className="mt-1 text-body text-muted-foreground">
          New customers always start at <strong>Registered</strong> / <strong>Initialized</strong>.
        </p>
      </header>
      <NewCustomerForm />
    </main>
  )
}
```

Thin orchestrator — the guard, then a single client form component. No data fetching (nothing exists yet to fetch).

### 3.7 `components/customers/new-customer-form.tsx` (new, `'use client'`)

Fields (`react-hook-form` + `zodResolver(createCustomerSchema.omit({ confirmed: true }))` — `confirmed` is managed as local component state, not a form field the user fills in):

- **Name** (required text input).
- **Trading Name**, **Registration Number**, **Tax ID**, **Industry** (optional text inputs).
- **Organization Type** (`<select>` — `COMPANY` / `GOVERNMENT`, `ORGANIZATION_TYPES`).
- **Locked status display** — `<OrganizationStatusBadge status="REGISTERED" />` + `<CustomerStatusBadge status="INITIALIZED" />` side by side, captioned "New customers always start here" — **not** inputs, no `StatusTransitionControl` (§2.3 point 3/§2.4).
- **Specification** — `<SpecificationEditor value={specText} onChange={setSpecText} />` (§3.8), defaulting to `'{}'`.
- **Submit button**: "Create customer" normally; becomes **"Create anyway"** (a distinct visual treatment — still `--action-cta-bg`, not a destructive color, since this isn't a dangerous action, just an acknowledged one) once a `SIMILAR_NAMES_FOUND` result has been received for the current field values.

**Submit handler:**

```ts
async function onSubmit(values: OrganizationFields & { specificationRaw: string }) {
  const result = await createCustomerAction({ ...values, confirmed })
  if (result.ok) {
    router.push(`/customers/manage/${result.value.partyRoleId}`)
    return
  }
  if (result.code === 'SIMILAR_NAMES_FOUND') {
    setSimilarNames(result.similarNames)
    setConfirmed(true) // next submit skips the check (§2.2 step 2)
    return
  }
  if (result.code === 'DUPLICATE_REGISTRATION_NUMBER') {
    form.setError('registrationNumber', { message: 'This registration number is already in use.' })
    return
  }
  if (result.code === 'INVALID_SPECIFICATION') {
    setSpecError('Specification must be valid JSON.')
    return
  }
  toast.error('Something went wrong. Please try again.')
}
```

- `similarNames` renders as a dismissible, non-blocking warning list ("Similar customers already exist: ...") above the submit button when non-empty — **dismissing it does not clear `confirmed`**, so the user can still proceed without re-triggering the check (only editing the Name field again resets `confirmed` to `false`, since a changed name invalidates the prior check).
- A `useEffect` on the `name` field's value resets `confirmed` and clears `similarNames` when it changes after a warning was shown — otherwise a user could edit the name to something genuinely unique and still see "Create anyway" for a check that no longer applies.

### 3.8 `components/customers/specification-editor.tsx` (new)

```tsx
export function SpecificationEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const [error, setError] = useState<string | null>(null)

  function handleChange(next: string): void {
    onChange(next)
    try {
      const parsed: unknown = JSON.parse(next)
      setError(
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? null
          : 'Must be a JSON object.',
      )
    } catch {
      setError('Invalid JSON.')
    }
  }

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        rows={6}
        className={cn(
          'w-full rounded-md border bg-[color:var(--surface-sunken)] p-2 font-mono text-body-sm',
          error ? 'border-[color:var(--color-danger-500)]' : 'border-[color:var(--border-default)]',
        )}
        aria-label="Party role specification (JSON)"
        aria-invalid={error !== null}
      />
      {error && (
        <p className="mt-1 text-caption text-[color:var(--color-danger-700)]">{error}</p>
      )}
    </div>
  )
}
```

Client-side parse mirrors `cm02`'s `parseSpecificationInput` (same "object, not array/primitive" rule) but is **never** the actual gate — a client bypass still gets rejected server-side by `createCustomer` (§3.4), general code-standards §1.2. Per ui-context §6, valid JSON gets **no special "success" styling** — the default chrome is the resting state, not a flash.

### 3.9 Guardrail tests owned by this unit

- `tests/services/create-customer.service.test.ts` — mock repositories, `writeAuditEvent`, `db.transaction`:
  - Happy path: both repository inserts called, both audit events written (`ORGANIZATION_CREATED` then `CUSTOMER_CREATED`) with `beforeData: null`; result carries both generated IDs.
  - Invalid specification text ⇒ `INVALID_SPECIFICATION`, no transaction opened, no repository call.
  - `confirmed: false` + `findSimilarNames` returns matches ⇒ `SIMILAR_NAMES_FOUND` with the names, **no transaction opened, nothing written**.
  - `confirmed: false` + no similar names ⇒ proceeds to create normally.
  - `confirmed: true` ⇒ `findSimilarNames` **not called at all**, creation proceeds regardless of what it would have returned.
  - A unique-violation on `registration_number` thrown mid-transaction ⇒ `DUPLICATE_REGISTRATION_NUMBER`, not a raw exception; any other thrown error propagates unmapped (fail loud).
  - Initial status is never taken from `input` — assert the repository `insert` call's `status`/nothing-passed shape directly (structural, guards against a future accidental "status" field leaking through).
- `tests/actions/create-customer.action.test.ts` — no grant ⇒ `FORBIDDEN`, service not called; malformed input ⇒ `VALIDATION_ERROR` with field errors, service not called; success ⇒ `revalidatePath('/customers/manage')` called.
- `tests/components/specification-editor.test.tsx` — valid object text ⇒ no error message; array/primitive/invalid-JSON text ⇒ the matching error message; `onChange` fires on every keystroke regardless of validity (the parent, not this component, decides what to do with an invalid value).
- `tests/components/new-customer-form.test.tsx` — submitting once with a name that triggers `SIMILAR_NAMES_FOUND` shows the warning and relabels the button "Create anyway"; submitting again succeeds without a second similar-name check (assert the second `createCustomerAction` call's `confirmed: true`); editing the name after a warning resets the button label and clears the warning; a `DUPLICATE_REGISTRATION_NUMBER` result surfaces as a field-level error on Registration Number, not a toast.
- **Integration** (`describe.skipIf(!databaseUrl)`) — `tests/db/create-customer.integration.test.ts`: a full create against a real DB produces `ORG…`/`PTRL…`-formatted IDs, `REGISTERED`/`INITIALIZED` statuses, both `AUDIT_LOG` rows with correct `target_entity`/`target_id`, and the row is immediately findable via `cm02`'s `searchCustomers`; a second create with the same `registration_number` fails with `DUPLICATE_REGISTRATION_NUMBER` and leaves no partial rows (transaction rollback proven — count of `organization`/`party_role` rows unchanged after the failed attempt).

### 3.10 Explicitly NOT in this unit

No edit page (`cm08`). No status transitions. No contact creation. No optimistic lock. No `actions/customer/update-organization.ts` or any other mutation file.

---

## 4. Dependencies (packages to install)

**None.** `react-hook-form`, `@hookform/resolvers/zod`, `lucide-react`, `drizzle-orm`, Zod already installed.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/organization.ts` + `party-role.ts` (extended), `validation/customer/create-customer.schema.ts` (new), `services/customer/create-customer.ts` (new), `actions/customer/create-customer.ts` (new), `lib/db-errors.ts`'s `isUniqueViolation` (new, first needed here), `app/(app)/customers/manage/new/page.tsx` + `loading.tsx` + `error.tsx` (new), `components/customers/new-customer-form.tsx` + `specification-editor.tsx` (new), the new test files. Nothing else.
- [ ] No edit to `cm01`–`cm06` files beyond the two named repository extensions.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] A MANAGER creates a customer with a unique name/registration number; it lands at `REGISTERED`/`INITIALIZED` with `ORG…`/`PTRL…` IDs and redirects to the (currently 404) edit page.
- [ ] A duplicate `registration_number` is blocked with a field-level error, no row created.
- [ ] A similar name warns without blocking; "Create anyway" proceeds; editing the name after a warning re-triggers the check on next submit.
- [ ] Invalid specification JSON is rejected both client-side (inline message) and server-side (the actual gate).
- [ ] Both `ORGANIZATION_CREATED` and `CUSTOMER_CREATED` audit rows exist with correct actor/target/after-data.
- [ ] A USER (no `customers:EDIT`) cannot call `createCustomerAction` successfully even with a hand-crafted payload (defense in depth — the guard, not the hidden nav item, is what stops them).

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm07` complete, records the two-step similar-name-confirm design (§2.2) as authoritative.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm08` (edit page + update-organization) is the first unit to read back a created customer and introduces the optimistic-lock compare-and-bump this unit deliberately didn't need.
