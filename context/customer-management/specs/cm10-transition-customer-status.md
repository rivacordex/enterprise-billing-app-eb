# CM10 — Transition Customer Status (EDIT) + Party Role Specification Edit

- **Unit:** 10 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm09` (`StatusTransitionControl`, reused unchanged), `cm08` (edit-page container seam, `compareAndBumpLock` pattern, `OptimisticLockConflictBanner`), `cm02` (`CUSTOMER_TRANSITIONS`, `specification.schema.ts`), `cm07` (`SpecificationEditor`, first built there for create — reused here for edit).
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* step 8, *Features* ("Customer lifecycle", "no skipping VALIDATED"); `custmgmt-architecture.md` §6 Module Invariant #2; `custmgmt-code-standards.md` §1.8 ("`CUST_TYPE`/`CUST_KEY`/`PARTY_TYPE` are free custom values, editable anytime"), §2.2, §4.4; general `code-standards.md` §2.16.
- **Note on codebase verification:** no live-repo mount this session.
- **Scope note, recorded here rather than silently patched into `cm00`:** the build plan's Server Action list (`cm00`, Phase 4 note) names `transition-customer-status` but has no separate unit for editing `party_role_specification` after creation — yet code-standards §1.8 says the specification fields are "editable anytime," and this unit is the first (and, per the file tree, only) place `CustomerRoleForm` gets built. Rather than leave a real, documented editability requirement with no action to fulfill it, **this unit folds in `update-party-role-specification`** as a second, independent mutation alongside the status transition — both live in `CustomerRoleForm`, both are separate Server Actions (code-standards §3.6's "contact mutations are separate from org/role update" logic applied here too: status and specification are separately-submitted concerns, not one combined save).

---

## 1. Goal

Add `transition-customer-status` (reusing `StatusTransitionControl` unchanged, `entityKind="customer"`) and `update-party-role-specification`, both wired into the new `CustomerRoleForm` — the second section added to `cm08`'s edit-page container. A MANAGER progresses a customer's status along a valid `CUSTOMER_TRANSITIONS` edge (no skipping `VALIDATED`) with a reason, and independently edits the specification JSON at any time regardless of status. Visible result: `INITIALIZED → VALIDATED → ACTIVE` succeeds with reasons; `INITIALIZED → ACTIVE` directly is rejected; the specification can be edited and saved independent of any status change, still validated for well-formedness only.

## 2. Design

### 2.1 `CustomerRoleForm` — three independent areas, one card

Read-only fields (`partyRoleId`, `account ?? '—'`, `lastModifiedByName`, `lastModifiedDatetime`) render first, followed by two **separately submitted** mini-forms in the same card:

1. **Status** — `<StatusTransitionControl entityKind="customer" currentStatus={customerRole.status} nextStates={CUSTOMER_TRANSITIONS[customerRole.status]} onTransition={transitionCustomerStatusAction-bound} onConflict={...} />` — the exact component `cm09` built, zero changes, only different bound values (Module Invariant/code-standards §1.4's "one source" claim proven by actually reusing the component for a second entity kind, not just asserting it's possible).
2. **Specification** — `<SpecificationEditor value={specText} onChange={setSpecText} />` (`cm07`) + its own "Save specification" button, independent of the status control. A `CONFLICT` here shows the same `OptimisticLockConflictBanner` (`cm08`), independently of whether the status area also happens to be mid-edit.

Both areas read the **same** `lastModifiedDatetime` prop from the page (the customer role's, already the sole lock value in this module) but submit it as part of two **different** action payloads — a save in one area doesn't require the other to be untouched, but if one save lands first, the other's next attempt will correctly see the now-stale value it was holding and get a `CONFLICT` (this is the correct, expected behavior of one shared lock column serializing all edits within the customer's scope, Module Inv. #6).

### 2.2 The combined compare-and-update — a refinement of `cm08`'s pattern

`cm08`/`cm09`'s mutations touch a **different** table (`organization`) than the lock column's home (`party_role`), so they call `compareAndBumpLock` (bump `party_role`) and then a separate entity write as two statements in one transaction. This unit's two mutations write **directly to `party_role`** — the same row the lock lives on — so the compare-check and the actual data write **collapse into one atomic `UPDATE`**, rather than bumping the lock and then immediately issuing a second `UPDATE` against the row that was just touched:

```ts
async function compareAndUpdateStatus(
  tx: DrizzleTransaction,
  partyRoleId: string,
  expectedLastModifiedDatetime: Date,
  data: { status: CustomerStatus; statusReason: string; lastModifiedBy: string },
): Promise<PartyRole | null> {
  const [row] = await tx
    .update(partyRole)
    .set({ ...data, lastModifiedDatetime: new Date() })
    .where(and(eq(partyRole.partyRoleId, partyRoleId), eq(partyRole.lastModifiedDatetime, expectedLastModifiedDatetime)))
    .returning()
  return row ?? null
}
```

`compareAndUpdateSpecification` is the same shape, setting `partyRoleSpecification` instead of `status`/`statusReason`. Both still satisfy Module Invariant #6 exactly (read-compare-bump `party_role.last_modified_datetime` in the mutation's transaction) — they're just more efficient than calling the cross-table `compareAndBumpLock` primitive and then writing the same row again. **`compareAndBumpLock` itself is untouched** — `cm08`/`cm09` and every contact mutation (`cm11`+) still use it as-is; this unit adds two party-role-specific siblings alongside it, not a replacement.

### 2.3 Other decisions

1. **`account` stays a plain read-only field, no edit path, no FK** (Module Inv. #9) — `CustomerRoleForm` has no form control for it whatsoever, not even a disabled one.
2. **`CUSTOMER_TRANSITIONS`'s "no skipping `VALIDATED`" is enforced by the map itself**, not extra service logic — `INITIALIZED`'s entry is `['VALIDATED', 'CLOSED']`, so `ACTIVE` is never in the allowed set and the same `!allowed.includes(target)` check `cm09` uses rejects it identically. No special-case code for this rule; it falls out of the map's shape.
3. **`status_reason` persists on `party_role` itself**, same as `cm09`'s organization-side rule (Module Inv. #2/§11).
4. **Specification edits write no `status_reason`-style field and need no reason at all** — only status transitions require one (Module Inv. #2 is scoped to "every transition," and a specification edit isn't a lifecycle transition).

### 2.4 What this unit explicitly does NOT do

No contact mutations (`cm11`+). No change to `cm09`'s organization-status code. No shape/key validation added to the specification (still well-formedness only, Inv. #7). No authz-matrix file (`cm16`).

## 3. Implementation

### 3.1 Repository — `db/repositories/party-role.ts` (extend)

Add `compareAndUpdateStatus` and `compareAndUpdateSpecification` (§2.2) alongside `cm08`'s `compareAndBumpLock`, `findById`, `searchByOrganizationNameOrTradingName`.

### 3.2 Validation — two new files

`validation/customer/transition-customer-status.schema.ts`:
```ts
export const transitionCustomerStatusSchema = z.object({
  partyRoleId: partyRoleIdSchema,
  targetStatus: z.enum(CUSTOMER_STATUSES),
}).merge(statusTransitionInputSchema)
```

`validation/customer/update-party-role-specification.schema.ts`:
```ts
export const updatePartyRoleSpecificationSchema = z.object({
  partyRoleId: partyRoleIdSchema,
  specificationRaw: z.string(),
}).merge(optimisticLockSchema)
```

### 3.3 Services — `services/customer/transition-customer-status.ts` and `update-party-role-specification.ts` (new)

```ts
export async function transitionCustomerStatus(input: TransitionCustomerStatusInput, actorId: string): Promise<
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' | 'PARTY_ROLE_NOT_FOUND' | 'INVALID_TRANSITION' }
> {
  const before = await partyRoleRepository.findById(db, input.partyRoleId)
  if (before === null) return { ok: false, code: 'PARTY_ROLE_NOT_FOUND' }
  if (!CUSTOMER_TRANSITIONS[before.status].includes(input.targetStatus)) {
    return { ok: false, code: 'INVALID_TRANSITION' }
  }
  return db.transaction(async (tx) => {
    const after = await partyRoleRepository.compareAndUpdateStatus(tx, input.partyRoleId, input.lastModifiedDatetime, {
      status: input.targetStatus,
      statusReason: input.statusReason,
      lastModifiedBy: actorId,
    })
    if (after === null) return { ok: false, code: 'CONFLICT' }

    await writeAuditEvent(tx, {
      eventType: 'CUSTOMER_STATUS_CHANGED',
      actorUserId: actorId,
      targetEntity: 'PARTY_ROLE',
      targetId: input.partyRoleId,
      beforeData: { status: before.status, statusReason: before.statusReason },
      afterData: { status: after.status, statusReason: after.statusReason },
    })
    return { ok: true, value: { lastModifiedDatetime: after.lastModifiedDatetime } }
  })
}
```

`updatePartyRoleSpecification` mirrors this exactly, substituting `parseSpecificationInput` for the transition-map check (`INVALID_SPECIFICATION` in place of `INVALID_TRANSITION`) and `PARTY_ROLE_SPECIFICATION_UPDATED` for the audit event type.

### 3.4 Server Actions — `actions/customer/transition-customer-status.ts`, `update-party-role-specification.ts` (new)

Same shape as every prior mutation action.

### 3.5 `components/customers/customer-role-section.tsx` → rename/extend to `customer-role-form.tsx`

`cm05`'s `CustomerRoleSection` (View, fully read-only) stays exactly as it is — this unit adds a **new, separate** `customer-role-form.tsx` for Manage (code-standards §7's file tree already lists both as distinct files: `customer-role-section.tsx` read-only and `customer-role-form.tsx` editable). `CustomerRoleForm` composes the read-only fields + `StatusTransitionControl` + the specification mini-form (§2.1); it is what `cm08`'s edit-page seam comment (`{/* cm10 adds <CustomerRoleForm /> here */}`) resolves to.

### 3.6 Guardrail tests owned by this unit

- `tests/services/transition-customer-status.service.test.ts` — every `CUSTOMER_TRANSITIONS` edge accepted; `INITIALIZED → ACTIVE` (skips `VALIDATED`) and every other non-edge rejected with `INVALID_TRANSITION`; `compareAndUpdateStatus` returning `null` ⇒ `CONFLICT`; happy path persists `status_reason` and audits correctly.
- `tests/services/update-party-role-specification.service.test.ts` — malformed JSON ⇒ `INVALID_SPECIFICATION`, no transaction; valid object ⇒ saved and audited (`PARTY_ROLE_SPECIFICATION_UPDATED`); stale lock ⇒ `CONFLICT`.
- `tests/components/customer-role-form.test.tsx` — status area and specification area submit independently (mock both actions, assert calling one doesn't call the other); a `CONFLICT` in either area shows the banner scoped to that area only, not both.
- **Integration** — every `CUSTOMER_TRANSITIONS` edge without `statusReason` rejected (code-standards §9.3's "both maps" requirement, `cm09` already covered the organization side — this closes the customer side).

### 3.7 Explicitly NOT in this unit

No contact mutations. No shape validation on the specification. No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.** All tooling already installed.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/party-role.ts` (extended), `validation/customer/transition-customer-status.schema.ts` + `update-party-role-specification.schema.ts` (new), `services/customer/transition-customer-status.ts` + `update-party-role-specification.ts` (new), `actions/customer/transition-customer-status.ts` + `update-party-role-specification.ts` (new), `components/customers/customer-role-form.tsx` (new), `app/(app)/customers/manage/[id]/page.tsx` (extended — the `cm10` seam resolved), the new test files. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] `INITIALIZED → VALIDATED → ACTIVE` succeeds with reasons at each step; `INITIALIZED → ACTIVE` directly is rejected.
- [ ] The specification can be edited and saved independent of status, and vice versa.
- [ ] A stale save in either area shows the reload prompt without affecting the other area's state.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm10` complete and records the specification-edit scope addition (§ note above) as intentional, not drift.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm11` (add contact) is the next section added to the edit-page container, and the first mutation to prove Module Inv. #6's "even a contact-only edit" clause using the original cross-table `compareAndBumpLock` (not this unit's same-row shortcut, since a contact mutation touches `contact_medium`, not `party_role`, directly).
