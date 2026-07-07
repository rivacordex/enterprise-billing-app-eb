# AI Coding Agent Workflow Rules — All Modules

Binding rules for any AI coding agent building a module of the rebuilt **enterprise billing application**. They govern *how you work* — scope, sequence, split, clarify, verify, keep docs in sync — not the product or technical design.

**Companion docs (authoritative — do not restate or contradict).** Every module ships its own set:

- `<module>-project-overview.md` — product spec: user flows, pages, data model, roles, permission seed, audit events.
- `<module>-architecture.md` — technical design: stack, folder boundaries, enforcement, multi-module DB, numbered **Invariants**.
- `<module>-code-standards.md` — coding conventions and CI gates.
- `<module>-ai-workflow-rules.md` — module supplement to this doc: the module's concrete units, mutations, guardrails, permission names, and doc-section references.

**Precedence.** On conflict: architecture **Invariants** → overview → architecture → code-standards → module workflow supplement → this doc. This doc never overrides spec or standards; where it appears to, stop and treat it as a bug. Never weaken a companion-doc rule.

---

## 1. Operating Approach

1. **Work spec-driven.** Build only what the docs authorize. Before coding, name the section that authorizes the work (an overview page, an architecture boundary, a code-standard). No section, no mandate — stop and ask (§4).
2. **Work incrementally.** Deliver one **unit** at a time (§2). Never the whole module, a whole page, or multiple pages in one pass.
3. **Leave the tree green.** After every unit, keep `tsc`, ESLint, Prettier, tests, and the security scan passing (per code-standards). Never commit a unit that breaks the build.
4. **Make the smallest correct change.** Least new surface area. No refactors, renames, folder reorgs, or dependency upgrades as a side effect.
5. **State your plan first.** Per unit, write the scope, files, permission(s), and tests before editing.
6. **Trace every change to a reason.** Each file maps to the unit's plan; editing anything off-plan means stop and re-scope (§2.3).

---

## 2. Scoping Rules — One Unit at a Time

1. **Define the unit.** A vertical slice delivering one capability end to end, in dependency order: `validation/` schema → `db/` schema + migration + repository → `services/` use case → `actions/` or `app/api/` entry point + guard → `app/` page/component → `tests/` (incl. the route × level matrix). Typically one page's read path, or one mutation — not a whole page's features at once. The module supplement lists the module's typical units.
2. **One unit per pass.** Don't start a second until the current passes verification (§8) and is committed.
3. **Re-scope when a unit grows.** If it exceeds its plan, stop, split (§3), finish the smaller piece first.
4. **No speculative changes.** No abstractions, flags, generic helpers, extra columns, parameters, endpoints, or future-proofing the current unit doesn't need.
5. **No scope creep across units.** Don't fix unrelated bugs, restyle unrelated components, or touch another page or module. Note it and raise it separately.
6. **No drive-by edits.** No reformatting, import re-sorting, or rewriting outside the unit's diff.
7. **Respect layer boundaries while slicing** (module architecture). UI never calls `db/**`; permission checks live at the action/handler boundary; services assume an authorized context.
8. **Platform-level changes need explicit authorization.** Touch shared/platform files or another module's folders only when the module's supplement or architecture doc explicitly authorizes that change (e.g. a route-group rename or shared-nav refactor). Deliver it as its own isolated unit — nothing else in the same change — and prove via CI that every existing module's behavior, URLs, and authz results are unchanged. Absent that authorization, §2.5 applies: stop and raise it.

---

## 3. When to Split Into Smaller Steps

Split whenever any holds. When in doubt, split.

1. **Crosses more than one page or permission** — each page, and each `permission : level`, is its own unit.
2. **Mixes read and write** — split the read path (`READ`) from each mutation (`EDIT`/`DELETE`); build read first.
3. **Bundles multiple mutations** — each mutation the module defines is a separate unit with its own action, audit event, and tests. The module supplement lists them.
4. **Needs a schema change plus behavior** — land the migration (schema + any registry seed row) as its own reviewed step first.
5. **Diff is large or hard to review** — if it can't be explained in a few sentences, split.
6. **Introduces a guardrail** — every guardrail named in the module's overview or Invariants gets a focused step with tests. The module supplement lists them.
7. **A step would leave the tree red** — re-cut boundaries so every step is independently green.

Sequence steps validation → db → service → action/route → UI → tests; finish each before the next.

---

## 4. Missing or Ambiguous Requirements

1. **Never guess on security, data shape, permissions, audit, or lifecycle.** Stop and ask; invent no default.
2. **Resolve from the docs first** (overview, architecture incl. Invariants, code-standards, module supplement). If the answer is there, follow it and cite the section.
3. **Stop and ask when the spec is silent or self-contradictory** on a permission name/level, route, column/constraint, audit event, state transition, guardrail, a field mapping, or any Invariant interaction. Ask one precise question with the options.
4. **Don't expand scope to fill a gap.** Surface it; let it be decided.
5. **Fail closed on ambiguity.** Pick a conservative default only for non-security cosmetics (spacing, label wording), note it for review. Anything affecting access, data integrity, or audit is never cosmetic.
6. **Record the resolution** in the owning companion doc (§6) so the next agent doesn't re-ask.

---

## 5. Files You Must Not Modify Without Explicit Instruction

Don't edit, regenerate, delete, or "improve" these unless explicitly told to in that request:

