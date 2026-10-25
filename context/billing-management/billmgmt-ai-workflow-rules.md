# Billing Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first and obey it in full; this supplement adds the Billing Management rules for the in-flight **Invoice Template Types** update (editor-package upload, type catalog, BAN binding, retire with bulk switch, export and restore) and the rules from delivered work that still bind every change. It never weakens the general rules. Where §6 below pre-authorizes an edit to a file that general §5 protects, that is the recorded instruction general §5 asks for. It does not skip general §5's "stop, explain why, and get explicit confirmation" step, which you still run at the start of that unit. Where a facet is not mentioned here, the general rule applies unchanged. If anything here appears to weaken a general rule or a Module Invariant, stop and treat it as a bug.

**Companion docs (authoritative; do not restate or contradict them):**

- `billmgmt-update-overview.md`: **the authoritative design of the in-flight update**: goals, flows, features, scope and success criteria 1–11. `billmgmt-project-overview.md` holds everything delivered: phases 1–4 (bm01–bm39), Target Capacity Pricing (bm40–bm46), the Invoice Template update (bm47–bm63) and Invoice Template Phase 3 (bm64–bm73).
- `billmgmt-architecture.md`:
  - **68 Module Invariants (§6).** **#59–#68** belong to this update and are planned. #51–#58 are Invoice Template Phase 3's (built). #15 is a retired tombstone.
  - The 2026-10-25 amendment notes under #44, #45, #46, #47, #49 and #54.
  - The dated section _Invoice Template Types — architecture deltas_, including its contradiction table **T1–T10**.
- `billmgmt-code-standards.md`:
  - The dated section _Invoice Template Types — code-standards deltas_.
  - **Guardrail items 68–79**.
  - Its permission map and its _Rules superseded by this update_ table.
- `_updatemodule-billing-invoice-template-types-plan.md`: the analysis record behind the design (decisions D61–D132, the eng review, the proposed build order). **Background only.** It is never the authority over the update overview, the architecture or the code standards.
- `specs/bm00-build-plan.md`: the authority on unit numbering, boundaries and build order **once this update's part is written** (see §2). Parts 1–5 record delivered work.
- `context/customer-management/custmgmt-ai-workflow-rules.md`: **binding on you** for every Customer Management file this update changes (§6.2).
- The Invoice Template Editor repo (`F:\Projects\invoice-editor`): a separate repository with its own plan. Change it only as §6.9 authorizes.

**Precedence:** the general order stands (architecture **Invariants** → overview → architecture → code-standards → this supplement → general rules). For this update, `billmgmt-update-overview.md` is the overview. **If the update overview and the plan differ, the update overview wins.** Fix the plan to match; never build from the plan's wording.

**Current state:** `billmgmt-progress-tracker.md` is the only status source. This file keeps no status snapshot. Check the tracker against `git log` on `dev1` before you start.

---

## 0. Carried-Forward Module Rules (Delivered Work, Still Binding)

