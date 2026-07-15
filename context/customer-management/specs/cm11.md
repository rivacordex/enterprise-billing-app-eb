# CM11 — Add Contact (Auto-Preferred Contact + Auto-Preferred Method)

- **Unit:** 11 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm10` (edit-page container seam, `OptimisticLockConflictBanner`), `cm08` (`compareAndBumpLock`), `cm02` (`contactFieldsSchema`, `ContactRow` read model, `optimisticLockSchema`), `cm01` (the composite deferrable FK — this is the first unit to actually exercise it).
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* step 7, *Features* ("Contacts and preferred logic"); `custmgmt-architecture.md` §3 (`contact_medium` flattened), Module Invariants #4, #5, #6; `custmgmt-code-standards.md` §1.7, §3.6, §6.5–§6.7, §7.3; `custmgmt-ui-context.md` §4 (`PreferredIndicator`), §7 (`--action-cta-bg` for "Add contact").
- **Note on codebase verification:** no live-repo mount this session.

---

## 1. Goal

Add `add-contact` (Server Action + `services/customer/contact-mutations.ts`, the one shared home for all contact-mutation logic per code-standards §7.3) and `ContactManagerPanel` — the third and final section added to `cm08`'s edit-page container. A MANAGER adds a contact with any combination of phone/email/address; the contact auto-becomes the party role's preferred contact **only if it's the first contact ever added**, and its own first-populated method (fixed priority: phone, then email, then address) auto-becomes its preferred method. Visible result: adding a customer's first contact makes it — and its first-filled method — preferred without any separate action; adding a second contact does not disturb the existing preferred contact.

## 2. Design

### 2.1 `contact-mutations.ts` — the one file for all contact-mutation logic

Code-standards §7.3 names this file explicitly as the home for add/update/delete + preferred-pointer maintenance — not one file per action. This unit creates it with `addContact`; `cm12`–`cm15` each add one more exported function to this **same** file (each still gets its own thin `actions/customer/*.ts` orchestrator, per code-standards §3.6 — "separate Server Actions," not separate service files).

### 2.2 Two independent invariants, two independent flags — don't conflate them

Module Invariants #4 and #5 look similar but govern different things and must not be merged into one "preferred" check:

- **#4 — preferred *contact*** (`party_role.contact_medium`, which contact is "the" preferred one for this customer): auto-set **only when the party role currently has zero contacts** — i.e., this is genuinely the first one ever added. A second, third, etc. contact never touches this pointer.
- **#5 — preferred *method*** (`contact_medium.preferred_contact_method`, which of phone/email/address is preferred *for this one contact*): auto-set on **every** contact add, independent of whether it's the customer's first contact — evaluated per-contact, from that contact's own populated fields only, never looking at sibling contacts.

A contact can be preferred-contact **and** have no preferred method (name-only, nothing populated yet) — both are valid, independently-tracked states (§2.3 below explicitrly allows a contact with zero populated methods).

### 2.3 "First populated method" — a fixed priority order, decided here

The overview narrates a temporal "first method filled" (a user typing into fields one at a time), but this unit's form submits all fields in one request — there's no server-visible ordering signal from a single POST. This unit resolves it as **the fixed priority `PHONE → EMAIL → ADDRESS`**: whichever of the three is populated, checked in that order, becomes the preferred method; if none are populated, `preferredContactMethod` stays `null` (Module Inv. #5 permits this — "NULL iff no method is populated"). This is a one-time decision at creation; changing which method is preferred *later*, or across an edit that adds a second method, is `cm12`/`cm15`'s concern, not this unit's.

### 2.4 The composite deferrable FK, exercised for the first time

`cm01`'s `party_role.contact_medium → contact_medium(contact_medium_id, ref_party_role)` composite FK (`DEFERRABLE INITIALLY DEFERRED`) exists precisely for this moment: setting the preferred-contact pointer requires the contact row to already exist with `ref_party_role` equal to *this* party role. This unit's transaction order is therefore fixed: (1) lock-check, (2) insert the contact row (gets its ID), (3) *if first contact*, point `party_role.contact_medium` at that ID. Because the whole sequence is one transaction, no cross-transaction race is possible, and the deferred FK only needs to hold at `COMMIT` — it never blocks the intermediate insert.

### 2.5 The pointer update needs no second lock check

Once `compareAndBumpLock` succeeds inside a transaction, the `party_role` row is locked for the remainder of that transaction (standard Postgres row-level locking) — a second, later write to the same row within the *same* transaction (step 3 above) doesn't need to re-check `last_modified_datetime` again; a plain, unconditional `UPDATE ... WHERE party_role_id = $1` suffices and is not a weaker guarantee than re-checking, since nothing else could have touched the row in between. This is a deliberate simplification versus `cm10`'s "combine lock-check and write into one statement" pattern — that pattern fit `cm10` because both target the *same* write in a single step; here the second `party_role` write depends on data (the new contact's ID) that doesn't exist until after an intervening insert to a different table, so it's naturally a separate, later statement, and doesn't need its own lock predicate.

### 2.6 Other decisions

1. **`ContactManagerPanel` is built now, showing existing contacts + one "Add contact" form** — the first version of this component; `cm12`–`cm15` each add their own control (edit, delete, set-preferred-contact, set-preferred-method) to it incrementally, same "grow the container" approach `cm08`–`cm10` used for the page itself.
2. **"Add contact" uses `--action-cta-bg`** (ui-context §7), the same token `cm06`'s "Add new customer" button introduced — not redefined.
3. **No cross-field requirement that at least one method be populated.** A contact can be name-only (code-standards §6.5's "max one phone/email/address per row" caps, it doesn't floor). `contactFieldsSchema` (`cm02`) already allows this — nothing new needed here.
4. **`PreferredIndicator`** (`cm05`) marks the new contact and/or its auto-preferred method identically to how View Customer renders it — same component, no variant.

### 2.7 What this unit explicitly does NOT do

No contact update/delete/set-preferred (`cm12`–`cm15`, each extends this same file and panel). No change to `cm08`/`cm09`/`cm10`'s organization/status code. No authz-matrix file (`cm16`).

## 3. Implementation

### 3.1 Repository — `db/repositories/contact-medium.ts` (extend `cm02`'s file)

```ts
async function insert(tx: DrizzleTransaction, data: ContactMediumInsert): Promise<ContactMedium> {
  const [row] = await tx.insert(contactMedium).values(data).returning()
  return row
}
```

### 3.2 Repository — `db/repositories/party-role.ts` (extend)

```ts
async function setPreferredContact(tx: DrizzleTransaction, partyRoleId: string, contactMediumId: string): Promise<void> {
  await tx.update(partyRole).set({ contactMedium: contactMediumId }).where(eq(partyRole.partyRoleId, partyRoleId))
}
```

No lock predicate (§2.5) — called only after `compareAndBumpLock` already succeeded in the same transaction.

### 3.3 Validation — `validation/customer/add-contact.schema.ts` (new)

```ts
export const addContactSchema = contactFieldsSchema.extend({
  partyRoleId: partyRoleIdSchema,
}).merge(optimisticLockSchema)
export type AddContactInput = z.infer<typeof addContactSchema>
```

### 3.4 Service — `services/customer/contact-mutations.ts` (new)

```ts
function resolvePreferredMethod(input: ContactFields): PreferredContactMethod | null {
  if (input.phoneNumber !== null) return 'PHONE'
  if (input.emailAddress !== null) return 'EMAIL'
  if (input.addressLine1 !== null) return 'ADDRESS'
  return null
}

export async function addContact(
  input: AddContactInput,
  actorId: string,
): Promise<
  | { ok: true; value: { contactMediumId: string; lastModifiedDatetime: Date } }
  | { ok: false; code: 'CONFLICT' | 'PARTY_ROLE_NOT_FOUND' }
> {
  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId)
  if (partyRole === null) return { ok: false, code: 'PARTY_ROLE_NOT_FOUND' }

  const existingContacts = await contactMediumRepository.findByPartyRoleId(db, input.partyRoleId)
  const isFirstContact = existingContacts.length === 0
  const preferredContactMethod = resolvePreferredMethod(input)

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(tx, input.partyRoleId, input.lastModifiedDatetime)
    if (bumped === null) return { ok: false, code: 'CONFLICT' }

    const contact = await contactMediumRepository.insert(tx, {
      refPartyRole: input.partyRoleId,
      contactName: input.contactName,
      contactRole: input.contactRole,
      phoneNumber: input.phoneNumber,
      emailAddress: input.emailAddress,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      stateProvince: input.stateProvince,
      postalCode: input.postalCode,
      country: input.country,
      preferredContactMethod,
      lastModifiedBy: actorId,
    })

    await writeAuditEvent(tx, {
      eventType: 'CONTACT_CREATED',
      actorUserId: actorId,
      targetEntity: 'CONTACT_MEDIUM',
      targetId: contact.contactMediumId,
      beforeData: null,
      afterData: contact,
    })

    if (isFirstContact) {
      await partyRoleRepository.setPreferredContact(tx, input.partyRoleId, contact.contactMediumId)
      await writeAuditEvent(tx, {
        eventType: 'PREFERRED_CONTACT_CHANGED',
        actorUserId: actorId,
        targetEntity: 'PARTY_ROLE',
        targetId: input.partyRoleId,
        beforeData: { preferredContactId: null },
        afterData: { preferredContactId: contact.contactMediumId },
      })
    }

    return { ok: true, value: { contactMediumId: contact.contactMediumId, lastModifiedDatetime: bumped } }
  })
}
```

`existingContacts` and `partyRole` are both loaded **before** the transaction (plain reads, `cm08`/`um11` precedent) — the transaction itself contains only the writes.

### 3.5 Server Action — `actions/customer/add-contact.ts` (new)

Same shape as every prior mutation action; `revalidatePath` the edit page.

### 3.6 `components/customers/contact-manager-panel.tsx` (new, `'use client'`)

Renders the current `contacts: ContactRow[]` (same shape `cm05`'s `ContactDetailsSection` consumes, reused verbatim from `getCustomerDetail`) using the same per-contact layout `cm05` established (name + role, phone/email/address rows with icons, `PreferredIndicator` at the contact level and per-method) — **this unit does not fork that rendering**, it composes the same visual pattern for the Manage context, since View's version is read-only JSX with no controls, and Manage's needs edit/delete affordances `cm12`/`cm13` will add. Below the list: an "Add contact" button (`--action-cta-bg`) revealing an inline add form (`contactFieldsSchema` fields) with Save/Cancel; Save calls `addContactAction`, handling `CONFLICT` via `OptimisticLockConflictBanner` like every other mutation UI in this module.

### 3.7 `app/(app)/customers/manage/[id]/page.tsx` — seam resolved

The `{/* cm11 adds <ContactManagerPanel /> here */}` comment from `cm08` becomes:

```tsx
<ContactManagerPanel
  partyRoleId={detail.customerRole.partyRoleId}
  contacts={detail.contacts}
  lastModifiedDatetime={detail.customerRole.lastModifiedDatetime}
