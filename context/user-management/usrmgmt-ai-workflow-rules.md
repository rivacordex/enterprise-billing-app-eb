# User Management — AI Coding Agent Workflow Rules

Binding rules for any AI coding agent building the **User Management Module** — first module of the rebuilt **wholesale enterprise billing application** (billing other MNOs for wholesale 5G services). They govern _how you work_ — scope, sequence, split, clarify, verify, keep docs in sync — not the product or technical design.

**Companion docs (authoritative — do not restate or contradict):**

- `usrmgmt-project-overview.md` — product spec: user flows, 4 pages, 10-table data model, roles, permission seed, audit events.
- `usrmgmt-architecture.md` — technical design: stack, folder boundaries, enforcement, multi-module DB, numbered **Invariants**.
- `usrmgmt-code-standards.md` — coding conventions and CI gates.

**Precedence.** On conflict: architecture **Invariants** → overview → architecture → code-standards → this doc. This doc never overrides spec or standards; where it appears to, stop and treat it as a bug. Never weaken a companion-doc rule.

---

## 1. Operating Approach

1. **Work spec-driven.** Build only what the docs authorize. Before coding, name the section that authorizes the work (an overview page, an architecture §2 boundary, a code-standard). No section, no mandate — stop and ask (§4).
2. **Work incrementally.** Deliver one **unit** at a time (§2). Never the whole module, a whole page, or multiple pages in one pass.
3. **Leave the tree green.** After every unit, keep `tsc`, ESLint, Prettier, tests, and the security scan passing (code-standards §10). Never commit a unit that breaks the build.
4. **Make the smallest correct change.** Least new surface area. No refactors, renames, folder reorgs, or dependency upgrades as a side effect.
5. **State your plan first.** Per unit, write the scope, files, permission(s), and tests before editing.
6. **Trace every change to a reason.** Each file maps to the unit's plan; editing anything off-plan means stop and re-scope (§2.3).

---

## 2. Scoping Rules — One Unit at a Time

1. **Define the unit.** A vertical slice delivering one capability end to end, in dependency order: `validation/` schema → `db/` schema + migration + repository → `services/` use case → `actions/` or `app/api/` entry point + guard → `app/` page/component → `tests/` (incl. the route × level matrix). Typically one page's read path, or one mutation — not a whole page's features at once.
2. **One unit per pass.** Don't start a second until the current passes verification (§8) and is committed.
3. **Re-scope when a unit grows.** If it exceeds its plan, stop, split (§3), finish the smaller piece first.
4. **No speculative changes.** No abstractions, flags, generic helpers, extra columns, parameters, endpoints, or future-proofing the current unit doesn't need.
5. **No scope creep across units.** Don't fix unrelated bugs, restyle unrelated components, or touch another page. Note it and raise it separately.
6. **No drive-by edits.** No reformatting, import re-sorting, or rewriting outside the unit's diff.
7. **Respect layer boundaries while slicing** (architecture §2). UI never calls `db/**`; permission checks live at the action/handler boundary; services assume an authorized context.

---

## 3. When to Split Into Smaller Steps

Split whenever any holds. When in doubt, split.

1. **Crosses more than one page or permission** — each page, and each `permission : level`, is its own unit.
2. **Mixes read and write** — split the read path (`READ`) from each mutation (`EDIT`/`DELETE`); build read first.
3. **Bundles multiple mutations** — create, edit, assign/revoke role, reset password, unlock, change auth method, disable, tombstone are separate units, each with its own action, audit event, tests.
4. **Needs a schema change plus behavior** — land the migration (schema + any registry seed row) as its own reviewed step first.
5. **Diff is large or hard to review** — if it can't be explained in a few sentences, split.
6. **Introduces a guardrail** — ADMIN-only administration, last-admin protection, instant revocation, exclusive auth paths, custom per-account lockout, and the tombstone precondition each get a focused step with tests.
7. **A step would leave the tree red** — re-cut boundaries so every step is independently green.

