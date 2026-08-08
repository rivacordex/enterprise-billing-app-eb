# AC24 — Correct Entry Date / Reference Date Field Mapping & Column Name

- **Unit:** 24 (`ac00-build-plan.md` Part 3 — not part of the original 17-unit build or the ac18–ac23 Transactions revision)
- **Dependencies:** `ac07` (introduces `documentBaseSchema` and the Q29 field trio), `ac14` (the re-date recovery UX that corrects `event_at` into an open period), `ac21` (document detail drawer — read surface carrying the bug), `ac22` (row-level reversal dialog — the most recently shipped surface carrying the bug). All four delivered. In practice this touches every unit that shares `documentBaseSchema` (`ac07`–`ac11`), since the schema is merged into each operation's own Zod schema.
- **Authorizing sections:** `_change-entry-date-reference-date-columns.md` (full investigation: file census, occurrence counts, migration risk analysis); `acctmgmt-project-overview.md` §Transactions (documents) — the Q29 field description; `acctmgmt-architecture.md` §3 storage-model table (`billing.document` row) and §6 Inv. #7 (closed-period rejection, unaffected); `ac00-build-plan.md` Part 3 (why this is one unit, not several, and what's deliberately excluded); platform `architecture.md` §1 (Drizzle/Postgres/Next.js stack — no new technology needed) and §7 Inv. #18 (financially-significant-row immutability — this change renames a column, it does not mutate or replace any row, so Inv. #18 does not apply).

---

## 1. Goal

`billing.document` has always had two correctly-implemented but mislabeled date fields: `event_at` (drives period validation and GL-journal grouping) is captioned "Entry Date" in every capture form, and the inert, user-entered `reference_date` is captioned "Reference Date" — backwards from what each field actually does. This unit swaps both UI captions to match each field's real behavior and renames `reference_date` → `entry_date` so the column name matches its corrected caption going forward, with zero change to `event_at`'s type, name, or role in period/GL logic.

## 2. Design

### 2.1 The mapping, before and after

| Column | Behavior (unchanged by this unit) | Caption today (wrong) | Caption after this unit |
|---|---|---|---|
| `event_at` | The document's true business-event date. Drives period validation and GL-journal grouping (`to_char(event_at, 'YYYY-MM')`). Backdatable; a closed-period value is rejected (`PERIOD_CLOSED`, Inv. #7). | "Entry Date" | **"Reference Date"** |
| `reference_date` → renamed **`entry_date`** | Manually entered, defaults to today. Not used by period validation or GL grouping; selected only for read-only display (the document detail drawer). | "Reference Date" | **"Entry Date"** |

### 2.2 Visual decision: captions swap, field position does not

Each of the 11 write panels/dialogs renders the pair as two adjacent `<Field>`s in a fixed two-column grid (`event_at` first/left, `reference_date` second/right). This unit swaps only the `<FieldLabel>` text and which state variable each input is bound to — **the DOM position of each field stays exactly where it is.** Reordering the fields (so "Entry Date" visually leads) was considered and rejected: it adds a DOM/layout diff for zero functional benefit, and the field that drives period/GL (`event_at`, now captioned "Reference Date") staying in the primary/first position is a reasonable default.

Before (every panel, e.g. `capture-payment-panel.tsx`):
```tsx
<div className="grid grid-cols-2 gap-3">
  <Field>
    <FieldLabel>Entry Date</FieldLabel>
    <Input type="date" value={eventAt} onChange={(e) => setEventAt(e.target.value)} />
  </Field>
  <Field>
    <FieldLabel>Reference Date</FieldLabel>
    <Input type="date" value={referenceDate} onChange={(e) => setReferenceDate(e.target.value)} />
  </Field>
</div>
```

After:
```tsx
<div className="grid grid-cols-2 gap-3">
  <Field>
    <FieldLabel>Reference Date</FieldLabel>
    <Input type="date" value={eventAt} onChange={(e) => setEventAt(e.target.value)} />
  </Field>
  <Field>
    <FieldLabel>Entry Date</FieldLabel>
    <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
  </Field>
</div>
```

`document-detail-drawer.tsx` (read-only) gets the same caption swap on its display pair, without touching the unrelated `transfer.eventAt` shown elsewhere in the same drawer (a different table — ledger transfer detail).

### 2.3 Structural decision: rename the column, don't add a new one

Considered and rejected: leaving `reference_date` in place (unused) and adding a new `entry_date` column. Rejected because it produces a permanently dead column, requires backfilling `entry_date` for every already-posted document, and costs the same 40+ file touch as a straight rename for no benefit. Decision: `ALTER TABLE ... RENAME COLUMN`, which is data-preserving and leaves exactly two date columns on `document`, as today.

