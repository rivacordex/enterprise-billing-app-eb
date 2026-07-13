# CM15 — Set Preferred Contact Method (EDIT)

- **Unit:** 15 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm11` (`contact-mutations.ts`, `ContactManagerPanel`, `compareAndBumpLock`), `cm12` (`resolveUpdatedPreferredMethod` — the "preserve unless blocked" logic this unit deliberately does **not** reuse, since it governs a different trigger).
- **Authorizing sections:** `custmgmt-project-overview.md` *Features* ("Contacts and preferred logic"); `custmgmt-architecture.md` Module Invariant #5; `custmgmt-code-standards.md` §3.6, §7.3.
- **Note on codebase verification:** no live-repo mount this session.

---

## 1. Goal

Add `set-preferred-contact-method` — the last of the module's nine mutation actions. A MANAGER explicitly switches a contact's preferred method between two (or three) already-populated methods (e.g. phone → email); the target must already be populated — this action never populates a field or clears one, it only ever repoints the preference among what's already there. Visible result: switching a contact's preferred method between two populated methods succeeds and is audited; attempting to prefer an unpopulated method is rejected with a clear message.

## 2. Design

### 2.1 A narrower, sibling concern to `cm12`'s "preserve unless blocked" logic

`cm12`'s `resolveUpdatedPreferredMethod` answers "what happens to the preferred method when a *field edit* touches it." This unit answers a different question — "the MANAGER explicitly asked to prefer method X" — and needs its own, much simpler validation: is X currently populated on this contact at all?

```ts
function isMethodPopulated(contact: ContactMedium, method: PreferredContactMethod): boolean {
  if (method === 'PHONE') return contact.phoneNumber !== null
  if (method === 'EMAIL') return contact.emailAddress !== null
  return contact.addressLine1 !== null // ADDRESS
}

