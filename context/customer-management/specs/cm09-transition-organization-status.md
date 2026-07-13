# CM09 — Transition Organization Status (EDIT)

- **Unit:** 9 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm08` (edit page container, `OrganizationForm`, `compareAndBumpLock`, `OptimisticLockConflictBanner`), `cm02` (`ORGANIZATION_TRANSITIONS`, `statusTransitionInputSchema`), `cm04` (`OrganizationStatusBadge`).
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* step 8, *Features* ("Customer lifecycle"); `custmgmt-architecture.md` §6 Module Invariant #2; `custmgmt-code-standards.md` §1.3–§1.4, §2.2, §3.3, §4.2; `custmgmt-ui-context.md` §2 ("`StatusTransitionControl` renders only the next-states the transition map allows ... style each offered option with its target status's badge color as a leading swatch/icon"); general `code-standards.md` §4.9 (Radix/shadcn for dropdowns).
- **Note on codebase verification:** no live-repo mount this session. Builds directly on `cm08`'s newly-established (also unverified-against-live-code) optimistic-lock and conflict-banner primitives.

---

## 1. Goal

Add the `transition-organization-status` Server Action + service, and build `StatusTransitionControl` — the one component that ever renders a status dropdown in this module, first consumed here and reused unchanged by `cm10` for the customer entity — wired into `OrganizationForm` (`cm08`). A MANAGER picks one of the organization's valid next-states (computed server-side from `ORGANIZATION_TRANSITIONS`, never hand-authored), supplies a mandatory reason, and saves; every invalid edge or missing reason is rejected server-side even if the UI is bypassed. Visible result: an organization's status progresses along a valid edge (e.g. `REGISTERED → ACTIVE`) with a reason, is audited, and persists `status_reason` on the row; an invalid edge (e.g. `DISSOLVED → ACTIVE`) or a blank reason is rejected regardless of how directly the action is called.

## 2. Design

### 2.1 `StatusTransitionControl` — built once, parameterized by entity kind

Per code-standards §4.2, exactly one component renders any status dropdown in this module. Props:

```ts
interface StatusTransitionControlProps {
  currentStatus: OrganizationStatus | CustomerStatus
  entityKind: 'organization' | 'customer'
  nextStates: readonly (OrganizationStatus | CustomerStatus)[] // precomputed server-side, never imported/derived client-side
  onTransition: (targetStatus: string, statusReason: string) => Promise<
    { ok: true; value: { lastModifiedDatetime: Date } } | { ok: false; code: 'CONFLICT' | 'INVALID_TRANSITION' | 'VALIDATION_ERROR' }
  >
  onConflict: () => void // typically router.refresh()
}
```

1. **`nextStates` is a prop, not computed inside the component** — code-standards §3.3: "Status dropdowns are populated server-side from the transition map for the record's current status." The page/form computes `ORGANIZATION_TRANSITIONS[organization.status]` (or `CUSTOMER_TRANSITIONS[...]`, `cm10`) and passes the result down; `StatusTransitionControl` itself never imports either map — it only renders whatever list it's given. This is a deliberate extra step even though the maps are plain, non-secret TypeScript objects a client component *could* import directly: keeping the computation server-side is the "one source, never two lists kept in sync by hand" rule (code-standards §1.4) applied literally, not just to the validation side.
2. **`nextStates.length === 0` is the terminal-state signal** — no separate `isTerminal` prop. `ORGANIZATION_TRANSITIONS.DISSOLVED`/`.MERGED` and `CUSTOMER_TRANSITIONS.CLOSED` already return empty arrays (`cm02`); the control renders the current-status badge with no dropdown, no reason field, no button underneath when the list is empty — "terminal, nothing further to do here."
3. **Rich `<Select>` options with a leading color swatch, per ui-context §2** — a native `<select>` can't style individual `<option>` elements with icon/color, so this uses shadcn's Radix-based `Select`/`SelectItem` (general code-standards §4.9: Radix/shadcn for dropdowns). Each `SelectItem` renders a small filled dot (`bg-[color:var(--color-{family}-500)]`, matching that target status's badge family from `custmgmt-ui-context.md` §1/§2) + the status label — "the dropdown previews the destination state, not just plain text."
4. **Selecting a target status reveals a mandatory reason field + an Apply button** — nothing submits until both a target and a non-empty reason are present; the Apply button is disabled while either is missing (client-side courtesy; `statusReasonSchema`, `cm02`, is still the actual server-side gate).
5. **Conflict handling reuses `OptimisticLockConflictBanner`** (`cm08`) — a `CONFLICT` result from `onTransition` renders it in place of the dropdown/reason/button, calling `onConflict` (the parent's `router.refresh()`) on click. This is a **separate, independent submit** from `OrganizationForm`'s own field-save button (code-standards §3.6's "contact mutations are separate Server Actions from the org/role update" generalizes here too: a status transition is its own action, with its own lock check, distinct from an organization-field edit even though both live in the same visual card).
6. **`INVALID_TRANSITION`** (submitted directly, bypassing the UI's own filtered options — the UI itself can never construct this request since `nextStates` only ever contains valid edges) renders a generic inline error, not a special banner — this path only matters for defense in depth (code-standards §1.3), a normal user can never trigger it through the rendered control.

### 2.2 Other decisions

1. **`OrganizationForm` (`cm08`) gains one addition**: a `StatusTransitionControl` rendered below the existing fields, `entityKind="organization"`, `currentStatus={organization.status}`, `nextStates={ORGANIZATION_TRANSITIONS[organization.status]}` (computed in the page, per §2.1.1 — threaded through `OrganizationForm` as a prop, or computed directly in the page and passed straight to the control if `OrganizationForm` doesn't otherwise need it; either placement is fine as long as the computation happens server-side).
2. **`status_reason` persists on the `organization` row itself**, in addition to the atomic `AUDIT_LOG` entry (Module Inv. #2/§11, code-standards §6.11) — queryable directly, not only recoverable from audit history.
3. **The lock check is identical to `cm08`'s** — `compareAndBumpLock` against `party_role.last_modified_datetime`, even though this mutation only touches the `organization` table (Module Inv. #6's "even a contact-only edit" logic applies symmetrically to a status-only edit on the org side).

### 2.3 What this unit explicitly does NOT do

No customer (party role) status transition (`cm10` — reuses this exact component, doesn't duplicate it). No new badge (all statuses already have badges from `cm04`). No authz-matrix file (`cm16`).

## 3. Implementation

### 3.1 Repository — `db/repositories/organization.ts` (extend)

```ts
async function updateStatus(
  tx: DrizzleTransaction,
  organizationId: string,
  data: { status: OrganizationStatus; statusReason: string; lastModifiedBy: string },
): Promise<Organization> {
  const [row] = await tx
    .update(organization)
    .set({ ...data, lastModifiedDatetime: new Date() })
    .where(eq(organization.organizationId, organizationId))
    .returning()
  return row
}
```

A narrow, targeted update (status + reason + provenance only) — distinct from `cm08`'s general `update` (organization fields, no status) so neither function can accidentally touch the other's columns.

### 3.2 Validation — `validation/customer/transition-organization-status.schema.ts` (new)

```ts
export const transitionOrganizationStatusSchema = z.object({
  organizationId: organizationIdSchema,
  partyRoleId: partyRoleIdSchema,
  targetStatus: z.enum(ORGANIZATION_STATUSES),
}).merge(statusTransitionInputSchema) // { statusReason, lastModifiedDatetime } from cm02
export type TransitionOrganizationStatusInput = z.infer<typeof transitionOrganizationStatusSchema>
```

### 3.3 Service — `services/customer/transition-organization-status.ts` (new)

```ts
type TransitionOrganizationStatusResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' }
  | { ok: false; code: 'ORGANIZATION_NOT_FOUND' }
  | { ok: false; code: 'INVALID_TRANSITION' }