These come from phases 1–4, Target Capacity Pricing, the Invoice Template update and Invoice Template Phase 3. They are **permanent**, and this update touches the code they protect. A unit that violates one is a review-blocking defect.

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
   - The compiled-template memo is the only cache, and it never holds a DRAFT (Inv #61).
7. **Decided policies stay decided:**
   - unresolvable subscriber (Inv #25);
   - recurring-price miss (Inv #28);
   - `EXCLUDED` forgoes the month (Inv #26);
   - "Uncharged means no charge line" (Inv #22);
   - no four-eyes on profile activation;
   - no `ONE_TIME` source;
   - partial-period capacity billing (**O-TC7**) is an open business decision; never build a method for it.
8. **Invoice Template Phase 3 is settled (bm64–bm73, signed off 2026-10-17).** Read each line with the correction this update makes:
   - **Capture and freeze:** a BAN's template is captured once at run start and frozen on `bill_run_account`. Drafts, posting and reprint read the stamps, and only a rerun re-captures, for the rerun BANs only (Inv #51, #52).
   - **One resolver:** never add a live-resolver call on a run path, not even behind a flag. Only `captureTemplateStamps` and the editor preview resolve "current ACTIVE" (Inv #53, guardrail 57).
   - **The bill run only reads the BAN's template reference (Inv #54, as amended).** _Corrected:_ the reference is now `billing_account.ref_bill_template_family_id`, and Customer Management is no longer read-only. Billing reads the column at capture, and writes it **only** in the retire bulk switch (Inv #66).
   - **Utilised / Unutilised** are derived in SQL from the bill line and never stored; a negative Utilised fails `INVOICE_NEGATIVE_UTILISED` (Inv #55).
   - **Per-polygon detail** has one source, the live `udr_rated` read, reconciled per type (Inv #56).
   - **Layout v1 and its first generated version are pinned** (`tests/guardrails/invoice-template-v1-pin.test.ts`, Inv #57). Every later layout, structure or footnote change is a new version. _Corrected:_ new layout versions now arrive **by upload only** (Inv #59), never by editing seed files.
   - **A template problem at run start** never excludes a BAN or blocks the trigger: the draft 422s, approval is blocked, posting skips before the INV, and a rerun after activating a version recovers it (Inv #58).
   - **Admin template input:** the footnote (1–5 plain-text lines of at most 200 characters) is the only admin-authored text in the settings form, and Payment information is the only section toggle. _Corrected:_ an **uploaded layout package** is now the one sanctioned way admin input becomes layout code, and only through the upload gate (Inv #46 amended, #60).

---

## 1. Operating Approach — This Update

1. **Name the authorizing source before you write anything:** a `bm`/`cm` spec for this update, an Invariant (#59–#68, or an amended #44–#47, #49, #54), a guardrail item (68–79), or a section of `billmgmt-update-overview.md`. Cite the Invariant first whenever one exists. Never cite the plan as the authority.
2. **Do not write code before its spec exists.** No spec for this update is written yet. The plan's §12 build order is a **proposal from analysis**, not a unit authority. Write `bm00-build-plan.md` Part 6 (and the matching Customer Management build-plan entries) first. Then write each unit's spec. Then build. If a spec turns out wrong, or a codebase fact has moved, correct the spec in this planning repo first, then build.
3. **Assume a populated database.** This update's migrations (`0053`, `0054`) are additive and run on environments holding real runs and bills. Never edit `0046` or any other applied migration. Never empty a database or a blob container to make a change work. If a change only works on an empty database, it is wrong; stop and ask.
4. **Route every layout write through `installLayoutPackage` (Inv #59).** Never insert or update a `kind = 'layout'` row anywhere else: not in a seed, a migration, a script or a test helper. Tests create layouts by calling the service.
5. **Validate first, write last (Inv #60).** The upload gate runs every check and collects every problem before the first blob or row write. Never "write and roll back".
6. **Keep DRAFTs away from bills (Inv #61).** Load a DRAFT only through `loadLayoutDraft`, and only from preview, the upload gate, activation and export. Never relax `assertLoadable`, and never add a DRAFT to any cache.
7. **Trust content, never origin (Inv #60).** Never add a check, flag or code path that treats a package differently because of who or what made it. An app export is recognised only by a schema-valid `settings.json`.
8. **Render through the one hardened context (Inv #64).** Never call `chromium.launch` or `browser.newContext` outside the context factory in `render-invoice.ts`. Never let a blocked fetch throw from a draft or final render.
9. **Prove behavior at the right layer.**
   - The upload gate needs one fixture per problem code (guardrail 69).
   - Rendering needs a real Chromium render plus a stub server that records hits (guardrail 74).
   - Locks need DB-backed parallel-transaction tests (guardrail 76).
   - Migrations need a populated-database test (guardrail 75).

---

## 2. Units and Sequencing

1. **Build the units in `specs/bm00-build-plan.md` Part 6 (bm74–bm85), in that order.** It is the unit authority, written 2026-10-25 at the owner's request. Do not renumber, merge, split or reorder them. If a unit turns out too large, stop and ask before changing `bm00`. The Customer Management units are `cm00` Phase 3 (cm23–cm24).

   | Unit | Visible result |
   |---|---|
   | bm74 | type-scoped catalog in the database (`0053`) |
   | bm75 | network-blocked, script-free rendering |
   | bm76 | `compliance.ts` + the `INVTPL-BASIC-A4` reference package, checked in CI |
   | bm77 | type list, create type, type detail page |
   | bm78 | upload a layout package as a new draft (the gate, `installLayoutPackage`, `fflate`) |
   | bm79 | activate an uploaded draft pair; discard |
   | bm80 | overwrite an open draft, with the warning |
   | bm81 | export a version and restore it |
   | cm23 + bm82 | bind a BAN to a type + capture reads it (**one merge**) |
   | bm83 | retire with bulk switch |
   | bm84 | rerun "type changed" warning |
   | bm85 + cm24 | ship gate |

2. **Keep the merge pairs whole.** The `0054` column change and the capture read ship in **one merge**: both units' specs say so, and both build plans mark them as one merge unit. Never merge one without the other.
3. **Respect the dependencies.**
   - Upload (bm78) follows `compliance.ts` (bm76) and the type detail page (bm77); it introduces `installLayoutPackage`, `loadLayoutDraft`, `lockTemplateType` and `fflate` itself.
   - Export (bm81) follows activation (bm79).
   - Binding (cm23 + bm82) follows activation (bm79), because a type is usable only after a layout is uploaded and activated.
   - Retire (bm83) follows binding.
4. **The editor reworks follow the step that creates `compliance.ts`** (§6.9). No app unit waits on them.
5. **The ship gate is last and builds nothing.** It audits Inv #59–#68 and guardrail items 68–79, runs success criteria 1–11, and folds the update into `billmgmt-project-overview.md` (§7.8).

---

## 3. Scoping — No Speculative Changes

Apply the general §2. In addition, do not build any of the following. Each is out of scope in `billmgmt-update-overview.md`:

1. **An in-app visual layout editor,** or any in-app editing of layout files.
2. **Uploading single files or a partial package.** An upload is always a complete package.
3. **Installing layouts through the seed, a migration or a release step.** Upload is the only path (Inv #59).
4. **Renaming a type,** or any UPDATE of a type's `name`, `code` or `layout_code` (Inv #65).
5. **A new kind of invoice section,** a toggle beyond Payment, other detail-table columns or grouping, or a new render-input field. These need generator changes, which are out of scope.
6. **Making a compliance section optional,** or weakening the visible-text check (Inv #63).
7. **Changing the default type,** or un-retiring a type (Inv #65, #67).
8. **Per-BAN targets on retire,** a bulk rebind outside retire, or choosing a type at onboarding (onboarding keeps writing NULL).
9. **A second approver,** an "uploader ≠ activator" check, package signing or provenance checks.
10. **A worker or timeout for the upload gate** (an accepted risk), a bulk export of all types, or automatic sync between environments.
11. **CSV templates per type,** an invoice profile per type, non-`INVOICE` bill formats, or e-invoicing (LHDN MyInvois).
12. **A new permission or level.** Use `invoice_settings` READ/EDIT, the cm21 gate and `billrun_operate` as mapped in code-standards.
13. **An index on `billing_account.ref_bill_template_family_id`.**
14. **Raising `next.config` `serverActions.bodySizeLimit`.** A package is about 200 KB.

---

## 4. When to Split Into Smaller Steps

Apply the general §3 triggers. Inside a unit, these orderings are mandatory:

1. **Schema and grants first.** Land each migration (`0053`, `0054`), its Drizzle mirror and the `bootstrap-db-roles.sql` grant change as the unit's first commit, before any consumer code.
2. **The dependency on its own commit.** Add `fflate` to `package.json` and the lockfile as the first commit of the unit that first uses it, with no other change in that commit (general §5.6).
3. **Read before write.** The type list and type detail (READ) land before create, upload, activate, discard and retire (EDIT). Export (READ) lands before restore (EDIT) (general §3.2).
4. **One mutation per step.** Create type, upload, save settings, activate, discard, retire and export are separate steps, each with its own action, audit event and tests (general §3.3).
5. **The merge pair together, nothing else with it.** The `0054` change and the capture read form one change set. Add no UI to it.
6. **Each guardrail with its step** (§8.1).

If a unit grows beyond its `bm00` entry, stop and ask (general §2.3). Do not split or merge units on your own.

---

## 5. Missing or Ambiguous Requirements

Apply the general §4. Never guess on the upload gate, a lock, a grant, a permission, what a template may contain, or what the invoice prints.

**DECIDED. Build to these and do not re-litigate them.** This list is an index, not the source: if a line here and its owning section differ, the owning doc wins and this line is a bug to fix.

1. **Intake:** upload only; one complete package; trust by content only (Inv #59, #60).
2. **Drafts:** one layout DRAFT and one settings DRAFT per type. An upload over an open DRAFT overwrites it in place, after the warning, keeping the row and `version_no`. A changed DRAFT fails `DRAFT_CHANGED_SINCE_WARNING`. Every upload bumps the settings DRAFT's token (Inv #62).
3. **The version check is strict** for editor packages. An app export with a valid `settings.json` skips it; the type-code check always applies (Inv #60, #68).
4. **Compliance** is the visible-text check in `compliance.ts`, never the manifest's `mandatory` flags (Inv #63).
5. **Rendering:** network blocked and script off everywhere. The gate fails on a fetch; draft and final renders log and never throw. Preview stays sandboxed HTML (Inv #64).
6. **Types:** a new type starts empty; name and code are final; Standard is the permanent default and is stored as NULL on a BAN (Inv #65, #66).
7. **Retire:** bulk switch to one usable target, ascending-id locks, zero BANs before `retired_datetime`, one-way (Inv #66, #67).
8. **Export:** any version pair, byte-identical, plus `settings.json`, with `invoice_settings` READ (Inv #68).
9. **Access:** one EDIT holder may upload and activate; `last_modified_by` is recorded on every DRAFT write.
10. **Grants:** `app_runtime` gets INSERT, UPDATE and sequence USAGE on `bill_template_family`; DELETE stays revoked; `billrun_runtime` gets nothing.

**OPEN. Stop and ask one precise question with the options. Never pick a default:**

| Topic | Interim rule |
| --- | --- |
| Partial-period capacity billing (O-TC7) | A **business** decision. Partial-period accounts stay `EXCLUDED`. |
| A change to the unit list | `bm00` Part 6 is written (2026-10-25). Any split, merge or reorder needs owner approval first. |

**Also stop and ask** when a unit seems to need any of these:
- a write to `billing_account` outside the bind gate or the retire switch;
- a new error code beyond the unions in code-standards (TS rule 2);
- an audit event beyond the five this update adds;
- a cache, a worker or a background job;
- a layout-row write outside `installLayoutPackage`;
- a change to a UI string beyond `template-type-messages.ts`;
- a change to the compile settings or the helper set.

**Record every resolution in the owning companion doc** (product behavior → `billmgmt-update-overview.md`; rule or invariant → `billmgmt-architecture.md`; convention → `billmgmt-code-standards.md`) in the same change. Add a plan note only as history (§7).

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general §5 list applies in full. Stop, explain why, and get confirmation before touching any of these:

1. **Carried forward. Never change these in this update:**
   - `components/ui/`
   - `udr-status.repository.ts` (the only `rating` writer), `db/bootstrap/rating-db-roles.sql`
   - `billrun_delete_trial_bill`, `customer_bill_finalization_guard`, `rating.billrun_status_guard`
   - `postDocument`, pgledger and the INV reason code
   - Better-Auth tables
   - `tsconfig`, lint and CI configuration
   - `next.config.ts` `serverActions.bodySizeLimit`
   - `getBrandingLogo()` and `app`/`app_logo_path`
   - the destructive-DB preflight
   - `product.ratecard_ran_usage_lkp` / `ratecard_version` (product-owned; read only)
   - all flow YAML under `workflow-management/**`, because this update needs no flow change
2. **Customer Management files are authorized only as `custmgmt-ai-workflow-rules.md` §10.6 lists them** (the single list): the bind gate, the bind service, action and schemas, onboarding's signature, the BAN list, summary and label reads, the new usable-type read, the BAN panel and card components, the Manage Customer page, and the `billing_account` Drizzle mirror and migration. Build them under that file's rules.
   - Nothing else under `services/accounts/**`, `actions/accounts/**`, `components/customers/**` or `app/(app)/customers/**`.
   - Never edit `db/migrations/0050_billing_account_template_ref.sql`; `0054` supersedes its column.
3. **Applied migrations (through `0052`).** Never edit one, `0046` included. This update adds `0053` and `0054` only, each with a hand-added journal entry. **The one authorized trigger disable** is inside `0053`: a single-row backfill of Standard's default layout row, asserted to change exactly one row, then re-enabled. Add no other trigger disable anywhere.
4. **Seed directories.**
   - `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**` and `generated/INVOICE/v1/**` stay pinned (guardrail 65). Never edit them.
   - **Authorized:** add the new reference package `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/**`, and regenerate its `checksums.json` only with `scripts/invoice-templates/write-checksums.ts`.
   - Never make `db/seeds/invoice-templates.ts` upload the reference package or insert any layout row.
5. **`services/billing/invoice-template/helpers.ts` and `compile.ts`.** Register no helper, remove none, and keep the compile settings exactly as they are.
6. **`services/billing/render-invoice.ts`.** **Authorized:** the hardened browser-context factory (`javaScriptEnabled: false`, `offline: true`, the route block, logging of blocked URLs). Keep the semaphore, the 2-render cap and `BROWSER_CLOSE_TIMEOUT_MS` unchanged. The upload gate's probe render goes through the same semaphore.
7. **Role bootstraps.** **Authorized:** `db/bootstrap/bootstrap-db-roles.sql` replaces Phase 3's `REVOKE INSERT, UPDATE, DELETE` on `billing.bill_template_family` with `GRANT INSERT, UPDATE` plus `GRANT USAGE` on `billing.bill_template_family_seq`, and keeps DELETE revoked. Give `billrun_runtime` nothing new. Change no other grant.
8. **Stored blobs.** Never overwrite or delete a template, asset or invoice blob. An overwritten DRAFT's files stay in the store; an overwrite writes new objects under a new content-digest folder.
9. **The Invoice Template Editor repo (`F:\Projects\invoice-editor`).** **Authorized only:**
   - **E7:** snapshot `compliance.ts`, call it from `src/shared/gates.ts`, delete `contract/lint/lint.ts` and the local `hardeningHits`, point `contract-drift.test.ts` at the snapshot, and bump `contractVersion` to `1.1.0`.
   - **E8:** add `INVTPL-BASIC-A4/v1` to `scripts/snapshot-contract.ts`'s sources.
   - **E9:** the export-dialog and README hand-off wording.

   Make these in that repo, under its own plan. Never copy editor code into the app.
10. **`rated-lines.repository.ts`** stays read-only.

---

## 7. Keeping Docs in Sync With Implementation

Apply the general §6. In addition:

1. **Keep these docs aligned on every unit of this update:**
   - `billmgmt-update-overview.md`
   - `billmgmt-architecture.md`
   - `billmgmt-code-standards.md`
   - `billmgmt-progress-tracker.md`
   - for Customer Management units, the matching `custmgmt-*` docs
2. **The update overview is the design.** If code or a spec must differ from it, change the overview first, with owner approval, and then the architecture and code standards. Record the reason only as a note in the plan, never as the authority.
3. **Flip "planned" to "built" as you go.** When a unit delivers an invariant (#59–#68) or a guardrail item (68–79), change its marker to "built (bmNN)" in the same change, and name the test file that proves it.
4. **Never reuse a number.** Invariants run to #68 and guardrail items to 79; #15 is a tombstone. New rules take #69 and item 80 onward.
5. **Keep the superseded tables current.** If a unit changes an earlier rule not yet listed in code-standards' _Rules superseded by this update_ or architecture's T1–T10, add a row in the same change.
6. **Bind names exactly as code-standards writes them:** file paths, `installLayoutPackage`, `loadLayoutDraft`, `lockTemplateType`, `compliance.ts`, the error-code unions, `LAYOUT_PACKAGE_FILES`, the UI strings in `template-type-messages.ts`. If a spec needs a different name, update code-standards first.
7. **Close tracked items in one change set.** When binding ships, close `TODOS.md`'s Customer Management "Phase 3: catalog + posting reads the BAN binding" entry. The binding UI and create/retire screens are what it was waiting for.
8. **Fold at the ship gate only.** The ship gate folds the update into `billmgmt-project-overview.md` and **deletes** `billmgmt-update-overview.md` in the same change. The next update re-creates it. Do not fold early.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general §8 checklist, then every module guardrail covering the files the unit touched. **Run the checks; do not assume.** Additionally:

1. **Guardrails land with their unit.** Every item the unit introduces (68–79) passes in that unit, never deferred to the ship gate:

   | Unit | Guardrail items |
   |---|---|
   | bm74 | 75 |
   | bm75 | 74 (draft/final render half, single context factory) |
   | bm76 | 72, 73 |
   | bm77 | the grant half of 79 |
   | bm78 | 68, 69, 70, the gate half of 74 |
   | bm79 | the activation half of 71 |
   | bm80 | the concurrency half of 71, the preview-after-overwrite half of 70 |
   | bm81 | 78 |
   | bm82 (with cm23) | the `0054` half of 79 |
   | bm83 | 76, 77, the boundary-exemption half of 79 |

2. **Earlier guardrails still green.** Re-run every guardrail covering touched files, at minimum:
   - one resolver (57)
   - freeze (58–60)
   - the v1 pin (65)
   - the boundary test (66, with its new pinned exemption)
   - structure and manifest parity (67)
   - default resolution (45)
   - tamper (47)
   - escaping (50)
   - the authz matrix (56)
3. **Drafts never reach a bill.** Any unit touching load, capture, posting, render or reprint proves that a DRAFT is refused there (guardrail 70).
4. **Populated-database proof for migration units.** `0053` and `0054` apply on a database holding Standard's rows, posted bills and BANs. Existing rows stay valid. `bill_template_version_guard_trg` is enabled afterwards. `0054` aborts on a non-NULL version binding.
5. **Grants.** Asserted over `information_schema`:
   - `app_runtime` has SELECT, INSERT and UPDATE (and **no DELETE**) on `bill_template_family`, and USAGE on its sequence
   - `billrun_runtime` has no new grant
6. **Upload rejections write nothing.** For every rejected fixture, the row, blob and audit counts are unchanged.
7. **Render units.** A real Chromium render runs with the hardened context. A stub server records no hit. Standard v1's golden is unchanged. A blocked fetch in a final render still produces the PDF.
8. **Customer Management scope.** `git diff --stat` shows no Customer Management file outside the §6.2 list, and `custmgmt-ai-workflow-rules.md`'s own checklist passes for those files.
9. **Audit.** Each new action writes exactly its event in the same transaction as its rows:
   - `INVOICE_TEMPLATE_TYPE_CREATED`, `INVOICE_TEMPLATE_LAYOUT_UPLOADED`, `INVOICE_TEMPLATE_DRAFT_DISCARDED`, `INVOICE_TEMPLATE_TYPE_RETIRED`, `INVOICE_TEMPLATE_EXPORTED`
   - one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per switched BAN

   A rejected upload writes no audit row.
10. **Docs.** The §7 docs are updated in the same change set, with "planned" markers flipped and the progress tracker current.

If any item fails, the unit is not done. Fix it before moving on. Never defer a failure to a later unit or to the ship gate.

---

## What Changed in This Revision (2026-10-25, Invoice Template Types planned)

| Was | Now | Why |
| --- | --- | --- |
| "No update is in flight"; §1–§8 kept Phase 3's unit discipline as the record | §1–§8 rewritten for the in-flight **Invoice Template Types** update; Phase 3's binding rules stay condensed in §0 item 8 | A new update is planned (`billmgmt-update-overview.md` re-created) |
| Companion: the Phase 3 plan (D1–D60) as "the design authority"; "the plan's later decision wins" | `billmgmt-update-overview.md` is the authoritative design; the types plan is background only, and if it differs from the overview, the overview wins | Owner instruction: the update overview is authoritative |
| 58 invariants; guardrail items to 67; next numbers #59 / item 68 | 68 invariants (#59–#68 planned); guardrail items to **79**; next numbers **#69 / item 80** | New architecture and code-standards sections |
| §0.8 / §1.5 / §3.1 / §6.2: Customer Management read-only and off limits; no family column, no family-aware gate, no dropdown | Customer Management changed **only** for the bind gate, signature adoption, the BAN panel dropdown and the Accounts tab label, under `custmgmt-ai-workflow-rules.md`. Billing writes `billing_account` only in the retire switch | Binding is in scope; Inv #54 amended, #66 |
| §3.2 / §6.8 / §8.9: no `INSERT`/`UPDATE` grant on `bill_template_family`; assert `app_runtime` SELECT-only | Grant INSERT, UPDATE and sequence USAGE; DELETE stays revoked; assert exactly that | Create type and retire write the table |
| §1.3 / §6.3 / §8.6: fresh-DB round; `0046` edited in place; empty the blob container | Assume a populated database; additive `0053`/`0054`; never edit `0046`; one authorized single-row trigger disable inside `0053` | The update runs on environments with real bills |
| §3.10: no layout v2, no second generated version; §0.8: the footnote is the only admin-authored text | New versions (v2+) arrive by upload only; an uploaded package is the one sanctioned admin-supplied layout, gated by Inv #60 | Upload is the update's purpose; Inv #46 amended |
| §5 "stop and ask" on a second family or a write to `billing_account` | Both in scope; still stop and ask for a `billing_account` write outside the bind gate or retire switch | Binding and retire are in scope |
| §8.10: "No new audit event type exists" | Five new audit events plus per-BAN `BILLING_ACCOUNT_TEMPLATE_CHANGED`; a rejected upload writes none | New flows |
| §6.7: `render-invoice.ts` changes only the footer alignment | The hardened context factory is authorized; semaphore and cap unchanged | Inv #64 |
| §7.3: update `TODOS.md`'s Phase 3 entry to "binding UI deferred" | Close that entry when binding ships | Binding ships in this update |
| Lockfiles untouched | `fflate` added as its own first commit | Inv #60 (in-memory zip) |
| Editor repo not mentioned | E7, E8 and the E9 wording authorized in that repo only | The app owns the rules; the editor snapshots them |

## What Changed in the Previous Revision (2026-10-17, bm73 ship gate)

| Was | Now | Why |
| --- | --- | --- |
| Scoped to the in-flight **Invoice Template Phase 3**; #51–#58 planned; the `0046` and v1 in-place edits authorized | **No update in flight.** Phase 3's still-binding rules condensed into §0 item 8; §1–§8 kept as the record and the default discipline for the next update; the in-place authority is spent (v1 pinned, `0046` protected again) | bm73 signed off Phase 3 (criteria 1–15, Inv #51–#58 audited, guardrails 57–67 green); the update is folded into `billmgmt-project-overview.md` |

## What Changed in the Revision Before (2026-10-15)

| Was | Now | Why |
| --- | --- | --- |
| Scoped to two in-flight updates, Part 1 (Target Capacity) and Part 2 (Invoice Template), with their sequencing, splits and open-item lists | Re-scoped to **Invoice Template Phase 3**. The still-binding Part 1 and Part 2 rules are condensed into §0 | Both parts are delivered and folded into `billmgmt-project-overview.md` |
| "50 Module Invariants"; guardrails to item 56; applied migrations through `0049` | **58** Invariants (#51–#58 planned); guardrail items to **67**; applied migrations through **`0050`** | Phase 3 architecture and code-standards sections |
| "Do not edit seeded layout versions"; "never edit an applied migration"; "`workflow-management/**` gets no change" | One authorized in-place edit each for `0046` and the v1 seeds (fresh-DB round, then pinned); one authorized flow edit (appendix removal) | Phase 3 plan |
| "The only admin template input is the boolean `structure` map" | Plus 1–5 plain-text footnote lines; only the Payment toggle remains | Inv #46 amended |
| Part 1 rate gate: "OFF logs, records the flag state" | OFF logs a WARN and bills Model 1; the flag state is **not** stored | Corrected against dev1 (bm43) |
| Three slices, with the binder shape in slice 2 | Units bm64–bm73 in `bm00`: the binder and the matching v1 pages change together, page by page (bm70–bm72) | The current v1 cannot render the new shape, so the binder must never run ahead of the layout (general §3.7) |
| Rerun audit only records the stamps | Trigger **and** rerun audits record the stamps | Owner-approved fix (2026-10-15) |
