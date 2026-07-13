# CM14 — Set Preferred Contact (EDIT)

- **Unit:** 14 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm11` (`contact-mutations.ts`, `ContactManagerPanel`, `compareAndBumpLock`, `partyRoleRepository.setPreferredContact`), `cm13` (the delete-blocked case this action is the escape hatch for).
- **Authorizing sections:** `custmgmt-project-overview.md` *Features* ("Contacts and preferred logic"); `custmgmt-architecture.md` Module Invariant #4; `custmgmt-code-standards.md` §3.6, §7.3.
- **Note on codebase verification:** no live-repo mount this session.

---

## 1. Goal

Add `set-preferred-contact` — the explicit reassignment path, distinct from `cm11`'s auto-assign-on-first-contact logic. With ≥ 2 contacts on a customer, a MANAGER explicitly re-picks which one is preferred; `PreferredIndicator` moves to the new selection and the change is audited. This is also the action that unblocks `cm13`'s delete-blocked case: reassign preference away from a contact, then delete it.

## 2. Design

### 2.1 This reuses `cm11`'s pointer-write function; only the caller and audit framing differ

`partyRoleRepository.setPreferredContact` (`cm11`) already does exactly the write this action needs — no new repository function. What's different from `cm11`'s auto-assignment is entirely in the service layer: this is a **user-initiated** reassignment among *existing* contacts, not a side effect of adding the first one, so it validates the target belongs to the customer and always records the *before* pointer (which `cm11`'s creation path never has, since there's nothing to reassign *from* on a brand-new customer).

```ts
export async function setPreferredContact(input: SetPreferredContactInput, actorId: string): Promise<
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' | 'PARTY_ROLE_NOT_FOUND' | 'CONTACT_NOT_FOUND' }
> {
  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId)
  if (partyRole === null) return { ok: false, code: 'PARTY_ROLE_NOT_FOUND' }

  const target = await contactMediumRepository.findById(db, input.contactMediumId)
  if (target === null || target.refPartyRole !== input.partyRoleId) {
    return { ok: false, code: 'CONTACT_NOT_FOUND' } // belongs to a different customer, or doesn't exist
  }

  const previousContactId = partyRole.contactMedium

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(tx, input.partyRoleId, input.lastModifiedDatetime)
    if (bumped === null) return { ok: false, code: 'CONFLICT' }

    await partyRoleRepository.setPreferredContact(tx, input.partyRoleId, input.contactMediumId)

    await writeAuditEvent(tx, {
      eventType: 'PREFERRED_CONTACT_CHANGED', actorUserId: actorId, targetEntity: 'PARTY_ROLE',
      targetId: input.partyRoleId,
      beforeData: { preferredContactId: previousContactId },
      afterData: { preferredContactId: input.contactMediumId },
    })

    return { ok: true, value: { lastModifiedDatetime: bumped } }
  })
}
```

1. **`target.refPartyRole !== input.partyRoleId` is checked in the service, not left to the DB's composite FK to reject.** The FK (`cm01`) makes a cross-customer pointer *structurally* impossible regardless, but a service-level check here produces a clean `CONTACT_NOT_FOUND` result instead of a raw constraint-violation error bubbling up (same "validate before you rely on the DB to reject" philosophy `cm07` used for `registration_number`, except here it's belt-and-suspenders on top of a guarantee that already exists, not the sole enforcement).
2. **No special-casing "already preferred."** Reassigning to the contact that's already preferred is a harmless no-op write — this unit doesn't short-circuit it (consistent with `um11`'s precedent of not special-casing "nothing actually changed" either); it still bumps the lock and writes an audit row with identical before/after values, which is a faithful (if uninteresting) record of the action having been invoked.
3. **`previousContactId` can be `null`** in the odd case a party role somehow has a contact but no preferred pointer set (shouldn't happen given `cm11`'s guarantees, but the type allows it, so the code handles it rather than assuming) — the audit `beforeData` just reflects whatever was actually there.

### 2.2 What this unit explicitly does NOT do

No preferred-*method* reassignment (`set-preferred-contact-method`, outside this batch). No change to `cm11`'s auto-assign-on-first-contact behavior. No authz-matrix file (`cm16`).

## 3. Implementation

### 3.1 Validation — `validation/customer/set-preferred-contact.schema.ts` (new)

```ts
export const setPreferredContactSchema = z.object({
  contactMediumId: contactMediumIdSchema,
  partyRoleId: partyRoleIdSchema,
}).merge(optimisticLockSchema)
```

### 3.2 Service — `contact-mutations.ts` (extend, add `setPreferredContact`)

Per §2.1.

### 3.3 Server Action — `actions/customer/set-preferred-contact.ts` (new)

Same shape as every prior mutation action.

### 3.4 `ContactManagerPanel` — extend

Each **non-preferred** contact gets a "Make preferred" affordance (a plain button, `Star` icon, not destructive-styled — this is a reversible, low-stakes action unlike delete) calling `setPreferredContactAction`. The currently-preferred contact shows `PreferredIndicator` instead of the button (nothing to reassign to itself). A `CONFLICT` shows the same `OptimisticLockConflictBanner` every other mutation in this panel already uses.

### 3.5 Guardrail tests owned by this unit

- `tests/services/contact-mutations.service.test.ts` (extend) — reassigning among two existing contacts moves the pointer and audits `beforeData`/`afterData` correctly; reassigning to a contact belonging to a **different** party role ⇒ `CONTACT_NOT_FOUND`, no write (proving the service-level check catches what the FK would also catch, cleanly); reassigning to the already-preferred contact still succeeds as a no-op-value write (bump + audit still happen); stale lock ⇒ `CONFLICT`.
- `tests/components/contact-manager-panel.test.tsx` (extend) — "Make preferred" renders only on non-preferred contacts; clicking it moves `PreferredIndicator` after a successful response.

### 3.6 Explicitly NOT in this unit

No preferred-method reassignment. No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.**

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `validation/customer/set-preferred-contact.schema.ts` (new), `services/customer/contact-mutations.ts` (extended: `setPreferredContact`), `actions/customer/set-preferred-contact.ts` (new), `components/customers/contact-manager-panel.tsx` (extended: "Make preferred" affordance), the new test assertions. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] With ≥ 2 contacts, a MANAGER explicitly reassigns the preferred contact; the indicator moves and the change is audited with correct before/after.
- [ ] Reassigning to a contact belonging to a different customer is rejected with a clean error, never a raw DB constraint error surfacing to the UI.
- [ ] This action is what unblocks `cm13`'s "cannot delete the preferred contact" case in practice — reassign, then delete succeeds.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm14` complete.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `set-preferred-contact-method` (`cm15`, outside this batch) and the final authz-matrix + guardrail sweep (`cm16`) remain.
