# CM00 — Customer Management Module Build Plan (Units in Build Order)

**Sources:** `custmgmt-project-overview.md` (v1 and the delivered binding update), `custmgmt-update-overview.md` (the in-flight **Invoice Template Types** update, Customer Management part; owning design `context/billing-management/billmgmt-update-overview.md`), `custmgmt-architecture.md` (stack = platform `architecture.md` §1 unchanged; §6 Module Invariants #1–#22; §7 and §8 update deltas), `custmgmt-code-standards.md` (§7 file tree, §8 permission map, §9 guardrails, §10 Types deltas), `custmgmt-ai-workflow-rules.md` (§9 binding record, §10 Types rules). The Billing units of the update are **bm74–bm85** in `context/billing-management/specs/bm00-build-plan.md` Part 6.

## How units are cut

1. **One visible result per unit** — a migration that introspects cleanly, a page or tab that renders, an action that mutates, audits and is inspectable in the DB.
2. **One system boundary per unit** — see the boundary key.
3. **Dependencies just in time** — a repository function, validator or read service is introduced in the first unit that calls it, never upfront.
4. **Merge always-done-together units** — e.g. a page container with its first mutation; an action with the only UI that calls it.
5. **Merge units with no standalone visible result** — e.g. Zod schemas, validators and read services merge into the first unit that renders or mutates with them.

**Boundary key:** `DB` = `db/**` schema, migrations, seeds · `APP` = `app/(app)/customers/**`, `components/customers/**`, `actions/customer/**`, `services/customer/**`, `validation/customer/**`, and, for the binding and Types updates, the Accounts-side files a customer screen calls (`actions/accounts/**`, `services/accounts/**`, `validation/accounts/onboard-customer-accounts.schema.ts`; the `billing_account` table is Accounts-owned, `custmgmt-architecture.md` §7) · `TESTS` = `tests/**` cross-cutting guardrail/authz sweep.

---

## Delivered units (numbering record)

_Per-unit detail lives in the spec files (`specs/cm01`–`specs/cm22`); the build record is `custmgmt-completed-tracker.md` (cm01–cm16) and `custmgmt-progress-tracker.md` (cm17–cm22). Product scope is in `custmgmt-project-overview.md`._

| Units | Phase | Names |
| --- | --- | --- |
| cm01–cm16 | Phase 1 — v1 full CRUD (delivered) | DB foundation (`customer` schema, `customers` permission, search-limit seed) · validation, transition maps and read services · nav · View Customer search · View Customer detail · Manage Customer search · create customer · edit page + update organization · organization status transition · customer status transition · add contact · update contact · delete contact · set preferred contact · set preferred contact method · authz + guardrail ship gate |
| cm17–cm22 | Phase 2 — Invoice Template Binding (delivered, signed off 2026-10-25) | BAN template reference column · onboarding "Invoice template" field + `assertBindableTemplate` · View Customer tab shell · View Customer Accounts tab · Manage Customer Billing account panel + template reset · binding ship gate |

**Durable facts from delivered units:**
- **Permissions:** `customers` is READ/EDIT only; there is no `DELETE` level.
- **Out of scope:** shape validation on `party_role_specification`, MERGED-status migration tooling, multi-value contact fields, individual (person) customers, TMF/external APIs.
- **Account linkage:** `party_role.account` stays display-only (Inv. #9).
- **Navigation:** governed by the platform `NAV_REGISTRY` rule.
- **Locks and reads:** a BAN template change is guarded by the BAN lock, not the customer lock (Inv. #17); customer screens read accounting data read-only (Inv. #11).
- **What Phase 3 replaces:** the NULL-only rule, the version column and the Reset control.

---

## Phase 3 — Invoice Template Types update, Customer Management part (cm23–cm24) — PLANNED

Bind a BAN to a **template type**: the BAN column moves from a version to a type (`NULL` = Standard), RevOps chooses the type on Manage Customer, and the labels show the type the next bill run will capture. A cross-module update owned by Billing (`bm00` Part 6, bm74–bm85). No new permission, table, audit event type, technology or background job. Units follow `custmgmt-ai-workflow-rules.md` §10. Every DB-gated test runs on a disposable Postgres. Specs written (2026-10-25): `cm23-bind-ban-to-template-type.md` (counterpart `bm82-capture-reads-ban-type.md`) and `cm24-template-types-ship-gate.md` (counterpart `bm85-template-types-ship-gate.md`).

### Unit cm23 — Bind a BAN to a template type (**one merge with bm82**)

- **Boundary:** APP, including the Accounts-side files and the `billing_account` migration, as cm17 did.
- **Builds:**
  - Migration `0054`: add `billing.billing_account.ref_bill_template_family_id` (FK to `bill_template_family`, nullable, `NULL` = Standard), `RAISE EXCEPTION` if any `ref_bill_template_version_id` is non-`NULL`, then drop that column and its FK. The Drizzle mirror and the column comment follow.
  - `assertBindableTemplate(tx, typeId | null)`: `null` is accepted; a type id goes through Billing's `lockTemplateType(tx, id, 'share')` and must be usable. Standard's id, unknown, retired or not-yet-usable types return `TEMPLATE_NOT_BINDABLE`.
  - `setBillingAccountTemplate`, its action and schema take `typeId | null`. The guards, the BAN compare-and-set, the result codes and the no-write-on-unchanged rule are unchanged. The audit carries the type id and name before and after.
  - **Just in time:** `listBindableTemplateTypes()` (Standard first, then usable types, via Billing's type repository) and the rewritten `resolveBanTemplateLabel`.
  - `BillingAccountPanel`: a per-BAN `TemplateTypeSelect` + **Save** replaces Reset, with the "next bill run" caption, the retired-type message and reload. `BillingAccountCard`: the "Invoice template type" label. The onboarding wizard wording. `billing-account-messages.ts`.
  - The `list-customer-billing-accounts` and `get-customer-accounts-summary` reads return the type id and label.
- **Merged because:** the migration and the gate have no visible result without the panel. The panel has nothing to save without them. And `0054` must ship in the same merge as Billing's capture read (bm82).
- **Visible result:**
  - A user with both permissions picks "Wholesale" for BAN A on Manage Customer and saves. One audited update follows, and the label reads "Wholesale · v1".
  - With bm82, the next Run drafts BAN A on Wholesale.
  - "Standard (default)" writes `NULL`.
  - A retired or not-yet-usable type is refused with the message.
  - A `customers : EDIT`-only user sees the panel greyed.
  - The View Customer Accounts tab shows the type label.
  - Onboarding still creates `NULL`, with the new wording, and V7 stays green.
  - `0054` aborts on a non-`NULL` version fixture.
  - CM guardrails 11, 12 and 13.
- **Dependencies:** Billing bm74 (type table), bm77 (type repository `listUsable`), bm78 (`lockTemplateType`), bm79 (a usable non-Standard type to bind). **Counterpart: bm82** (same merge).

### Unit cm24 — Invoice Template Types ship gate pointer (**joint with bm85**)

- **Boundary:** TESTS.
- **Builds:**
  - The Customer Management half of bm85's end-to-end journey: bind → run → retire switch → label shows the new type.
  - The parallel bind-vs-retire run (with bm83).
  - Guardrails 11–13 green, and the docs close-out per `custmgmt-ai-workflow-rules.md` §10.7: Inv. #19–#22 flipped to "built", #18 and guardrail 10 marked replaced, the `cm05`/`ac04` wording, the fold of `custmgmt-update-overview.md` into `custmgmt-project-overview.md` and its deletion, and the progress tracker.
- **Visible result:** CM success criteria 1–11 pass; CI green; the CM update overview is folded and gone, in the same change as Billing's.
- **Dependencies:** cm23; Billing bm83 (retire) and bm84. **Counterpart: bm85.**

---

## Dependency graph

```
Phase 3 (planned; Billing units in bm00 Part 6):
  bm74 ─► bm77 ─► bm78 ─► bm79 ─► [cm23 + bm82 : one merge] ─► bm83 ─► bm84 ─► [bm85 + cm24]
```

## Notes

- **Just-in-time introduction (Phase 3):** `0054`, the type-aware gate, `listBindableTemplateTypes` and the new label resolver all land in cm23, their first caller. `lockTemplateType` and the type repository come from Billing (bm78, bm77) and are consumed here, never edited.
- **Not in any unit:** choosing a type at onboarding; bulk-binding outside Billing's retire; version pinning; a new permission or audit event type; any change to `customer` schema tables.
- **Per-unit checklist:** `custmgmt-ai-workflow-rules.md` §8 and §10.8 apply to every Phase 3 unit.
