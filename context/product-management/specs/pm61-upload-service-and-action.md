# pm61 — Upload: service + action

**Unit:** pm61 (Part 5). **Boundary:** `services/product/ratecard/upload-version.ts` (new), `actions/product/upload-ratecard-version.action.ts` (new — `EXPECTED_PRODUCT_ACTION_FILES` **+1**), the `RATECARD_VERSION_UPLOADED` audit type and its ripple, and this unit's live-DB tests. **No UI** — pm66 builds the dialog. **No diff** — pm62. **No activation** — pm63.
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow steps 2–5; goal 2) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7, RC15**, **D-A1**, **D-A8**, **OR7′ (confirmed 2026-09-25)** · `prodmgmt-architecture.md` §3.6, §4, §5 (Audit), Inv. **#46, #51, #57, #58** · `prodmgmt-code-standards.md` §1.40, §1.41, §1.42, §1.43, §2.24, §2.25, §3.18, §3.19, §3.20, §3.21, §3.22, §3.23, §6.18, §6.36, §6.37, §7.9 · `prodmgmt-ai-workflow-rules.md` §3.7, §3.12, §4.3, §7.4, §8.3, §8.4, §8.9, §8.12.
**Depends on:** **pm59** (the parser), **pm60** (the repository), **pm58** (the contract); **G-RC3** (the permission the guard names).

---

## Goal

Turn an uploaded CSV into exactly one `DRAFT` version in one transaction — parse, validate structurally, insert in batches — and on any refusal return a row-level error report having written **nothing at all**, including no version row.

---

## Design

### D1. The pipeline, in order, and why the order is the security argument

The upload action's shape deliberately differs from §3.7's ordinary action shape, and **that difference is the whole security argument** (§3.18):

```
requirePermission('ratecard', 'EDIT')
  → isRedirectError catch
  → take the file off FormData
  → check extension, MIME type and byte size BEFORE reading it
  → parse to rows with the pinned parser (pm59)
  → fileSchema.safeParse        (header, duplicate keys)
  → row schema per row
  → one write service, one transaction  (snapshot_date = upload date, app timezone — D4)
  → revalidatePath('/products/rate-card')
  → typed result
```

`safeParse` still runs **before any service call**; it simply cannot run on a file handle. **Never parse a `FormData` envelope and treat the pass as validation of the file's contents** (§3.18) — the envelope tells you a file arrived, not what is in it.

The three pre-read checks (extension, MIME, byte size) are cheap refusals on an obviously wrong input, taken **before** the bytes are read into memory. They are not validation and they are not a substitute for it.

### D2. `requirePermission` comes first, and the client's header sniff grants nothing

`ratecard : EDIT` (§8). Upload and activate deliberately share **EDIT** so one RevOps user is never blocked mid-task (RC7); activation is gated by the **diff review**, not by a higher level.

pm66 may read the first line in the browser to reject an obviously wrong file early. That is a **convenience and never a boundary** (§3.19): the server re-parses and re-validates the **entire** file unconditionally, and _"the client already checked it"_ is never a reason to skip a server check. A `ratecard : READ` principal is refused **at the action guard** and receives **no partial effect**.

### D3. Validation is structural only, and `lkp_subscriber_ref_id` is stored as uploaded

Validation is **structural** — the file schema and the per-row schema of pm58, and nothing more. There is **no referential check** of any cell against another table: `lkp_subscriber_ref_id` (a `product_inventory.product_inventory_id` value carried as plain `text`, no FK) is **stored exactly as uploaded**, and `service_code` is a plain `text` column with no meaning to check. This unit **does not read `inventory`, `ordering/**` or any other module** — the only reads are through pm60's repository.

The one non-structural signal is a duplicate-file warning: a `file_checksum` matching an earlier version **surfaces on the draft review and never refuses** (§6.37). Re-uploading the same file after a rollback is legitimate, and the column carries no unique constraint. It is returned as a `warning`, not persisted (D6).

### D4. `snapshot_date` is the upload date, set here — not read from the file

The RevOps file has **no date column** (plan D-A8; pm58 D0). This service sets `snapshot_date` to the **calendar date of the upload in the app timezone**, as a `YYYY-MM-DD` string (§2.21). Nothing is hoisted from the file, and a file that carries a `Date` column has already been refused as `HEADER_MISMATCH` before this point.

