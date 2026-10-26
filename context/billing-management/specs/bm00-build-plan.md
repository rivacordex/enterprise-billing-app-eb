# Bill Run — Build Plan (Units, in build order)

Decomposition of the Billing Management (Bill Run) module into build units. This revision (2026-10-26) records the **Invoice Template Types** update (units **bm74–bm85**: editor-package upload, a catalog of template types, binding a BAN to a type, retire with a bulk switch, and export/restore) as **delivered**, signed off by the bm85 ship gate. It was a cross-module update; its Customer Management units are **cm23–cm24** in `context/customer-management/specs/cm00-build-plan.md` Phase 3. Units bm01–bm85 are delivered and listed below as the numbering record. No update is planned; the next one starts at **bm86**.

**Sources of truth:**
- `billmgmt-project-overview.md` › Invoice Template Types: the delivered design of the update (goals, flows, features, scope, success criteria 1–11 with evidence; folded from the update overview at bm85).
- `billmgmt-architecture.md`: Invariants #1–#68, with **#59–#68** for the Invoice Template Types update (built); the dated _Invoice Template Types — architecture deltas_ section; contradictions T1–T10.
- `billmgmt-code-standards.md`: the _Invoice Template Types — code-standards deltas_ section; guardrail items **68–79**.
- `billmgmt-ai-workflow-rules.md`: unit discipline, protected files, the verification checklist.
- `billmgmt-ui-context.md`: §7, §10a, §10e.
- `context/customer-management/custmgmt-project-overview.md` (› Invoice Template Types — Customer Management part) and `custmgmt-architecture.md` (Inv. #19–#22): the Customer Management part.
- `_updatemodule-billing-invoice-template-types-plan.md`: background analysis only. This build plan supersedes its §12 proposed order.
- **Stack:** `context/architecture.md` §1 + `billmgmt-architecture.md` (stack sections), unchanged except **one new library**:
  - unchanged: Next.js App Router (Server Actions, Route Handlers), TypeScript strict, Drizzle + PostgreSQL, Better-Auth RBAC, Zod, Handlebars 4.7.10, Playwright 1.63 Chromium, Azure Blob (Azurite locally), vitest
  - **new:** **`fflate`**, introduced just in time in bm78

**Decomposition rules:**
- Each unit produces **one visible result**.
- Each unit stays within **one system boundary**.
- Dependencies land **just in time**: a library, helper, grant or repository function arrives in the first unit that calls it.
- Units always done together in one session are **merged**.
- A unit with no standalone visible result is **merged** into its neighbour.
- Every unit finishes green (`tsc` / lint / tests incl. the route × level matrix), carries its own guardrail items, and syncs its owning doc before the next starts.

**Boundary key:**
- **DB:** `db/**` (schema, migrations, bootstrap grants, repositories).
- **RENDER:** `services/billing/render-invoice.ts`.
- **TEMPLATE-CORE:** `services/billing/invoice-template/**`, `validation/billing/**`, `db/seeds/invoice-templates/**`.
- **SETTINGS-UI:** `app/(app)/administration/invoice-settings/**`, `actions/billing/invoice-settings/**`, `components/billing/invoice-settings/**`, with the services they call.
- **BILL-RUN:** `services/billing/{capture-template-stamps,trigger-run,rerun-run}.ts`, `components/billing/rerun-dialog.tsx`.
- **TESTS:** cross-cutting guardrails and E2E.

---

> ## Status (2026-10-26)
>
> | Units | State |
> | --- | --- |
> | bm01–bm39 | **Delivered.** Phases 1–4. The cloud cutover is a gated ops step. |
> | bm40–bm46 + bm42a | **Delivered.** Target Capacity Pricing. Still open: **TC54** (capacity-aware live-Kestra harness) and **O-TC7** (partial-period capacity, a business decision). |
> | bm47–bm63 | **Delivered.** The Invoice Template update; signed off 2026-10-11. |
> | bm64–bm73 | **Delivered.** Invoice Template Phase 3; signed off by bm73, 2026-10-17. |
> | bm74–bm85 | **Delivered.** Invoice Template Types (with CM cm23–cm24); signed off by bm85, 2026-10-26. The manual editor-export pass (bm85 §3) is pending with the owner. |
>
> **Latest applied migration:** `0054` (cm23, `billing_account`), after `0053` (bm74, catalog). Both are additive and ran on a populated database; no applied migration was edited.

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
| 64–73 | `bm64`–`bm73` | Standard template family · run-start template capture · drafts from captured template · posting from captured template · flow stops writing appendix · DD/MM/YYYY and Mbps formats · page 1 capacity summary · detail pages per service type and State-District · Total Amount page + footnote editor + v1 pin · Invoice Template Phase 3 ship gate |
| 74–85 | `bm74`–`bm85` | type-scoped catalog (`0053`) · network-blocked, script-free rendering · `compliance.ts` + `INVTPL-BASIC-A4` reference package · type list, create type, type detail · upload a layout package as a draft (`fflate`) · activate an uploaded pair + discard · overwrite an open draft with the warning · export + restore · capture reads the BAN's type (one merge with cm23, `0054`) · retire with bulk switch · rerun type-changed warning · Invoice Template Types ship gate (joint with cm24) |
