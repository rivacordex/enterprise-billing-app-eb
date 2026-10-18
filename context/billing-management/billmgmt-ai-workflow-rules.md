# Billing Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first and obey it in full. This supplement never weakens it. Where §6 below pre-authorizes an edit to a file the general §5 protects, that is the recorded instruction general §5 asks for. It does not skip general §5's "stop, explain why, and get explicit confirmation" step, which you still run at the start of that unit. It records only the Billing Management deltas and the rules from delivered work that still bind every later change. **No update is in flight:** Invoice Template Phase 3 (the bill run uses the BAN's invoice template, plus the new Standard layout written into v1) was signed off by the bm73 ship gate on 2026-10-17, and its still-binding rules are in §0 item 8. §1–§8 keep the Phase 3 unit discipline as the record, and as the default for the next update until that update's own revision replaces them. Where a facet is not mentioned here, the general rule applies unchanged. If anything here appears to weaken a general rule or a Module Invariant, stop and treat it as a bug.

**Companion docs (authoritative; do not restate or contradict them):**

- `billmgmt-update-overview.md`: pointers only; no update is in flight. `billmgmt-project-overview.md` holds everything delivered: phases 1–4 (bm01–bm39), Target Capacity Pricing (Part 1, bm40–bm46), the Invoice Template update (Part 2, bm47–bm63) and Invoice Template Phase 3 (bm64–bm73), with success criteria 1–15 and their evidence.
- `_updatemodule-billing-invoice-template-phase3-billrun-plan.md`: the design authority, decisions **D1–D60**. Later decisions amend earlier ones; each amendment names what it amends.
- `billmgmt-architecture.md`:
  - **58 Module Invariants (§6)**. **#51–#58** are Invoice Template Phase 3's (built bm64–bm72, audited at bm73); #15 is a retired tombstone.
  - The 2026-10-15 amendment notes under #36, #40, #41, #42, #44 and #46.
  - The dated section _Invoice Template Phase 3 — architecture deltas_, including its contradiction table **P1–P11**.
- `billmgmt-code-standards.md`:
  - The dated section _Invoice Template Phase 3 — code-standards deltas_.
  - **Guardrail items 57–67**.
  - Its _Rules superseded by this update_ and _Existing inconsistencies_ tables.
- `specs/bm00-build-plan.md`: the authority on unit numbering, boundaries and build order. Phase 3 is units **bm64–bm73**; all ten specs are written (`specs/bm64`–`bm73`, 2026-10-15).
- `_updatemodule-rating-udr-key-resource-plan.md` and `context/rating-management/specs/rm24`–`rm29` (rating Phase H): the rating prerequisite. `context/rating-management/ratemgmt-ai-workflow-rules.md` is **binding on you** for any rating-side change.

**Naming:** "Phase 3" in this file always means **Invoice Template Phase 3**. It never means the bill run's own Phase 3 (bm14–bm35). Write "Invoice Template Phase 3" in every spec, commit and doc you produce.

**Precedence:** the general order stands (architecture **Invariants** → overview → architecture → code-standards → this supplement → general rules). One module addition: for in-flight work, `billmgmt-update-overview.md` is the overview, and the plan's later decision wins over its earlier one.

**Current state:** `billmgmt-progress-tracker.md` is the only status source. This file keeps no status snapshot. Check the tracker against `git log` on `dev1` before you start.

---

## 0. Carried-Forward Module Rules (Delivered Work, Still Binding)

These come from phases 1–4, Part 1 and Part 2. They are **permanent**, and Phase 3 touches the code they protect. A unit that violates one is a review-blocking defect.