- **One instant, both columns.** The service takes the upload instant as a parameter (`uploadedAt: Date`); the action passes `new Date()` once. `uploaded_at` is stamped with it and `snapshot_date` is derived from it, so the two can never disagree across midnight.
- **The zone is the app's, never UTC.** Resolve it with `getAppTimezone()` and take the local `year` / `month` / `day` with stdlib `Intl.DateTimeFormat(…, { timeZone }).formatToParts` — um29's zero-dependency approach. **Never `uploadedAt.toISOString().slice(0, 10)`**: that is the UTC date, a day behind for eight hours of every day in `Asia/Kuala_Lumpur`. If `lib/timezone.ts` already has a calendar-date-in-zone helper, reuse it; if not, adding one there is a shared-file edit — call it out in review, and do not fork a second date helper in `services/product` (workflow §3.13).
- **Only the action supplies the real clock.** Tests pass a fixed instant (I5.11). The demo seed (pm67) passes the real clock too — it never backdates a version.

A late upload records a later `snapshot_date`. That is accepted (plan D-A8): nothing in this delivery reads `snapshot_date` for matching.

### D5. A failure writes nothing — including no version row

On any refusal the service returns the row-level error report and **inserts nothing** (§1.42, RC7). Consequently `status = 'REJECTED'` and `reject_summary` have **no writer in this phase**. They exist for a future asynchronous ingest and are **dead in Phase A by design** (workflow §3.5).

**Do not invent a writer to make the columns look used.** A `REJECTED` version row would be a lie about what happened — nothing was created — and it would put a failed upload into the version list where a user would reasonably try to activate it.

The whole pipeline therefore validates **before** opening the transaction; the transaction contains only the inserts and the audit write. That ordering is what makes "writes nothing" true by construction rather than by rollback.

### D6. The typed result — a union, never a throw

```
{ ok: true;  versionId: string; rowCount: number; warnings: RateCardIssue[] }
{ ok: false; code: RateCardUploadViolation; issues: RateCardIssue[] }
```

(§2.24, general §2.9). `RateCardUploadViolation`'s **three** members (`HEADER_MISMATCH` · `DUPLICATE_ROW_KEY` · `ROW_SCHEMA_INVALID`) are pm58's and are closed — **never invent a fourth** (workflow §5.4). `RateCardIssue` carries line · column · value · reason with the header counted as line 1 (§2.25); this unit **must not renumber**, because pm66's error table renders exactly what this returns.

`warnings` on the success path is how D3's duplicate-file warning reaches the draft review. It is returned, not persisted — there is no warning column, and `reject_summary` is not it (D5).

### D7. One transaction, one audit event

`RATECARD_VERSION_UPLOADED`, written **in the same transaction as the data change** (§1.43, architecture §5). Page reads, row previews and diff reads are **never** audited.

**The audit ripple is not `tsc`-caught in full** (§6.18, workflow §7.4). Three things are needed and the third bites every write unit in this module's history:

1. the `AUDIT_EVENT_TYPES` entry,
2. the `AUDIT_EVENT_CATEGORY_MAP` entry (**`tsc`-caught**),
3. the bumped event-type count and optgroup assertion in `tests/components/audit-log-filters.test.tsx` (**not `tsc`-caught**).

This unit lands one of the update's three types. pm63 and pm64 land the other two; each does the full ripple for its own, rather than one unit doing all three up front.

### D8. `EXPECTED_PRODUCT_ACTION_FILES` +1, and the guardrail moves with it

`actions/product/upload-ratecard-version.action.ts` is the **first movement in that list since the Manage rebuild** — the pricing update left it unchanged (§3.7, §3.21). The guardrail asserting the list is updated **in the same change set, never afterwards**.

Across pm61 + pm63 + pm64 the list moves by **exactly three** (§3.21). Stating the total here, in the first of the three, is what makes an accidental fourth visible.

### D9. Revalidate narrowly

`revalidatePath('/products/rate-card')` **and nothing else** (§3.22). No catalog page reads the card, so revalidating `/products/manage-products` or `/products/product-offering` here would be a lie about what changed. `router.refresh()` is not the success path.

At this unit the route does not exist yet (pm65 builds it). `revalidatePath` on a path Next does not yet serve is harmless — call it anyway, so the action is complete and pm65 adds a page rather than a missing call.

### D10. The file is never stored, and never enters form state

