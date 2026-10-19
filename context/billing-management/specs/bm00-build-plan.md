# Bill Run — Build Plan (Units, in build order)

Decomposition of the Billing Management (Bill Run) module into build units. This revision (2026-10-15) plans **Invoice Template Phase 3: the bill run uses the BAN's invoice template, and the Standard layout v1 is rewritten**, as units **bm64–bm73**. Units bm01–bm63 are delivered and listed below only as the numbering record. Their full unit text is in `git show a63eebb:context/billing-management/specs/bm00-build-plan.md` and in `specs/bm01`–`bm63`.

**Sources of truth:**
- `billmgmt-project-overview.md` › Invoice Template Phase 3: the change; success criteria 1–15 with evidence (folded from `billmgmt-update-overview.md` at bm73).
- `_updatemodule-billing-invoice-template-phase3-billrun-plan.md`: decisions D1–D60.
- `billmgmt-architecture.md`: Invariants #1–#58, with #51–#58 for this update; the dated _Invoice Template Phase 3 — architecture deltas_ section; P1–P11.
- `billmgmt-code-standards.md`: the Phase 3 section; guardrail items 57–67.
- `billmgmt-ai-workflow-rules.md`: unit discipline, protected files.
- `billmgmt-ui-context.md`: §10b and §10d.
- Stack: `context/architecture.md` §1 + `billmgmt-architecture.md` §1. **No new technology** in this update: Next.js App Router, TypeScript strict, Drizzle + PostgreSQL 16, Kestra OSS flows as `billrun_runtime`, Handlebars 4.7 + Playwright Chromium `page.pdf`, Azure Blob (Azurite locally).

**Decomposition rules:**
- Each unit produces **one visible result**.
- Each unit stays within **one system boundary**.
- Dependencies land **just in time**.
- Units always done together in one session are **merged**.
- A unit with no standalone visible result is **merged** into its neighbour.
- Every unit finishes green (`tsc` / lint / tests incl. the route × level matrix), carries its own guardrail tests, and syncs its owning doc before the next starts.

---

> ## Status (re-checked 2026-10-15 against `enterprise-billing-app` `dev1` `1ab2bd1`)
>
> | Units | State |
> | --- | --- |
> | bm01–bm39 | **Delivered.** Phases 1–4: control plane, two-writer boundary, real compute plane, self-driving lifecycle, production deployable and wired. The cloud cutover is a gated ops step. |
> | bm40–bm46 + bm42a | **Delivered.** Target Capacity Pricing. Still open: **TC54** (capacity-aware live-Kestra harness) and **O-TC7** (partial-period capacity, a business decision). |
> | bm47–bm63 | **Delivered.** The Invoice Template update; bm63 ship gate signed off 2026-10-11. |
> | **bm64–bm73** | **Planned, specced.** Invoice Template Phase 3 (below). All ten specs written 2026-10-15 (`specs/bm64`–`bm73`); none built yet. |
>
> **Latest applied migration:** `0050_billing_account_template_ref.sql` (cm17, Customer Management). There is no `0042`. Migrations after `0026` are hand-written SQL with no drizzle-kit snapshot. This plan adds `0051` (bm65) and `0052` (bm67), and edits `0046` in place once (bm64, fresh-DB round only).
>
> **Rating prerequisite:** rating Phase H (rm24–rm29: raw `udr_key`, `udr_resource` = `state|district|polygon_start_date`) is implemented on `dev1` (rm28 `e955d7d`, rm29 `1ab2bd1`). bm71 needs it **deployed** and the rm26 raw-key format confirmed.

---

# Delivered units (numbering record)

