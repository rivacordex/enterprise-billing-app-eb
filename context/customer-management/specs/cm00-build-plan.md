# CM00 — Customer Management Module Build Plan (Units in Build Order)

**Sources:** `custmgmt-project-overview.md` (v1, the delivered binding update and the delivered **Invoice Template Types** update, Customer Management part; owning design Billing's), `custmgmt-architecture.md` (stack = platform `architecture.md` §1 unchanged; §6 Module Invariants #1–#22; §7 and §8 update deltas), `custmgmt-code-standards.md` (§7 file tree, §8 permission map, §9 guardrails, §10 Types deltas), `custmgmt-ai-workflow-rules.md` (§9 binding record, §10 Types record). The Billing units of the update are **bm74–bm85**, recorded as the `74–85` row of `context/billing-management/specs/bm00-build-plan.md`'s numbering record (formerly Part 6).

## How units are cut

1. **One visible result per unit** — a migration that introspects cleanly, a page or tab that renders, an action that mutates, audits and is inspectable in the DB.
2. **One system boundary per unit** — see the boundary key.
3. **Dependencies just in time** — a repository function, validator or read service is introduced in the first unit that calls it, never upfront.
4. **Merge always-done-together units** — e.g. a page container with its first mutation; an action with the only UI that calls it.
5. **Merge units with no standalone visible result** — e.g. Zod schemas, validators and read services merge into the first unit that renders or mutates with them.

**Boundary key:** `DB` = `db/**` schema, migrations, seeds · `APP` = `app/(app)/customers/**`, `components/customers/**`, `actions/customer/**`, `services/customer/**`, `validation/customer/**`, and, for the binding and Types updates, the Accounts-side files a customer screen calls (`actions/accounts/**`, `services/accounts/**`, `validation/accounts/onboard-customer-accounts.schema.ts`; the `billing_account` table is Accounts-owned, `custmgmt-architecture.md` §7) · `TESTS` = `tests/**` cross-cutting guardrail/authz sweep.

---

## Delivered units (numbering record)

_Per-unit detail lives in the spec files (`specs/cm01`–`specs/cm24`); the build record is `custmgmt-completed-tracker.md` (cm01–cm16) and `custmgmt-progress-tracker.md` (cm17–cm24). Product scope is in `custmgmt-project-overview.md`._

| Units | Phase | Names |
| --- | --- | --- |
| cm01–cm16 | Phase 1 — v1 full CRUD (delivered) | DB foundation (`customer` schema, `customers` permission, search-limit seed) · validation, transition maps and read services · nav · View Customer search · View Customer detail · Manage Customer search · create customer · edit page + update organization · organization status transition · customer status transition · add contact · update contact · delete contact · set preferred contact · set preferred contact method · authz + guardrail ship gate |
| cm17–cm22 | Phase 2 — Invoice Template Binding (delivered, signed off 2026-10-25) | BAN template reference column · onboarding "Invoice template" field + `assertBindableTemplate` · View Customer tab shell · View Customer Accounts tab · Manage Customer Billing account panel + template reset · binding ship gate |
| cm23–cm24 | Phase 3 — Invoice Template Types, Customer Management part (delivered 2026-10-26; Billing units bm74–bm85, `bm00` row `74–85`) | bind a BAN to a template type (`0054`, type-aware `assertBindableTemplate` under `FOR SHARE`, panel select + Save, type labels, onboarding wording; one merge with bm82) · Types ship gate (joint with bm85) |

**Durable facts from delivered units:**
- **Permissions:** `customers` is READ/EDIT only; there is no `DELETE` level.
- **Out of scope:** shape validation on `party_role_specification`, MERGED-status migration tooling, multi-value contact fields, individual (person) customers, TMF/external APIs.
- **Account linkage:** `party_role.account` stays display-only (Inv. #9).
- **Navigation:** governed by the platform `NAV_REGISTRY` rule.
- **Locks and reads:** a BAN template change is guarded by the BAN lock, not the customer lock (Inv. #17); customer screens read accounting data read-only (Inv. #11).
- **What Phase 3 replaced:** the NULL-only rule, the version column and the Reset control (Inv. #18 → #19–#21; guardrail 10 → 11).
- **Phase 3 bindings:** a BAN references a template type (`NULL` = Standard, stored only as `NULL`); exactly three writers (bind service, onboarding always `NULL`, Billing's retire switch); the bind gate locks the type `FOR SHARE` in the caller's transaction; labels are computed live; customer files read Billing only through repositories (Inv. #19–#22).

---

## Dependency graph

```
Phase 3 (delivered 2026-10-26; Billing units bm74–bm85, `bm00` row `74–85`):
  bm74 ─► bm77 ─► bm78 ─► bm79 ─► [cm23 + bm82 : one merge] ─► bm83 ─► bm84 ─► [bm85 + cm24]
```

## Notes

- **Just-in-time introduction (Phase 3):** `0054`, the type-aware gate, `listBindableTemplateTypes` and the new label resolver all landed in cm23, their first caller. `lockTemplateType` and the type repository come from Billing (bm78, bm77) and are consumed here, never edited.
- **Not in any unit:** choosing a type at onboarding; bulk-binding outside Billing's retire; version pinning; a new permission or audit event type; any change to `customer` schema tables.
- **No phase is open.** The next update starts a new phase with its own unit numbers (cm25 onward).
