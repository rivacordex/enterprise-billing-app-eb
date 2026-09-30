# pm66 — Write UI + the `bodySizeLimit` raise

**Unit:** pm66 (Part 5). **Boundary:** `components/products/rate-card/{upload-version-dialog,upload-error-table,rate-card-diff-panel,rate-card-diff-badge,activate-version-dialog,rollback-version-dialog}.tsx` (new), the controls they hang from in the page header and the selected-version header, and `next.config.ts`. **No service, no action file, no repository, no schema, no migration, no permission row** — every mutation already exists (pm61, pm63, pm64).
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow steps 2–9) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7, RC15, D-A7, D-A8**, **OR7′ (confirmed 2026-09-25)**, _User flows (RevOps)_ · `prodmgmt-architecture.md` §3.6 · `prodmgmt-code-standards.md` §1.19, §1.46, §3.18, §3.19, §3.20, §4.23, §4.25, §4.26, §4.28, §4.29, §4.31, §5.5, §6.38, §7.11 · `prodmgmt-ui-context.md` §10.2, §10.4, §10.6, §10.7 · `prodmgmt-ai-workflow-rules.md` §3.11, §4.4, §4.5, §6.1, §6.9.
**Depends on:** **pm61, pm62, pm63, pm64** (the three mutations and the diff), **pm65** (the page these controls hang from, and C1/C3/C9 settled).

**This unit earns its own place on novelty alone: it is the first `<input type="file">` in the application.** There is no precedent anywhere in the tree for the mechanism, for parse-error reporting, or for the review flow (build plan, Sequencing notes Part 5). The pattern set here is **binding for whatever upload comes next** (§3.20).

---

## Goal

Give RevOps the whole loop on screen — pick a file, see either a draft or a row-level error table, review the diff buckets, activate with the consequences named, and roll back — with the server's typed results as the only source of truth and the body-size ceiling raised so a large file fails as a validation message rather than as a platform error.

---

## Design

### D1. The file input — uncontrolled, `FormData`, and never in form state

**The picker is an uncontrolled `<input type="file">` inside a `form` whose `action` is the Server Action; the action receives `FormData`** (§3.20).

**The file never enters react-hook-form state and is never serialised to JSON or base64.** Not as a convenience, not for a preview, not to show the name. A `File` in form state is a retained buffer with a rendering lifetime, and Inv. #58's "the uploaded file is never stored" is not only about disk.

**No Route Handler** (§5.5). `app/api/product*` still never exists and §5.3's absence guardrail is unchanged. _"An upload needs an endpoint"_ is the reflex to resist; a `multipart/form-data` body reaches a Server Action through `FormData` exactly as a text field does.

### D2. The client header sniff is a convenience and never a boundary

Reading the first line in the browser to reject an obviously wrong file early is **allowed** (§3.19). The server re-parses and re-validates the **entire** file unconditionally, and _"the client already checked it"_ is **never** a reason to skip a server check.

Keep the sniff small and keep it honest: it may say _"this does not look like a rate card export"_; it may **not** say _"valid"_. A client-side green tick on an unvalidated file is worse than no check at all. The sniff compares the first line against **pm58's header map, imported** — never a second spelling of the ten header strings (pm58 I1).

### D3. `UploadVersionDialog` — plain dialog, drop zone, and the hint that does the work

Per ui-context §10.6: plain dialog, `upload` icon in `--text-link`. Drop zone — 2px dashed `--border-strong` on `--surface-sunken`, `--radius-md`, `file-spreadsheet` glyph in `--text-disabled`. Card-name select. **There is no date field**: the file has no date column, and `snapshot_date` is set by the server to the upload date in the app timezone (plan D-A8, pm61). Confirm **"Upload & validate"** in `--action-primary-bg`.

The hint is exact and is not decoration:

> _"Uploads land as **Draft**. Nothing takes effect until you activate it."_

It is the sentence that makes RC7's two-step gate legible at the moment the user is deciding, rather than a surprise after the upload lands.