### 2.4 Structural decision: single atomic unit, not split by layer

Migration, schema, services, and components cannot ship independently — a schema-only change breaks `typecheck` until every consumer is updated, and components can't be updated first because the Zod schema would reject their renamed field. There is no valid intermediate state, unlike the independently-shippable `ac18`–`ac23` slices. See `ac00-build-plan.md` Part 3 for the full rationale (mirrors the `ac20` "one unit, not three" precedent).

## 3. Implementation

### 3.1 Migration

New file, next free index — **verify via `ls db/migrations/` immediately before authoring** (was `0022` as of the last check against `enterprise-billing-app`, and has already moved three times during this planning session):

```sql
ALTER TABLE billing.document RENAME COLUMN reference_date TO entry_date;
```

Author by hand. Do not run a blind `drizzle-kit generate` and apply whatever it proposes — if it doesn't recognize this as a rename (vs. a drop of `reference_date` + add of `entry_date`), it will silently discard every already-posted document's reference-date value. `RENAME COLUMN` preserves the column's data, `NOT NULL`, and `DEFAULT now()` automatically — verify the generated file actually contains `RENAME COLUMN` before applying it. Regenerate `meta/00XX_snapshot.json` and the journal entry to match (same hand-correction pattern `ac02`/`ac09` used).

**Deployment sequencing:** per platform `architecture.md` §1, Container Apps supports both rolling and blue-green revision deploys, with migrations gated before traffic shifts. Because old app code querying `reference_date` breaks the instant this migration lands, use an **atomic cutover (blue-green), not a rolling deploy**, for this specific release — a rolling deploy would create a window where an old-revision replica serves traffic against the already-migrated schema and 500s on every document-touching request.

### 3.2 Schema + validation (source of truth — land together)

- `db/schema/billing/documents.ts`: rename the `referenceDate` Drizzle field to `entryDate`, column string `"reference_date"` → `"entry_date"`. Update its inline comment (currently describes it as "a reference date the user enters") and `eventAt`'s comment (currently says "the entry date") to state the corrected caption mapping.
- `validation/accounts/document-base.schema.ts`: rename `referenceDate: z.coerce.date()` → `entryDate: z.coerce.date()` in `documentBaseSchema`. Update the header comment, which currently documents the old (wrong) Q29 field-to-label mapping.

Run `tsc` immediately after this step — every file in §3.3–§3.5 will fail to compile until updated, which is the fastest way to confirm nothing is missed.

### 3.3 Services — 12 files, mechanical pass-through rename

`services/accounts/allocate-payment.ts`, `capture-deposit.ts`, `capture-payment.ts`, `raise-credit-note.ts`, `raise-debit-note.ts`, `refund-deposit.ts`, `refund-payment.ts`, `reverse-deposit.ts`, `reverse-document.ts`, `reverse-line.ts`, `rounding-adjustment.ts`, `write-off.ts`. Each has one or two lines of the shape `referenceDate: input.referenceDate` (some also declare a local type field named `referenceDate`). Rename both sides to `entryDate`. No logic changes — every one of these is a straight pass-through into the document insert.

### 3.4 UI components — 12 files, caption swap + rebind per §2.2

