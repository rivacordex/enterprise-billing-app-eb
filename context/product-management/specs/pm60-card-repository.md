# pm60 — Card repository

**Unit:** pm60 (Part 5). **Boundary:** `db/repositories/ratecard.ts` (new, **flat path**), the `RATECARD_INSERT_BATCH_SIZE` constant, guardrail 37, and this unit's live-DB tests. **No service, no action, no component, no page, no validation, no parser.** It is the one unit in Part 5 whose headline result is a **proof of absence**.
**Specs from:** `_updatemodule-ratecard-lookup-plan-v2.md` **RC11, RC15**, **RV3**, **D-A7** · `prodmgmt-architecture.md` §2 (**corrected here** — C6), §3.2, §3.6, Inv. **#46, #59** · `prodmgmt-code-standards.md` §1.36, §1.44, §2.22, §6.33, §6.34, §6.35, §7.8, §7.9, guardrail 37 · `prodmgmt-ai-workflow-rules.md` §0.2 row 5, §1.5, §3.13, §5.3, §6.1, §8.13.
**Depends on:** **pm57** (the tables). Ordered after pm59 by workflow §0.2, but it needs only pm57 — pm58 → pm59 and pm60 may run beside each other.

**Doc-vs-doc conflict this unit settles — C6 / W6 (already resolved in the tree — verify-only).** code-standards §7.8 settles the path **flat** as `db/repositories/ratecard.ts`, and every product repository on disk is flat (`product-offering.ts`, `product-specification.ts`, `product-offering-price.ts`). **`prodmgmt-architecture.md` §2 already reads the flat path** (confirmed 2026-09-27: "`db/repositories/ratecard.ts` … Flat path, matching every existing product repository") — so this unit **confirms** it rather than correcting it. Build flat; if a stale nested `ratecard.repository.ts` reference resurfaces, fix it, and clear W6 with its date.

---

## Goal

Build the card's whole data-access surface — three writes, four reads, 1,000-row batches inside one transaction — and prove that the surface contains **no row-level update or delete of any name**, because upload-is-the-only-write-path is a load-bearing invariant of the design rather than a style preference.

---

## Design

### D1. The exported surface, exactly

**Writes — four** (§1.36):

