# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- **DONE (code-complete, verified) — Landing Homepage, top-bar chrome, and
  permission-filtered navigation** (`context/_change-homepage-topbar-nav-rbac-plan.md`).
  Platform-level chrome change (authorized by the plan under `ai-workflow-rules.md`
  §2.8). All seven units implemented exactly as specified:
  - [x] U1 — `lib/nav-registry.ts` (`NAV_REGISTRY` via `as const satisfies` so
        `NavHref` stays a literal union; `visibleSections` fail-closed) +
        `components/nav-icons.ts` (`Record<NavHref, LucideIcon>`) +
        `tests/lib/nav-registry.test.ts` + the §6.3 guardrail gate
        (`tests/guardrails/nav-registry-guard.test.ts`: registry↔guard parity,
        orphan check w/ `UNLISTED_BY_DESIGN`, icon exhaustiveness, no locked residue).
  - [x] U2 — Accounts Settings guard EDIT→READ (D7); `canEdit` threaded to the five
        mutation controls (disabled + `--action-disabled-bg` + title; wizard inputs
        readOnly); `route-level-accounts-settings` guard assertion flipped to READ +
        canEdit; new `accounts-settings-can-edit` test. Actions unchanged (still EDIT).
  - [x] U3 — `admin-nav.tsx` reads `visibleSections` + `NAV_ICONS`; locked-item
        branch + `Lock`/`hasLevel` deleted (D2/D6); divider count follows visible
        sections; nav + accounts-context tests rewritten. Fixes the 8 unguarded links.
  - [x] U4 — `app-shell.tsx` + `app-topbar.tsx` (new), `brand-logo.tsx` (topbar in;
        nav/nav-collapsed/Monogram out), `admin-sidebar.tsx` slimmed to controlled
        nav-only, `lib/sidebar.ts` `DEFAULT_SIDEBAR_COLLAPSED`+`resolveSidebarCollapsed`
        (D9), `(app)/layout.tsx` renders `<AppShell>` in a flex-col shell. Tests moved
        to app-topbar/app-shell; admin-layout/admin-sidebar/brand-logo rewritten.
  - [x] U5 — `app/page.tsx` → `app/(app)/page.tsx` (Homepage directory, empty state,
        redirect-preamble verbatim); `lib/root-redirect.ts` simplified to
        `(session) → "/login" | "/set-password" | null`; `ROUTE_ORDER`/`RouteOrderEntry`
        deleted; eslint `root-page` carve-out moved to `app/\(app\)/page.tsx` (escaped
        parens) so the preamble keeps its db access; `home-page`/`root-redirect` tests.
  - [x] U6 — `app_name` 40-char cap: `0005` description edited in place (D14),
        `lib/config-limits.ts` (`APP_NAME_MAX_LENGTH`), write-service `VALUE_TOO_LONG`
        + action passthrough, `ConfigEditDialog` `maxLength`+live counter+field error
        (no `watch()` — tracked via field onChange), `db/migrations/README.md` §4
        corrected (edited applied migration = silently *skipped*, not re-applied),
        `migration.integration.test` description assertion + new write-length test.
        **NOTE:** the one-off `UPDATE` for already-migrated environments + README
        install/admin rewrite are **D15 — tracked in `_change-readme-install-and-admin-plan.md`**
        (not this change); README.md untouched here.
  - [x] U7 — §7 doc amendments: `architecture.md` §2 components/lib rows + §5 `/`
        session-gated exception; `usrmgmt-architecture.md` `/` Homepage row + ROUTE_ORDER
        retired + zero-grant-lands-on-Homepage; `acctmgmt-ui-context.md` + `ac15`/`ac17`
        READ-with-disabled-controls; `ui-context.md` `--surface-topbar` in use + 40-char
        budget; `ai-workflow-rules.md` new-page rule gains NAV_REGISTRY+NAV_ICONS;
        `um28` records `app_logo_mark_path` as orphaned (D10). AGENTS.md already points here.

  Verification: `tsc --noEmit` clean; full `eslint .` clean; Prettier clean on all
  changed files; `npm run build` passes (`/` now served through the `(app)` shell).
  Affected unit tests green: 143/143 across the 17 touched/new files. Full unit suite
  = only the 5 PRE-EXISTING failing files remain (4 order/subscription action files +
  `config.test.ts` env-artifact, all fail at HEAD, outside this blast radius) — one
  self-introduced `grep-gates` regression (the `carriesAccountsContext` flag moved to
  the registry) was caught and fixed. Integration assertions (`migration.integration`)
  updated but not run here (need the disposable test DB).

  Post-review fixes (xhigh code-review, all applied + verified — tsc/eslint/prettier
  clean, build passes, affected suites green, full unit suite = same 5 pre-existing
  failures only):
  - [x] [authz] Homepage admitted a PENDING session (status check only rejected
        DISABLED/DELETED), diverging from `getActiveUser`/Inv #4. Now, after the
        force-password gate, a non-ACTIVE session is deleted + bounced to `/login`
        (a PENDING SSO user whose activation never completed no longer sees the
        directory). New `home-page` test covers it.
  - [x] [perf] Moving `/` into `(app)` double-resolved the permission map + session +
        user (layout + page). Added request-scoped `React.cache` wrappers in
        `auth/guard.ts` (`loadSessionUser`, `getEffectivePermissions`) used by the
        layout + Homepage; resolver stays uncached/framework-agnostic (note clarified).
  - [x] [ux] `ConfigEditDialog`: clear the stale `VALUE_TOO_LONG` field error on edit;
        count the app_name cap in Unicode code points (counter + write service) so
        emoji/astral names aren't miscounted; counter reflects the trimmed/stored
        value; dropped the UTF-16 `maxLength` (it can't count code points). New
        emoji-safe write-service test.
  - [x] [types] `visibleSections` now returns `VisibleNavSection` (href narrowed to
        `NavHref`), so `NAV_ICONS[item.href]` needs no `as NavHref` cast — a missing
        icon is a compile error end-to-end.
  - [x] [hardening/cleanup] slugify Homepage section ids (`aria-labelledby`); shared
        `EDIT_DISABLED_TITLE` (`components/accounts/edit-access.ts`) replacing the
        triplicated constant; broadened `admin-layout.test` mock to cover non-admin
        sections.
  - Left as plan-intended (noted, not "fixed"): `markSrc` read (§7.9 deferral),
    sign-out reuse (§3.5), gradient empty-state (ui-context §4), brand+Home dual
    `/` link (§3.5).

  Post-delivery UI adjustments (user request, applied + verified):
  - [x] Top bar shares the sidebar color (`--surface-nav`, unified chrome separated
        by the `--color-primary-900` hairline); `--surface-topbar` now defined-but-unused
        (ui-context token note updated).
  - [x] Nav + Homepage section order → **Billing, Customer, Accounts, Products,
        Administration** (reordered once in `NAV_REGISTRY`; both consumers follow;
        section-order tests realigned).
  - [x] Homepage tiles: horizontal chips (icon beside label, not stacked), squeezed
        icon (24→18), 5 side by side at every width (`grid-cols-5`; labels wrap within
        the chip when narrow). (A responsive `sm:3 md:4 lg:5` was tried first but
        yielded only 3–4 per row below the lg viewport — forced to 5.)

- **DONE (code-complete, verified) — Dynamic application name** (`context/_change-dynamic-app-name-plan.md`).
  Drive the wordmark / monogram / `<title>` from the existing `app`/`app_name`
  `system_config` row (um28 open item #2). FRONTEND-only: one new `getAppName()`
  reader + one new `lib/branding.ts` `DEFAULT_APP_NAME` constant + prop
  thread-through to the four wordmark surfaces (sidebar nav, login, set-password,
  no-access) and `generateMetadata()` on the admin layout + auth/no-access pages.
  No schema/migration, no repo change, no new RBAC/audit/Server-Action surface,
  no new dependency. Recommended options taken for all §6 open questions:
  (Q1) accept the seeded `"Enterprise Billing System"` value — no migration;
  (Q2) wire only the dynamic name on set-password/no-access (no logo);
  (Q3) convert admin-layout + auth/no-access metadata to `generateMetadata()`,
  root `app/layout.tsx` stays literal; (Q4) monogram derives initials from
  `appName`; (Q5) constant lives in new `lib/branding.ts`.
  Verified: `tsc --noEmit` clean, ESLint clean (src + tests), Prettier clean,
  `npm run build` passes, affected unit tests green (new `getAppName`
  service cases, `BrandLogo` monogram-derivation + required-`appName` prop,
  `AdminSidebar` prop reach, login/no-access/set-password wordmark +
  `generateMetadata` title/description).

  Post-review fixes (high-effort /code-review, all applied + verified):
  - [x] [CRITICAL] `tests/app/admin-layout.test.tsx` mocked the config-read
        service but omitted the new `getAppName` → all 5 AdminLayout tests threw
        `getAppName is not a function`. (The earlier "50/50" claim missed this
        file.) Added `getAppName` to the mock; 5/5 pass.
  - [x] [altitude, decision: extend] The layout `generateMetadata` title is
        overridden by each child page's own title (Next.js precedence), so the
        8 admin/product pages that hardcoded `"… — Enterprise Billing"`
        (users, roles, system-config, audit-log, subscriptions, orders,
        manage-products, product-offering) stayed stale after a rebrand.
        Converted all 8 to `generateMetadata()` → `"… — ${getAppName()}"` and
        added `getAppName` to their existing service mocks. (Bare-title pages —
        customers/accounts/bill-runs — left alone: no stale literal; they rely
        on the root `%s · User Management` template.)
  - [x] [robustness, decision: truncate] `app_name` is now unbounded admin text
        feeding the wordmark spans. Added `truncate` (login/nav via `BrandLogo`;
        `set-password`/`no-access` spans) so an over-long name clips with an
        ellipsis instead of breaking layout. Also extended the `app`/`app_name`
        config-row description (migration `0005`) to note the wordmark/title
        wiring + one-line truncation, and realigned the
        `migration.integration.test.ts` assertion.
  - Verification: `tsc` + ESLint + Prettier clean; `npm run build` passes;
    15 affected unit-test files green (102 tests). Full unit suite = same 15
    pre-existing failures as HEAD (4 order/subscription action files +
    `config.test.ts` env-artifact), zero new. `migration.integration.test.ts`
    run against the disposable integration DB (docker-compose.test.yml, project
    `ebill-test`, port 5434) — 15/15 green after a real DROP→migrate cycle,
    confirming the updated `app_name` description assertion; DB torn down
    (`down -v`), dev stack on 5432 untouched.

- **DONE (code-complete) — wfm01 Workflow-Engine Restructure**
  (`context/workflow-management/specs/wfm01-engine-restructure.md`). Restructure the
  workflow-engine code into the wfm platform shape: spin-off `workflow-management/`
  subdirectory with function-first `flows/`, one shared process-runner
  `workflow-engine` image, physical rename `rating-engine` → `workflow-engine`,
  topology as a single deploy parameter (default `collapsed`), and stand-up that
  deploys both functions' flows into the running engine. Executing **code changes
  §1–§7b** in this app repo; **§8 doc reconciliations are the planning repo's** and
  are out of scope for this session. No `[CRITICAL]` invariant/grant/claim/two-writer/
  money-math touched.

  Done (§ = wfm01 spec section):
  - [x] §1 Directory move → `workflow-management/` (D-A move map, `git mv`); removed emptied
        `rating-engine/`, `flows/billrun/`; `.gitignore` pycache glob; new function READMEs.
        Rating flow + worker-runtime bodies verified byte-identical (git-hash match).
  - [x] §2 Shared `worker/workflow-engine/` image — added `postgresql-client` (USER root), platform header.
  - [x] §3 `kestra/kestra.yml` header cross-refs + default-namespace note (semantics unchanged).
  - [x] §4 Infra bicep rename `rating-engine-*` → `workflow-engine-*` (kept `RATING_ENGINE_VERSION`,
        `rating_engine_version`, `rating-landing`). `az bicep build` clean.
  - [x] §4b Topology deploy param (`collapsed` default | `split-by-module` | `enterprise`) + per-env
        bicepparams; ACR/KV grant params → arrays for the split; easy-auth gated to collapsed;
        NO `services/`/`app/` change.
  - [x] §5 CI stages `containerize_workflow_engine` / `deploy_workflow_flows`; ZAP stage file renamed; YAML parses.
  - [x] §6 Dev compose service `rating-engine` → `workflow-engine`, paths under `workflow-management/`; compose config parses.
  - [x] §7 App-repo comment/doc touch-ups only (no `services/billing/*` or `app/api/billrun/*` logic change).
  - [x] §7b Idempotent stand-up flow bootstrap: dev `flow-deploy` one-shot (engine healthcheck +
        deploy all 3 functions to their namespaces) + CI `deploy_workflow_flows` generalized; billrun flows as `# STUB` shells.
  - [x] Verification: typecheck clean; `az bicep build` clean; pipeline/compose parse; tree matches D-A;
        no `[CRITICAL]` invariant/grant/claim/two-writer/money edit.

  Judgment calls / reconciliations (surfaced for review):
  - §3 vs §4 storage env var: renamed the whole `RATING_ENGINE_AZURE_` prefix →
    `WORKFLOW_ENGINE_AZURE_` consistently across bicep + kestra.yml + dev `.env.example` + dev compose
    (a half-rename would break `${...}` interpolation). Two stale bicep-filename refs INSIDE
    kestra.yml's storage note were left verbatim per §3.
  - Rating INTEGRATION tests (rm06–rm13) hard-code `join(process.cwd(),"rating-engine",...)`; the §1
    move breaks them, so path literals were updated to `workflow-management/...` (under-scoped by the
    spec, necessary for the move). Not run here (need the disposable test DB).
  - `acr.bicep`/`key-vault.bicep` engine-grant param generalized `string` → `array` so split-by-module
    grants both engine identities. easy-auth scoped to collapsed (split ingress = later, rm05).
  - §8 doc reconciliations are the PLANNING repo's (per the spec header) — NOT done in this code repo.

  Post-review fixes (xhigh code-review, all applied + verified):
  - [x] flow-deploy called bare `kestra` under a bash entrypoint (not on PATH) → now `/app/kestra`.
        Verified: `up flow-deploy` exits 0.
  - [x] deploy loops targeted bill-run function ROOTs (no deployable flow there; the *.template.yml is a
        non-deployable contract doc, CLI doesn't recurse) → now target `<fn>/local-dev`. VERIFIED end-to-end:
        `rating` ns = 4 flows, `billrun` ns = bill_run_processing + bill_run_distribution (API-confirmed).
  - [x] CI `deploy_fn`/rating_fanout_gate invoked `"$IMG" kestra flow …` (leading `kestra` = "Unmatched
        argument" under the default `/app/kestra "$@"` entrypoint) → dropped the `kestra` prefix. Also
        DROPPED the standalone `flow validate` step — deprecated + server-connecting in v1.3.35; `flow
        namespace update --server` validates server-side on ingest.
  - [x] split-by-module: both container-app instances hardcoded ACA env-storage name `rating-landing` →
        added `landingEnvStorageName` param (billrun split = `billrun-landing`); collision gone. `az bicep build` clean.
  - [x] split billrun instance now sets default namespace `billrun` (`defaultNamespace` param); documented
        the remaining shared-`kestra`-DB/JDBC-queue limitation as deferred to phase 2 (true isolation needs a
        second kestra DB or Enterprise edition).
  - [x] Corrected the misleading easy-auth+split "fails fast" comment (it safely skips; split ingress is internal)
        and the `enterprise` topology comment (currently deploys the collapsed single-instance shape; edition/tokens deferred).
  - Deferred (low): shared path-literal helper for the 9 rating integration tests (cleanup only).

  Pre-existing (NOT wfm01): the app unit suite is 2985/2999 green; 14 failures in 4 order/subscription
  action test files (`create-order`, `resume/suspend/terminate-subscription`). Their test files,
  subjects, and shared deps are all unmodified vs HEAD and outside wfm01's blast radius — they fail at
  HEAD, independent of this change. Flagged for separate investigation.

## Previous Goal (done)

- Implement `_change-id-padding-standardization-plan.md`: widen the 9 non-compliant
  domain-table ID DEFAULT expressions (6/7 → 8 digits), loosen the exact-length
  validation regexes to `\d+`, update the affected integration tests, and pin the
  width in `code-standards.md` #18.

## Completed

- Change: Standardize Human-Readable ID Sequences to 8-Digit Padding
  (`_change-id-padding-standardization-plan.md`) — code complete.
  - [x] 4.1 Migration — the 8-digit `SET DEFAULT` widening shipped folded into the
        base CREATE migrations (`0006`/`0009`/`0012`), not a standalone `0023`
        (see *Migration-chain consolidation* below); the drizzle-kit baseline was
        later re-generated as `meta/0021_snapshot.json`.
  - [x] 4.2 Drizzle schema — 9 lpad `6/7 → 8` edits across product.ts, customer.ts,
        billing/accounts.ts, billing/catalogs.ts, billing/ledger-binding.ts.
  - [x] 4.3 Validation — 23 regexes → `^PREFIX\d+$` across 15 files (FIN, BAN, BCY,
        ORG, PRDOFR). CTMD/PTRL/DLN left at `\d{8}` per plan default.
  - [x] 4.4 Tests — 5 integration tests → `^PREFIX\d{8}$` for fresh inserts.
  - [x] Plan gap fixed: 3 unit tests in `tests/validation/` asserted the removed
        exact-width rejection (parse-accounts-context, organization.schema,
        offering-list.schema) — realigned to the `\d+` shape contract. (§4.4 only
        listed integration tests; these were under-scoped by the plan.)
  - [x] 4.6 Docs — `context/code-standards.md` #18 pins width to 8 and documents
        the `^PREFIX\d+$` validation rule.
  - [x] typecheck clean, lint clean, full unit suite green (2097 tests).

- Migration-chain consolidation (folded 0022 + 0023 into originals):
  - [x] `0006_product.sql` — PRDOFR/PRDOFP/PRDSMD lpad `6 → 8`.
  - [x] `0009_customer.sql` — ORG lpad `7 → 8`.
  - [x] `0012_billing_module_tables.sql` — BAN/FIN/BCY/GLM/LBD lpad `6 → 8`;
        `reference_date` column created directly as `entry_date`.
  - [x] Deleted `0022_document_rename_reference_date_to_entry_date.sql` and
        `0023_widen_id_sequence_padding.sql`; removed journal idx 22 & 23
        (tail truncation — no renumbering; journal now ends at 0021).
  - [x] `db/schema/billing/documents.ts` comment updated (no longer cites the
        deleted 0022 migration).
  - [x] Structural verification: 22 .sql = 22 journal entries, every tag has a
        file, zero leftover 6/7-digit lpad, zero `reference_date` in migrations,
        schema TS (source of truth) already matches (entry_date + 8-digit).
  - Safe because ALL databases are rebuilt from 0000 (user-confirmed) — editing
    already-applied migrations is otherwise a divergence hazard.

## Verification (DB rebuilt from 0000)

- Full rebuild run (steps 1–6): drop schemas → `db:migrate` as superuser →
  `db:bootstrap-roles` → `db:setup-partman` → seeds. §7 checklist confirmed by
  read-only query against the live DB:
  - 22 migrations applied, ledger `0000` → `0021` (no stale `0022`/`0023`).
  - `billing.document` has `entry_date`, no `reference_date`.
  - All 9 widened tables' ID defaults are `lpad(..., 8, '0')`; new inserts are 8-digit.
  - partman: `core.audit_log` config present; premake future partitions only
    partially created (known/accepted — a prior partman run left stale state;
    audit writes land in the default partition).
- NOT run against the live dev DB: `vitest --config vitest.integration.config.ts`
  — it drops+rebuilds all schemas (destructive) and would wipe the just-seeded
  DB. Run it on CI / a disposable DB for the end-to-end proof.
- Seed data: the rebuild produced a uniform 8-digit baseline, so option (a)'s
  mixed-width case does not arise; no legacy narrow rows remain.

## Open Questions

- Seed data: going with §5 option (a) — leave existing narrow-width rows as-is
  (recommended default). Reseed (option b) only if a clean baseline is later wanted.

## Architecture Decisions

- Human-readable domain-table IDs standardize on 8-digit zero-padded suffix
  (`PREFIX + lpad(nextval(seq), 8, '0')`). DEFAULT-expression change only; column
  stays `text`, sequence stays `BIGINT`. Existing rows keep their stored width.
- ID validation regexes use `^PREFIX\d+$` (shape, not fixed width) for the widened
  IDs so legacy-narrow, newly-widened, and future widths all stay valid; the
  always-8-digit IDs (party_role, contact_medium, document_line, document) keep
  `^PREFIX\d{8}$`.

## Session Notes

- Snapshot convention deviation from the plan is intentional; see In Progress note.
- No 6/7-digit width assumptions exist outside `validation/` and `tests/` (swept
  app/, components/, lib/, services/, db/).
