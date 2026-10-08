# Billing Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first and obey it in full. This supplement changes nothing there. It records only the Billing Management deltas to it for the two in-flight updates in `billmgmt-update-overview.md` (**Part 1, Target Capacity Pricing** and **Part 2, Invoice Template**), plus the rules from delivered phases that still bind both updates. Where a facet is not mentioned here, the general rule applies unchanged. If anything here appears to weaken the general rules or a Module Invariant, stop and treat it as a bug.

**Companion docs (authoritative; do not restate or contradict them):**

- `billmgmt-update-overview.md`: the functional scope, in/out of scope and success criteria for Part 1 and Part 2. It is the overview for in-flight work. `billmgmt-project-overview.md` describes delivered phases 1–4 (bm01–bm39) only.
- `billmgmt-architecture.md`: **50 Module Invariants (§6)**. #15 is a retired tombstone, #29–#38 belong to Part 1 and #39–#50 to Part 2. It also holds the dated Part 1 and Part 2 delta sections and the **open cross-update conflicts X1–X4**.
- `billmgmt-code-standards.md`: §1–§9 and its two dated delta sections. Part 1 guardrails are §9 items **36–42**. Part 2 guardrails are items **43–56**, and conflicts **C1–C4** are listed there.
- `specs/bm00-build-plan.md`: the authority on unit numbering, unit boundaries and build order. Part 1 is **bm40–bm46**. Part 2 has no units yet.
- Design authority: for Part 1, `_updatemodule-billing-billrun-target-capacity-plan.md` (TC1–TC58, open set O-TC*). For Part 2, `_updatemodule-billing-invoice-template-merged-plan.md`, where **§15 (R1–R11) overrides §§1–14**. Also `invoice-template/placeholder-catalog.md` (placeholder roots and field formats).
- `context/rating-management/ratemgmt-ai-workflow-rules.md`: **binding on you** for any rating-side change (§3.5).

**Precedence:** the general order stands (architecture **Invariants** → overview → architecture → code-standards → this supplement → general rules). Two module additions:

1. For in-flight work, `billmgmt-update-overview.md` is the overview.
2. Inside the Part 2 plan, §15 wins over the body. Never build the four superseded body items: the legacy-template fallback, the rendered-HTML hash, the watermark move, and `kind = xml`.

**Current state:** `billmgmt-progress-tracker.md` is the only status source. This file keeps no dated status snapshot. Check the tracker against `git log` on `dev1` before you start.

---

## 0. Carried-Forward Module Rules (Delivered Phases, Still Binding)

These rules come from phases 1–4. They are **permanent**, and both updates touch the code they protect. A unit that violates one is a review-blocking defect.