Sequence steps validation → db → service → action/route → UI → tests; finish each before the next.

---

## 4. Missing or Ambiguous Requirements

1. **Never guess on security, data shape, permissions, audit, or lifecycle.** Stop and ask; invent no default.
2. **Resolve from the docs first** (overview, architecture incl. Invariants, code-standards). If the answer is there, follow it and cite the section.
3. **Stop and ask when the spec is silent or self-contradictory** on a permission name/level, route, column/constraint, audit event, state transition, guardrail, the field mapping, or any Invariant interaction. Ask one precise question with the options.
4. **Don't expand scope to fill a gap.** Surface it; let it be decided.
5. **Fail closed on ambiguity.** Pick a conservative default only for non-security cosmetics (spacing, label wording), note it for review. Anything affecting access, data integrity, or audit is never cosmetic.
6. **Record the resolution** in the owning companion doc (§6) so the next agent doesn't re-ask.

---

## 5. Files You Must Not Modify Without Explicit Instruction

Don't edit, regenerate, delete, or "improve" these unless explicitly told to in that request:

1. **`components/ui/`** — shadcn/ui (Radix) primitives, a managed vendor layer (code-standards §4.1). Compose a new app component in `components/`, or change tokens in `globals.css`; never alter primitive logic or API.
2. **Better-Auth managed tables, columns, and field mapping** — `user`/`APPUSER`, `account`, `session`, `verification`. Don't change the field-to-column mapping in `auth/` or bypass it with hand-written SQL (Inv. #19). The DB is snake_case; managed columns (scrypt hash, session token, expiry, timestamps) are written only by Better-Auth. Add custom fields only as the spec defines, in snake_case.
3. **Applied migrations.** Never edit or delete a committed/applied migration; every schema change is a new forward migration (code-standards §6.2). No hand-written production DDL.
4. **The code-seeded permission registry mechanism.** No code path inserts `PERMISSIONS` rows (Inv. #7); rows come only from a committed migration.
5. **`tsconfig.json` strict flags, ESLint/Prettier configs, CI/pipeline definitions** (`infra/**`, incl. the OWASP ZAP DAST stage). Don't relax flags, disable lint globally, or weaken gates to pass a build. Fix the code.
6. **Lockfiles and dependency versions.** No add/remove/upgrade as a side effect; dependency changes are their own requested unit.
7. **The companion docs' decisions.** Keep docs in sync (§6) but don't unilaterally change a documented decision, an Invariant, the permission seed, or the ADMIN-only model. Propose and get approval first.
8. **Secrets and env templates.** Never commit a real secret or read secrets from repo, image, or DB (Inv. #1, #18).

If a unit genuinely requires touching one of these, stop, explain why, and get explicit confirmation.

---

## 6. Keeping Docs in Sync With Implementation

1. **Docs are part of the unit.** A unit isn't done until the docs that describe it match the code (§8).
2. **Update the permission map when pages/actions change** — architecture §6 and code-standards §9, in the same change set (page, route, component, folder, `permission : level`).
3. **Add the registry entry alongside the migration.** A new page ships only with (a) its migration adding the `PERMISSIONS` row, (b) its §9/§6 row, (c) its route guard — all together (code-standards §1.11).
4. **Reflect decisions in the owning doc:** product behavior → overview; technical/Invariant → architecture; convention → code-standards. Each fact in one place.
5. **Never let docs drift.** If you can't update the owning doc in the same change, don't ship it. If code and docs already disagree, stop and flag it; don't "fix" one to match without confirming which is correct.
6. **Keep references, not copies.** Link the owning section; don't restate it.
7. **Document the public surface you add.** Exported service functions, actions, and `AppError` codes get a one-line doc comment on contract and failure modes.

---

## 7. Front-End Pages Must Carry Permissions for Authorization Mapping

Every page is permission-bearing; that declaration is the map authorization is enforced against. Frontend checks are UX only (Inv. #3).

1. **Declare one permission name + the level to render** (`READ` to view). A page with no permission is a bug (architecture §6). Only exceptions: public pages (`/login`, the Entra callback) and session-gated pages (`/set-password`, `/no-access`).
2. **Enforce the page guard at the top of the page/layout** via the shared helper (e.g. `await requirePermission('users', 'READ')`): unauthenticated → `/login`, unauthorized → no-access state (code-standards §3.6). In v1 only ADMIN holds the four grants, so MANAGER/USER land on `/no-access`.
3. **Re-check every mutation server-side.** Each Server Action / Route Handler re-resolves the live `ACTIVE` user and re-checks `permission : level` (`EDIT` for changes, `DELETE` for destructive). Never trust the page guard or client; insufficient → **403** (Inv. #3).
4. **Map controls to the effective-permission set for show/hide only** — it carries no secret and grants nothing (code-standards §3.10).
5. **One permission name per page, referenced by a typed constant** in `auth/` (code-standards §8.5). No per-button names; mutations reuse the page's name at a higher level.
6. **Add a new page only with its full mapping:** typed constant + registry migration + §6/§9 row + page guard + action re-checks + route × level matrix tests. No mapping, no merge.
7. **Honor the hierarchy and resolution.** `DELETE ⊃ EDIT ⊃ READ`; effective permission = union across roles, highest wins, in the single `auth/` resolver (Inv. #5). Don't re-implement it elsewhere.
8. **Keep the page↔route↔component↔permission chain intact** — create components with the exact code-standards §9 names.

---

## 8. Verification Checklist — Before the Next Unit

Don't start the next unit until every item passes. Run the checks; don't assume.

1. **Spec match.** Exactly what the docs specify — no more, no less; no scope creep (§2).
2. **Build green.** `tsc --noEmit`, ESLint (import boundaries, `no-floating-promises`, `no-explicit-any`), Prettier (code-standards §10).
3. **Tests added and passing,** incl. the **route × level matrix** for any guarded route (code-standards §7.9).
4. **Authorization verified end to end.** Page guard present; every mutation re-checks `permission : level` server-side; unauthorized → **403** even when the UI is bypassed; deny-by-default holds (§7, Inv. #3, #4).
5. **Guardrails hold (when relevant).** Administration is ADMIN-only and role assignment requires ADMIN (Inv. #6); last ADMIN-capable account can't be disabled/deleted (Inv. #13); disable and `auth_method` change revoke sessions instantly (Inv. #8); auth methods stay mutually exclusive (Inv. #9); custom lockout fires at 5 → 15-min; tombstone requires DISABLED first and never hard-deletes (Inv. #12, #13).
6. **Data layer correct.** DB access only in `db/**` via repositories; mutation + `AUDIT_LOG` insert in one transaction; audit records actor, timestamp, event type, target, before/after; sign-ins write `SSO_LOGIN`/`LOCAL_LOGIN`; audit stays INSERT-only (Inv. #11, #14, code-standards §6).
7. **Input validated** against a `validation/` Zod schema at the boundary (Inv. #16).
8. **Migrations correct** — new, ordered, committed; no edits to applied migrations; no manual DDL (§5.3).
9. **Permissions mapped** — new/changed page or action reflected in architecture §6 and code-standards §9, with its registry row and typed constant (§6, §7).
10. **Docs in sync** — owning doc updated in the same change set; no drift (§6).
11. **Security scan clean** — SAST and the OWASP ZAP DAST baseline pass, no high/critical (code-standards §10.7, Inv. #23).
12. **No forbidden edits** — no protected file (§5) touched without instruction; no secret added (Inv. #1, #18); no `TODO`, commented-out code, or `console.*` on the branch (code-standards §1.10).
13. **Diff is minimal and reviewable** — only planned files changed; no drive-by edits (§2.6).

If any item fails, the unit isn't done. Fix it before moving on; never defer a failure to a later unit.