**Filename and checksum only** (Inv. #58, §6.36) — `source_file` is forensics, `file_checksum` is duplicate detection. No blob, no `landing/` drop, no temp file, no retained buffer. This is a **deliberate departure** from `context/architecture.md` §3's _"binary goes to Azure Blob, the DB stores a reference"_: that rule anticipates uploads the app must hand back, and a card's rows **are** the record of its upload. The platform doc owes a one-line follow-up saying an ingest path now exists and its answer is parse-and-discard — **propose it; it is platform-owned** (workflow §7.9).

**The file never enters react-hook-form state and is never serialised to JSON or base64** (§3.20). The picker is an uncontrolled file input inside a `form` whose `action` is the Server Action; the action receives `FormData`. That is pm66's construction, and it is **binding for whatever upload comes next** — which is why it is written down in the unit that defines the server half.

### D11. No Route Handler

Upload is an ordinary Server Action. `app/api/product*` still never exists and §5.3's absence guardrail is unchanged (§5.5). _"An upload needs an endpoint"_ is the reflex to resist here, not a requirement. The body-size ceiling is raised in `next.config.ts` at **pm66**, never routed around.

### D12. An open `DRAFT` is replaced, not refused (D-A11)

If an open `DRAFT` already exists for the card, this upload **replaces** it: inside the one upload transaction, before inserting, call pm60's `deleteDraftVersion` on the existing draft (a `DRAFT`-guarded version delete; its rows go by cascade), then insert the new `DRAFT`. This is the recovery path for a wrong upload — without it, the one-`DRAFT`-per-card partial index (pm57a) would let a single fat-fingered upload block every future upload for the card until it was activated (the abandoned-draft trap C2 originally left standing).

It stays inside the scope rules: **no new permission** (still `ratecard : EDIT`), **no `ratecard : DELETE`**, **no fourth audit type** (the replace emits the same one `RATECARD_VERSION_UPLOADED` for the new draft), and **no fourth action file** — the discard is a repository write, not its own action. Lookup rows are still only inserted or cascade-removed, never edited (Inv. #46). This **reopens and resolves C2**: a discard exists, but only implicitly via re-upload, never as a standalone control.

**`version_num` is read on `tx`.** The service reads `max(version_num)` for the card **inside the transaction** and assigns `max + 1`. Because the replaced draft is deleted first, the new draft takes the same number the old one held; `UNIQUE (card_name, version_num)` is the backstop. Reading the max outside the transaction is the same TOCTOU class §1.13 forbids elsewhere — do it on `tx`, after the `deleteDraftVersion`.

---

## Implementation

### I1. `services/product/ratecard/upload-version.ts`

The pipeline of D1 from the parse onward: file schema, row schema (structural only, D3), then **one transaction** that — if an open `DRAFT` exists for the card — calls `deleteDraftVersion` (pm60, D12), reads `max(version_num)` on `tx`, then calls `insertVersion` + `insertLookupRows` (pm60) and writes the audit event. Framework-agnostic — **no `next/*` import** (§7.2). `snapshot_date` is computed here from the upload instant in the app timezone (D4) — nothing is hoisted from the file; `row_count` is the uploaded row count, and equals the rows stored (RV3, D-A7).

### I2. `actions/product/upload-ratecard-version.action.ts`

D1's order exactly, including the three pre-read checks. One service call. `revalidatePath` per D9. Typed result per D6.

### I3. Audit

`RATECARD_VERSION_UPLOADED` with the full three-part ripple of D7, including the assertion `tsc` does not catch.

### I4. Guardrails and lists

`EXPECTED_PRODUCT_ACTION_FILES` +1 with its guardrail updated in the same commit (D8). The repository mutation allow-list gains this unit's entry.

### I5. Tests — live-DB

1. A valid ~5,400-row CSV creates **exactly one** `DRAFT`, with `row_count` matching the rows stored.
2. The current `ACTIVE` is **untouched and still active** afterwards.
3. **Every refusal case creates no version** — assert `count(*) = 0` on `ratecard_version` after each structural failure: duplicate row key; missing column; unknown column (a `Date` column is one — D-A8).
4. A `file_checksum` match warns and does **not** refuse; the draft is created.
5. **The upload query budget holds — including after a failed upload** (§3.23): no per-row query, no `Promise.all` over rows. Assert the query **count**, not just the absence of a loop.
6. `ratecard : READ` is refused **at the action guard**, with no partial effect and no version row.
7. Exactly **one** audit event per successful upload, in the same transaction; a failed upload writes **none**.
8. A second upload while a `DRAFT` is open **replaces** it (D12, D-A11): the prior draft and its rows are gone, exactly **one** `DRAFT` remains for the card, and it carries the new file's rows. Assert the old draft's `ratecard_version` row and its lookup rows are absent, that the one-`DRAFT` partial index still holds (one draft, not two), and that no second audit type was emitted. A concurrent variant (two uploads racing when no draft exists) still serializes on the `DRAFT` index — assert the loser surfaces a typed refusal, not a raw `23505`.
9. The file is not written to disk and no buffer survives the call (D10) — assert no `fs` write in the path.
10. `EXPECTED_PRODUCT_ACTION_FILES` moved by exactly one here; the running total toward three is recorded.
11. **`snapshot_date` is the upload date in the app timezone** (D4): with `APP_TIMEZONE=Asia/Kuala_Lumpur` and a fixed `uploadedAt` of `2026-09-25T17:00:00Z`, the version's `snapshot_date` is `2026-09-26`, not `2026-09-25`; with `UTC` it is `2026-09-25`. `uploaded_at` equals the instant passed in.

### I6. Documentation

1. **Code-standards §7 tree** — `upload-version.ts` and the action marked landed under **pm61**.
2. **Code-standards §3.21** — the first of three movements recorded.
3. **Architecture §5 (Audit)** — the first of three types marked landed.
4. **`context/architecture.md` §3** — the parse-and-discard follow-up **proposed** (D10), not written (workflow §7.9).
5. **`pm00-build-plan.md`** — nothing owed for OR7′: it is **resolved** (2026-09-25) and recorded in the hand-off register. `lkp_subscriber_ref_id` is still stored **as uploaded, validated structurally only** (D-A1).

---

## Dependencies

**Packages to install: none.** pm59 added the one dependency this update needs.

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run test` (live-DB integration against a disposable container), `npx tsc --noEmit`, `npm run lint`.

**Prerequisites:** pm58, pm59, pm60 merged. **G-RC3** for the permission the guard names.

---

## Verification checklist

Order and authorization

- [ ] The action runs `requirePermission('ratecard', 'EDIT')` **first**, then the `isRedirectError` catch, then the file checks, then parse, then `safeParse`, then one service.
- [ ] Extension, MIME type and byte size are checked **before** the bytes are read.
- [ ] `ratecard : READ` is refused at the action guard with **no partial effect**.
- [ ] No client check is relied on for anything.

Writes nothing on failure

- [ ] Each structural refusal case leaves `ratecard_version` and `RATECARD_RAN_USAGE_LKP` **empty of that upload** — asserted by count, per case.
- [ ] `status = 'REJECTED'` and `reject_summary` have **no writer**; neither is populated anywhere in the diff.
- [ ] Validation completes **before** the transaction opens.

Success path

- [ ] A valid CSV creates exactly one `DRAFT`; `row_count` matches the rows stored.
- [ ] The current `ACTIVE` is untouched and still active.
- [ ] `snapshot_date` is set by the service from the upload instant in the app timezone — never read from the file, never the UTC date (D4).
- [ ] A second upload against an open `DRAFT` **replaces** it (D12): one `DRAFT` remains, the prior draft's rows are gone, and only one upload audit event is written. The concurrent race still serializes on the index and the loser gets a typed refusal, not a raw `23505`.

Validation

- [ ] Validation is **structural only** — the file schema and per-row schema of pm58; no referential check of any cell against another table.
- [ ] `lkp_subscriber_ref_id` is stored **exactly as uploaded** as plain `text`; `service_code` is plain `text` with no meaning checked.
- [ ] No per-row query, no `Promise.all` over rows, no concurrency-limited mapper — asserted by **query count**.
- [ ] A `file_checksum` match warns and does not refuse.

Result contract

- [ ] The result is a typed union, never a throw; `RateCardUploadViolation` still has exactly three members.
- [ ] Line numbers are pm58's, unrenumbered; the first data row is line 2.
- [ ] Warnings are returned, not persisted.

Audit, lists and boundaries

- [ ] Exactly one `RATECARD_VERSION_UPLOADED` per success, in the same transaction; none on failure; no read is audited.
- [ ] All three parts of the audit ripple landed, including the assertion `tsc` does not catch.
- [ ] `EXPECTED_PRODUCT_ACTION_FILES` +1 with its guardrail updated in the same commit; the running total to three is recorded.
- [ ] `revalidatePath` names `/products/rate-card` **only**.
- [ ] No `app/api/**` path; no blob, no temp file, no retained buffer; the file never enters form state.
- [ ] `ordering/**` and `inventory` untouched; the only reads are through pm60's repository.
- [ ] `tsc --noEmit`, ESLint, Prettier and the unit's suite green.

**Definition of done:** RevOps can upload five and a half thousand rows and get back either one draft version or a list of the rows that were wrong — and in the second case the database looks exactly as it did before they pressed the button, which a test proves by counting.