Touch targets follow §7 — 28px icon buttons at fine pointer, **44px minimum under `@media (pointer: coarse)`**. The drop zone is already well past 44px (ui-context §10.7).

### D4. `UploadErrorTable` — a table, in a plain dialog, quoting the validator verbatim

**Not an `AlertDialog`** (ui-context §10.6): _the failure already happened and there is nothing to confirm_. A plain dialog with `alert-triangle` in `--text-danger`, a danger banner — _"No version was created. Fix the file and upload again."_ — then the table.

Columns **Line · Column · Value · Reason** (§4.28): `tabular-nums` on Line, `--font-mono` on Value, reason in plain body text **quoting the validator verbatim** — e.g. _"Polygon Start Date must be a real date in YYYY-MM-DD form"_. The copy is keyed to pm58's three `RateCardUploadViolation` codes — `HEADER_MISMATCH`, `DUPLICATE_ROW_KEY`, `ROW_SCHEMA_INVALID` — and is not paraphrased. There is no copy for `SNAPSHOT_DATE_NOT_CONSTANT`: it is withdrawn (plan D-A8). A `HEADER_MISMATCH` row names the column exactly as the file spelled it (an unknown `Date`, a mis-cased `Polygon Id`). Paraphrasing here means the user reads one thing and the contract says another.

**Not a toast and not a list of strings** (§4.28). **The dialog stays open and the file input keeps its selection**, so the user sees what failed against what they actually picked. That detail is the difference between a usable error report and one that makes people re-pick the file to read it.

**Line numbers are pm58's**, with the header counted as line 1 — rendered exactly as returned, never re-derived. An off-by-one introduced here points every reported row at its neighbour.

### D5. `RateCardDiffPanel` and `RateCardDiffBadge` — three buckets, billing-consequence order

The panel renders pm62's three buckets **in contract order**: `added`, `changed`, `removed`, each section headed by its count (§4.25).

`RateCardDiffBadge` is the **tenth binding component name**, settled at pm65 (C9). Its three values are ui-context §10.2's, and all three render **in one view**, so they must be distinguishable by **hue _and_ icon**:

