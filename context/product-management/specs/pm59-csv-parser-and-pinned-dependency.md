# pm59 — CSV parser + the pinned dependency

**Unit:** pm59 (Part 5). **Boundary:** `services/product/ratecard/parse-csv.ts` (new — **the only file in the repository that imports the parser package**), the `package.json` pin and its lockfile entry, and this unit's fixtures and tests. **No schema, no repository, no service beyond this file, no action, no component, no page.**
**Specs from:** `_updatemodule-ratecard-lookup-plan-v2.md` **RC15**, **OR4**, **OR7′ (confirmed 2026-09-25)**, **D-A8**, _Technology choices_ › CSV parser · `prodmgmt-architecture.md` §3.3 (the empty-cell discipline), §7, Inv. **#51** · `prodmgmt-code-standards.md` §2.25, §7.9, §7.10, §7.12 · `prodmgmt-ai-workflow-rules.md` §0.2 row 4, §1.6, §4.2, §8.5, §8.15 · `pm00-build-plan.md` Part 5 › G-RC4.
**Depends on:** **pm58** (the contract this feeds, and `RateCardIssue`'s line-number rule); **G-RC4** (the pin).

**Gate G-RC4 — the file format and the library (OR4). Required before the dependency is added.** CSV is recommended; **no library is chosen and `package.json` has none**. This is the update's **only** new runtime dependency and it is its own unit for that reason (general §5.6, workflow §1.6). Record the choice with its date in `_updatemodule-ratecard-lookup-plan-v2.md` and in `pm00-build-plan.md`.

Whatever is pinned must satisfy the **empty-cell discipline** — _a parser that coerces an empty cell to `0` turns a missing value into a real zero, and no test catches it unless it was written for exactly this_ (G-RC4, Inv. #51). A library that cannot be configured to return every cell as a string **is the wrong library**, and that is a selection criterion, not a preference.

---

## Goal

Turn an uploaded CSV into string cells and nothing else — coercion off, empty cells preserved as `""`, a missing column reported as a contract change — with the empty-cell discipline (Inv. #51) asserted here in one place, behind the single import of the only new dependency this update adds.

---

## Design

### D1. The two candidates, and what actually separates them

| Library          | Coercion switch        | Notes                                                                                                           |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `papaparse`      | `dynamicTyping: false` | Non-streaming use is fine at 0.5 MB; widely used in browsers, which is irrelevant here — this runs server-side. |
| `csv-parse/sync` | `cast: false`          | Node-native, synchronous API matching RC15's synchronous ingest exactly.                                        |

Both can satisfy the rule. **The selection criterion is not ergonomics — it is that the coercion switch is a documented, tested option rather than a default someone can flip.** Whichever is pinned, `cast` / `dynamicTyping` is set **explicitly to `false`** even if `false` is already the default: a default is a fact about a version, and this one is load-bearing enough to be written down in code.

Pin an **exact version**, not a range. A minor release that changes a coercion default is precisely the failure this unit exists to make impossible, and a caret range invites it.

### D2. One import, in one file, forever

`services/product/ratecard/parse-csv.ts` is **the only file in the repository that imports the parser package** (§7.10). Consequences, both deliberate:

- The pin stays **swappable** — replacing the library is a change to one file, not a search across the tree.
- **Inv. #51's discipline is asserted in one place** rather than wherever a parse happens to be called. A second import is a second place the empty-cell rule can be got wrong silently.

**Guardrail-asserted, not convention-asserted:** `grep` proves exactly one import (§9's _also gated_ list, workflow §8.15). Write that assertion in this unit — it is cheap now and unenforceable later.

The services folder nests as `services/product/ratecard/` (§7.9). The nesting is for the card only: **no existing `services/product/*.ts` file moves into a folder**, and a second nested group needs its own justification rather than this precedent.

### D3. Every cell is a string, and `""` is a value

The parser returns `Record<string, string>` per row. Not `unknown`, not `string | number`, not a typed row — **typing the output here would duplicate pm58's schema and invite the two to drift** (§2.16's no-second-copy rule applied to types). The schema parses; the parser reads.

The empty cell is the whole point: **`""` is preserved and never becomes `0`, `null` or `undefined`.** An empty cell means _no value_; a coerced zero means _a real zero_; and the difference is a silent data corruption that no ordinary test catches (Inv. #51).

Two adjacent hazards this unit also owns, because they are the same class of coercion:

- **A leading-zero key survives unmangled.** `polygon_id` and the two public keys are free-text RevOps data (§2.20) and may legitimately be `"007"`. A parser that reads that as `7` re-keys the row to something that will never match a UDR.
- **A date-shaped cell stays a string.** `polygon_start_date` and `polygon_end_date` are calendar dates typed `string` in `YYYY-MM-DD` form **end to end** (§2.22) — they never become a `Date`, never round-trip through `toISOString()` and never reach `formatDatetime`. A parser that helpfully constructs a `Date` here moves the date by a day at a zone boundary (§4.30). The file carries **no snapshot `Date` column** (plan D-A8), and `snapshot_date` never passes through the parser — pm61 sets it from the upload date.

### D4. A missing column is a contract change, and the parser reports it as one

The parser surfaces the **header row it actually found**. Deciding that a column is missing is pm58's file schema (D1 there); the parser's job is to hand over the header faithfully — including duplicate headers, which some libraries silently de-duplicate and which must be visible rather than resolved.

Do **not** let the parser fill missing columns with a default. `""` for a cell the file contains and _absent_ for a column the file lacks are different facts, and merging them destroys the distinction Inv. #51 turns on.

**The header is the one place anything is normalised, and the rule is pm58's (D0).** A leading UTF-8 BOM on the first header cell may be stripped here (`bom: true` in `csv-parse`; `papaparse` strips it by default) — a BOM is an encoding artefact, not part of the text `MNO Name`. The parser **trims nothing**: whitespace around a header cell is left for pm58 to trim when it matches, and **data cells are returned untouched** — no BOM handling, no trim, no case change. pm58 accepts a header with or without the BOM, so the result is the same either way; what must never happen is a trim reaching a data cell. The checksum (D6) is over the raw bytes, BOM included.

### D5. The line-number contract is honoured here first

§2.25 fixes it: the **1-based line number of the row in the uploaded file, counting the header as line 1**, so the first data row is line **2**. The parser attaches it; pm61 reports it; pm66 renders it. **An off-by-one between any two of them points every reported row at its neighbour**, which is worse than reporting no line number at all.

If the library reports its own index, **do not pass it through** — convert it explicitly and test the conversion. A borrowed index is the most likely source of the off-by-one.

### D6. Buffered, synchronous, and nothing else

At ~5,000–5,500 rows and ~0.5 MB the whole file is buffered and parsed in one call (RC15). **No streaming parse, no chunked reader, no worker, no temp file** (workflow §3.6). The engine was considered and set aside, which is not the same as overlooked; revisit only past ~50k rows per upload, and read RC15 first.

**The file itself is never stored** (Inv. #58, §6.36). No blob, no `landing/` drop, no temp file on disk, no buffer retained past the call. The parser takes bytes and returns rows; `source_file` (the filename, forensics only) and `file_checksum` are the only survivors, and they are pm61's to write.

`file_checksum` is computed over the **uploaded bytes**. Whether it is computed here or in pm61 is a judgement call — compute it **here**, in the same pass that already holds the buffer, and return it alongside the rows, so nothing downstream has to hold the file a second time. It **detects** a duplicate upload; it never **prevents** one (§6.37): re-uploading the same file after a rollback is legitimate, so a match is a warning on the draft review and never a refusal, and the column carries no unique constraint.

### D7. This unit refuses nothing on its own authority

The parser does not validate. It does not know what `rate_per_unit` means, it does not check the header against an expected set, and it does not detect duplicate keys. Those are pm58's, and keeping them there is what preserves **which layer refused a write** (workflow §4.2).

What the parser _does_ own is the empty-cell discipline of Inv. #51 **as it manifests in parsing** — the cell-level behaviour that makes pm58's rules reachable. Tests for it live here in one place (§7.10); pm58 tests the same cases at the schema level. That duplication is deliberate and is the only duplication this pair permits.

---

## Implementation

### I1. The pin

Add the chosen library at an **exact** version to `package.json`, with the lockfile updated in the same commit. One dependency, no transitive dev tooling, no type-only companion package unless the library ships no types.

### I2. `services/product/ratecard/parse-csv.ts`

Exports one function: bytes in, `{ header: string[]; rows: Array<{ line: number; cells: Record<string, string> }>; checksum: string }` out. Coercion explicitly off (D1). Line numbers per D5. Checksum per D6. No validation (D7). No `next/*` import — `services/product` stays framework-agnostic (§7.2).

### I3. Fixtures

Small, hand-written CSV fixtures committed beside the test — **not** a 5,400-row file. Each fixture isolates one behaviour; a realistic-size fixture proves nothing these do not and makes the suite slow. One larger fixture (a few hundred rows) exists only to prove the buffered path does not blow up, and it is generated, not committed. Fixtures carry the ten OR7′ headers (pm58 D0) and **no `Date` column**. Their header line is **built from pm58's header map, imported** (a small test helper joins its keys), not typed out again — pm58 I1 makes the map the only spelling of the header strings. The BOM and whitespace fixtures (test 13) prepend or pad that built line.

### I4. Tests

1. Every cell arrives as a **string**; no row value has a non-string type.
2. An **empty cell arrives as `""`** and never `0`, `null` or `undefined`.
3. A **whitespace-only cell arrives as whitespace**, preserved — pm58 is what refuses it, and it cannot refuse what the parser already trimmed away.
4. `"0"` arrives as the string `"0"`, distinguishable from `""`.
5. A **missing column** is visible in the returned header (D4); the parser fills nothing.
6. A **duplicate header** is visible, not silently de-duplicated.
7. A **leading-zero key survives unmangled** (`"007"` stays `"007"`).
8. A **date-shaped cell stays a string** in its file form; no `Date` is constructed anywhere in the module.
9. The **first data row is line 2**; a 10-row file reports lines 2–11.
10. A quoted field containing a comma, and one containing an embedded newline, parse correctly — the two cases every hand-rolled splitter gets wrong, asserted so nobody is tempted to hand-roll one later.
11. **`grep` proves exactly one import of the package in the tree** (D2, guardrail assertion).
12. The module retains no buffer and writes no file (D6) — assert no `fs` import.
13. A file saved with a **leading UTF-8 BOM** yields a first header cell equal to `MNO Name` (or one pm58 accepts, D4); a header cell with surrounding spaces and every **data** cell — including a whitespace-only one — are returned untouched.

### I5. Documentation

1. **`_updatemodule-ratecard-lookup-plan-v2.md`** — **OR4 recorded as resolved**, with the library, the exact version, the date and the coercion setting. The _Technology choices_ table's `CSV parser` row is filled in.
2. **`pm00-build-plan.md`** — G-RC4 closed with its date.
3. **Code-standards §7.10** — the chosen library and its coercion flag named, replacing _"OR4 has not pinned the library"_.
4. **Code-standards §7 tree** — `parse-csv.ts` marked landed under **pm59**.
5. **Architecture §7** — the _"File format and parser are unpinned"_ gap removed, not reworded.

---

## Dependencies

**Packages to install: exactly one** — the CSV parser chosen at G-RC4 (`papaparse` or `csv-parse`), pinned to an exact version. **This is the only runtime dependency the entire update adds.** No streaming library, no file-upload library, no schema-from-CSV helper, no `multer`-equivalent — a Server Action receives `FormData` natively (§5.5).

**Commands used:** `npm install <parser>@<exact>`, `npm run test`, `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** **G-RC4** recorded. Blocking this unit only.

---

## Verification checklist

Gate and pin

- [ ] G-RC4 recorded with the library, the **exact** version and the date, in both the plan and the build plan.
- [ ] The version is exact, not a caret or tilde range; the lockfile is updated in the same commit.
- [ ] Coercion is set **explicitly** to off (`dynamicTyping: false` / `cast: false`), even where that is already the default.

Cell discipline (Inv. #51, here in one place)

- [ ] Every cell is a `string`.
- [ ] An empty cell is `""` — never `0`, `null` or `undefined`.
- [ ] A whitespace-only cell is preserved, not trimmed away.
- [ ] `"0"` is distinguishable from `""`.
- [ ] A leading-zero key survives unmangled.
- [ ] A date-shaped cell stays a string; no `Date` is constructed in the module.

Header and structure

- [ ] A missing column is visible in the returned header; the parser fills nothing.
- [ ] A duplicate header is visible, not de-duplicated.
- [ ] Quoted commas and embedded newlines parse correctly.
- [ ] A leading BOM on the first header cell is handled per pm58 D0; nothing is trimmed, and no data cell is touched.

Contracts

- [ ] The first data row is line **2**; the line number is computed explicitly, not borrowed from the library's index.
- [ ] The checksum is computed over the uploaded bytes in the same pass, and nothing downstream re-reads the file.

Boundaries

- [ ] **`grep` proves exactly one import of the parser package in the whole tree.**
- [ ] The module validates nothing — no header comparison, no duplicate-key detection, no reserved-column rule.
- [ ] No `fs` import, no temp file, no retained buffer, no `landing/` path (Inv. #58).
- [ ] No `next/*` import; `services/product` stays framework-agnostic.
- [ ] No existing `services/product/*.ts` file moved into a folder (§7.9).
- [ ] `tsc --noEmit`, ESLint, Prettier and this unit's tests green.

**Definition of done:** the one new dependency this update adds is pinned to an exact version, imported in exactly one file, and configured so that an empty cell stays empty — with a test for that specific case, because it is the one failure that would otherwise bill a customer nothing and tell no one.
