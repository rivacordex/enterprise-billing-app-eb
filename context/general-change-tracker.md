# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- **DONE (code-complete) — wfm02 Rating Flow-ID Harmonization (rename)**
  (`context/workflow-management/specs/wfm02-rating-flow-rename.md`). Renamed the four
  `rating`-namespace flow `id:`s + matching `.yaml` filenames per the D-A table
  (`completeness-check`→`rating-completeness-check`,
  `stranded-batch-reconcile`→`rating-batch-reconcile`, `log-sweep`→`rating-logger`,
  `ran-usage-rating`→`rating-engine-ran-usage`) and fixed every reference that keys on
  the old id/filename. Executed code changes §1–§7 in this repo plus the §8 doc
  reconciliations in the code-repo `context/` copy. Flow bodies, triggers, tasks,
  namespace `rating`, runtime module names, KV keys, and all rating invariants are
  byte-unchanged (identity rename only; no `[CRITICAL]` invariant/grant/claim/
  two-writer/money-math edit).

  Done (§ = wfm02 spec section):
  - [x] §1 `git mv` the four flows + edited each `id:` line (rename shows as `R` in git).
  - [x] §2 Fixed stale in-flow comment cross-references in all four renamed flows.
  - [x] §3 Tests: rm06/07/08/09/11/12/13 — filename joins, comment mentions, rm13
        `FLOW_ID` const + `rating.<id>` assertion message → new names.
  - [x] §4 Runtime docstrings: completeness_check/stranded_reconcile/log_sweep/prp/rp/rl/
        `__init__`.py + runtime/README.md → new flow filenames. Runtime module names
        (`log_sweep`, `stranded_reconcile`, `completeness_check`, `prp`/`rp`/`rl`) left
        as-is (D-B); the `log-sweep:`/`completeness-check:` log-output prefixes left
        (component prefixes, D-B); internal task id `completeness-check` left (D-B).
  - [x] §5 `flows/rating-engine/README.md` table → new filenames.
  - [x] §6 `.gitignore`, `dev/.env.example` (×2 incl. webhook path), `engine-access.md`
        (×2), `workflow-engine-container-app.bicep` (×2), `azure-pipelines.yml:491`
        illustrative comment `log-sweep`→`rating-logger`. CI `deploy_fn rating-engine
        rating` unchanged (deploys the whole directory — new ids picked up automatically).
  - [x] §8 Doc reconciliations (code-repo `context/` copy): `ratemgmt-code-standards.md`
        §8 tree, `ratemgmt-progress-tracker.md` (21/22/27/38, `.py` names kept per D-B),
        `rm00-build-plan.md` (138/148 boundary tags), `billmgmt-completed-tracker.md`
        (391), and the product docs (`_updatemodule-product-pricing-components-plan`,
        `prodmgmt-ai-workflow-rules`, `prodmgmt-code-standards`,
        `_updatemodule-ratecard-lookup-plan-v2`, `pm51-rating-runtime-rekey`).
        `wfm-architecture.md` §3/§4.1 were already renamed (pre-session edit) and match
        the D-A target — verified, no further change needed.

  Deviations / judgment calls (flagged for review):
  - **§4 line 263 of `log_sweep.py` fixed, not left.** The spec §4 grouped `:263` with
    the "leave — log-string prefixes" at `:266/:270/:290`, but `:263` is actually a
    comment referencing the flow **filename** (`log-sweep.yaml's own errors/finally
    handler`), a now-dangling path after the rename. The verification checklist forbids
    any surviving docstring/filename reference to an old name, and §2/§4 treat filename
    references as meaning-changing; so `:263` was retargeted to `rating-logger.yaml`.
    The genuine `log-sweep:` log-output prefixes (`:266/:270/:290`) were left per D-B.
  - **`wfm01-engine-restructure.md` tree (lines 23–26) left with the OLD names.** Not in
    the §8 edit list; it is a historical build-spec body (wfm01 is DONE), so it was left
    as a point-in-time delivery record — mirroring §8's treatment of the historical
    `rmNN` spec bodies (wfm02 is the authority for the rename). Surface if a live-doc
    rename is wanted there too.
  - **`ran-usage-rating.yaml:12` `deploy_rating_flows` left unchanged.** Per §2's
    "(see §6 note)" and §6 ("CI deploy needs no change"), this is a pipeline-stage
    reference, not a flow-id; not in the rename's scope.
  - **§6 webhook path change must be flagged to the (now-legacy) webhook-secret owner.**
    The doc/comment paths moved to `…/webhook/rating/rating-engine-ran-usage/…`; rm07
    replaced that trigger with the `landing/` file trigger so no live webhook keys on the
    id today, but any external caller/KV secret still assuming the old path must move.

  - **NOT DONE — §7 (operational).** One-time delete of the four orphaned old-id flows
    (`ran-usage-rating`, `log-sweep`, `stranded-batch-reconcile`, `completeness-check`)
    from every running engine (dev compose + any deployed engine), because the deploy is
    upsert-only (`--no-delete`, D-D). Requires a live engine + confirming the Kestra CLI
    delete verb at the D0 spike — not runnable in this session. Per D-E the first live
    execution is still pending, so no `udr_rated` row is stamped under an old id and the
    revision-counter reset is safe; this is the safe pre-go-live window.

  - Verified: `tsc --noEmit` clean; Prettier clean on edited TS/MD; repo-root grep for
    the four old names returns only intended survivors (log-output prefixes, internal
    task id `completeness-check`, historical `rmNN`/wfm01 spec bodies, the wfm02 spec
    itself).

  Post-review (xhigh multi-agent code-review + live disposable-stack test run):
  - [x] [doc consistency, applied] `runtime/README.md` log_sweep row now names its
        invoking flow (`invoked by ../../flows/rating-logger.yaml`) like the sibling
        stranded_reconcile/completeness_check rows — fulfils wfm02 §4 line 87, which the
        first pass had left because the row historically named no `.yaml`. Prettier clean.
  - Review verdict: angles A–D (line-scan, missed-reference auditor, cross-file consumer
        tracer, YAML/format validity) all clean — 0 correctness/invariant regressions;
        both renamed-flow YAMLs parse under js-yaml AND pyyaml; all 8 test filename joins
        resolve to on-disk files; every four-flow doc list fully updated. Two altitude
        notes (rm13 duplicates FLOW_ID + filename literal; the flow filename is hardcoded
        across 5 test files rather than a shared const) are PRE-EXISTING, not introduced —
        left as-is.
  - **Test run — disposable DB + disposable Kestra (both torn down after):**
    - Disposable DB: `docker-compose.test.yml` (project `ebill-test`, pg on 5434). Ran
      the 7 rename-touched rating integration suites (rm06/07/08/09/11/12/13-no-fan-out):
      **7 files passed, 31 passed, 54 skipped, 0 failed.** The 31 passing include the
      static structural checks that read all four RENAMED flow files — direct rename
      validation. The 54 skips are the `python3`-gated processor describes (this Windows
      host has no `python3` on PATH — only `python`/`py` 3.14.0; graceful
      `describe.skipIf(!pythonReady)`) and the rm13 live-engine describe (no `KESTRA_URL`).
    - Disposable Kestra: `kestra/kestra:v1.3.35 server local` (H2). `kestra flow namespace
      update rating /flows/rating-engine` **deployed all four flows** and the API
      (`/flows/search?namespace=rating`) returned **total 4** = exactly
      `rating.rating-batch-reconcile`, `rating.rating-completeness-check`,
      `rating.rating-engine-ran-usage`, `rating.rating-logger` and **none of the four old
      ids** — Kestra validates schema server-side on ingest, so this confirms every
      renamed flow is structurally valid with its new id/namespace (D-D check shape).
    - NOT executed (host-infra gap, not a rename risk): the `python3`-backed processor
      bodies (rm06–rm12 DB describes) and the full rm13 no-fan-out live run — both need a
      Linux-style host with `python3`+`polars`+`psycopg`, or the flows-deployed dev stack.
      Run on CI for that coverage.