/>
```

### 3.8 Guardrail tests owned by this unit

- `tests/services/contact-mutations.service.test.ts` (`addContact`) — first contact for a party role with zero existing contacts ⇒ `party_role.contact_medium` set to the new contact, `PREFERRED_CONTACT_CHANGED` audited; a second contact added to a party role that already has one ⇒ the pointer **untouched**, no `PREFERRED_CONTACT_CHANGED` event at all; `resolvePreferredMethod` priority proven for every combination (phone-only ⇒ `PHONE`; phone+email ⇒ `PHONE`; email-only ⇒ `EMAIL`; email+address ⇒ `EMAIL`; address-only ⇒ `ADDRESS`; nothing populated ⇒ `null`); stale lock ⇒ `CONFLICT`, no contact row inserted, no pointer change.
- `tests/components/contact-manager-panel.test.tsx` — the add-contact form's fields match `contactFieldsSchema`; submitting with only a name (no methods) succeeds and shows "No contact method on file" (`cm05`'s existing empty-method rendering, reused); a `CONFLICT` shows the banner.
- **Integration** (`describe.skipIf(!databaseUrl)`) — `tests/db/add-contact.integration.test.ts`: adding a contact to a brand-new customer (zero contacts) results in `party_role.contact_medium` pointing at the new row and the composite FK holding (`ref_party_role` matches); a `party_role.contact_medium` pointer to a contact owned by a *different* party role is provably impossible to construct through this code path (the FK, `cm01`, is what makes it structurally impossible — this test re-confirms it end to end through the service, not just raw SQL as `cm01`'s own test already did).

### 3.9 Explicitly NOT in this unit

No update/delete/set-preferred (`cm12`–`cm15`). No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.** All tooling already installed.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `db/repositories/contact-medium.ts` + `party-role.ts` (extended), `validation/customer/add-contact.schema.ts` (new), `services/customer/contact-mutations.ts` (new, `addContact` only), `actions/customer/add-contact.ts` (new), `components/customers/contact-manager-panel.tsx` (new), `app/(app)/customers/manage/[id]/page.tsx` (extended — `cm11` seam resolved), the new test files. Nothing else.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] A customer's first contact auto-becomes preferred; a second contact does not disturb it.
- [ ] A contact's first-populated method (phone > email > address priority) auto-becomes preferred; a name-only contact has no preferred method and doesn't crash any rendering.
- [ ] A stale save is rejected with the reload prompt; no partial write (contact inserted but pointer half-updated) is ever observable.

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm11` complete, records the fixed phone>email>address priority (§2.3) as authoritative.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline.

Any failing item means the unit isn't done. `cm12` (update contact), `cm13` (delete contact), `cm14` (set preferred contact), and `cm15` (set preferred contact method, not covered by this pass) all extend `contact-mutations.ts` and `ContactManagerPanel` built here.
