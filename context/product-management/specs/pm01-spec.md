# PM01 — Route-Group Rename `(admin)` → `(app)`

- **Unit:** 1 of 9 (`pm00-build-plan.md`)
- **Dependencies:** None. Must land before any product code (prodmgmt-workflow §2.1; general workflow §2.8).
- **Authorizing sections:** overview *Goals #4* / *In Scope*; `prodmgmt-architecture.md` §2 (Decision #10) and Inv. #12; `prodmgmt-code-standards.md` §1.6, §7.4; `prodmgmt-ai-workflow-rules.md` §1.4, §2.1, §4.1.
- **Codebase state verified 2026-07-04:** `app/(admin)/` contains 14 files; exactly 6 files import `@/app/(admin)/…` (all in `tests/app/`); 2 code comments reference the old path (`lib/sidebar.ts:2`, `auth/guard.ts:46`); the repo copies of `usrmgmt-architecture.md` (2 occurrences) and `usrmgmt-code-standards.md` (7 occurrences) still say `(admin)` — the plan-folder copies are already updated.

---

## 1. Goal

Move `app/(admin)/**` to `app/(app)/**` and update every `(admin)` reference (imports, comments, repo doc one-liners) in one commit containing nothing else, so that every existing Administration page serves at a byte-identical URL with identical authz results (Inv. #12). Add the rename-invariance CI proof — a route-manifest snapshot test plus a no-stale-reference assertion — so CI green *proves* invariance rather than assumes it.

## 2. Design

**No visual or behavioral change of any kind.** No page, layout, component, style, guard, or URL changes. Route groups are invisible to Next.js URLs, so `/administration/users`, `/administration/roles`, `/administration/system-config`, `/administration/audit-log`, and `/no-access` are unchanged by construction — and the new manifest test proves it by assertion, not construction.

**Structural decisions (all pre-made, cited):**

1. **One route group hosts all authenticated modules** as plain subfolders (`administration/`, later `products/`, `customers/`, `bill-runs/`). New route groups are created only when chrome genuinely differs (cf. `(auth)`) — prodmgmt-architecture §2, Decision #10.
2. **`(auth)` group, `app/api/**`, and root-level files are untouched.** Only the `(admin)` group is renamed.
3. **CI proof mechanism (decision 2026-07-04, this spec):** a route-manifest snapshot test enumerating every `app/**/page.tsx`, stripping route-group segments, and asserting the derived URL set equals a frozen manifest; plus an assertion that no `(admin)` string survives anywhere in code directories. The existing page/authz tests passing *unchanged* (zero assertion edits) completes the proof.
4. **Commit scope (decision 2026-07-04, this spec):** code-standards §7.4 ("nothing else") is read as *no functional/behavioral change*; all **mechanical** `(admin)` references go in the one rename commit — file moves, the 6 test imports, the 2 path comments, and the one-line `(admin)` → `(app)` updates to the repo copies of the usrmgmt docs (mandated by prodmgmt-workflow §7.3). No stale reference survives the commit; no other edit of any kind rides along.

## 3. Implementation

### 3.1 Folder move (14 files, `git mv`, content byte-identical)

Note the asymmetry: `users/`, `roles/`, `system-config/` each carry `page.tsx` + `loading.tsx` + `error.tsx`; `audit-log/` and `no-access/` carry only `page.tsx` (they inherit the group-level `loading.tsx`/`error.tsx`).

| From | To |
|---|---|
| `app/(admin)/layout.tsx` | `app/(app)/layout.tsx` |
| `app/(admin)/loading.tsx` | `app/(app)/loading.tsx` |
| `app/(admin)/error.tsx` | `app/(app)/error.tsx` |
| `app/(admin)/no-access/page.tsx` | `app/(app)/no-access/page.tsx` |
| `app/(admin)/administration/users/{page,loading,error}.tsx` | `app/(app)/administration/users/{page,loading,error}.tsx` |
| `app/(admin)/administration/roles/{page,loading,error}.tsx` | `app/(app)/administration/roles/{page,loading,error}.tsx` |
| `app/(admin)/administration/system-config/{page,loading,error}.tsx` | `app/(app)/administration/system-config/{page,loading,error}.tsx` |
| `app/(admin)/administration/audit-log/page.tsx` | `app/(app)/administration/audit-log/page.tsx` |

Use `git mv` so the diff shows 100% renames for the 14 moved files. File contents are not edited — none of them self-reference the group path. `app/(admin)/` must not exist afterward (no empty directories left behind).

### 3.2 Import updates (6 files, one line each)

Replace `@/app/(admin)/` with `@/app/(app)/` in exactly these imports:

| File | Import |
|---|---|
| `tests/app/admin-layout.test.tsx:25` | `import AdminLayout from "@/app/(app)/layout"` |
| `tests/app/no-access-page.test.tsx:16` | `import NoAccessPage from "@/app/(app)/no-access/page"` |
| `tests/app/users-page.test.tsx:41` | `import UsersPage from "@/app/(app)/administration/users/page"` |
| `tests/app/roles-page.test.tsx:27` | `import RolesPage from "@/app/(app)/administration/roles/page"` |
| `tests/app/system-config-page.test.tsx:30` | `import SystemConfigPage from "@/app/(app)/administration/system-config/page"` |
| `tests/app/audit-log-page.test.tsx:30` | `import AuditLogPage from "@/app/(app)/administration/audit-log/page"` |

**No test assertion, mock, fixture, or expectation is edited.** If any test fails after the import update, that is a defect in the rename, not in the test (Inv. #12; protected-files §6.7).

Test file *names* (`admin-layout.test.tsx`) and component *names* (`AdminLayout`) are **not** renamed — the layout is still the authenticated-shell layout; renaming test files is out of scope for this unit and would pollute the diff.

### 3.3 Path-comment updates (2 files, comment text only)

- `lib/sidebar.ts:2` — comment `…the server read (\`app/(admin)/layout.tsx\`)…` → `app/(app)/layout.tsx`.
- `auth/guard.ts:46` — comment `\`(admin)/layout.tsx\` runs no guard…` → `(app)/layout.tsx`.

No executable code in either file changes.

### 3.4 Repo doc one-liners (mechanical `(admin)` → `(app)`, prodmgmt-workflow §7.3)

Update the **repo copies** (`enterprise-billing-app/context/user-management/`) to match the already-updated plan-folder copies:

- `usrmgmt-architecture.md` — 2 occurrences (§2 folder-ownership table, rows for `app/(admin)/**` and `components/**`). On the folder row, append the note used by the plan copy: *renamed from `(admin)`, Product Module plan Decision #10*.
- `usrmgmt-code-standards.md` — 7 occurrences (rule §16-style line, the file-tree line, and the 5 permission-map folder cells for `/no-access`, `/administration/users`, `/administration/roles`, `/administration/system-config`, `/administration/audit-log`).

These are string-level path updates only; no rule, decision, or matrix value changes. A deliberate historical note containing the literal `(admin)` (e.g. "renamed from `(admin)`") is permitted **in `context/` docs only** — the CI proof (§3.5) scans code directories, not `context/`.

### 3.5 Rename-invariance CI proof — `tests/app/route-manifest.test.ts` (new)

One new unit-suite test file (runs under `vitest.config.ts`; pure `node:fs`/`node:path`, no jsdom rendering, no DB). Three assertions:

**(a) Route-manifest snapshot.** Walk `app/**` collecting every `page.tsx`; derive each page's URL by joining path segments and dropping route-group segments (`/^\(.+\)$/`); assert the derived URL set **equals exactly** this frozen manifest:

```ts
const ROUTE_MANIFEST = [
  "/",
  "/login",
  "/set-password",
  "/no-access",
  "/administration/users",
  "/administration/roles",
  "/administration/system-config",
  "/administration/audit-log",
] as const;
```

Set equality (not subset) in both directions: a missing URL means the rename broke a route; an extra URL means an unplanned page shipped. Future units (e.g. `/products/product-offering` in pm05) extend this manifest consciously in their own commit — that is the guardrail working as designed.

**(b) Old group is gone.** Assert `app/(admin)` does not exist and `app/(app)` does.

**(c) No stale reference.** Recursively scan code directories — `app/`, `actions/`, `auth/`, `components/`, `db/`, `lib/`, `services/`, `types/`, `validation/`, `tests/` (excluding `node_modules/`, `.next/`) — and assert no file contains the string `(admin)`. `context/**` is deliberately excluded (historical notes allowed, §3.4); generated files (`.next/`, `tsconfig.tsbuildinfo`) are excluded as non-source.

This test is permanent, not scaffolding — it remains the Inv. #12 / code-standards §9.7 guardrail for every future unit. It ships **in the same rename commit** (the unit is the rename *plus its proof*; a rename commit without the proof cannot demonstrate Inv. #12).

### 3.6 Commit

One commit, e.g. `rename route group (admin) -> (app); update refs; add rename-invariance guard (pm01)`. Contents: exactly §3.1–§3.5. Explicitly **not** in this commit: nav changes (`components/admin-nav.tsx` untouched — Unit 4), any `db/`, `services/`, `validation/` file, any product code, any dependency or config change, any `infra/**` edit (the new test runs inside the existing `npm run test` CI gate; no pipeline YAML change is needed or permitted — protected files §6.5).

Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` entry for Unit 1) is updated in the plan directory, outside the app repo commit.

## 4. Dependencies

**None.** No npm packages added, removed, or upgraded (pm00: "no new npm packages anywhere"; protected files §6.6). The manifest test uses only `node:fs`, `node:path`, and Vitest already in place.

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**
- [ ] `git status` shows only: 14 renames (100% similarity), 6 test files (one import line each), `lib/sidebar.ts`, `auth/guard.ts` (one comment line each), 2 usrmgmt doc files, 1 new test file. Nothing else.
- [ ] `app/(admin)/` no longer exists; `app/(app)/` contains exactly the 14 moved files.
- [ ] `grep -rn "(admin)" app actions auth components db lib services types validation tests` returns zero matches.
- [ ] No edit to `components/admin-nav.tsx`, `infra/**`, `tsconfig.json`, ESLint/Prettier configs, lockfiles, or any applied migration.
- [ ] No `TODO`, commented-out code, or `console.*` introduced.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — **both** vitest configs (unit + integration).

**Rename invariance (Inv. #12 — the point of the unit)**
- [ ] `tests/app/route-manifest.test.ts` passes: manifest set-equal, `(admin)` absent, no stale reference.
- [ ] All 6 pre-existing page tests and `tests/auth/guard.integration.test.ts` pass **with zero assertion changes** (only the import lines differ from `main`).
- [ ] Dev-server spot check: `/administration/users`, `/administration/roles`, `/administration/system-config`, `/administration/audit-log`, `/no-access` all render at the same URLs; unauthenticated → `/login`; an authenticated no-grant user still gets the no-access state (deny-by-default unchanged).
- [ ] Sidebar collapse (cookie via `lib/sidebar.ts`) still works — layout move did not break the server read/client write pair.

**Docs in sync**
- [ ] Repo `usrmgmt-architecture.md` and `usrmgmt-code-standards.md` contain no bare `(admin)` path references (only the deliberate "renamed from" note).
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit 1 complete with the commit reference.

**Pipeline**
- [ ] CI pipeline green end-to-end on the branch, including SAST + ZAP DAST baseline (no new findings — no runtime behavior changed).

Any failing item means the unit is not done (workflow §8). Unit 2 (product data layer) must not start until this commit is verified and merged.