`allocate-payment-panel.tsx`, `capture-deposit-panel.tsx`, `capture-payment-panel.tsx`, `payment-refund-panel.tsx`, `raise-credit-note-panel.tsx`, `raise-debit-note-panel.tsx`, `refund-deposit-panel.tsx`, `reversal-dialog.tsx` (ac22's reversal dialog — not `reversals-panel.tsx`, which no longer exists), `reverse-deposit-panel.tsx`, `rounding-adjustment-panel.tsx`, `write-off-panel.tsx`, plus the read-only `document-detail-drawer.tsx` (ac21). `eventAt`/`setEventAt` are untouched in every file; `referenceDate`/`setReferenceDate` become `entryDate`/`setEntryDate` (state var, submit-payload key, and any `fieldErrors?.referenceDate` lookup).

`lib/formatters.ts`'s `formatDatetime` (used by the drawer) needs no change — it's field-agnostic.

### 3.5 Tests — 16 files, mechanical rename, no assertion-logic changes

`refund-payment.integration.test.ts`, `transactions-documents-list.integration.test.ts`, `v03-balance-equals-ledger.integration.test.ts`, `v04-cash-conservation.property.test.ts`, `v06-journal-balance.integration.test.ts`, `v06b-period-close-export.integration.test.ts`, `v08-payment-status.integration.test.ts`, `v11-document-state-machine.integration.test.ts`, `v12-posting-nature-steering.integration.test.ts`, `v13-line-reversal-conservation.property.test.ts`, `v14-deposit-lifecycle.integration.test.ts`, `document-detail.integration.test.ts`, `tests/components/document-detail-drawer.test.tsx`, `reversal-eligibility.integration.test.ts`, `reversal-line-selection.integration.test.ts`, `tests/db/billing-schema.test.ts` (one column-existence assertion string). None asserts the literal "Entry Date"/"Reference Date" UI text, so every one of these is a pure field-name rename in fixtures/assertions — the invariants under test (V1 zero-sum, V4 cash conservation, V12 posting-nature steering, V13 line-reversal conservation, V14 deposit lifecycle) don't change.

### 3.6 Docs — 9 files, reviewed and confirmed necessary (not a blanket sweep)

`acctmgmt-architecture.md` (§3 storage-model row), `acctmgmt-code-standards.md` (shared `documentBaseSchema` description), `acctmgmt-project-overview.md` (Q29 field line + the period-close flow line), `specs/ac02-module-tables-and-views.md` (column definitions), `specs/ac07-document-core-and-payment.md` (Q29 description, validation section, checklist), `specs/ac14-period-close-and-csv-export.md` (re-date UX description), `specs/ac21-document-detail-drawer.md` (drawer field list), `specs/ac22-row-level-reversal.md` (dialog field list), and the Q9/Q29 entries + column table in `_newmodule-account-plan.md` (edit in place as a dated revision, matching Q29's existing "(rev.)" convention — don't silently rewrite history, mark the new revision date).

Deliberately **not** touched, per `ac00-build-plan.md` Part 3's review: `ac06`/`ac08`–`ac11` specs (one boilerplate mention each, already authoritative elsewhere), `ac20-documents-table.md` (its mention is a point-in-time verification snapshot, correct as history), `_assessment-accounting-module-compare-eric-ax.md` (its own stated update policy — taxonomy/scope only — doesn't cover this), and both mockup HTML files (superseded by the shipped page).

## 4. Dependencies (packages to install)

**None.** Every layer reuses existing infrastructure: Drizzle ORM for the migration and schema (already the module's ORM), Zod for validation (already `documentBaseSchema`'s library), the existing `Field`/`FieldLabel`/`Input` components (no new UI primitive — unlike `ac19`, which added `DropdownMenu`, this unit needs nothing from the shared kit). Zero new npm packages, zero new extensions.

## 5. Verification checklist

**Migration**
- [ ] Applies cleanly against a throwaway Postgres 16 container; generated SQL contains `RENAME COLUMN`, not `DROP`/`ADD`.
- [ ] `SELECT entry_date FROM billing.document LIMIT 5` against a fixture with pre-existing posted documents returns their original `reference_date` values unchanged.
- [ ] `meta/00XX_snapshot.json` and the journal entry regenerated and consistent.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check` all green.
- [ ] Full test suite green, including all 16 files in §3.5.

**Behavior — the point of the unit**
- [ ] Each of the 11 write panels/dialogs (including `reversal-dialog.tsx`) shows "Reference Date" next to the field that rejects a closed-period value, and "Entry Date" next to the inert default-today field.
- [ ] `document-detail-drawer.tsx` shows the same swap on read; the unrelated ledger-transfer `eventAt` display elsewhere in the drawer is untouched.
- [ ] A closed-period rejection still fires off `event_at` (now captioned "Reference Date") exactly as before — Inv. #7 behavior is unchanged, only the caption next to the field that triggers it.
- [ ] Grep sweep: zero remaining `reference_date`/`referenceDate` in active consumers — schema, services, tests, UI payloads, and SQL consumers. Excluded by design: the `0022` migration SQL, migration metadata/snapshots, and documentation describing the rename (which necessarily names the old column).

**Docs**
- [ ] All 9 files in §3.6 updated; `_newmodule-account-plan.md`'s Q29/Q9 entries carry a new revision date, not a silent rewrite.
- [ ] `acctmgmt-progress-tracker.md` gets an `ac24` entry on completion (not part of the 9 — that file needs no *content* correction, only the new completion record).

**Deployment**
- [ ] Released via atomic/blue-green cutover per §3.1, not a rolling deploy.

**Explicitly not verified by this unit** (out of scope, per `ac00-build-plan.md` Part 3): datetime capture (`type="date"` → `type="datetime-local"`), the Ledger Explorer's separate `event_at` range filter, and syncing the codebase's own mirrored spec copies under `enterprise-billing-app/context/accounting-management/**`.
