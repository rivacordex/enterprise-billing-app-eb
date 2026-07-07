# User Management — AI Workflow Rules (Module Supplement)

Module supplement to `../ai-workflow-rules.md` (binding for all modules — read it first). That doc governs *how you work*; this doc pins the **User Management Module** specifics it defers to a supplement: units, mutations, guardrails, permissions, protected files, and the authoritative doc-section references. User Management is the first module of the rebuilt **enterprise billing application**.

**Companion docs (authoritative — do not restate or contradict):**

- `usrmgmt-project-overview.md` — product spec: user flows, 4 pages, 10-table data model, roles, permission seed, audit events.
- `usrmgmt-architecture.md` — technical design: stack, folder boundaries (§2), enforcement, multi-module DB, numbered **Invariants**, permission map (§6).
- `usrmgmt-code-standards.md` — coding conventions and CI gates.

**Precedence** per the general doc: architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## 1. Units and Mutations

Typical units (general doc §2): one page's read path, or one mutation — across the 4 pages defined in the overview.

Each of these is a **separate mutation unit** with its own action, audit event, and tests (general doc §3.3):

- create user
- edit user
- assign / revoke role
- reset password
- unlock account
- change auth method
- disable user
- tombstone user

---

## 2. Guardrails

Each gets a focused step with tests (general doc §3.6), and must hold at verification (general doc §8.5):

1. **Administration is ADMIN-only**; role assignment requires ADMIN (Inv. #6).
2. **Last-admin protection** — the last ADMIN-capable account can't be disabled or deleted (Inv. #13).
3. **Instant session revocation** — disable and `auth_method` change revoke sessions immediately (Inv. #8).
4. **Exclusive auth paths** — auth methods stay mutually exclusive (Inv. #9).
5. **Custom per-account lockout** — fires at 5 failed attempts → 15-min lock.
6. **Tombstone precondition** — tombstone requires DISABLED first and never hard-deletes (Inv. #12, #13).

---

## 3. Protected Files — Module References

Module-specific detail for the general doc §5 list:

1. **`components/ui/`** — managed vendor layer per code-standards §4.1.
2. **Better-Auth managed tables**: `user`/`APPUSER`, `account`, `session`, `verification`. Field-to-column mapping lives in `auth/` (Inv. #19); managed columns (scrypt hash, session token, expiry, timestamps) are written only by Better-Auth.
3. **Migrations** — forward-only per code-standards §6.2.
4. **Permission registry** — `PERMISSIONS` rows only via committed migration (Inv. #7).
5. **CI/pipeline** — `infra/**`, including the OWASP ZAP DAST stage.
6. **Companion-doc decisions** — incl. the permission seed and the ADMIN-only model.
7. **Secrets** — Inv. #1, #18.

---

## 4. Permissions and Pages

Module specifics for the general doc §7:

1. **v1 access model:** only ADMIN holds the four grants; MANAGER/USER land on `/no-access`.
2. **Exceptions to permission-bearing pages:** public — `/login`, the Entra callback; session-gated — `/set-password`, `/no-access` (architecture §6).
3. **Page guard:** shared helper, e.g. `await requirePermission('users', 'READ')` (code-standards §3.6).
4. **Server-side re-checks:** each Server Action / Route Handler re-resolves the live `ACTIVE` user and re-checks `permission : level`; insufficient → **403** (Inv. #3). Deny-by-default (Inv. #4).
5. **Show/hide:** effective-permission set drives UI visibility only (code-standards §3.10).
6. **Typed constants** in `auth/` (code-standards §8.5); hierarchy `DELETE ⊃ EDIT ⊃ READ`, union across roles, highest wins, single `auth/` resolver (Inv. #5).
7. **Full mapping for a new page:** typed constant + registry migration + architecture §6 row + code-standards §9 row + page guard + action re-checks + route × level matrix tests (code-standards §1.11, §7.9). Component names exactly per code-standards §9.

---

## 5. Verification — Module Additions

On top of the general doc §8 checklist:

1. **Guardrails** (§2 above) hold with tests (Inv. #6, #8, #9, #12, #13).
2. **Audit** — mutation + `AUDIT_LOG` insert in one transaction; records actor, timestamp, event type, target, before/after; sign-ins write `SSO_LOGIN`/`LOCAL_LOGIN`; INSERT-only (Inv. #11, #14, code-standards §6).
3. **Validation** — Zod schema in `validation/` at every boundary (Inv. #16).
4. **Build gates** — per code-standards §10; no `TODO`/commented-out code/`console.*` (code-standards §1.10).
5. **Security scan** — SAST and OWASP ZAP DAST baseline pass, no high/critical (code-standards §10.7, Inv. #23).
6. **No secret** committed or read from repo, image, or DB (Inv. #1, #18).
