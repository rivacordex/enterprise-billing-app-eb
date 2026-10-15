# rm25 — `udr_resource` contract and event code — Spec

- **Unit:** rm25 of Phase H (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (app) · **Boundary:** `validation/rating/` + `db/seeds/rating-event-catalog.data.ts` + `db/schema/rating/udr-rated.ts` (comment only) + their tests.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` R1, R2, R5, R9; `ratemgmt-architecture.md` Inv 14, 27, 28; `ratemgmt-code-standards.md` §0.1 (TypeScript rules 2–5), §7.11; `ratemgmt-ai-workflow-rules.md` §0.1 rules 5, 13, 23.
- **Depends on:** rm02 (the catalog), rm24 (so no document still calls the column reserved). Must land before rm26.

## Goal

Put the `udr_resource` format, the raw-key builder and the `RATECARD_LABEL_INVALID` event code on `main` as tested code, so PRP (rm26), the seeds and the tests all build and read the same strings and PRP never emits a code the catalog lacks.

## Design

- **One definition of each string, in `validation/rating/`** — beside `udr-rate-detail.schema.ts` and `decimal-string.ts`, which already hold pure helpers that seeds import (for example `toScaled`). `validation/` is a leaf module, so `db/seeds/**` and `tests/**` can import it; nothing else needs to.
- **`udr_resource` is `state|district|polygon_start_date`** (Inv 28). Three segments, delimiter `|`, date ISO `YYYY-MM-DD`, an empty segment for a blank label. A label is blank when it is null, undefined or whitespace-only (the same rule as PRP's `_geo_label`); a non-blank label is used exactly as given, with no trim or case change.
- **The builder is strict.** `formatUdrResource` throws if a label contains `|` or the date is not `YYYY-MM-DD`, so a seed or test can never write a value PRP would refuse. (Amended 2026-10-15: shape only — the card's `date NOT NULL` column already guarantees a real day, and the date is never passed through a `Date`; code-standards §0.1 TypeScript rule 4.) This mirrors the PRP check (R9) on the TypeScript side.
- **The raw key builder mirrors `build_udr_key`** (rm26): key names sorted ascending, `name=value` with the value untouched, joined by `|`. It throws if a named column is missing. Key names are ASCII, so JavaScript's code-unit sort and Python's code-point sort agree.
- **The event code copies its siblings** (decided 2026-10-14): `RATECARD_LABEL_INVALID`, component `PRP`, `MAJOR`, event type `processingErrorAlarm`, probable cause `ratecardLabelInvalid`, **not auto-clearing** (no `clearEventCode`). A card fix plus a re-drop is the remedy; a later clean batch must not clear it.
- **No schema, migration or grant change.** The Drizzle column already exists; only its comment changes.

## Implementation

### 1. `validation/rating/udr-resource.schema.ts` (new)
Exports:
- `UDR_RESOURCE_DELIMITER = "|"`.
- `udrResourceSchema`: `z.string()` matching `^[^|]*\|[^|]*\|\d{4}-\d{2}-\d{2}$`. (Amended 2026-10-15: the calendar-date refinement and its `new Date` round trip are dropped — shape only, see above.)
- `UdrResourceParts = { state: string | null; district: string | null; polygonStartDate: string }`.
- `formatUdrResource(parts)`: blank state or district → empty segment; throws `Error` naming the field if a label contains `|` or the date is not `YYYY-MM-DD`; returns the string and parses it through `udrResourceSchema` before returning, so format and schema cannot drift.
- `parseUdrResource(value)`: validates through `udrResourceSchema`, splits on `|`, returns `UdrResourceParts` with empty segments as `null`. Tests use this instead of splitting by hand.

### 2. `validation/rating/udr-key.ts` (new)
`buildRawUdrKey(columns: Readonly<Record<string, string>>, keyColumns: readonly string[]): string` — as in Design. Example: `buildRawUdrKey({ mno_public_id: "MNO-001", commercial_unit: "CU-5G", polygon_id: "ABCD_25 DISTRICT2" }, ["mno_public_id", "commercial_unit", "polygon_id"])` returns `commercial_unit=CU-5G|mno_public_id=MNO-001|polygon_id=ABCD_25 DISTRICT2`. No `trim()`, `toLowerCase()` or `normalize()` anywhere in the file.

### 3. Event code (`db/seeds/rating-event-catalog.data.ts`)
- Append `"RATECARD_LABEL_INVALID"` to `RATING_EVENT_CODES` inside the rm18 group.
- Add, next to `INPUT_UNMAPPED`:
  ```ts
  event({
    eventCode: "RATECARD_LABEL_INVALID",
    component: "PRP",
    defaultSeverity: "MAJOR",
    eventType: "processingErrorAlarm",
    probableCause: "ratecardLabelInvalid",
    description:
      "A ratecard state or district label contains the '|' delimiter, so udr_resource cannot be split into three segments; the whole batch is refused.",
  }),
  ```
- The seed's emitter (`rm26`) does not exist yet; that is expected. The code ships before its emitter, which §7.3 allows because the guardrail only fails an emitted code that has no row.

### 4. Drizzle comment (`db/schema/rating/udr-rated.ts` lines 61–62)
Replace "Reserved, stays NULL in v1 (rm01-spec D10). Do not populate." with: "Cell label written once at INSERT by RL: `state|district|polygon_start_date` of the matched ratecard cell (Inv 28; format in `validation/rating/udr-resource.schema.ts`). NULL only for a usage type that reads no ratecard." The column definition itself is unchanged.

### 5. Tests
- `tests/validation/udr-resource.schema.test.ts` (new): valid full value; valid blank state, blank district, both blank; reject two segments, four segments, a `|` inside a label, a non-ISO date; `formatUdrResource` → `parseUdrResource` round trip; whitespace-only label becomes an empty segment; a label with inner spaces is kept exactly (`"STATE 2"`).
- `tests/validation/udr-key.test.ts` (new): the worked example above; case and spaces preserved; names sorted regardless of input order; missing column throws; a source search asserts the file contains no `trim`, `toLowerCase`, `toUpperCase` or `normalize`.
- `tests/rating/rm02-event-catalog-seed.integration.test.ts` (update): add `"RATECARD_LABEL_INVALID"` to `NON_AUTO_CLEARING`; the two `toHaveLength(28)` assertions (lines 228 and 396) become 29. Test #4 (constant and rows are the same set both ways) must pass unchanged.

## Dependencies

None. `zod` is already a dependency.

## Verification checklist

- [ ] `udrResourceSchema` accepts `STATE-1|DIST-1|2026-01-01`, `|DIST-1|2026-01-01` and `||2026-01-01`; rejects the cases listed in §5.
- [ ] `formatUdrResource` throws on a `|` in a label and on a date that is not `YYYY-MM-DD`; its output always parses.
- [ ] `buildRawUdrKey` reproduces the worked example exactly and the source contains no normalising call.
- [ ] `RATECARD_LABEL_INVALID` resolves in `event_catalog` as `MAJOR`, component `PRP`, `is_auto_clearing = false`; the `INDETERMINATE` count is still zero; `RATING_EVENT_CODES` and the rows are the same set in both directions.
- [ ] The rm02 suite passes with 29 rows and the updated non-auto-clearing list.
- [ ] `udr-rated.ts` differs only in the comment; `drizzle-kit` reports no schema change.
- [ ] `tsc --noEmit`, ESLint (import boundaries), Prettier and the DB-free unit suite are green.
- [ ] The diff contains no migration, no `db/bootstrap/**` change, no Python and no billing file.