| Units | Specs | Names |
| --- | --- | --- |
| 1–13 | `bm01`–`bm13` | RBAC scaffold · runs list + materialization · trigger + scoping · M2M stage ingest · draft bill generation · taxation · verification/Uncharged/Errors · rerun · Accounts INV enablement · approve · post · stall recovery · phase-1 ship gate |
| 14–21 | `bm14`–`bm21` | `billrun_runtime` role · sample seed · engine registry + processing flow · `udr_rated` lifecycle + Reject · rendering + draft preview · posting + final render · distribution flow · phase-2 ship gate |
| 22–35 | `bm22`–`bm35` | environmental gate · `customer_bill_line` schema · claim release · rating in-flight guard · `RAN_USAGE` seed · real collection · real aggregation USAGE · real aggregation RECURRING · verification + reconciliation · checksum re-anchor · Uncharged redefinition · retire placeholder mode · SFTP multi-target · phase-3 ship gate |
| 36–39 | `bm36`–`bm39` | processor signal-back · local E2E assertion · production deployable + wired · phase-4 ship gate |
| 40–46, 42a | `bm40`–`bm46`, `bm42a` | flow rename + extracted-SQL harness · capacity columns · capacity aggregation · capacity verification + rate gate · checksum re-anchor on `rated_amount` · usage appendix · capacity ship gate · flow fixes |
| 47–63 | `bm47`–`bm63` | invoice binder · rating geo · usage annex · template catalog · blob store · prod containers · resolution + seed upload · posting stamps · settings shell + template read/preview · profile read · template save draft · template activate · profile save draft · logo upload · profile activate · CSV output · Invoice Template ship gate |

---

# Part 5 — Invoice Template Phase 3 (delivered, Units 64–73; signed off by bm73, 2026-10-17)

**What changes, in one line:** each BAN's template is resolved once at run start (NULL → Standard → its ACTIVE version), frozen on `bill_run_account`, and used by draft, posting and reprint. The Standard layout v1 is rewritten to the business design. Customer Management is **not** touched (D46), and only the Standard family exists (D45).

**v1 is edited in place across bm70–bm72 and pinned at bm72.** Each of those units re-seeds a freshly emptied database and `invoice-templates` container (the bm64 runbook) before its render tests. Never overwrite a blob.

## Units

### 64 — Standard template family in the catalog (`bm64`)

- **Spec:** `specs/bm64-template-family-catalog.md` (written 2026-10-15).

- **Boundary:** database (migration, Drizzle schema, seed, grants, read repository), plus its ops runbook.
- **Builds:**
  - `0046_invoice_template_catalog.sql` **edited in place** (D26). Only the `.sql` changes; its journal entry stays.
    - New `billing.bill_template_family`: `BTF` + 8-digit id, `name`, `code` UNIQUE, `kind = 'generated'`, `is_default`, `retired_datetime`, audit columns. `btf_one_default_uq ON (kind) WHERE is_default`, and a CHECK that the default is never retired.
    - `bill_template_version.ref_bill_template_family_id`, with `CHECK (kind <> 'generated' OR ref_bill_template_family_id IS NOT NULL)`, added to the guard trigger's identity list.
    - `btv_one_active_uq` split into a family-scoped `generated` index and a (`format`, `kind`) index for layout/CSV. `btv_one_draft_uq` becomes family-scoped.
    - The **Standard** family seeded, with every seeded `generated` row carrying it.
  - `app_runtime` `SELECT` on `bill_template_family`. `billrun_runtime` gets nothing.
  - Drizzle `db/schema/billing/bill-template-family.ts`, `db/repositories/billing/bill-template-family.ts` (`findDefault`, `findById`), and `validation/billing/template-family-id.schema.ts` (`^BTF\d+$`).
  - The **fresh-environment runbook (T11)**: rebuild from an empty database **and** an empty `invoice-templates` container, then `db:setup`.
- **Visible result:** on a fresh database the catalog holds one family, "Standard (default)", owning the seeded generated version. A second non-default ACTIVE or DRAFT in that family, or a `generated` row without a family, is refused. Version history is unchanged. Guardrail item 61.
- **Depends on:** the fresh-DB round being confirmed (D3, D26).

### 65 — Template captured at run start and on rerun (`bm65`)

- **Spec:** `specs/bm65-run-start-template-capture.md` (written 2026-10-15).