| Category | Tint family | Icon     | Note                                                                                                                                       |
| -------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Added    | Success     | `plus`   |                                                                                                                                            |
| Changed  | Info        | `pencil` | Info rather than warning, because warning is already spoken for on this page (Draft badge, the validation tab's count) — ui-context §10.1. |
| Removed  | **Danger**  | `minus`  | A deliberate departure from §1's neutral end-of-life treatment.                                                                            |

**"Removed" takes danger, and the copy carries the nuance so danger never reads as _deleted_**: a removed key is one in the current `ACTIVE` version that is absent from the upload — it is **not in the new version, and stays readable in the version being superseded** (plan D-A7). The qualifier _"Not in this upload; still held by `RCV########`"_ sits in `--text-muted`, the superseded version id in `--font-mono` (ui-context §10.2, §4.25). The label is **"Removed"** — never "Retiring", never "Deleted". There is no closing date and no carry-forward copy: nothing is copied into the new version.

**Changed-value cells** show both states inline: old in `--text-muted` with `line-through`, new in `--text-primary` weight 500, **both `--font-mono`**. No red/green fill on the cell — the row's category badge already carries the colour.

### D6. `ActivateVersionDialog` — the page's one CTA, and it carries the decision

**`--action-cta-bg` is used exactly once on this page.** ui-context §10.6 assigns it to **"Activate version"**; code-standards §4.31 assigns it to **"Upload new version"**. That is a third doc-vs-doc disagreement in §10 and it must be **recorded, not silently resolved** (workflow §7.10).

**Settled: the CTA is "Activate version".** ui-context §10.6 argues it explicitly and correctly — _"Upload new version" creates a record and therefore takes `--action-primary-bg`, per the shared §3.3 rule that record-creation triggers never take the CTA_; activation is the single featured confirm and the only act on the page with billing consequence. The mockup agrees. **Correct code-standards §4.31 in this change set** and record the conflict as **C10** in `pm00-build-plan.md`.

The dialog is a **plain confirmation, not danger** (§7's Activate-confirmation construction). Above the confirm control (§4.26, ui-context §10.4) it carries:

1. the **version being superseded**, named;
2. the **change counts** — added / changed / removed — in a metadata strip.

There is **no carry-forward summary banner** (plan D-A7): activation is two status flips and writes no rows, so the counts are the whole consequence.

**It is not a bare "Are you sure", and it is not warning-tinted** (§4.26). Activation is the single act on the page with consequence — a mis-keyed CSV becoming the live version — and the DRAFT gate, the diff and this confirmation are the review that stands before it. Weakening the copy weakens that review.

The counts shown come from pm62 via the server; the counts **recorded** come from pm63 computed inside the transaction (pm63 D8). Those can differ if the card changed between render and click — which is exactly why the audit records its own.

### D7. `RollbackVersionDialog` — plain, reversible, same counts the other way

**Plain confirmation, not danger** — versions are immutable, so nothing is lost and the move is itself reversible (ui-context §10.6). It names the version being demoted and repeats the same counts **computed in the other direction** (pm62 D6, pm64 D4). Confirm in `--action-cta-bg` inside the dialog.

Activate and Roll back **never co-render** — a version cannot be both `DRAFT` and `SUPERSEDED` — so the one-accent-per-view rule holds, the same allowance §5 already grants the catalog's Activate dialog.

### D8. "Discard draft" is **not built** — C2

ui-context §10.6 specifies a danger `AlertDialog` that **deletes** a `DRAFT` version and its rows. Against it, four scope rules at once (C2):

- `ratecard` is **READ/EDIT only, with no DELETE** (§8, workflow §3.11);
- audit types are capped at **three** (workflow §3.12) and all three are spent;
- `EXPECTED_PRODUCT_ACTION_FILES` moves by **exactly three** (§3.21) and has;
- **upload is the only write path** (Inv. #46).

A **standalone** discard dialog would be a fourth mutation, a fourth action file, a fourth audit type **and** a delete — so the ui-context §10.6 danger `AlertDialog` is **still not built**. Remove that row from §10.6 or mark it explicitly deferred with an owner — do not leave a specified danger dialog the page does not have.

**But the abandoned-draft trap it was meant to solve is now solved another way (D-A11, pm61 D12).** A new upload for the card **replaces** the open draft (the upload service discards it via pm60's `DRAFT`-guarded `deleteDraftVersion`, then inserts). So a wrong draft no longer blocks the card: the recovery is "upload the right file again," not a discard button. This **reopens and resolves C2** — a discard exists, but only implicitly through re-upload, with **no** new permission, audit type or action file. There is therefore no residual "abandoned draft blocks the next upload" consequence to name; where earlier drafts of this spec said there was, it is superseded.

### D9. `next.config.ts` — platform-owned, called out, splittable

`experimental.serverActions.bodySizeLimit: '4mb'` (RC15, §6.38). **The file has no `experimental` key today, so this adds one.**

The Next default is 1 MB and a ~0.5 MB card fits. **The raise exists so that the day a card does not fit, the user sees a validation message instead of a generic body-size error that reads as a bug.** Buying the headroom now is cheap; discovering the limit in production is not.

It is a **platform-owned root file**, not covered by code-standards §7's tree, and **must be called out in review** rather than folded silently into the diff (§1.46, workflow §6.9). **If review stalls on it, split it into its own commit** rather than holding the upload UI hostage (workflow §4.5).

Raising it **further** triggers the RC15 revisit (architecture §1): past roughly 50k rows the schema is unchanged and the **loader** is what must change — streaming parse, staging table, or a Kestra flow. Write that in the config comment so the next person to raise it reads it first.

### D10. Client leaves, and nothing mirrors the server

The four dialogs and the file picker are client leaves. **`RateCardVersionTable`, `RateCardRowPreview` and `RateCardDiffPanel` stay server components** — a client dialog hanging off a server table is the pattern `manage-products` already uses (§3.6's spirit; the pricing update's explicit three-leaf budget is Part 4's and does not extend here, but the principle does).

**Every refusal renders from the server's typed result, never from client state** (§3.13's rule, applied). The dialogs do not re-implement any validation, do not pre-check the status transitions and do not decide whether Activate is allowed — they render `{ ok, code, issues }` and nothing else. A client-side mirror of a server rule is drift the moment either changes.

### D11. Read-only stays read-only

A `ratecard : READ` user sees the list, the rows and the diff in full, and **every control in this unit is absent, not disabled** (ui-context §10.7, pm65 D11). All three mutations are refused **at the action guard** regardless (§8 notes) — the absent control is the courtesy; the guard is the boundary.

An `ACTIVE` version shows **no mutating action at all** (ui-context §10.6): versions are immutable, and replacing one is an upload, not an edit.

---

## Implementation

### I1. Components

The six files of the boundary, per D3–D7, in `components/products/rate-card/**`. Reuse the Administration table primitives for the error table and the diff rows (§4.3) — **no parallel table implementation**. `components/ui/` is composed, **never edited** (workflow §6.1). Import nothing from `manage/` (§7.11).

### I2. Controls on the page

"Upload new version" in the page header in `--action-primary-bg` (D6), always shown to `ratecard : EDIT`. "Activate version" on a `DRAFT` only; "Roll back to this version" on a `SUPERSEDED` only; both in the **selected version's header**, not on every list row (§4.10). `ACTIVE` gets nothing (D11).

### I3. `next.config.ts`

D9, with the RC15-revisit comment, called out in review, splittable.

### I4. Documentation

1. **`prodmgmt-code-standards.md` §4.31** — corrected to name **Activate** as the page's one CTA (**C10**, D6); the conflict recorded in `pm00-build-plan.md`'s C-table.
2. **`prodmgmt-ui-context.md` §10.6** — the "Discard draft" row removed or marked deferred with an owner (**C2**, D8); the export rows already handled at pm65 (**C4**).
3. **`prodmgmt-code-standards.md` §7 tree** — the six components and `next.config.ts` marked landed under **pm66**; §4.23's list (ten names after C9) confirmed complete.
4. **`prodmgmt-code-standards.md` §6.38** — marked landed with its value.
5. **`pm00-build-plan.md`** — C2 recorded as **declined**, with the four rules it would break and the abandoned-draft consequence it leaves standing.

### I5. Tests

1. **End to end, the whole loop:** a bad file shows the error table and **creates nothing**; a good one creates a `DRAFT`; the diff renders three buckets; Activate names what it supersedes and the added / changed / removed counts; Rollback restores the previous version.
2. The upload form posts `FormData` from an **uncontrolled** file input; the file appears in **no** react-hook-form state and is never serialised (D1) — assert by inspecting the submitted payload and the form state.
3. The client header sniff rejects an obviously wrong file **and the server still re-validates a file that passed it** — assert the server ran, not that the client said yes (D2).
4. `UploadErrorTable` renders Line · Column · Value · Reason, **quotes the validator verbatim**, keeps the dialog open and **keeps the file input's selection** (D4). A file carrying a `Date` column shows a `HEADER_MISMATCH` row naming `Date`; there is copy for exactly the three pm58 codes and none for `SNAPSHOT_DATE_NOT_CONSTANT`; the upload dialog has **no date field** (D3).
5. Line numbers are rendered exactly as returned; the first data row shows **2**.
6. The three diff badges are distinguishable by **hue and icon**, all three in one view; changed cells show old (`line-through`, muted) and new inline, both mono.
7. The removed section is labelled **"Removed"**, names the superseded version that still holds those keys, and the words "Retiring" and "carried forward" appear nowhere.
8. The activate dialog shows the superseded version and the change counts (added / changed / removed) — **above** the confirm control — and no carry-forward summary.
9. **`--action-cta-bg` is used exactly once on the page**, on Activate; Upload is `--action-primary-bg` (D6).
10. Activate and Rollback never co-render.
11. A `ratecard : READ` user sees **none** of these controls (absent, not disabled) and is refused all three mutations **at the action guard**.
12. An `ACTIVE` version shows no mutating control.
13. **No "Discard draft" control exists in any form** (D8).
14. No `app/api/**` path is added; §5.3's guardrail still passes.
15. Touch targets meet 44px under `@media (pointer: coarse)`.
16. A file larger than the old 1 MB default but under 4 MB **reaches validation and fails as a validation message**, not as a platform body-size error (D9).

---

## Dependencies

**Packages to install: none.** No file-upload library, no drag-and-drop library, no table library, no CSV helper on the client — the drop zone is a styled label over a native input, and `FormData` is native (§5.5). pm59 added the only dependency this update needs, and it is server-side.

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run test`, `npx tsc --noEmit`, `npm run lint`, `next build`.

**Prerequisites:** pm61–pm65 merged.

---

## Verification checklist

The upload mechanism (binding for whatever comes next)

- [ ] Uncontrolled `<input type="file">` inside a `form` whose `action` is the Server Action; the action receives `FormData`.
- [ ] **The file never enters form state and is never serialised to JSON or base64.**
- [ ] The client header sniff rejects early but grants nothing; the server re-validates unconditionally.
- [ ] **No Route Handler**; `app/api/product*` still does not exist.

Error reporting

- [ ] A bad file creates **nothing** and shows Line · Column · Value · Reason in a **plain dialog**, not an `AlertDialog`, not a toast.
- [ ] Reason copy quotes the validator **verbatim** and is keyed to pm58's three codes; no `SNAPSHOT_DATE_NOT_CONSTANT` copy exists.
- [ ] The upload dialog has no date field; the client sniff imports pm58's header map.
- [ ] The dialog stays open and the file input keeps its selection.
- [ ] Line numbers are rendered as returned; the first data row is 2.

Diff and confirmations

- [ ] Three buckets in billing-consequence order, each headed by its count.
- [ ] `RateCardDiffBadge` distinguishes all three by hue **and** icon.
- [ ] Removed is labelled **"Removed"** and names the superseded version; "Retiring" and "carried forward" appear nowhere.
- [ ] Changed cells show old and new inline, both mono, with no cell fill.
- [ ] Activate names the superseded version and the added / changed / removed counts, above the confirm; no carry-forward summary.
- [ ] Rollback is plain, not danger, and repeats the counts in the other direction.
- [ ] **`--action-cta-bg` appears exactly once on the page**, on Activate; §4.31 corrected (C10).
- [ ] Activate and Rollback never co-render.

Absences

- [ ] **No "Discard draft"** control, no `ratecard : DELETE`, no fourth action file, no fourth audit type (C2 — recorded as declined).
- [ ] A `ratecard : READ` user sees no mutating control at all, and is refused all three at the action guard.
- [ ] An `ACTIVE` version shows no mutating control.
- [ ] No client-side mirror of any server rule; every refusal renders from the typed result.

`next.config.ts`

- [ ] `experimental.serverActions.bodySizeLimit: '4mb'` landed, **called out in review**, with the RC15-revisit comment.
- [ ] A 2 MB file fails as a **validation message**, not a platform error.
- [ ] The raise was splittable and was split if review stalled.

Boundaries

- [ ] No service, action file, repository, schema, migration or permission row in the diff.
- [ ] `components/ui/` untouched; nothing imported from `manage/`; no parallel table implementation.
- [ ] Touch targets meet 44px under coarse pointer.
- [ ] `tsc --noEmit`, ESLint, Prettier, the suite and `next build` green.

**Definition of done:** a Revenue Operations user picks a CSV, is told precisely which rows are wrong and that nothing was created — or reviews the diff buckets, sees what the new version supersedes and what it adds, changes and removes, and activates it — using the application's first file upload, which is now the pattern for every one after it.