1. **Compute lives in the flow; rendering lives in the app.**
   - All bill-data computation runs in `workflow-management/flows/bill-run-processor/` as `billrun_runtime` (Inv #17, #29), enforced by `billing-trial-bill-compute-boundary.test.ts`.
   - The app writes run-state, posting and posting stamps only.
   - The engine never renders and never reads the template or asset containers.
2. **Reversed rules stay reversed.** `customer_bill_line` **is** the charge record (Inv #3). Recurring derivation is billing compute; usage rating is not (Inv #1). Inv #15 is a tombstone.
3. **Cross-schema writes are fixed.** In `rating`, write only the six claim columns, through `udr-status.repository.ts` (Inv #2). Grant per table, never `ON ALL TABLES` (Inv #23).
4. **The finalization boundary is fixed.**
   - Once `ref_inv_document_id` is set, the bill header never changes (Inv #4, migration `0033`).
   - Posting is per account, in one transaction (Inv #6).
   - Four-eyes guards the money gate (Inv #8).
   - Every posting stamp lands in the same `UPDATE` as `ref_inv_document_id` (Inv #41).
5. **Capacity pricing is settled.**
   - Bill Model 1; Model 2 only checks (Inv #29).
   - `capacity_rate_matching` defaults ON and code never ships it OFF (Inv #30). OFF logs a WARN and bills Model 1; the flag state is not stored.
   - `capacity_max_bands = 1` in production.
   - One capacity subscription per `(customer, product)` (Inv #37).
   - The `charge_checksum` tuple is append-only with `rated_amount` last; `additional_info` is never hashed (Inv #35).
   - Flow SQL is tested from the extracted YAML **and** by a live-Kestra run (Inv #38).
6. **The invoice pipeline is settled.**
   - The binder reconciles `Σ net_amount = subtotal` before rendering (Inv #39).
   - A failure parks the account on the existing render-pending surface, with no legacy fallback (Inv #40).
   - Reprint is a byte download (Inv #43).
   - Blobs are write-once (Inv #44) and checksum-verified on load (Inv #45).
   - Handlebars is locked down: auto-escape on, `knownHelpersOnly`, nine helpers (Inv #46).
   - The render does no network fetch and no ratecard query (Inv #47).
   - The compiled-template memo is the only cache.
7. **Decided policies stay decided:**
   - unresolvable subscriber (Inv #25);
   - recurring-price miss (Inv #28);
   - `EXCLUDED` forgoes the month (Inv #26);
   - "Uncharged means no charge line" (Inv #22);
   - no four-eyes on profile activation (G14);
   - no `ONE_TIME` source (G5);
   - partial-period capacity billing (**O-TC7**) is an open business decision; never build a method for it.
8. **Invoice Template Phase 3 is settled (bm64–bm73, signed off 2026-10-17):**
   - A BAN's template is captured once at run start and frozen on `bill_run_account`; drafts, posting and reprint read the stamps, and only a rerun re-captures, for the rerun BANs only (Inv #51, #52).
   - One resolver: never add a live-resolver call on a run path, not even behind a flag. Only `captureTemplateStamps` and the editor's `preview-family` mode resolve "current ACTIVE" (Inv #53, guardrail 57).
   - Customer Management stays read-only: `billRunAccountRepository.listBanFamilies` is the one billing reader of `billing_account.ref_bill_template_version_id`, and NULL means the default family (Inv #54, D46).
   - Utilised / Unutilised are derived in SQL from the bill line and never stored; a negative Utilised fails `INVOICE_NEGATIVE_UTILISED` (Inv #55).
   - Per-polygon detail has one source, the live `udr_rated` read, reconciled per type; bad data fails `INVOICE_POLYGON_DATA_MISSING` / `INVOICE_USAGE_OVER_LIMIT` / `INVOICE_RECONCILIATION_FAILED`, and the flow writes no `additional_info.appendix` (Inv #56, #36 note).
   - Layout v1 and its first generated version are pinned (`tests/guardrails/invoice-template-v1-pin.test.ts`). The in-place rewrite authority of §6.3–§6.4 is spent: every later layout, structure or footnote change is a new immutable version, and `0046` is applied and protected again (Inv #57).
   - A template problem at run start never excludes a BAN or blocks the trigger: the draft 422s, approval is blocked (D58a), posting skips before the INV, and a rerun after activating a version recovers it (Inv #58).
   - The footnote (1–5 plain-text lines of at most 200 characters) is the only admin-authored text, and Payment information the only section toggle (Inv #46 amended, D56).

---

## 1. Operating Approach — Phase 3 Specifics

1. **Name the authorizing source before you write anything.** Cite a `bm` spec (bm64+), an Invariant (#51–#58, or an amended #36/#40–#46), a guardrail item (57–67), or a plan decision (D#). Cite the Invariant over the bare D# whenever one exists.
2. **Do not write code before its `bm` spec exists.** The Phase 3 specs exist (`specs/bm64`–`bm73`, listed in `bm00-build-plan.md` Part 5). Build only what a unit's spec specifies; if a spec turns out wrong or a codebase fact has moved, correct the spec in this planning repo first, then build.
3. **Confirm the fresh-DB round before any seed or migration work.**
   - The plan edits `0046` and the v1 seed files **in place** (D26, D41, Inv #57). That is safe **only** on an environment rebuilt from an empty database **and** an empty `invoice-templates` blob container (T11).
   - Before you run `db:setup` or any seed, verify both are empty.
   - If either is not empty, stop and ask. Never "fix" a checksum mismatch by overwriting a blob or editing a journal.
4. **Resolve once, read stamps everywhere (Inv #51, #53).** Never add a call to the live resolver on a run path, not even temporarily, and not behind a flag. Only `captureTemplateStamps` and the editor's `preview-family` mode may resolve "current ACTIVE".
5. **Treat Customer Management as read-only (D46, Inv #54).** Read `billing_account.ref_bill_template_version_id` inside the capture statement. Write nothing else there.
6. **Put money in SQL (code-standards Phase 3 General rule 6).** Every derived figure is computed in SQL as `numeric` and arrives as a string. If a figure seems to need TypeScript arithmetic, stop and ask.
7. **Prove behavior at the right layer.**
   - Flow YAML changes need the extracted-SQL harness **and** a live-Kestra run (Inv #38).
   - Render changes need unit tests, the structural golden **and** a real Chromium render.
   - Capture and freeze need DB-backed integration tests that activate a version mid-run.

---

## 2. Units and Sequencing

1. **Build the units in `specs/bm00-build-plan.md` Part 5 (bm64–bm73), in that order (D59).** It is the unit authority. Do not renumber, merge, split or reorder them, and never reopen bm01–bm63 to absorb Phase 3 scope. If a unit turns out too large, stop and ask before changing `bm00`.

   | Unit | Visible result |
   |---|---|
   | bm64 | Standard family in the catalog |
   | bm65 | template captured at run start and on rerun |
   | bm66 | drafts render from the captured template |
   | bm67 | posted invoices use the captured template |
   | bm68 | the flow stops writing the appendix |
   | bm69 | DD/MM/YYYY and Mbps formats |
   | bm70 | page 1 summary |
   | bm71 | detail pages |
   | bm72 | Total Amount page + footnote editor, then the v1 pin |
   | bm73 | ship gate |
2. **Keep each unit green on its own (general §3.7).** In particular:
   - **bm66:** replace the `draft` render kind with `run` and `preview-family` while posting still resolves live.
   - **bm67:** delete `resolveVersionsForPosting` only there, once nothing else calls it.
3. **Never change the binder shape without the v1 pages that render it (D57, kept by D59).**
   - **bm70** adds the summary fields and rewrites page 1, leaving `usage` and the old annex in place.
   - **bm71** replaces `usage` with the detail regions and rewrites the detail pages.
   - **bm72** adds the Total Amount page and the footnote.
4. **Do not start bm71 until rating Phase H (rm24–rm29) is deployed** and its raw-key format is confirmed in the rm26 spec. Use that spec's delimiter, not a guess. bm64–bm70 and bm72's prerequisites do not need it.
5. **Re-seed v1 from empty for every unit that edits it (bm70, bm71, bm72).** Empty the database and the `invoice-templates` container per the bm64 runbook before running render tests. Add the checksum pin only in bm72; from then on v1 is immutable (Inv #57).
6. **bm68 is independent.** Land it any time before bm73. It removes the SQL from `local-dev/bill_run_processing.yml` (the only copy with SQL), corrects the comments in `bill_run_processing.template.yml`, updates the extracted-SQL tests, revokes the two ratecard grants only the appendix used, and needs a live-Kestra run.
7. **bm73 is last and builds nothing.** It audits Inv #51–#58 and guardrail items 57–67, runs success criteria 1–15 on your sample data, and folds the update into `billmgmt-project-overview.md`.

---

## 3. Scoping — No Speculative Changes

Apply the general §2. In addition, do not build any of the following. Each is out of scope in `billmgmt-update-overview.md`:

1. **Any Customer Management change:**
   - the family dropdown;
   - a family-aware `assertBindableTemplate`;
   - a family column on `billing_account`;
   - any edit to the "Reset to follow active template" button, onboarding or `0050`.
2. **Create-family or retire-family screens, and the retire/bind row locks and parallel test** (D45). Seed exactly one family, Standard. Add no `INSERT`/`UPDATE` grant on `bill_template_family`.
3. **Any second family, any per-BAN version pin, any non-NULL binding path in a UI.**
4. **Bespoke or In-building rating or products** (D6). Build for N types from the data; never hard-code a type name or list.
5. **A "(continued)" marker, Paged.js or measured pre-pagination** (D48).
6. **A visible discount line or any line reconciling detail Sub Totals to Total Amount** (D43).
7. **Adjustments or OCC creation, real tax, credit or debit notes, MyInvois/UBL, CSV export changes** (§23j stays open).
8. **Freezing customer contact, address or organisation name** (D36, D51), or anything after the PDF is handed to loopback or SFTP.
9. **RBAC grant changes** (D53). Add no permission.
10. **A layout v2, a second generated version in the seed, a tenth Handlebars helper, or an admin toggle beyond Payment information** (D56). The footnote is the only admin-authored text: 1–5 plain-text lines (Inv #46 amended).
11. **A larger DB seed** (D52). The seed stays at 1 MNO, 1 rate-card entry and 2–3 polygons. Build large and edge cases as test fixtures under `tests/`.
12. **A rating cutover guard or any `udr_rated` backfill** (D3, D32).

---

## 4. When to Split Into Smaller Steps

Apply the general §3 triggers. The bm64–bm73 boundaries already apply them, together with the module's merge rules: one visible result per unit, units always done together are merged, and a unit with no visible result merges into its neighbour. Inside a unit, these orderings are mandatory:

1. **Schema first inside a unit.** Land the migration, Drizzle mirror and grants as the unit's first commit, before any consumer code: `0046` in bm64, `0051` in bm65, `0052` in bm67.
2. **The platform change first inside bm69.** Its first commit adds the numeric option to the shared `lib/` calendar-date formatter, changes no default, and proves in CI that every other module's output is unchanged (general §2.8). Only then switch `helpers.ts`.
3. **The money transaction alone in bm67.** bm67 touches nothing outside posting and its migration (Inv #6, #41); its freeze tests (guardrail items 57, 58, 60) land with it.
4. **The flow edit alone in bm68.** No TypeScript change rides with the YAML edit.
5. **Read before write in the editor.** The preview's `familyId` (read) lands in bm66; the footnote and toggle changes (write) land in bm72 (general §3.2).
6. **Keep the rating Phase H change set whole and separate.** Never mix a billing change into a rating unit.

If a unit grows beyond its `bm00` entry, stop and ask (general §2.3). Do not split or merge units on your own.

---

## 5. Missing or Ambiguous Requirements

Apply the general §4. Never guess on money, the render source, a stamp, a permission, or what the invoice prints.

**DECIDED. Build to these and do not re-litigate them** (plan decision → invariant / guardrail). This list is an index, not the source (general §6.4, §6.6): if a summary here and its owning D# or Inv # differ, the owning doc wins and this line is a bug to fix.

1. **Template choice and freeze:**
   - the BAN's NULL reference means Standard (D46, Inv #54);
   - capture at run start (D12, D23, D35, Inv #51);
   - rerun re-captures only the rerun BANs (D13, Inv #52);
   - one resolver (D33, Inv #53);
   - both `BILL_RUN_TRIGGERED` and `BILL_RUN_RERUN` record the stamps (D35, as extended 2026-10-15).
2. **Missing template:** a family with no ACTIVE version stamps a NULL version. The draft throws `TEMPLATE_VERSION_NOT_FOUND` (`FAMILY_HAS_NO_ACTIVE_VERSION`); posting skips the account **before** the INV and never copies the NULL to `customer_bill`; a rerun recovers it. Never exclude the BAN and never block the trigger (D55, D58, Inv #58).
3. **Amounts:**
   - Unutilised = `gross − rated`; Utilised = `net − Unutilised`; no new columns (D28);
   - discount is folded into Utilised and not itemised (D30, D43);
   - Total Amount = Σ Utilised (D22);
   - Utilised < 0 fails `INVOICE_NEGATIVE_UTILISED` (D42, Inv #55).
4. **Detail:**
   - polygon from the `udr_key` segment; State, District and start date from `udr_resource`; never `udr_rated.state/district` (D8);
   - one source, the live query (D31);
   - per-type reconciliation and the 10,000-row limit (D37);
   - missing data fails `INVOICE_POLYGON_DATA_MISSING` (D29, D54, Inv #56).
5. **Layout:**
   - ordering, label and format rules (D21);
   - pagination: each type on a new page, groups may split, no "(continued)" (D17, D48);
   - "Page X of Y" bottom-right (D18);
   - footnote after Total Amount (D19);
   - Other charges block, hidden when empty, and "Total charges" label (D47);
   - Adjustments always shown (D14);
   - tax at 0% (D15, D52).
6. **v1:** rewritten once in place, then pinned. Every later change is a new version (D41, D49, Inv #57).
7. **Editor:** only the Payment toggle, plus 1–5 footnote lines of ≤ 200 characters (D56).
8. **Scope:** only Standard (D45); Customer Management untouched (D46); PDF only (D51); no RBAC change (D53).

**OPEN. Stop and ask one precise question with the options. Never pick a default:**

| Topic | Where it is tracked | Interim rule |
| --- | --- | --- |
| Partial-period capacity billing | O-TC7 | A **business** decision. Partial-period accounts stay `EXCLUDED`. |
| The final raw `udr_key` delimiter and `polygon_id=` form | rating rm26 spec | Read the rm26 spec. If it is ambiguous, ask; never infer the format from sample data. |

**Also stop and ask** when a unit seems to need any of these:
- a second family, or a write to `billing_account`;
- TypeScript money arithmetic;
- a new error code beyond `INVOICE_POLYGON_DATA_MISSING` and `INVOICE_NEGATIVE_UTILISED`;
- a new audit event type;
- a change to printed wording beyond the code-standards labels;
- a v1 file change after the rewrite unit.

**Record every resolution in the plan (as a new D#) and in each companion doc that cites it, in the same change** (§7).

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general §5 list applies in full. Stop, explain why, and get confirmation before touching any of these:

1. **Carried forward:**
   - `components/ui/`
   - `udr-status.repository.ts` (the only `rating` writer)
   - `db/bootstrap/rating-db-roles.sql`
   - `billrun_delete_trial_bill`, `customer_bill_finalization_guard`, `rating.billrun_status_guard`
   - `postDocument`, pgledger and the INV reason code
   - Better-Auth tables
   - `tsconfig`, lint and CI configuration
   - lockfiles
   - `next.config.ts` `serverActions.bodySizeLimit`
   - `getBrandingLogo()` and `app`/`app_logo_path`
   - the destructive-DB preflight (bm40)
   - `product.ratecard_ran_usage_lkp` / `ratecard_version` (product-owned; read only)
2. **Customer Management — off limits for this whole update (D46):**
   - `services/accounts/**`
   - `components/customers/**`
   - `app/(app)/customers/**`
   - `actions/accounts/**`
   - `db/migrations/0050_billing_account_template_ref.sql`
3. **Applied migrations (now through `0050`; there is no `0042`).**
   - **Authorized exceptions, fresh-DB round only:** bm64 edits `0046_invoice_template_catalog.sql` in place for the family schema and seed (D26), and bm70–bm72 update only its v1 seed literals (the two checksums and, in bm71/bm72, the `BTV00000002` `structure`) to match the rewritten v1 files (D41). Change only the `.sql`; leave its `_journal.json` entry.
   - Every other schema change is a new migration with a hand-added journal entry, like `0047`–`0050`.
   - After that unit, `0046` is applied and protected again.
4. **The v1 seed directories** `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**` and `db/seeds/invoice-templates/generated/INVOICE/v1/**`.
   - **Authorized exception:** bm70, bm71 and bm72 rewrite v1 in place (D41, D59); the checksum pin lands in bm72.
   - Regenerate `checksums.json` only with `scripts/invoice-templates/write-checksums.ts`.
   - After that unit the checksum pin (guardrail 65) makes them immutable. Every later change is a new version.
5. **Flow YAML.** The only authorized Phase 3 change is removing the `appendix` build and the `CAPACITY_APPENDIX_OVER_LIMIT` guard from `local-dev/bill_run_processing.yml`, plus correcting the comments in `bill_run_processing.template.yml` (D31). Commit it to the repo; never edit it in the Kestra UI. Any other flow change is off-plan.
6. **`services/billing/invoice-template/helpers.ts`.** The only authorized change is the `date`/`period` (DD/MM/YYYY) and `qty` (whole or 2 decimals) formats, through the shared formatter. Register no helper; remove none.
7. **`services/billing/render-invoice.ts` orchestration.** The semaphore, the 2-render cap and `BROWSER_CLOSE_TIMEOUT_MS` stay unchanged. Only the footer alignment changes.
8. **Role bootstraps.** Authorized changes only: `db/bootstrap/bootstrap-db-roles.sql` limits `app_runtime` to SELECT on `bill_template_family` (bm64); `db/bootstrap/billrun-db-roles.sql` revokes `billrun_runtime`'s SELECT on `product.ratecard_ran_usage_lkp` and `product.ratecard_version` (bm68) and updates its Step 5 comment (bm67). Give `billrun_runtime` nothing new. The one exception, recorded 2026-10-18: Step 5a's `customer_bill_line` INSERT list gains `rated_amount` and `additional_info`, columns bm41 added and bm42's aggregation already writes (a missed grant, found by the bm73 manual run; see architecture's auth deltas).
9. **Stored blobs.** Never overwrite a template, asset or invoice blob, and never delete one inline. Emptying the `invoice-templates` container is a runbook step (T11) for an operator, not code you write or run.
10. **`rated-lines.repository.ts` stays read-only.** Add the detail query as a read; add no write.

---

## 7. Keeping Docs in Sync With Implementation

Apply the general §6. In addition:

1. **Keep five docs aligned on every Phase 3 unit:**
   - `billmgmt-update-overview.md`
   - `billmgmt-architecture.md`
   - `billmgmt-code-standards.md`
   - `billmgmt-progress-tracker.md`
   - the plan, when a decision changes
2. **Flip "planned" to "built" as you go.** When a unit delivers an invariant (#51–#58) or a guardrail item (57–67), change its "planned" marker to "built (bmNN)" in the same change, and note the test file that proves it.
3. **Close each item everywhere it is tracked, in one change set:**
   - When bm67 ships, close known-issues §19 (mid-run activation splits a run).
   - Update `TODOS.md`'s Phase 3 entry to say the binding UI is deferred to the second-family phase (D46). Do not mark the entry fully done.
4. **Never reuse a number.** Invariants run to #58 and guardrail items to 67; #15 is a tombstone. New rules take #59 and item 68 onward, and new decisions take D61 onward.
5. **Keep the superseded tables current.** If a unit changes a Part 1 or Part 2 rule not yet listed in code-standards' _Rules superseded by this update_ or architecture's P1–P11, add a row in the same change.
6. **Bind names exactly as code-standards writes them:**
   - `captureTemplateStamps`
   - `RenderMode` kinds
   - `RunTemplateStamps`
   - `serviceTypes` / `otherCharges`
   - error codes
   - stamp columns as plain keys with no FK (the `0029`/`0046` stamp rule)
   - file paths

   If a spec needs a different name, update code-standards first.
7. **Change `InvoiceRenderInput` and the layout placeholders together.** The bind shape, the v1 partials and `sample-data.json` move in one unit (§2.5).
8. **Fold at the ship gate only.** The Phase 3 ship gate folds the update into `billmgmt-project-overview.md` and empties `billmgmt-update-overview.md` back to pointers in the same change. Do not fold early.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general §8 checklist, then every module guardrail covering the files the unit touched. **Run the checks; do not assume.** Additionally:

1. **Guardrails land with their unit.** The items the unit introduces (57–67) pass in that unit and are never deferred to the ship gate:

   | Unit | Guardrail items |
   |---|---|
   | bm64 | 61 |
   | bm65 | 59; the capture half of 60 |
   | bm67 | 57, 58, 60 |
   | bm68 | 66 |
   | bm70 | 62 |
   | bm71 | 63; the detail half of 64 |
   | bm72 | 64 (final), 65, 67 |
2. **Earlier guardrails still green.** Re-run every guardrail covering touched files, at minimum:
   - compute boundary (§9);
   - rating write boundary;
   - finalization guard;
   - checksum (items 35, 46);
   - three-handler route inventory;
   - default resolution (45);
   - tamper (47);
   - escaping (50);
   - authz matrix (56).
3. **Freeze holds.** Any unit touching draft, posting, rerun or the resolver activates a new version mid-run in a test and proves the run's PDFs did not change, except for rerun BANs.
4. **Customer Management unchanged.** `git diff --stat` shows no file under the §6.2 paths, and guardrail 66 passes.
5. **Money unchanged where it should be.** `charge_checksum` recomputes for every posted bill, and `Σ net_amount = subtotal` still holds (Inv #39). No amount is computed in TypeScript (grep the diff for `Number(`, `parseFloat`, `+` on amount fields).
6. **Fresh-DB proof for schema and seed units.**
   - The migrations apply on an empty database.
   - The seed uploads to an empty container.
   - A second run of the seed is a no-op that succeeds, because the seed is idempotent (`onExists: 'returnExisting'`, `db/seeds/invoice-templates.ts`).
   - A container still holding an old-v1 blob with different bytes fails with `SEED_BLOB_CONFLICT` and overwrites nothing.
   - **General §8.8 ("no edits to applied migrations") for bm64 and bm70–bm72:** it passes only when the diff edits `0046_invoice_template_catalog.sql` alone among existing migrations (bm70–bm72: its v1 seed literals only), cites D26, records the general §5 confirmation, and the empty-database apply above is green. Every other unit must pass §8.8 as written.
7. **Flow units.** The extracted-SQL harness passes, and a live-Kestra run reaches `SCHEDULED → COMPLETED` on the `ci` seed with no `appendix` key on any capacity line.
8. **Render units.**
   - The structural golden passes on a fixture of about 900 polygons.
   - A real Chromium render produces the PDF.
   - A parked render leaves the INV posted and blocks distribution `COMPLETED` (Inv #40).
9. **Grants.** Asserted over `information_schema`:
   - `app_runtime` has `SELECT` only on `bill_template_family`;
   - `billrun_runtime` has no grant on it and none on the new stamp columns.
10. **Audit.** `BILL_RUN_TRIGGERED` and `BILL_RUN_RERUN` carry `afterData.templateStamps`, written in the capture's transaction. No new audit event type exists.
11. **Docs.** The §7 docs are updated in the same change set, with "planned" markers flipped and the progress tracker current.

If any item fails, the unit is not done. Fix it before moving on. Never defer a failure to a later unit or to the ship gate.

---

## What Changed in This Revision (2026-10-17, bm73 ship gate)

| Was | Now | Why |
| --- | --- | --- |
| Scoped to the in-flight **Invoice Template Phase 3**; #51–#58 planned; the `0046` and v1 in-place edits authorized | **No update in flight.** Phase 3's still-binding rules condensed into §0 item 8; §1–§8 kept as the record and the default discipline for the next update; the in-place authority is spent (v1 pinned, `0046` protected again) | bm73 signed off Phase 3 (criteria 1–15, Inv #51–#58 audited, guardrails 57–67 green); the update is folded into `billmgmt-project-overview.md` |

## What Changed in the Previous Revision (2026-10-15)

| Was | Now | Why |
| --- | --- | --- |
| Scoped to two in-flight updates, Part 1 (Target Capacity) and Part 2 (Invoice Template), with their sequencing, splits and open-item lists | Re-scoped to **Invoice Template Phase 3**. The still-binding Part 1 and Part 2 rules are condensed into §0 | Both parts are delivered and folded into `billmgmt-project-overview.md` |
| "50 Module Invariants"; guardrails to item 56; applied migrations through `0049` | **58** Invariants (#51–#58 planned); guardrail items to **67**; applied migrations through **`0050`** | Phase 3 architecture and code-standards sections |
| "Do not edit seeded layout versions"; "never edit an applied migration"; "`workflow-management/**` gets no change" | One authorized in-place edit each for `0046` and the v1 seeds (fresh-DB round, then pinned); one authorized flow edit (appendix removal) | D26, D31, D41 |
| "The only admin template input is the boolean `structure` map" | Plus 1–5 plain-text footnote lines; only the Payment toggle remains | D20, D56, Inv #46 amended |
| Part 1 rate gate: "OFF logs, records the flag state" | OFF logs a WARN and bills Model 1; the flag state is **not** stored | Corrected against dev1 (bm43) |
| D40: three slices, with the binder shape in slice 2 | Units bm64–bm73 in `bm00` (D59): the binder and the matching v1 pages change together, page by page (bm70–bm72) | The current v1 cannot render the new shape (D34), so the binder must never run ahead of the layout (general §3.7); the module's merge rules remove repository-only units |
| Rerun audit only records the stamps | Trigger **and** rerun audits record the stamps | Owner-approved fix 9 (2026-10-15), D35 extended |