export async function transitionOrganizationStatus(
  input: TransitionOrganizationStatusInput,
  actorId: string,
): Promise<TransitionOrganizationStatusResult> {
  const before = await organizationRepository.findById(db, input.organizationId)
  if (before === null) return { ok: false, code: 'ORGANIZATION_NOT_FOUND' }

  const allowed = ORGANIZATION_TRANSITIONS[before.status]
  if (!allowed.includes(input.targetStatus)) return { ok: false, code: 'INVALID_TRANSITION' }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(tx, input.partyRoleId, input.lastModifiedDatetime)
    if (bumped === null) return { ok: false, code: 'CONFLICT' }

    const after = await organizationRepository.updateStatus(tx, input.organizationId, {
      status: input.targetStatus,
      statusReason: input.statusReason,
      lastModifiedBy: actorId,
    })

    await writeAuditEvent(tx, {
      eventType: 'ORGANIZATION_STATUS_CHANGED',
      actorUserId: actorId,
      targetEntity: 'ORGANIZATION',
      targetId: input.organizationId,
      beforeData: { status: before.status, statusReason: before.statusReason },
      afterData: { status: after.status, statusReason: after.statusReason },
    })

    return { ok: true, value: { lastModifiedDatetime: bumped } }
  })
}
```

**The transition-edge check runs before the transaction opens** (a pure in-memory check against the already-loaded `before.status`) — an invalid edge never needs a DB round trip to reject, let alone a lock check.

### 3.4 Server Action — `actions/customer/transition-organization-status.ts` (new)

Same shape as `cm08`'s `update-organization.ts` action; `revalidatePath` the edit page (and the search pages, since organization status shows in results).

### 3.5 `components/customers/status-transition-control.tsx` (new, `'use client'`)

Per §2.1. Internal state: `selectedTarget: string | null`, `reason: string`, `submitting: boolean`, `conflict: boolean`. On Apply: call `onTransition(selectedTarget, reason)`; `ok:true` ⇒ reset local state, let `revalidatePath` refresh the badge; `CONFLICT` ⇒ `setConflict(true)`; anything else ⇒ inline error text near the Apply button (not a toast — this is a form-level failure, not a background one).

### 3.6 Guardrail tests owned by this unit

- `tests/services/transition-organization-status.service.test.ts` — every edge in `ORGANIZATION_TRANSITIONS` accepted; every non-edge pair (e.g. `DISSOLVED → ACTIVE`, `MERGED → ACTIVE`, `REGISTERED → SUSPENDED`) rejected with `INVALID_TRANSITION`, checked **before** any transaction/lock call (assert `compareAndBumpLock` not called); `compareAndBumpLock` returning `null` ⇒ `CONFLICT`, no status write, no audit; happy path persists `status_reason` on the row and in the audit `afterData`.
- `tests/validation/transition-organization-status.schema.test.ts` — a blank/whitespace-only `statusReason` fails Zod validation (never reaches the service).
- `tests/components/status-transition-control.test.tsx` — terminal state (`nextStates: []`) renders no dropdown; selecting a target reveals the reason field and Apply button, both required before Apply is enabled; a `CONFLICT` response swaps in `OptimisticLockConflictBanner`; each `SelectItem` renders the correct color swatch per target status.
- **Integration** — every `ORGANIZATION_TRANSITIONS` edge submitted without a `statusReason` is rejected server-side (the guardrail `custmgmt-code-standards.md` §9.3 names explicitly: "every valid transition submitted without `status_reason` is rejected").

### 3.7 Explicitly NOT in this unit

No customer-status transition (`cm10`). No contact mutations. No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None new**, except confirm `@/components/ui/select` (shadcn `Select`) is already added to `components/ui/` from a prior module (Product or User Management likely already use a `<select>`-family control) — if it isn't, add it via the shadcn CLI now (a managed vendor-layer addition, not a new npm dependency; `class-variance-authority`/Radix primitives it depends on are already installed).

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/organization.ts` (extended), `validation/customer/transition-organization-status.schema.ts` (new), `services/customer/transition-organization-status.ts` (new), `actions/customer/transition-organization-status.ts` (new), `components/customers/status-transition-control.tsx` (new), `components/customers/organization-form.tsx` (extended to render the control), the new test files. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] A MANAGER transitions an organization along a valid edge with a reason; the badge and audit trail update.
- [ ] Every invalid edge and every reason-less valid edge is rejected server-side, even via a direct action call bypassing the rendered options.
- [ ] A stale save shows the reload prompt, consistent with `cm08`.
- [ ] Terminal statuses (`DISSOLVED`, `MERGED`) show no dropdown.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm09` complete.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm10` reuses `StatusTransitionControl` unchanged for the customer entity.
