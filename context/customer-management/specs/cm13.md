# CM13 — Delete Contact (The Module's One Physical Delete)

- **Unit:** 13 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm11` (`contact-mutations.ts`, `ContactManagerPanel`, `compareAndBumpLock`), `cm12` (`contactMediumRepository.findById`).
- **Authorizing sections:** `custmgmt-project-overview.md` *Features* ("Contacts and preferred logic" — "deleting the preferred contact is blocked until another is made preferred"); `custmgmt-architecture.md` §3 ("the only rows in this module that are ever physically deleted"), Module Invariants #1, #4; `custmgmt-code-standards.md` §1.2, §6.7 ("the delete repository function must not be callable without that check having passed").
- **Note on codebase verification:** no live-repo mount this session.

---

## 1. Goal

Add `delete-contact` to `contact-mutations.ts` and `ContactManagerPanel` — the module's one sanctioned physical delete. A MANAGER deletes a non-preferred contact (hard-deleted, audited); deleting the currently-preferred contact is blocked with a clear message until another contact is made preferred first. Visible result: a non-preferred contact disappears and is audited as a physical delete; attempting to delete the preferred contact is rejected, not silently allowed.

## 2. Design

### 2.1 The precondition check is the only thing standing between this and a dangling pointer

Module Invariant #4 exists precisely to prevent a customer with contacts from ever dropping to "has contacts but no preferred one." The **only** enforcement point is this service function checking, before any write, whether the target contact is the one `party_role.contact_medium` currently points to:

```ts
export async function deleteContact(input: DeleteContactInput, actorId: string): Promise<
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' | 'CONTACT_NOT_FOUND' | 'CANNOT_DELETE_PREFERRED_CONTACT' }
> {
  const contact = await contactMediumRepository.findById(db, input.contactMediumId)
  if (contact === null) return { ok: false, code: 'CONTACT_NOT_FOUND' }

  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId)
  if (partyRole?.contactMedium === input.contactMediumId) {
    return { ok: false, code: 'CANNOT_DELETE_PREFERRED_CONTACT' }
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(tx, input.partyRoleId, input.lastModifiedDatetime)
    if (bumped === null) return { ok: false, code: 'CONFLICT' }

    await contactMediumRepository.deleteById(tx, input.contactMediumId)

    await writeAuditEvent(tx, {
      eventType: 'CONTACT_DELETED', actorUserId: actorId, targetEntity: 'CONTACT_MEDIUM',
      targetId: input.contactMediumId, beforeData: contact, afterData: null,
    })

    return { ok: true, value: { lastModifiedDatetime: bumped } }
  })
}
```

- **`beforeData` captures the full row** (it's the only record of the contact once deleted, since this is a hard delete — the audit row is the sole historical trace, unlike every other entity in this module where the row itself persists).
- **`deleteById` (`contactMediumRepository`) has no built-in guard of its own** — it is a plain `DELETE FROM contact_medium WHERE contact_medium_id = $1`, per code-standards §6.7's "the delete repository function must not be callable without that check having passed." The safety is entirely procedural: **`deleteContact` (this service function) is the only place in the codebase allowed to call it.** This is enforced by convention + a structural test (§3.3), not a technical barrier the type system provides — worth being explicit about, since it's the one place in this module where "don't call this function directly" is a rule a reviewer has to actually check, not something the compiler catches.
- **No lock predicate needed on the delete itself**, same reasoning as `cm11`/`cm12` — `compareAndBumpLock` already proved freshness and locked the row for the rest of the transaction.

### 2.2 What this unit explicitly does NOT do

No cascading deletion of anything else (a contact delete never touches `organization` or `party_role` beyond the lock bump). No set-preferred actions (`cm14`, and `cm15` outside this batch) — this unit only *blocks* deleting the preferred contact, it doesn't offer a way to reassign preference from within the delete flow itself (the UI directs the user to `cm14`'s "make preferred" control on another contact first).

## 3. Implementation

### 3.1 Repository — `db/repositories/contact-medium.ts` (extend)

```ts
async function deleteById(tx: DrizzleTransaction, contactMediumId: string): Promise<void> {
  await tx.delete(contactMedium).where(eq(contactMedium.contactMediumId, contactMediumId))
}
```

### 3.2 Validation — `validation/customer/delete-contact.schema.ts` (new)

```ts
export const deleteContactSchema = z.object({
  contactMediumId: contactMediumIdSchema,
  partyRoleId: partyRoleIdSchema,
}).merge(optimisticLockSchema)
```

### 3.3 Service + guardrail — `contact-mutations.ts` (extend, add `deleteContact`)

Per §2.1. **Structural test**: `tests/structure/contact-medium-delete-callers.test.ts` — greps the source tree for every reference to `contactMediumRepository.deleteById` and asserts the only match outside its own definition is inside `services/customer/contact-mutations.ts`'s `deleteContact` function. This is the module's one place a plain grep-based guardrail substitutes for a type-system guarantee (code-standards §6.7 named this exact risk).

### 3.4 Server Action — `actions/customer/delete-contact.ts` (new)

Same shape as every prior mutation action. Client confirmation (a destructive-action dialog, "Delete this contact? This cannot be undone.") happens in `ContactManagerPanel` before the action is even called — the one genuinely irreversible action in the whole module deserves the one confirmation dialog in the whole module.

### 3.5 `ContactManagerPanel` — extend

Each **non-preferred** contact gets a "Delete" affordance (destructive-styled button, `Trash2` icon) behind a confirm dialog. The **preferred** contact's row shows no delete control at all — rather than showing a button that always errors, the UI simply omits it where it can never succeed, with a small caption explaining why ("Make another contact preferred to delete this one") so the constraint is visible, not just discoverable by failure. (The server-side check in §2.1 is still the actual guard — Server Actions are public endpoints regardless of what the UI omits, general code-standards §1.2.)

### 3.6 Guardrail tests owned by this unit

- `tests/services/contact-mutations.service.test.ts` (extend) — deleting the currently-preferred contact ⇒ `CANNOT_DELETE_PREFERRED_CONTACT`, no transaction opened, row still present; deleting any non-preferred contact ⇒ succeeds, row gone, `CONTACT_DELETED` audited with the full pre-delete row as `beforeData` and `afterData: null`; stale lock ⇒ `CONFLICT`, row still present.
- The structural caller-check test (§3.3).
- **Integration** — a direct `deleteContactAction` call (bypassing the UI's own button-omission) against the preferred contact is still rejected server-side — proving the omitted button is a UX nicety, not the actual boundary (mirrors this module's now-familiar "the UI reflects the rule, the server enforces it" pattern from `cm03`'s nav lock and `cm06`'s guard).

### 3.7 Explicitly NOT in this unit

No set-preferred actions (`cm14`/`cm15`). No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.**

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/contact-medium.ts` (extended: `deleteById`), `validation/customer/delete-contact.schema.ts` (new), `services/customer/contact-mutations.ts` (extended: `deleteContact`), `actions/customer/delete-contact.ts` (new), `components/customers/contact-manager-panel.tsx` (extended: delete affordance + confirm dialog), the new test files. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] Deleting a non-preferred contact removes it (physically) and audits it with the full before-state.
- [ ] Deleting the preferred contact is blocked, server-side, regardless of whether the UI even offers the control.
- [ ] A confirm dialog gates the delete button in the UI.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm13` complete.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm14` (set preferred contact) gives the MANAGER the actual way to reassign preference before a delete that would otherwise be blocked.