export async function setPreferredContactMethod(input: SetPreferredContactMethodInput, actorId: string): Promise<
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' | 'CONTACT_NOT_FOUND' | 'METHOD_NOT_POPULATED' }
> {
  const contact = await contactMediumRepository.findById(db, input.contactMediumId)
  if (contact === null || contact.refPartyRole !== input.partyRoleId) {
    return { ok: false, code: 'CONTACT_NOT_FOUND' }
  }
  if (!isMethodPopulated(contact, input.targetMethod)) {
    return { ok: false, code: 'METHOD_NOT_POPULATED' } // Inv. #5 — must name a currently-populated method
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(tx, input.partyRoleId, input.lastModifiedDatetime)
    if (bumped === null) return { ok: false, code: 'CONFLICT' }

    await contactMediumRepository.updatePreferredMethod(tx, input.contactMediumId, input.targetMethod, actorId)

    await writeAuditEvent(tx, {
      eventType: 'PREFERRED_METHOD_CHANGED', actorUserId: actorId, targetEntity: 'CONTACT_MEDIUM',
      targetId: input.contactMediumId,
      beforeData: { preferredContactMethod: contact.preferredContactMethod },
      afterData: { preferredContactMethod: input.targetMethod },
    })

    return { ok: true, value: { lastModifiedDatetime: bumped } }
  })
}
```

1. **`targetMethod` is never `null`.** This action's Zod schema types it as `z.enum(PREFERRED_CONTACT_METHODS)` (no `.nullable()`) — there is no "explicit clear" verb in this module; a contact's preferred method only ever becomes `null` as a side effect of `cm12`'s update-contact clearing the last populated field. Submitting `null` here is a validation error, not a valid "clear" request.
2. **The target-belongs-to-this-party-role check is the same pattern `cm14` uses** for its contact-level equivalent — a clean service-level rejection rather than relying solely on the DB.
3. **No special-casing "already preferred"** — same economy as `cm14`.

### 2.2 What this unit explicitly does NOT do

No clearing verb (§2.1 point 1). No change to `cm11`'s auto-assign or `cm12`'s preserve-unless-blocked logic — this is a third, independent code path triggered only by an explicit user action, not a side effect of anything else.

## 3. Implementation

### 3.1 Repository — `db/repositories/contact-medium.ts` (extend)

```ts
async function updatePreferredMethod(tx: DrizzleTransaction, contactMediumId: string, method: PreferredContactMethod, lastModifiedBy: string): Promise<void> {
  await tx.update(contactMedium).set({ preferredContactMethod: method, lastModifiedBy, lastModifiedDatetime: new Date() }).where(eq(contactMedium.contactMediumId, contactMediumId))
}
```

A narrow update — only this one column plus provenance, distinct from `cm12`'s broader `update` (all contact fields) so neither can accidentally touch the other's scope.

### 3.2 Validation — `validation/customer/set-preferred-contact-method.schema.ts` (new)

```ts
export const setPreferredContactMethodSchema = z.object({
  contactMediumId: contactMediumIdSchema,
  partyRoleId: partyRoleIdSchema,
  targetMethod: z.enum(PREFERRED_CONTACT_METHODS), // never nullable — §2.1.1
}).merge(optimisticLockSchema)
```

### 3.3 Service — `contact-mutations.ts` (extend, final function: `setPreferredContactMethod`)

Per §2.1. This is the last export added to this file — `cm11`–`cm15` together give it `addContact`, `updateContact`, `deleteContact`, `setPreferredContact`, `setPreferredContactMethod`, matching code-standards §7's file tree exactly (five contact operations, one file).

### 3.4 Server Action — `actions/customer/set-preferred-contact-method.ts` (new)

Same shape as every prior mutation action. This is the ninth and final `actions/customer/*.ts` file (`create-customer`, `update-organization`, `transition-organization-status`, `transition-customer-status`, `add-contact`, `update-contact`, `delete-contact`, `set-preferred-contact`, `set-preferred-contact-method`) — the complete set code-standards §7's file tree names.

### 3.5 `ContactManagerPanel` — extend

Each populated, non-preferred method row (phone/email/address) gets a small "Make preferred" affordance, identical in style to `cm14`'s contact-level version but scoped to the method row it sits in; the currently-preferred method's row shows `PreferredIndicator` instead. A method row for an *unpopulated* field never shows this control at all (there's nothing to prefer) — same "omit the control where it can never succeed" philosophy `cm13` used for the delete button.

### 3.6 Guardrail tests owned by this unit

- `tests/services/contact-mutations.service.test.ts` (extend) — switching between two populated methods succeeds and audits correctly; targeting an unpopulated method ⇒ `METHOD_NOT_POPULATED`, no transaction opened; targeting a contact belonging to a different party role ⇒ `CONTACT_NOT_FOUND`; stale lock ⇒ `CONFLICT`.
- `tests/components/contact-manager-panel.test.tsx` (extend) — "Make preferred" appears only on populated, non-preferred method rows; clicking it moves the indicator.

### 3.7 Explicitly NOT in this unit

Nothing further — this closes out the module's mutation surface. `cm16` is the final ship-gate sweep.

---

## 4. Dependencies (packages to install)

**None.**

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/contact-medium.ts` (extended: `updatePreferredMethod`), `validation/customer/set-preferred-contact-method.schema.ts` (new), `services/customer/contact-mutations.ts` (extended: `setPreferredContactMethod`, final export), `actions/customer/set-preferred-contact-method.ts` (new), `components/customers/contact-manager-panel.tsx` (extended), the new test assertions. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] Switching between two populated methods succeeds and is audited.
- [ ] Targeting an unpopulated method is rejected with a clear message.
- [ ] All nine `actions/customer/*.ts` files now exist, matching code-standards §7's file tree exactly.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm15` complete and notes the mutation surface (all nine actions) is now fully built.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm16` — the authz-matrix + full guardrail sweep — is the last unit in the build plan and depends on every one of `cm01`–`cm15`.