| Export               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertVersion`      | One `ratecard_version` row. Status is the caller's; this function decides nothing about lifecycle.                                                                                                                                                                                                                                                                                                                                                             |
| `insertLookupRows`   | N rows in batches of `RATECARD_INSERT_BATCH_SIZE` (D3), on the caller's `tx`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `setVersionStatus`   | One version's `status`, plus the provenance columns that move with it (`activated_by` / `activated_at`, `superseded_by_version_id`).                                                                                                                                                                                                                                                                                                                           |
| `deleteDraftVersion` | Discards a **`DRAFT`** version whole — one guarded `DELETE` of the `ratecard_version` row, whose lookup rows go with it by the existing `ON DELETE CASCADE`. Re-reads status on `tx` and **refuses to delete anything not in `DRAFT`** (an `ACTIVE`/`SUPERSEDED`/`REJECTED` version is immutable — RC11, Inv. #46). Exists only so pm61 can replace an open draft on re-upload (D-A11, pm61 D12); there is **no** standalone discard UI, action or permission. |

**Reads — four:** the version list (newest first, for one `card_name` or all), a version by id, a page of a version's rows (with a filter), and **the current `ACTIVE` version** for a card name.

**And nothing else. No `updateLookupRow`, no `deleteLookupRow`, no row-level write of a lookup row, in any layer** (Inv. #46). A lookup row is only ever inserted or removed by cascade — never edited or deleted directly. A correction is a new upload; a wrong open draft is **replaced** by re-upload (pm61 D12), never row-edited. **Guardrail 37 asserts the exported surface** — re-scoped for `deleteDraftVersion` (I3) — which is why the surface exists before any caller does (workflow §0.2 row 5).

### D2. Why a repository with no caller is a real unit

A repository that reads and writes with nothing calling it usually demonstrates little. Here _"the exported surface contains no row-level write"_ is a genuine visible result, because upload-is-the-only-write-path is what the whole version model rests on: immutability (RC11), the DRAFT gate (RC7) and rollback (RV3) all assume it. This delivery stands up the table; no consumer is built.

Landing the surface first also means pm61, pm63 and pm64 are each judged **against** it rather than each quietly adding the helper they happen to want.

### D3. Batching — one constant, not a runtime calculation

`RATECARD_INSERT_BATCH_SIZE = 1000`, declared **once in this repository** (§6.34). Postgres caps a statement at 65,535 bind parameters; 5,500 rows × 11 bound columns = 60,500 exceeds it in a single statement, so the rows are inserted in batches.

**Do not derive the batch size at runtime and do not make it configurable.** A computed batch size hides the cap it is protecting against, and a configurable one is a production incident waiting for someone to tune it upward.

All batches run **inside the caller's single transaction** — the repository never opens one. ~6 statements for a full card. A failure at batch four leaves nothing behind, which is what RC7's _"a failed upload writes nothing"_ depends on.

### D4. No carry-forward write (D-A7)

Removed. Mediation filters retired polygons out of the file upstream, so a version's rows are exactly its upload (RV3: rows stored = `row_count`) and activation is two status flips via `setVersionStatus` — no `INSERT … SELECT`, no row writes.

### D5. Reads: by id for display, `status = 'ACTIVE'` for resolution

**No resolution path reads a `SUPERSEDED` version** (§6.35). Every read of card rows _for resolution_ filters `status = 'ACTIVE'` on the version.

The version list, the row preview and the diff read a version **by id** and are the only exceptions — they are **display paths, never resolution paths**, which is why §6.35 is phrased about resolution rather than about the table. Write that distinction into the doc-block of the by-id read, because it is the one a future reader will mistake for a loophole.

`getCurrentActive(cardName)` filters on status. It exists now so pm62 and pm63 have one definition of "the current ACTIVE" rather than three.

### D6. No cache, anywhere, ever

No `unstable_cache`, no `revalidate`, no React `cache()`, no module-level `Map`, no in-process copy held across requests (Inv. #59, §1.44). The `ACTIVE` version can change at any activation or rollback, so a cached copy is **stale the moment it is taken** — and a future consumer's version stamp would then name a version it did not read.

This is guardrail 40's subject, and the guardrail lands at **pm65** with the `force-dynamic` page it also covers. This unit simply contains no cache — and the reviewer checks for one, because a repository is exactly where somebody would add it for a good-sounding reason.

### D7. Dates are strings, end to end

`snapshot_date`, `polygon_start_date` and `polygon_end_date` are Postgres `date` columns typed `string` in `YYYY-MM-DD` form end to end (§2.22). **They never become `Date`, never round-trip through `toISOString()`, and never reach `formatDatetime`.** General §2.13's `Date`-in-process rule governs `uploaded_at` and `activated_at` — the two `timestamptz` columns — and only those two.

Getting this backwards moves a `polygon_start_date` by a day at a zone boundary, which changes what a period bills (§4.30). Configure the driver's date handling deliberately and assert it, rather than trusting the default.

### D8. SQL lives here, and status reads are on `tx`, locked

SQL only in `db/**` (§1, general). Any status-gated decision reads its target on `tx`, `FOR UPDATE`, **immediately before the decision** — the TOCTOU bug this module found and fixed four times (pm14, pm15, pm16, pm20). This repository supplies the locked read (`findActiveForUpdate`); pm63 and pm64 make the decision. Treat a pre-transaction status read in a caller as a review-blocking defect on sight.

---

## Implementation

### I1. `db/repositories/ratecard.ts`

Flat path (C6). The three writes and four reads of D1, the constant of D3, the doc-blocks of D5 and D7. Every function takes `tx` or `db` explicitly as its first argument; none opens a transaction.

### I2. Architecture §2 — confirmed (already flat)

Architecture §2 **already** names the flat `db/repositories/ratecard.ts` (verify-only — confirmed 2026-09-27); no edit is owed unless a stale nested path resurfaces. Clear workflow Appendix A row **W6** with its date on the confirmation. Build the file flat.

### I3. Guardrail 37 (re-scoped for `deleteDraftVersion`)

_"`db/repositories/ratecard.ts` exports no update or delete of a **lookup row**, and no version delete except `deleteDraftVersion` — which refuses any version not in `DRAFT`; a direct `UPDATE` or `DELETE` against a row of an `ACTIVE` version is rejected"_ (§9, Inv. #46).

Two arms, both needed: the **exported-surface** arm (by inspection of the module's exports, in the style of the existing `*-repository-exports` guardrails — it asserts no `updateLookupRow`/`deleteLookupRow` of any name, and that the **one** delete export, `deleteDraftVersion`, is version-level and `DRAFT`-guarded) and the **database** arm. The database arm needs whatever mechanism refuses the write — confirm whether pm57a's DDL already refuses it or whether a trigger is required; **if a trigger is required, that is a pm57a finding to raise, not a trigger to add here** (workflow §5.7). Do not let a guardrail's need invent a schema object in the wrong unit.

Also add this unit's entry to the repository mutation allow-list (`*-repository-exports`, `*-module-boundaries`) in the **same commit as the write** — expected, not a surprise.

### I4. Tests — live-DB, against a disposable container

1. A version plus **5,400 rows** insert in batches inside **one** transaction; the row count matches exactly (RV3).
2. A failure injected at the fourth batch leaves **nothing** behind — no version row, no partial rows.
3. `getCurrentActive` returns the `ACTIVE` version and **never** a `SUPERSEDED` one, even when the superseded one is newer by `version_num`.
4. A read-by-id **does** return a `SUPERSEDED` version (D5's display exception, asserted so it is not "fixed" later).
5. Dates round-trip as `YYYY-MM-DD` strings; no `Date` object appears on the read model; a row written at a zone boundary reads back with the same date (D7).
6. **The exported surface has no row-level write** — guardrail 37's exported-surface arm.
7. A direct `UPDATE` / `DELETE` against an `ACTIVE` version's row is rejected — guardrail 37's database arm.
8. No cache wrapper of any kind appears in the module (D6).
9. `deleteDraftVersion` removes a `DRAFT` version and its rows (by cascade); called on an `ACTIVE`, `SUPERSEDED` or `REJECTED` version it **refuses with a typed error and deletes nothing** — asserted on `tx`.

### I5. Documentation

1. **Architecture §2** corrected (I2); **workflow Appendix A W6** cleared with its date.
2. **Code-standards §7 tree** — `db/repositories/ratecard.ts` marked landed under **pm60**; §7.8 annotated as settled.
3. **Code-standards §6.34** — `RATECARD_INSERT_BATCH_SIZE` marked landed and its home named.
4. **`pm00-build-plan.md`** — C6 marked settled.

---

## Dependencies

**Packages to install: none.** Existing Drizzle and core PostgreSQL.

**Commands used:** `npm run db:migrate`, `npm run test` (live-DB integration against a disposable, ephemeral Postgres 16 container — **never** the dev stack's own `DATABASE_URL`), `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** pm57 merged. **Architecture §2 corrected before the file is created** (C6).

---

## Verification checklist

Path and convention

- [ ] The file is `db/repositories/ratecard.ts` — flat, no `product/` sub-folder, no `.repository.ts` suffix.
- [ ] Architecture §2 was corrected **in the same change set**, and W6 is cleared.

Surface — the proof of absence

- [ ] Exactly four writes (`insertVersion`, `insertLookupRows`, `setVersionStatus`, `deleteDraftVersion`) and four reads; no carry-forward write (D-A7).
- [ ] **No `updateLookupRow`, no `deleteLookupRow`, no row-level write of a lookup row**; `deleteDraftVersion` is version-level and refuses anything not `DRAFT`.
- [ ] Guardrail **37** is landed and green on both arms; the repository allow-list entry lands in the same commit.
- [ ] A direct `UPDATE` / `DELETE` against an `ACTIVE` version's row is rejected — and if that needed a schema object, it was **raised as a pm57 finding**, not added here.

Batching and transactions

- [ ] `RATECARD_INSERT_BATCH_SIZE = 1000` is declared once, is not derived at runtime and is not configurable.
- [ ] 5,400 rows insert inside **one** caller-supplied transaction; the repository opens none.
- [ ] A mid-batch failure leaves nothing behind.

Reads

- [ ] `getCurrentActive` filters `status = 'ACTIVE'` and never returns a `SUPERSEDED` version.
- [ ] The by-id read **does** return a superseded version, and its doc-block says why that is a display path and not a loophole (§6.35).
- [ ] Dates are `YYYY-MM-DD` strings end to end; no `Date` object on the read model; no zone shift at a boundary.

Boundaries

- [ ] **No cache of any kind** — no `unstable_cache`, no `revalidate`, no React `cache()`, no module-level store.
- [ ] No service, action, component, page, validation or parser in the diff.
- [ ] Every function takes `tx` / `db` explicitly; a locked read exists for pm63 and pm64.
- [ ] `tsc --noEmit`, ESLint, Prettier and the unit's live-DB suite green.

**Definition of done:** the card's entire data layer exists, inserts five and a half thousand rows in one transaction, stores exactly the rows of the file and nothing else — and cannot edit a single row, which a test proves by looking at what the file does not export.