- **DONE (code-complete, verified) — Seed refactor: mandatory/demo split,
  de-TOREMOVE, retire BILLING_VIEWER**
  (`context/_change-database-seeds-refactor-plan.md`). Implemented §3 (the stated
  boundary: seeds + package.json + RBAC types/tests) + the §4 doc updates. Seed-
  only, fresh-install scope (D3) — no migrations for already-seeded environments.
  - [x] §3.1 Split the two mixed files. `db/seeds/product.ts` → mandatory
        `products:DELETE→ADMIN` grant only; `db/seeds/ordering-inventory.ts` →
        `grantOrderingPermissions` only (PREFIX + `seedStory` removed). Both stay
        wired in `db:setup` (chain **unchanged**).
  - [x] §3.2 New `db/seeds/demo/` tree (accounts-orchestrator pattern):
        `product-demo.ts` (`seedProductDemo`), `ordering-demo.ts`
        (`seedOrderingDemo`, looks the offering up by its new name via the shared
        `DEMO_5G_OFFERING_NAME` export), `seed-demo.ts` (orchestrator, one txn,
        product→ordering order). Prod guard mirrors `sample/seed-billrun-sample.ts`:
        refuses unless `DATABASE_URL` host ∈ {localhost,127.0.0.1,db,postgres} and
        `NODE_ENV !== production`; `ALLOW_DEMO_SEED=true` overrides. Idempotency
        scoped to demo data (5G offering by name; demo BAN's orders) so a `_SAMPLE_`
        offering can't false-trip the skip.
  - [x] §3.3 `package.json` — added `db:seed-demo`; `db:setup` untouched.
  - [x] §3.4 Rename map applied — demo rows now `Demo — *` (spaces + em-dash),
        emails `demo-order-*@example.invalid`. `TOREMOVE` gone from `db/seeds/**`.
  - [x] §3.5 Retired `BILLING_VIEWER`: `billing.ts` now grants `billrun_view:READ`
        to MANAGER + USER (Revenue Ops rollup) via the existing atomic-upsert
        `grant()`; ADMIN_GRANTS unchanged; header comment de-Finance/Audit'd.
        `types/rbac.ts` `SEEDED_ROLE_NAMES` → `["ADMIN","MANAGER","USER"]`. Tests:
        `rbac.test.ts`/`roles-write.service.test.ts` `it.each` dropped the role;
        `nav-registry.test.ts` case renamed (assertion unchanged). `0024` comment
        de-BILLING_VIEWER'd (comment-only; safe — repo rebuilds from 0000).
  - [x] §4 docs: `bm01` spec (record amended per D5), `billmgmt-project-overview`,
        `billmgmt-progress-tracker`, product specs pm02/03/05/06/07/08/10 (renames
        + `db:seed-demo`-first verification note, via subagent).
  - Verified: `tsc` clean; ESLint clean; Prettier clean (code + all edited docs);
        affected unit suites green — rbac/roles-write/nav-registry + the
        nav-registry-guard guardrail = 51/51. §5 acceptance greps confirmed:
        `TOREMOVE` gone from `db/seeds/**`; `BILLING_VIEWER` gone from `db/seeds/**`,
        `types/rbac.ts`, `tests/**`; `db:setup` chain byte-identical; `db:seed-demo`
        present.
  - Deviations / judgment calls (flagged):
    - **Three §4 doc targets do not exist in this repo** —
      `_assessment-seed-files-strategy.md`, `_newmodule-billing-billrun-plan.md`,
      `_change-homepage-topbar-nav-rbac-plan.md` (the last is referenced as an
      already-consumed plan in this tracker). The plan was drafted against a
      superset; these were NOT fabricated. Their intended edits (assessment §2
      correction, the two BILLING_VIEWER strikes) have no target here.
    - **Extended beyond §4's explicit list for correctness** (the change directly
      invalidated these): the prefix-convention *rules*
      `prodmgmt-code-standards.md` §8 + file-map, `prodmgmt-ai-workflow-rules.md`
      §8 (which literally said "keep the `TOREMOVE-Template-` prefix"),
      `prodmgmt-project-overview.md` go-live line, pm11/pm15 concrete row refs,
      `bm00-build-plan.md` (×2), `billmgmt-code-standards.md` file-map, and a now-
      false **code comment** in `app/(app)/billing/bill-runs/[runId]/page.tsx`
      (named "the Billing Viewer role"). All retargeted to `Demo — `/Revenue-Ops.
    - **DB acceptance test NOT run** (§5 steps 1/2/5 — `db:setup` clean-baseline,
      `db:seed-demo` idempotency + prod-guard, MANAGER/USER UI smoke). These need a
      fresh/disposable DB; running against the shared dev DB is destructive (repo
      convention). Run on CI / the disposable test DB for end-to-end proof.
  - Post-review fixes (xhigh multi-agent code-review, applied + verified). The
    review found **no correctness bugs** (mostly verbatim moves); the substantive
    findings were a test gap, reuse, and a misleading test name:
    - [x] [test gap] Added `tests/guardrails/demo-seed-boundary.test.ts` — a
          DB-free grep gate asserting `db:seed-demo` points at the demo
          orchestrator and never appears in `db:setup` (or any other chain),
          mirroring the sibling `billing-sample-seed-boundary.test.ts`. Enforces
          D2 (demo is opt-in-only), which previously nothing tested.
    - [x] [reuse + altitude, D-user-approved: full shared-lib rollup] New
          `db/seeds/lib/`: `non-prod-guard.ts` (`NON_PROD_HOSTS` +
          `assertNonProductionUrl(url,label,ctx)` — single source of truth for the
          safety-critical prod-write guard) and `get-or-create-appuser.ts` (moved
          out of `sample/`). Rewired **both** the demo seed AND the shipped
          `sample/seed-billrun-sample.ts` (plus `scripts/billrun-live-kestra-smoke.ts`)
          to consume them; deleted the duplicated guard bodies and the old
          `sample/get-or-create-appuser.ts`. The sample seed was fenced off by the
          plan (§4) — user explicitly authorized touching it for this dedup. Guard
          behavior preserved (messages parameterized per-seed via the ctx; sample's
          dual DATABASE_URL + BOOTSTRAP_DATABASE_URL checks both pass `SAMPLE_GUARD`).
    - [x] [test clarity] Retitled the nav-registry case from "MANAGER/USER with
          billrun_view:READ … sees just the Billing section" to "a principal whose
          only grant is billrun_view:READ …" — a real MANAGER/USER also holds the
          ordering grants and would see more sections; the body tests a synthetic
          billrun_view-only map. (Deviates from the plan's literal rename string,
          which was itself the source of the imprecision.)
    - Not changed (evaluated, judged WAI/inherited/out-of-scope): the grant helper
      reconciling MANAGER/USER `billrun_view` back to READ on re-run (by-design
      "seed is source of truth", unchanged from original); the prod-guard host
      allowlist accepting tunneled localhost/`db`/`postgres` and `ALLOW_*_SEED`
      bypassing the NODE_ENV check (specified by the plan, copied from the sample
      precedent — now shared, so any future hardening lands once); the
      receivables-binding self-heal leaving the mandatory path (D3 — already-seeded
      envs out of scope).
    - Verified: `tsc` clean; ESLint clean; Prettier clean; 59/59 across the demo +
      both sample guardrails, nav-registry, rbac, roles-write (both sample
      guardrails green confirms the sample-seed rewiring did not regress).