1. **`components/ui/`** — shadcn/ui (Radix) primitives, a managed vendor layer. Compose a new app component in `components/`, or change tokens in `globals.css`; never alter primitive logic or API.
2. **Auth-framework managed tables, columns, and field mapping** (Better-Auth). Don't change the field-to-column mapping in `auth/` or bypass it with hand-written SQL. The DB is snake_case; managed columns are written only by the auth framework. Add custom fields only as the spec defines, in snake_case. (Module supplement lists the managed tables and Invariant references.)
3. **Applied migrations.** Never edit or delete a committed/applied migration; every schema change is a new forward migration. No hand-written production DDL.
4. **The code-seeded permission registry mechanism.** No code path inserts `PERMISSIONS` rows; rows come only from a committed migration.
5. **`tsconfig.json` strict flags, ESLint/Prettier configs, CI/pipeline definitions** (`infra/**`, incl. security-scan stages). Don't relax flags, disable lint globally, or weaken gates to pass a build. Fix the code.
6. **Lockfiles and dependency versions.** No add/remove/upgrade as a side effect; dependency changes are their own requested unit.
7. **The companion docs' decisions.** Keep docs in sync (§6) but don't unilaterally change a documented decision, an Invariant, the permission seed, or the access model. Propose and get approval first.
8. **Secrets and env templates.** Never commit a real secret or read secrets from repo, image, or DB.

If a unit genuinely requires touching one of these, stop, explain why, and get explicit confirmation.

---

## 6. Keeping Docs in Sync With Implementation

1. **Docs are part of the unit.** A unit isn't done until the docs that describe it match the code (§8).
2. **Update the permission map when pages/actions change** — the module architecture's permission map and the code-standards' component/route map, in the same change set (page, route, component, folder, `permission : level`).
3. **Add the registry entry alongside the migration.** A new page ships only with (a) its migration adding the `PERMISSIONS` row, (b) its permission-map and component-map rows, (c) its route guard — all together.
4. **Reflect decisions in the owning doc:** product behavior → overview; technical/Invariant → architecture; convention → code-standards; workflow → this doc or the module supplement. Each fact in one place.
5. **Never let docs drift.** If you can't update the owning doc in the same change, don't ship it. If code and docs already disagree, stop and flag it; don't "fix" one to match without confirming which is correct.
6. **Keep references, not copies.** Link the owning section; don't restate it.
7. **Document the public surface you add.** Exported service functions, actions, and `AppError` codes get a one-line doc comment on contract and failure modes.

---

## 7. Front-End Pages Must Carry Permissions for Authorization Mapping

Every page is permission-bearing; that declaration is the map authorization is enforced against. Frontend checks are UX only.

1. **Declare one permission name + the level to render** (`READ` to view). A page with no permission is a bug. Only exceptions: the public and session-gated pages the module supplement lists.
2. **Enforce the page guard at the top of the page/layout** via the shared helper (e.g. `await requirePermission('<name>', 'READ')`): unauthenticated → `/login`, unauthorized → no-access state.
3. **Re-check every mutation server-side.** Each Server Action / Route Handler re-resolves the live `ACTIVE` user and re-checks `permission : level` (`EDIT` for changes, `DELETE` for destructive). Never trust the page guard or client; insufficient → **403**.
4. **Map controls to the effective-permission set for show/hide only** — it carries no secret and grants nothing.
5. **One permission name per page, referenced by a typed constant** in `auth/`. No per-button names; mutations reuse the page's name at a higher level.
6. **Add a new page only with its full mapping:** typed constant + registry migration + permission-map/component-map rows + page guard + action re-checks + route × level matrix tests. No mapping, no merge.
7. **Honor the hierarchy and resolution.** `DELETE ⊃ EDIT ⊃ READ`; effective permission = union across roles, highest wins, in the single `auth/` resolver. Don't re-implement it elsewhere.
8. **Keep the page↔route↔component↔permission chain intact** — create components with the exact names the module's code-standards define.

---

## 8. Verification Checklist — Before the Next Unit

Don't start the next unit until every item passes. Run the checks; don't assume.

1. **Spec match.** Exactly what the docs specify — no more, no less; no scope creep (§2).
2. **Build green.** `tsc --noEmit`, ESLint (import boundaries, `no-floating-promises`, `no-explicit-any`), Prettier.
3. **Tests added and passing,** incl. the **route × level matrix** for any guarded route.
4. **Authorization verified end to end.** Page guard present; every mutation re-checks `permission : level` server-side; unauthorized → **403** even when the UI is bypassed; deny-by-default holds (§7).
5. **Guardrails hold (when relevant).** Every module guardrail listed in the module supplement holds, with tests.
6. **Data layer correct.** DB access only in `db/**` via repositories; mutation + `AUDIT_LOG` insert in one transaction; audit records actor, timestamp, event type, target, before/after; audit stays INSERT-only.
7. **Input validated** against a `validation/` Zod schema at the boundary.
8. **Migrations correct** — new, ordered, committed; no edits to applied migrations; no manual DDL (§5.3).
9. **Permissions mapped** — new/changed page or action reflected in the module's permission map and component map, with its registry row and typed constant (§6, §7).
10. **Docs in sync** — owning doc updated in the same change set; no drift (§6).
11. **Security scan clean** — SAST and the DAST baseline pass, no high/critical.
12. **No forbidden edits** — no protected file (§5) touched without instruction; no secret added; no `TODO`, commented-out code, or `console.*` on the branch.
13. **Diff is minimal and reviewable** — only planned files changed; no drive-by edits (§2.6).

If any item fails, the unit isn't done. Fix it before moving on; never defer a failure to a later unit.