1. **Compute lives in the flow, not the app.** All bill-data computation runs in `workflow-management/flows/bill-run-processor/` as `billrun_runtime`, including capacity pricing. The app writes run-state, posting and posting stamps, and nothing else (Inv #17, #29). `billing-trial-bill-compute-boundary.test.ts` enforces this. Never weaken it.
2. **Rendering lives in the app, not the flow.** The engine never renders, never reads the invoice-template or asset containers, and gets no grant on the Part 2 tables. Part 2 makes **no change** to `workflow-management/**`.
3. **Three reversed rules stay reversed.** `customer_bill_line` **is** the charge record (Inv #3). Recurring derivation **is** sanctioned billing compute, and usage-rating is not (Inv #1). `BILLRUN_PLACEHOLDER_MODE` is retired and Inv #15 is a tombstone. If a unit touches a file that quotes an old rule, correct the quote in the same diff.
4. **Cross-schema writes are fixed.** In `rating`, the only permitted writes are the six claim columns, written through `udr-status.repository.ts` (Inv #2). Grants are enumerated per table and never `ON ALL TABLES` (Inv #23).
5. **The finalization boundary is fixed.** Once `ref_inv_document_id` is set, the header cannot change (Inv #4, migration `0033`). Posting is per-account, in one transaction (Inv #6). Four-eyes is enforced on the money gate (Inv #8).
6. **Treat decided policies as decided.** Unresolvable subscriber (D32, Inv #25), recurring-price miss (D33, Inv #28), `EXCLUDED` forgoes the month (Inv #26), and "Uncharged means no charge line" (Inv #22). Build to them and do not re-litigate them.

---

## 1. Operating Approach — Update Specifics

1. **Name the authorizing source before you write anything.** Cite one of: a `bm` spec, an Invariant (#1–#50), a code-standards rule or guardrail item, or a plan decision (TC*, D*, R*). For Part 2, cite the **Invariant**, not the bare R#/D#. Code-standards' Part 2 section predates Inv #39–#50 (§7.4).
2. **Finish Part 1 before Part 2 touches the render path.** Commit bm45 and pass bm46 before any Part 2 unit edits `render-invoice-template.ts`, `render-invoice.ts`, `post-run.ts` or `customer-bill-line.repository.ts`. Both updates rewrite those files (X4). Part 2's binder must then **carry** the bm45 appendix into the generated layout and never drop it.
3. **Build Part 2 binder-first (R10, Inv #39).** The first Part 2 behavior unit re-points the renderer to `customer_bill_line` and asserts `Σ net_amount = customer_bill.subtotal` before it renders. Until that unit is green, no editor page, action or component merges.
4. **Delete the legacy path; never flag it (Inv #40).** `buildDraftInvoiceHtml`, `buildFinalInvoiceHtml` and their `udr_rated` read are removed in the binder unit. Do not keep them behind a flag, an env var or a "fallback".
5. **Bill Model 1; use Model 2 only to check (Inv #29).** No code path bills from `max(Q, target) × baseRate`.
6. **Treat Inv #29–#50 as permanent cross-unit rules.** Each one is checked on every unit that touches its surface, not only in the unit that introduced it.
7. **Prove behavior at the right layer.** Logic-green is not run-green (Inv #38). Part 1 capacity changes need both the extracted-SQL harness **and** a live-Kestra execution. Part 2 render changes need both unit and golden-render tests **and** the Playwright e2e.

---

## 2. Units and Sequencing

1. **Part 1: follow bm40–bm46 exactly** as `bm00-build-plan.md` defines them. Do not renumber, merge or reorder them. bm46 is verification only and adds no new behavior.
2. **Part 2: do not start a build unit until its `bm` spec exists in `specs/` and `bm00-build-plan.md` lists it.** Part 2 units continue the sequence from **bm47**. Do not restart at 1 and do not invent a unit number. Writing those specs is planning work, done in this planning repo.
3. **Do not write Part 2 build specs until X1–X4 are decided** (architecture _Open cross-update conflicts_). Each spec must cite the resolution it builds on.
4. **Part 2 load-bearing order.** Each item below comes before anything that depends on it:
   1. binder + reconciliation (R10)
   2. schema + seed migration (tables, `INVOICE` row, default layout and generated versions, `invoice_settings` permission row)
   3. blob-store generalization (R4)
   4. resolution, load and checksum verification
   5. posting-time stamps
   6. generator
   7. profile + logo services
   8. read pages
   9. EDIT actions
   10. CSV output

   The rating-side geo change (X1 → R9) lands **before** any binder reads geo from `udr_rated`.
5. **Never reopen a delivered unit to absorb new scope.** A change to delivered bm01–bm44 behavior belongs in a new unit with its own spec, even when the edit is small.

---

## 3. Scoping — No Speculative Changes

Apply the general §2. In addition, do not build any of the following. Each one is out of scope in `billmgmt-update-overview.md`:

1. **Proration or partial-period capacity billing.** This waits on a **business** decision (O-TC7). Partial-period accounts stay `EXCLUDED`.
2. **More than one capacity subscription per `(customer, product)`, or multiple billing accounts per customer for one capacity product** (Inv #37).
3. **Production multi-step motivation.** Ship the N-band SQL with `capacity_max_bands = 1`. Also out of scope: negotiated overrides on capacity offerings, rate-card item pricing, district summarisation, an appendix beyond 10,000 rows per account, and any UI or invoice display of `additional_info`.
4. **Code that disables `CAPACITY_RATE_MATCHING`.** It is an ops flag, default ON. Code never ships it OFF (Inv #30).
5. **Out-of-scope Part 2 features:** credit notes, debit notes, a separate pro-forma document type, per-MNO or per-customer templates, admin control of order, position, labels, wording, colours inside the template, fonts or page setup, an admin code editor or drag-and-drop designer, multi-entity issuing, account summary or balance brought forward, per-line tax, `kind = xml`, MyInvois or `einvoice.*`, a shared asset library, DuitNow QR, bilingual invoices, re-render for reprint, and a `udr_rated` geo backfill.
6. **Admin-authored markup of any kind.** The only admin template input is the boolean `structure` map (Inv #46).
7. **A new `ChargeSource` member.** Do not add `ONE_TIME` to a CHECK, union, label or fixture (C2). The binder groups by the existing `USAGE | RECURRING | OCC` union.
8. **Real taxation.** The ratified `0.00` interim stands for both parts.
9. **A second cache.** The compiled-template memo keyed by immutable version id is the only sanctioned in-memory cache. Never cache the "current ACTIVE" resolution, a profile, a logo or a bill.
10. **Changes beyond the authorized platform firsts.** Part 2 is authorized to add exactly these: the first user-uploaded file (the logo), the compiled-template memo, Handlebars 4.7 as a direct dependency, and the `invoice_settings` permission. Do not extend any of them into a general mechanism, such as a generic upload service or a generic cache.

---

## 4. When to Split Into Smaller Steps

Apply the general §3 triggers. In addition, these splits are mandatory:

1. **Land each schema change and its grants alone, before any consumer:**
   - Part 1: bm41.
   - Part 2: the four new tables, the two new `customer_bill` columns, the seed rows, the `app_runtime` grants, and the **revoke** of `billrun_runtime`'s grants on `ref_bill_format_id` / `ref_bill_template_version_id` (Inv #41).
2. **Add the Handlebars dependency as its own change.** It is the only dependency add Part 2 authorizes (general §5.6).
3. **Split the blob-store generalization (`putObject`/`getObject`, `putInvoice` refactor) from any feature that uses it.** The refactor must leave invoice PDF writes byte-for-byte unchanged.
4. **Split the infrastructure from the code.** Provisioning the `invoice-templates` and `invoice-assets` prod containers in `infra/**` is its own isolated unit, as general §2.8 requires.
5. **Split the posting-time stamp (`stampPosted` + `post-run.ts`) from the renderer.** It touches the money transaction and needs its own pinning tests (guardrail 46).
6. **Split each Part 2 screen's read path from its mutations.** Build Company profile READ, then its save-draft, logo upload and activate actions. Build Invoice template READ (with preview), then its save-draft and activate actions. Each action is its own unit with its own audit event and route × level tests.
7. **Split the logo upload and SVG sanitization from profile activation.**
8. **Keep the rating geo change set whole.** If X1 resolves to R9, the rating migration, the rating flow write and the Inv #36 amendment land together under rating's rules. Do not split them, and do not mix in any billing change.
9. **Split the usage appendix from money-correctness.** In Part 1 it stays its own unit after the pricing core (bm45 after bm42–bm44). In Part 2, the usage section ships after the binder's charge reconciliation is green.

---

## 5. Missing or Ambiguous Requirements

Apply the general §4. Never guess on money, the render source, a stamp, or a permission.

**DECIDED. Build to these and do not re-litigate them:**

1. Part 1 rate-match model: Model 1 is billed, Model 2 checks, the gate defaults ON, and OFF logs, records the flag state and bills Model 1 (Inv #29–#30). Single-subscription grain is per `(customer, product)` (O-TC5, Inv #37).
2. Part 1 build opens are resolved in their owning specs: O-TC1 and O-TC2 in bm42/bm43, O-TC6 in bm45. Cite the spec. Do not re-decide.
3. Part 2: everything in Plan §15 R1–R11 and Inv #39–#50. This includes binder-first, no fallback, park via the existing render-pending surface, pinned → ACTIVE → default resolution, reprint as a byte download, and reproducibility through `charge_checksum`.
4. Field formats are those in `invoice-template/placeholder-catalog.md` §B. If code-standards disagrees, the catalog wins.
5. Usage-section geo source (X1 / C1 / overview _Overlap_): **R9** — rating persists the matched ratecard cell's `state`/`district` onto `rating.udr_rated` at INSERT (bm48, migration `0045`); Inv #36 is amended. The `udr_key` → ratecard-cell mapping (G13) reuses PRP's existing canonical cell match — no new mapping rule (decided 2026-10-08).
6. Usage-section scope, row bound and over-limit behaviour (X2 / G2): **delivered by bm49** — the annex lists every billed `udr_rated` row for the account (all USAGE lines), grouped state → district, bounded to 10,000 rows/account; over the bound the bind fails `INVOICE_USAGE_OVER_LIMIT` and the account parks (INV stays posted). Part 2's multi-page tests use this 10,000-row bound (decided 2026-10-07, delivered 2026-10-08).

**OPEN. Stop and ask one precise question with the options. Never pick a default:**

| Topic | Where it is tracked (same issue, three IDs) | Interim rule |
| --- | --- | --- |
| `is_default` versus one-ACTIVE | X3 / C3 | Code-standards C3 (the partial index excludes the default), pending spec confirmation |
| Same file, two rewrites | X4 | §1.2 |
| `ONE_TIME` charge sourcing | C2 | §3.7 |
| Checksum algorithm for templates and assets | O2 / C4 | SHA-256 for new blobs, md5 for invoice PDFs. Record the algorithm with each checksum |
| Notes & terms and the footer sentence: layout text or profile fields | O3 | Ask before adding profile fields |
| Embedded fonts | O4 | No external font fetch, ever |
| Customer SST no., PO and contract references | O5 | Fragments stay hidden while blank. Add no columns |
| Retention of retired versions | O10 | Nothing deletes a version |
| Four-eyes on company-profile activation | Architecture _Noted gap_ versus code-standards ("does not apply") | **Conflict: stop and ask.** Do not build the activation action until it is decided |
| Seeded `invoice_settings` role grants | Code-standards §8 delta | Confirm in the spec |
| Where the CSV template version column lives | Architecture storage deltas ("settle in specs") versus code-standards (`customer_bill`) | Settle in the spec before migrating |
| Partial-period billing | O-TC7 | A **business** decision. Never build a method |

**Record every resolution in all three places that track it,** in the same change (§7.2).

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general §5 list applies in full. Stop, explain why, and get confirmation before touching any of the files below:

1. **Carried forward:**
   - `components/ui/`
   - applied migrations (now including `0044`)
   - `udr-status.repository.ts` (the only `rating` writer)
   - `rated-lines.repository.ts`, which **stays read-only**. If X1 resolves to R9, the usage-row read goes here as a read
   - `db/bootstrap/billrun-db-roles.sql` and `rating-db-roles.sql`
   - `billrun_delete_trial_bill`, `customer_bill_finalization_guard`, `rating.billrun_status_guard`
   - `postDocument`, pgledger and the INV reason code
   - Better-Auth tables
   - `tsconfig`, lint and CI configuration
   - lockfiles
2. **Deployed flow YAML is never edited in the Kestra UI.** Every flow change is a repo commit (Inv #38 also depends on the YAML being the source of truth). Part 1's capacity SQL lives in `bill_run_processing.yml` only. Never put it in a DB function or a Python task.
3. **The checksum tuple is append-only.** `rated_amount` stays last. Never reorder the tuple, never hash `additional_info`, and never re-anchor the tuple for Part 2 (Inv #35, #43).
4. **The destructive-DB preflight from bm40 stays.** Never remove or weaken it, and never reintroduce a cross-cluster `DROP DATABASE … WITH (FORCE)`.
5. **`product.ratecard_ran_usage_lkp` and `product.ratecard_version` are owned by the product module.** Read them only.
6. **Do not edit seeded layout versions.** Once `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**` is seeded, it is immutable. A layout change is a new `v{n}` directory and a new version row (Inv #44).
7. **Stored blobs are write-once.** Never overwrite a template, asset or invoice blob. Never delete an orphan inline.
8. **`customer_bill_finalization_guard` is not relaxed to allow a late stamp.** Stamps land in the same `UPDATE` as `ref_inv_document_id` or not at all (Inv #41).
9. **Invoice rendering orchestration in `render-invoice.ts`:** the semaphore, the concurrency cap and `BROWSER_CLOSE_TIMEOUT_MS` stay unchanged. Only the `page_setup` read and `footerTemplate` are added.
10. **`next.config.ts` `serverActions.bodySizeLimit` is not raised** for the logo upload.
11. **The application branding logo is untouched:** `getBrandingLogo()` and `app`/`app_logo_path`.
12. **The generic System Config page:** the only authorized change is excluding the `invoice.profile` group from its editable list.
13. **No new dependency beyond Handlebars.** `sharp` is already installed. An SVG sanitizer library, an image library or any other addition is a stop-and-ask.
14. **Rating module files** (schema, flow, `rating-db-roles.sql`) change only after X1 resolves to R9, and only under `ratemgmt-ai-workflow-rules.md`.
15. **`workflow-management/**` gets no Part 2 change.** A Part 2 diff touching it is off-plan.

---

## 7. Keeping Docs in Sync With Implementation

Apply the general §6. In addition:

1. **Keep three docs aligned on every Part 1 or Part 2 change:** `billmgmt-architecture.md`, `billmgmt-code-standards.md` and `billmgmt-progress-tracker.md`. Both overviews' success criteria require it.
2. **Close an open item everywhere it is tracked, in one change set.** The same issue appears under different IDs: X1 = C1 = the overview _Overlap_ item, X3 = C3, and O2 = C4. Remove it from the overview's _Open items_, the architecture conflict table and the code-standards C-table together. If X1 resolves to R9, **amend Inv #36's "never from `udr_rated`" clause** in the same change.
3. **Update the progress tracker with each unit.** Its Part 3 status ("bm40–bm46 planned, not delivered") is already stale against `dev1`. Correct it the next time you touch the tracker.
4. **Replace R#/D# citations with Invariant numbers.** Code-standards' Part 2 section says the architecture "has no Part 2 invariants yet". That is no longer true (#39–#50 exist). When you touch that section, cite the Invariants and delete the stale sentence.
5. **Never reuse a number.** Invariants run to #50 and guardrails to item 56. #15 is a tombstone. New rules take new numbers.
6. **Fold each part into `billmgmt-project-overview.md` at its ship gate:**
   - Part 1 at bm46, Part 2 at its own gate.
   - Remove the folded part from `billmgmt-update-overview.md` in the same change.
   - Do not fold early.
7. **The permission map moves as one set.** `invoice_settings` changes ship together: the `PERMISSIONS` migration row, `PERMISSIONS.INVOICE_SETTINGS`, the `PermissionName` member, the architecture §4 and code-standards §8 map rows, the `NAV_REGISTRY` entry and its `NAV_ICONS` glyph.
8. **Binding names are binding.** Create the component, file, union, error-code and audit-event names exactly as code-standards writes them. If a spec needs a different name, update code-standards first.
9. **Placeholder roots and the `InvoiceRenderInput` shape change in pairs.** A new or renamed placeholder updates `invoice-template/placeholder-catalog.md` and `InvoiceRenderInput` together.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general §8 checklist, then the module guardrails for every surface the unit touched (code-standards §9). **Run the checks; do not assume.** Additionally:

1. **Part 1 units:**
   - guardrails **36–42** pass
   - DB suites run the **extracted** flow SQL
   - a live-Kestra capacity run reaches `SCHEDULED → COMPLETED` (required at bm46, and on any unit that changes flow YAML)
   - no migration exists beyond `0044`
2. **Part 2 units:** the guardrails the unit introduces (**43–56**) land **with** the unit and are never deferred to the ship gate. In particular:
   - the binder reconciles (43)
   - no legacy render caller remains (44)
   - stamps and pinning hold (46)
   - tamper fails the render (47)
   - escaping holds (50)
3. **Earlier guardrails still green.** Re-run guardrails 1–35 that cover the touched files: the compute boundary, the rating write boundary, the finalization guard, the checksum, the three-handler route inventory, and seed integrity.
4. **Render-path changes:**
   - golden-render snapshots pass
   - bm18/bm19 tests are rewritten against the binder, not kept on legacy builders
   - the bm45 appendix still renders after any Part 2 change to the render files
   - a parked render leaves the INV posted and blocks distribution `COMPLETED`
5. **Grants:**
   - `billrun_runtime` has no grant on the Part 2 tables and has lost its column grants on the two reserved stamps
   - `app_runtime` has no `DELETE` on the Part 2 tables
   - Part 1 read grants are enumerated
   - all of the above is asserted over `information_schema`
6. **Authz:**
   - the route × level matrix covers every new route and action
   - an `invoice_settings` READ user cannot save, activate or upload
   - previewing a posted bill also requires `billrun_view`
7. **Audit:** each save, activation and logo upload writes exactly one `AUDIT_LOG` row in its transaction, with the event types code-standards defines.
8. **Open items:** the unit depends on no open item from §5, or it cites the recorded resolution.
9. **Docs:** the §7 docs are updated in the same change set, including the progress tracker and every place a closed item was tracked.

If any item fails, the unit is not done. Fix it before moving on. Never defer a failure to a later unit or to a ship gate.

---

## What Changed in This Revision (2026-10-07)

| Was | Now | Why |
| --- | --- | --- |
| Phase-3 supplement (bm22–bm35 unit table, bm22 environmental gate, phase-3 verification items) with Target Capacity appended | Re-scoped to the two in-flight updates. The still-binding phase 1–4 rules are condensed into §0 | Phase 3 is delivered. Its checks now live as code-standards guardrails 1–35 |
| "38 Module Invariants"; `billmgmt-update-overview.md` "folded in 2026-10-04" | **50** Invariants. The update-overview is live and holds Part 1 and Part 2 | Invoice Template update added #39–#50 |
| Capacity Unit 0 = "repair the recurring resolver"; "do not invent capacity unit numbers" | Resolver repair already shipped (bm00, bm40 re-scope). Part 1 is bm40–bm46, with bm40–bm44 committed | Build plan and codebase |
| No Invoice Template rules | Part 2 rules: binder-first, no fallback, sequencing after Part 1, mandatory splits, protected files, open-item stop list | `billmgmt-update-overview.md` Part 2, Inv #39–#50 |
