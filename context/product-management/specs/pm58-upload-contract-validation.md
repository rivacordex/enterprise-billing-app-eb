# pm58 — Upload contract validation

**Unit:** pm58 (Part 5). **Boundary:** `validation/product/ratecard.schema.ts` (new), `RateCardIssueSeverity` in `types/product.ts`, the `reject_summary` `.$type<>()` annotation pm57 deferred, and this unit's own pure tests. **No database access anywhere in the unit** — no repository, no service, no action, no parser, no component.
**Specs from:** `_updatemodule-ratecard-lookup-plan-v2.md` **RC3′**, **RV2**, **D-A1, D-A2, D-A8**, **OR7′ (confirmed 2026-09-25)** · `prodmgmt-architecture.md` §3.2, §3.3 (the empty-cell discipline), Inv. **#47, #51, #57** · `prodmgmt-code-standards.md` §1.41, §1.42, §2.19, §2.24, §2.25, §2.26, §2.27, §7.12 · `prodmgmt-ai-workflow-rules.md` §4.2, §5.4, §8.3, §8.5.
**Depends on:** **pm57** (the shape it mirrors — **Zod is the primary guard, the database the backstop**, never the reverse).

**OR7′ — confirmed 2026-09-25 (source: product owner, from the RevOps file layout).** The column set is D0 below. `SITE` was never a column: the file carries **`Polygon ID`**. The file has **no date column** (D-A8), so `snapshot_date` is not part of this contract.

---

## Goal

Write the upload contract as Zod: the ten-column header of D0, a strict row schema, a file schema that rejects a header mismatch or a duplicate key outright, and the `RateCardIssue` line-number contract every later layer reports against — all as pure functions with no database and no parser behind them.

---

## Design

### D0. The column set — ten columns, exact header text

The header row must contain exactly these ten columns. The **header text is binding**: it is what RevOps' file carries, and it maps to the table column shown.

| #   | File header (exact)       | Table column                 | Required | Cell rule                                                                                               |
| --- | ------------------------- | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `MNO Name`                | `mno_public_key`             | yes      | non-empty string, stored as-is (key component)                                                          |
| 2   | `Commercial Unit ID`      | `commercial_unit_public_key` | yes      | non-empty string, stored as-is (key component)                                                          |
| 3   | `Polygon ID`              | `polygon_id`                 | yes      | non-empty string, stored as-is (key component)                                                          |
| 4   | `Polygon Start Date`      | `polygon_start_date`         | yes      | `YYYY-MM-DD`, a real calendar date; descriptive, not a key component (D-A9)                             |
| 5   | `Polygon End Date`        | `polygon_end_date`           | no       | `YYYY-MM-DD` if present; empty → NULL (open-ended); descriptive (D-A9)                                  |
| 6   | `State`                   | `state`                      | no       | string; empty → NULL; descriptive label (D-A10)                                                         |
| 7   | `District`                | `district`                   | no       | string; empty → NULL; descriptive label (D-A10)                                                         |
| 8   | `Subscriber Reference ID` | `lkp_subscriber_ref_id`      | yes      | non-empty string, stored as-is. Structural only: no `PRDINV` pattern check, no referential check (D-A1) |
| 9   | `Service Code`            | `service_code`               | no       | string; empty → NULL                                                                                    |
| 10  | `Rate per Unit`           | `rate_per_unit`              | no       | decimal string (D2); empty → NULL                                                                       |

Header matching rules:

- **Exact, case-sensitive text.** The only normalisation is stripping a leading UTF-8 BOM from the first header cell and trimming surrounding whitespace from each **header** cell. `Polygon Id` or `polygon_id` is a mismatch, not a synonym. An aliasing layer is a contract nobody wrote down.
- **Order is not significant.** Columns are matched by name, so RevOps can reorder the export without breaking the upload.
- **Required means the cell is non-empty.** All ten columns must be _present_ in the header. "Not required" only allows an empty _cell_.
- **Key cells are stored as-is.** No trimming, no case folding and no leading-zero loss (§2.20). A cell that is whitespace only counts as empty for a required column, and is refused.
- **No date column.** `snapshot_date` is set by the upload service (pm61), not read from the file (D-A8). A file that carries a `Date` column fails with `HEADER_MISMATCH` like any other unknown column.

`MNO Name` lands in a column called `mno_public_key`. The table column keeps its name; the key is still the MNO's identity for matching. The doc-block of the row schema says so, so no one "fixes" the mismatch later.

### D1. `strictObject`, in the pm47 house style — rejected, never stripped

Both schemas are `strictObject`s (§2.26, §2.4). An unknown column is **rejected**, never stripped. This is not a style preference: a stripped column is a contract change that arrives silently, and the upstream is a mediation export that nobody on this side controls. The first sign that the export changed should be a refused upload naming the column, not a quiet month of missing data.