- **Boundary:** the bill-run trigger and rerun services, with their repository and migration.
- **Builds:**
  - Migration `0051`: five nullable stamp columns on the partitioned `bill_run_account` — `ref_bill_template_family_id`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id`, `template_captured_at`. Plain keys with no FK (the posting-stamp rule).
  - Drizzle mirror; `RunTemplateStamps` type (`Pick` of `$inferSelect`).
  - `billRunAccountRepository.captureTemplateStamps` / `readStamps`: one set-based statement.
  - `services/billing/capture-template-stamps.ts`:
    - It reads `billing_account.ref_bill_template_version_id`. NULL → default family; non-NULL → that version's family.
    - Within the family it takes the non-default ACTIVE version, else the default.
    - No ACTIVE version → family stamped with a NULL version. It never throws and never marks the account `EXCLUDED` (D55).
    - EXCLUDED rows stay NULL.
  - Called from `trigger-run.ts` after `insertSnapshot`, and from `rerun-run.ts` for the selected BANs only, before the `BILL_RUN_RERUN` audit (so it lists the stamps). _(Corrected 2026-10-16 from "`setAttemptForRerun`", which runs after that audit.)_
  - `BILL_RUN_TRIGGERED` and `BILL_RUN_RERUN` `afterData.templateStamps`.
- **Visible result:** after **Run**, every non-EXCLUDED account row carries Standard and its version, and the Audit tab's trigger row lists them. Rerunning one BAN after a new activation changes only that BAN's stamps. Guardrail item 59; the capture half of item 60.
- **Depends on:** 64.

### 66 — Draft PRO-FORMA renders from the captured template (`bm66`)

- **Spec:** `specs/bm66-draft-renders-captured-template.md` (written 2026-10-15).

- **Boundary:** template resolution (`resolve-template.ts`) and its two non-posting callers.
- **Builds:**
  - `RenderMode` = `run` | `final` | `preview-posted` | `preview-family`, replacing `draft`, with `never` checks.
  - The run mode reads the BAN's stamps. A NULL version on a non-EXCLUDED row throws `TEMPLATE_VERSION_NOT_FOUND` (`FAMILY_HAS_NO_ACTIVE_VERSION`), never the default.
  - `GET /billing/bill-runs/[runId]/draft-invoice/[banId]` builds the run mode; a missing or EXCLUDED row gets 404.
  - The Invoice Settings preview action takes a `familyId` (Standard) and renders `preview-family`, the only live mode.
  - Posting is untouched in this unit.
- **Visible result:** activate a new Standard version mid-run. The run's draft previews keep the captured version, while the editor preview shows the new one. A NULL-stamp fixture's draft shows the "no active version" message (UI context §10d).
- **Depends on:** 65.

### 67 — Posted invoices use the captured template (`bm67`)

- **Spec:** `specs/bm67-posting-uses-captured-template.md` (written 2026-10-15).

- **Boundary:** the posting transaction (`post-run.ts`, `stampPosted`) and its migration.
- **Builds:**
  - Migration `0052`: `customer_bill.ref_bill_template_family_id` (plain key, no FK). `PostedBillStamps` gains the family.
  - `postAccount` reads the BAN's run stamps **before** creating the INV:
    - a NULL version → `SKIPPED` with `TEMPLATE_VERSION_NOT_FOUND`; no INV number is consumed (D58);
    - otherwise `stampPosted` copies the four stamps plus the family in the `ref_inv_document_id` `UPDATE`.
  - `resolveVersionsForPosting` is **deleted**.
  - Known-issues §19 is closed.
- **Visible result:** in a run where a new version is activated mid-run, every posted PDF and bill stamp equals the run's captured stamps. The NULL-stamp fixture is skipped with no INV number while siblings post. Guardrail items 57, 58, 60.
- **Depends on:** 66.

### 68 — Capacity flow stops writing the appendix (`bm68`)

- **Spec:** `specs/bm68-flow-drops-capacity-appendix.md` (written 2026-10-15).

- **Boundary:** the processing flow (`workflow-management/flows/bill-run-processor/`) and its extracted-SQL tests.
- **Builds:**
  - Remove `appendix` from the `additional_info` build and the `CAPACITY_APPENDIX_OVER_LIMIT` guard, from `local-dev/bill_run_processing.yml` (the only copy with SQL), correcting the comments in `bill_run_processing.template.yml` (D31); revoke the two ratecard grants only the appendix used.
  - Update the `billrun-capacity-appendix` suites to assert the key is absent.
  - The boundary guardrail (Customer Management untouched; `invoice-render-input.ts` free of `rating.`; no appendix in either YAML).
- **Visible result:** a live-Kestra run on the `ci` seed reaches `COMPLETED`, and no capacity line carries an `appendix` key. Guardrail item 66.
- **Depends on:** nothing new; bm49 already stopped reading the appendix.

### 69 — Invoice dates DD/MM/YYYY and Mbps quantities (`bm69`)

- **Spec:** `specs/bm69-invoice-date-quantity-formats.md` (written 2026-10-15).

- **Boundary:** formatting (the shared calendar-date formatter in `lib/` and the invoice Handlebars helpers).
- **Builds:**
  - A numeric day/month/year option on the shared formatter, landing **first, with no default change** and CI proof that every other module's output is unchanged (general §2.8).
  - `helpers.ts`: `date`/`period` render `DD/MM/YYYY`; `qty` renders whole numbers, else 2 decimals. Still nine helpers.
  - Current v1 goldens regenerated.
- **Visible result:** today's invoice preview shows `DD/MM/YYYY` dates and the new quantity format.
- **Depends on:** nothing new.

### 70 — New invoice page 1: capacity summary per service type (`bm70`)

- **Spec:** `specs/bm70-invoice-page1-capacity-summary.md` (written 2026-10-15).

- **Boundary:** invoice rendering (render-input repository, binder, v1 layout seed files).
- **Builds:**
  - `invoice-render-input.ts` SQL, all `numeric` → string:
    - per capacity type, Unutilised = Σ(`gross − rated`), Utilised = Σ`net` − Unutilised, and Total;
    - "Other charges" rows (non-capacity `charge` lines) and their Sub Total;
    - Total charges (= `subtotal`) and Adjustments.
  - Utilised < 0 fails `INVOICE_NEGATIVE_UTILISED` (D42); the recipient name comes from the preferred billing contact.
  - The binder **adds** `serviceTypes` (summary level), `otherCharges`, the new `totals` fields and `recipientName`; `usage` stays for now.
  - v1 `shell.hbs` rewritten: embedded IBM Plex fonts, `--inv-*` palette, title "Invoice".
  - The header, identification, bill-to, `chargeSummary`, `taxSummary`, `amountDue` and `payment` partials rewritten to the business page 1.
  - `sample-data.json` and checksums regenerated; goldens updated.
- **Visible result:** draft and posted page 1 show one Utilised / Unutilised / Total block per type of service, then "Other charges" (only when present), Total charges, Adjustments, Tax @ 0% and Grand Total (the amount due), with the recipient line. The 800 / 1,000 / 2,000 / 0 Mbps anchors print correctly. Guardrail item 62.
- **Depends on:** 67, 69; the bm64 runbook.

### 71 — New invoice detail pages per service type and State-District (`bm71`)

- **Spec:** `specs/bm71-invoice-detail-pages.md` (written 2026-10-15).

- **Boundary:** invoice rendering (rated-lines repository, binder, v1 layout seed files), plus the structure keys it retires.
- **Builds:**
  - **Detail query** in `rated-lines.repository.ts`:
    - one CTE: polygon from the `udr_key` `polygon_id=` segment; State, District and start date from `udr_resource`;
    - type attached via subscription → offering → capacity line;
    - `BILL_NOTUSED` excluded; ordered per D21; `LIMIT 10001`.
  - **Guards:** `INVOICE_POLYGON_DATA_MISSING`, the per-type `INVOICE_RECONCILIATION_FAILED`, and `INVOICE_USAGE_OVER_LIMIT`.
  - **Binder:** `serviceTypes[].regions[]` (rows and Sub Total); `usage` / `InvoiceUsageSection` removed.
  - **v1 `chargeDetails`** rewritten:
    - a page break per type, headed by the type name and "Access Seeker";
    - one table per State-District whose `<thead>` repeats the group label and column header;
    - a Sub Total row; no "(continued)".
  - **Retired:** the old line table, the `usageAnnex` partial and every `[[if columns.*]]` directive.
  - **Structure (D56, part 1):** the manifest gets `usageGrouping` `["serviceType","state","district"]` and the new `fixedColumns`. `usageAnnex` and the four column keys are removed from the manifest, the unions, the Zod structure schema and the seeded `structure.json`, so the editor drops those toggles.
  - "Page X of Y" moves right.
- **Visible result:** each type of service gets its own detail pages, grouped by State-District with Sub Totals. A ~900-polygon fixture paginates with the label and header repeated on each page. Bad polygon data parks the account. Guardrail item 63; item 64's detail half.
- **Depends on:** 70; rating Phase H **deployed**, with the rm26 raw `udr_key` format confirmed.

### 72 — Total Amount page and editable footnote (`bm72`)

- **Spec:** `specs/bm72-total-amount-page-footnote-editor.md` (written 2026-10-15).

- **Boundary:** the Invoice template (layout, structure and its editor).
- **Builds:**
  - **v1 Total Amount page:** "Summary of Utilised Capacity Charges" and Total Amount = Σ Utilised (D22), never styled as the amount due.
  - **Footnote:** `notes` becomes `structure.footnote`, 1–5 plain-text lines of ≤ 200 characters (D56, part 2), with the default two lines seeded. `layout-manifest.schema.ts` is Zod-validated (D38).
  - **Editor:**
    - heading "Invoice template — Standard (default)";
    - the Payment information toggle plus the Footnote lines (React Hook Form `useFieldArray`; read-only below EDIT);
    - the Activate dialog lists footnote changes.
    - Save draft and activate keep `invoice_settings : EDIT`; a READ user's footnote change is refused.
  - **Final:** goldens regenerated, and the **v1 seed-checksum pin** added. v1 is immutable from here (Inv #57).
- **Visible result:** an Admin/Manager edits the footnote, previews it and activates it, and the next run's last page prints the new footnote after Total Amount, while a run already started keeps the old one. Guardrail items 64 (final), 65, 67.
- **Depends on:** 71, 66 (the preview).

### 73 — Invoice Template Phase 3 ship gate (`bm73`)

- **Spec:** `specs/bm73-phase3-ship-gate.md` (written 2026-10-15).

- **Boundary:** cross-cutting: tests, docs and the tracker. **Nothing new is built.**
- **Builds:**
  - The update overview's success criteria 1–15 on the owner's sample data (~5 BANs, largest ~900 polygons), end to end: trigger, review drafts, edit and activate the footnote, rerun one BAN, approve, post, then loopback distribution to `COMPLETED`.
  - Inv #51–#58 audited, and guardrail items 57–67 plus every earlier guardrail covering touched files green.
  - Flip every "planned" marker to "built".
  - Fold the update into `billmgmt-project-overview.md` and return `billmgmt-update-overview.md` to pointers.
  - `TODOS.md` notes the binding UI as deferred (D46).
- **Visible result:** Invoice Template Phase 3 is declared shippable, with criteria 1–15 shown working.
- **Depends on:** 64–72.

## Order that must not change

- **64 first.** Everything resolves through the family.
- **65 → 66 → 67.** Capture before anything reads the stamps. Drafts read them before posting does. `resolveVersionsForPosting` is deleted only in 67, once nothing calls it.
- **69 before 70.** Page 1 prints dates and quantities.
- **70 → 71 → 72.** Each unit changes the binder **and** the v1 pages that consume it together, so the tree never holds a binder shape the layout cannot render (D57's rule, kept by D59).
- **Rating Phase H deployed before 71.**
- **68 is independent.** Land it any time before 73.
- **73 last.**

## Merged on purpose (do not split again)

- **Trigger + rerun capture → 65.** One helper, always done together.
- **The shared `lib/` date option + the invoice helper switch → 69.** The option alone shows nothing.
- **The amount SQL and the D42 guard → 70; the detail query and its guards → 71.** Neither has a visible result until a page prints it, and that replaces D57's repository-only slice 2.
- **The structure-key removals → 71 (columns, `usageAnnex`) and 72 (`notes` → footnote).** Each lands when the last layout directive using those keys is removed.
- **The editor preview's `familyId` → 66; the footnote editor → 72.**

## Deliberately no unit (out of scope)

- Any Customer Management change, including the family dropdown, a family-aware `assertBindableTemplate`, or edits to `billing_account` or `0050` (D46).
- Create or retire family screens, and the retire/bind locks (D45).
- Bespoke / In-building types (D6).
- A "(continued)" marker (D48).
- A discount line (D43).
- Adjustments or OCC creation, real tax, credit or debit notes, MyInvois.
- CSV changes (§23j).
- Freezing contact data (D36).
- RBAC changes (D53).
- A larger seed (D52).
- Layout v2.
- Partial-period capacity (O-TC7).
- TC54's capacity harness: it remains a separate open item from Part 3.