- **DONE — xhigh code-review fixes**

- **DONE — xhigh code-review fixes** (uncommitted changes + last 2 commits;
  multi-agent review, 15 findings). Fixed by criticality, evaluated against specs:
  - [x] [#2, CONFIRMED] GL-journal drill-down rendered `event_at` via raw
        `.toISOString()` (UTC) — a `um29 §2.4` violation (every displayed instant
        must go through `formatDatetime` with a server-resolved zone). Now threads
        `getAppLocale()`/`getAppTimezone()` and renders `formatDatetime(...)`;
        column relabelled "Date/Time" (`app/(app)/accounts/gl-journal/page.tsx`).
  - [x] [#3/#4/#5/#6, seed] One coherent refactor of `seed-billrun-sample.ts`:
        the privileged teardown connection is now **opened + probed + host-checked
        inside the transaction, before its destructive deletes commit** (chosen:
        pre-commit health-check) — closing the broken/unreachable-DSN strand window
        (#5/#1) and running `BOOTSTRAP_DATABASE_URL` through the same non-prod gate as
        `DATABASE_URL` via a shared `assertNonProductionUrl` (#3). Corrected the
        misleading "the same connection db:migrate uses" messaging → "superuser/owner
        DSN used to provision (db:setup/db:bootstrap-roles)" (#4). Removed the now-dead
        duplicate guard by passing the resolved connection in; teardown returns
        `{orphanLedgerAccountIds, admin}` rather than mutating outer `let`s (#6).
  - [x] [#1, CONFIRMED] README day-to-day "After pulling new commits" told operators
        to run bare `npm run db:migrate` — fails as least-privilege `app_runtime` (no
        DDL). Now documents the superuser `DATABASE_URL` override + reset (mirrors
        Part 1 step 4) + a new-schema `db:bootstrap-roles` note.
  - [x] [#8] README design-note precision: `db:migrate` reads `DATABASE_URL`;
        `BOOTSTRAP_DATABASE_URL` drives roles/partman + migrations via an override.
  - [x] [#7] Deduped the login wordmark Tailwind string → exported
        `LOGIN_WORDMARK_CLASS` from `brand-logo.tsx`, reused on the login page.
  - [x] [#10] `login-page.test.tsx`: reset `mockIsSsoConfigured` in `afterEach`
        (asymmetric teardown → latent false-green).
  - [x] Rule codified: `code-standards.md §2.13` (already the home for this rule)
        strengthened with an explicit anti-pattern ban — no `toISOString()`/
        `toLocaleString()`/`.slice()`/ad-hoc `Intl` for displayed instants.
  - Skipped [#9, PLAUSIBLE]: `new Date(r.event_at)` offset-reliance — verified
        not currently triggerable (columns are `timestamptz`, always offset-carrying);
        speculative hardening not warranted.
  - Verified: `tsc` clean; ESLint clean; Prettier clean; affected suites 14/14
        (login-page + brand-logo). Seed integration path not run here (needs the
        disposable test DB).

- **DONE — README install/admin rewrite + migrations doc §4 correction**
  (`context/_change-readme-install-and-admin-plan.md`, D15). DOCUMENTATION ONLY,
  implemented per §3:
  - [x] §3.1 Intro reworded (from-scratch-rebuild → install + operate).
  - [x] §3.2 Part 0 deleted; the port-3000 process-kill salvaged into Troubleshooting;
        both `down -v` lines + the `git clean -fdx` dropped.
  - [x] §3.3 Part A/B/C → Part 1/2/3; volume-persistence caution lines added to steps
        5 (roles+passwords) and 6 (billing grant patch); in-body "Part A/B" refs (steps
        7, 13, and the intro SSO note) retargeted to Part 1/2.
  - [x] §3.4 Teardown replaced by "Running the stack day to day" (Start / Stop / Check /
        After-pulling / Troubleshooting); Verify-a-real-execution folded in as the deep
        health check; Credentials & endpoints moved below the new admin section.
  - [x] §3.5 Useful scripts extended (`db:migrate`, `docker compose ps`, health curl).
  - [x] R5 / §4 `db/migrations/README.md`: already reads the corrected "silently
        skipped" form (timestamp-not-hash comparison) — NO change needed; the "wrong"
        parenthetical the plan targeted was corrected in a prior change.
  - Deviation from the plan's specified text (flagged): §3.4's line "`/api/health`
    returning OK means the app is up **and** its database connection is live" is
    FALSE — `app/api/health/route.ts` intentionally does no DB query (um30 liveness
    probe; `/api/health/db` reserved, unimplemented). Rewrote the sentence + the
    Useful-scripts label to say "app liveness (no DB query)" rather than ship the
    incorrect claim.
  - Open questions Q1 (one-sentence "how to start over" pointer) and Q2 (Windows-first
    framing) left as-is — flagged in the plan for review, not part of the §3 spec.
  - Verification: grep of README + wider repo for `Part 0`/`Part A/B/C` → zero README
    hits (remaining hits are unrelated accounting-management specs referencing their
    own plans); step numbering stays contiguous 1–14; all referenced npm scripts
    (`db:migrate`/`db:setup`/`db:seed-sample`/`db:bootstrap-roles`) and `/api/health`
    exist.

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