A **missing** expected column is likewise a file-level rejection — the contract changed (Inv. #51). It is not a per-row error, because every row has it.

### D2. `rate_per_unit` — a plain optional decimal-string column

`rate_per_unit` is an **ordinary optional decimal-string column**. An empty cell **stays `""`** and never becomes `0` — the general empty-cell hygiene of §3.3, applied here as plain typing, nothing more. A present value must fit the column's `numeric(18,6)`: `^\d{1,12}(\.\d{1,6})?$`. That means non-negative, at most 12 integer digits and 6 decimal places, no sign, no thousands separator, no exponent. Anything else is `ROW_SCHEMA_INVALID`. It is never rounded to fit. There is **no reserved rule**, no refusal of `"0"` or a decimal, and no verbatim reserved-column message.

### D3. The file schema — two rules, both whole-file

1. **Header match** against D0's ten columns (D1). `HEADER_MISMATCH`, naming each unknown and each missing column.
2. **No duplicate row key** `(mno_public_key, commercial_unit_public_key, polygon_id)` (RV2, D-A9). `DUPLICATE_ROW_KEY`, reporting **both** line numbers — one line number tells the user half of what they need.

The duplicate check keys rows on the three columns **joined by a delimiter that cannot occur in them** (§6.33). Pick it deliberately and say why in a comment; a naive concatenation makes `("AB", "C")` and `("A", "BC")` the same key, and the columns are free-text RevOps data (§2.20) with no character excluded by rule.

Polygon Start Date is compared **as its `YYYY-MM-DD` string** in the key. It is never converted to a `Date` first (§2.21).

### D4. `RateCardUploadViolation` — three members, closed

Exactly (§2.22): `HEADER_MISMATCH` · `DUPLICATE_ROW_KEY` · `ROW_SCHEMA_INVALID`. (`SNAPSHOT_DATE_NOT_CONSTANT` is withdrawn: the file has no date column, D-A8.) This is the **structural** set — every member is decidable by the schema over already-parsed cells, with no database and no referential check behind any of them.

The names are **binding** — pm66's error-table copy keys off them (§4.28). **Never invent a fourth** (workflow §5.4): if a case seems to need one, it is almost certainly one of the three, and if it genuinely is not, that is a question for the user rather than a new literal.

### D5. `RateCardIssue` and the line-number contract

`RateCardIssue` carries **line · column · value · reason**, and the line is the **1-based line number of the row in the uploaded file, counting the header as line 1** (§2.25). So the first data row is line **2**.

Fixed once, here, because the parser (pm59), the service (pm61) and the error table (pm66) must all agree. **An off-by-one between any two of them points every reported row at its neighbour, which is worse than reporting no line number at all.** Write the rule in the type's doc-block, not only in this spec.

`RateCardIssueSeverity`: `'ERROR' | 'WARNING'`, `as const` in `types/product.ts` (§2.19) — the second of §2.19's two unions; pm57 landed the first. Keyed to §1.41's two **fixed** lists:

| Severity    | Cases                                         | Effect                                      |
| ----------- | --------------------------------------------- | ------------------------------------------- |
| **ERROR**   | every schema and file-level failure above     | Upload refused; **no version row written**  |
| **WARNING** | a `file_checksum` matching an earlier version | Shown on the draft review; **never blocks** |

**These lists are not tunable** (§1.41, workflow §3.9). No environment variable, `SYSTEM_CONFIG` key or UI toggle moves a case between them. Do not build the indirection that would allow it.

### D6. `rejectSummarySchema` is bounded, and has no writer

`rejectSummarySchema` caps the stored issues at the **first 100** and carries `totalIssues: number` and `truncated: boolean` (§2.27). A 5,500-row file can produce 5,500 issues and a jsonb column is not a log.

**No path in this delivery writes it** (§1.42). It exists so that whoever writes the first one — a future asynchronous ingest — cannot write an unbounded blob. Say that in the schema's doc-block (workflow §7.11), and **do not invent a writer to make the column look used** (workflow §3.5).

This unit also lands the `.$type<z.infer<typeof rejectSummarySchema>>()` annotation on the Drizzle column that pm57 deliberately deferred (pm57 D7).

### D7. What this unit does not have

No database handle, no repository import, no `tx`, no parser import, no `FormData`, no file. Everything here is a pure function over already-parsed string cells. The split is workflow §4.2's — the schema owns the shape, the parser owns the cells, the service owns the transaction — and collapsing them **loses which layer refused a write**, which is the whole reason the split exists.

Also absent: **no capacity field** (RC4), no `currency` field (Inv. #53), no `capacity_mbps`, no field the plan does not show (workflow §5.4 — _if the plan does not show a field, it does not exist_).

---

## Implementation

### I1. `validation/product/ratecard.schema.ts`

The header map of D0 (a single `as const` record from file header to table column: the one place the ten header strings are spelled), the row schema (D1, D2), the file schema (D3), `RateCardUploadViolation` (D4), `RateCardIssue` with its line-number doc-block (D5), `rejectSummarySchema` (D6). One file; it is the contract's single home.

Header note: the column set is **OR7′'s confirmed mapping** (2026-09-25, D0). pm59, pm61, pm66 and pm67 import the header map from here. Nothing else spells the header text.

### I2. `types/product.ts` and the Drizzle annotation

`RateCardIssueSeverity` per D5; the `reject_summary` `.$type<>()` per D6.

### I3. Tests — pure, and one per condition

1. The ten D0 headers, in any order, are accepted, and each maps to its table column.
2. An **unknown column is rejected, not stripped**, and the issue names the column. A `Date` column is one such case (D-A8).
3. A **missing** expected column rejects the file as a contract change (not as 5,400 row errors).
4. A **case or spelling variant** (`Polygon Id`, `polygon_id`) is `HEADER_MISMATCH`. A leading BOM and whitespace around a header cell are accepted.
5. An empty or whitespace-only cell in each of the five required columns is `ROW_SCHEMA_INVALID`, naming the column.
6. `Polygon Start Date` accepts `2026-08-01` and refuses `01/08/2026`, `2026-8-1`, `2026-02-30` and `2026-08-01T00:00`.
7. A **duplicate row key** is refused, reporting **both** line numbers.
8. The delimiter cannot be produced by concatenating two different key tuples (D3). This is a property test over adversarial values, not a single example.
9. An **empty `Rate per Unit` or `Service Code` cell is accepted and stays `""`**: never coerced, never defaulted to `0`. `Rate per Unit` accepts `0`, `0.0125` and `123456789012.123456`, and refuses `-1`, `1,000`, `1e3` and `0.1234567`.
10. Key cells keep leading zeros and inner spaces exactly as uploaded.
11. The line number of the first data row is **2**.
12. `rejectSummarySchema` truncates at 100, sets `truncated: true` and reports `totalIssues` accurately.
13. `RateCardUploadViolation` has exactly three members.
14. The file imports **nothing** from `db/**`, `services/**` or a parser package. Assert this by inspecting the module graph, not by eye.

### I4. Documentation

1. **Code-standards §2.19** — the second union marked landed under pm58; the pm57/pm58 split annotated (pm57 D7).
2. **Code-standards §2.24–§2.27** — marked landed under pm58.
3. **Code-standards §7 tree** — `validation/product/ratecard.schema.ts` marked landed under **pm58**.
4. **`_updatemodule-ratecard-lookup-plan-v2.md`**: OR7′'s confirmation is recorded there (2026-09-25, D0), along with D-A8. Nothing further is owed.

---

## Dependencies

**Packages to install: none.** Zod is already a dependency. **The CSV parser is pm59's and must not be imported here** (§7.10) — a parser import in this file breaks the single-importer rule before that rule has even landed.

**Commands used:** `npm run test`, `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** OR7′ is confirmed and recorded (2026-09-25). Nothing is blocking.

---

## Verification checklist

Before the file is written

- [x] OR7′ is confirmed and **recorded with its date** (2026-09-25, D0). The file uses `Polygon ID`, not `SITE`, and has no date column.

Contract

- [ ] The ten D0 header strings are spelled once, in the header map, and nowhere else in the codebase.
- [ ] Headers are matched exactly and case-sensitively, in any order. The only normalisation is a leading BOM and whitespace around a header cell.
- [ ] Both schemas are `strictObject`s; an unknown column (including `Date`) is **rejected, never stripped**, and the issue names it.
- [ ] A missing expected column rejects the **file**, not 5,400 rows.
- [ ] The five required columns refuse an empty or whitespace-only cell. `Service Code` and `Rate per Unit` accept an empty cell.
- [ ] `Polygon Start Date` is strict `YYYY-MM-DD`, is a real calendar date, and stays a string.
- [ ] A duplicate row key is refused with **both** line numbers; the key delimiter cannot collide across different tuples.
- [ ] `rate_per_unit` is a plain optional decimal-string column with **no reserved rule**. It fits `numeric(18,6)`, non-negative, and is never rounded. `""` is accepted unchanged and never becomes `0`.
- [ ] No snapshot-date rule is in this file; `snapshot_date` belongs to pm61 (D-A8).

Contracts other units key off

- [ ] `RateCardUploadViolation` has exactly **three** members, spelled as §2.22 writes them.
- [ ] `RateCardIssue` carries line · column · value · reason, with the header counted as line 1 and the rule in the doc-block.
- [ ] `RateCardIssueSeverity` is `'ERROR' | 'WARNING'`, keyed to §1.41's two **fixed** lists, with no tunability of any kind.
- [ ] `rejectSummarySchema` bounds at 100 with `totalIssues` and `truncated`, and its doc-block says it has **no writer in this delivery**.

Boundaries

- [ ] **No database access anywhere in the unit** — proved by the module graph, not by reading.
- [ ] No parser package is imported.
- [ ] No capacity field, no currency field, no field the plan does not show.
- [ ] `tsc --noEmit`, ESLint, Prettier and this unit's tests green.

**Definition of done:** the upload contract exists as one strict, pure, database-free file that can tell an empty cell from a zero, a changed export from a bad row, and a warning from a refusal — and the line number it reports points at the row the user is actually looking at.
