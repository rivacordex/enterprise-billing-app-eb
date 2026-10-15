# bm63 — Invoice Template ship gate

**Unit:** bm63 (Invoice Template update, Part 4) · **Status:** Delivered and signed off 2026-10-11, commit `3ec1bae`, reviews `dd2c5d7`, `f733095`, `614743a` · **Boundary:** cross-cutting tests, docs and the tracker. Nothing new is built (the bm13/bm21/bm35/bm39/bm46 discipline). The sweep fixes landed in their owning areas but shipped inside `3ec1bae`, at the owner's request.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm63-invoice-template-ship-gate.md` in this repo; the codebase copy keeps the full text._

## Goal
Declare the Invoice Template update shippable by showing overview Part 2 success criteria 1–12 end to end on a fresh database:
- a journey that renders with the default, activates and pins versions, and survives a re-activation and a tamper;
- an admin browser e2e across both screens;
- guardrails 43–56 and the relevant earlier ones green.

Then fold Part 2 into the project overview. Sources: Inv #39–#50; workflow rules §1.7, §7.6, §8. Every G-item was decided before sign-off (G5, G8, G9, G16 and G14 by the owner on 2026-10-11).

## As built
- **D1: journey** (`tests/e2e/invoice-template-journey.integration.test.ts`), on disposable Postgres + Azurite + the app services. No live Kestra is needed, because Part 2 changes no flow.
  - The harness is `tests/db/helpers/extract-flow-sql.ts` (it gained `runCollection`); the fresh database comes from `tests/e2e/helpers/fresh-database.ts`.
  - Run 1 uses the `ci` seed. Runs 2–4 post bm53/bm54 fixture bills through the real `postAccount` (`setupInvoiceRenderFixtures` gained `reset: false`).
  - Steps:
    1. fresh setup;
    2. no admin activity: defaults with a NULL profile (G15 A), all lines, reconciliation, and an annex with "Unassigned region";
    3. activate template v2 and profile v1 through the actions;
    4. activate v3 and profile v2: earlier bills unchanged, reprint byte-identical, `charge_checksum` recomputes;
    5. tamper one byte of `invoice.hbs`, then the logo: `TEMPLATE_CHECKSUM_MISMATCH` / `ASSET_CHECKSUM_MISMATCH` park only the pinned accounts;
    6. CSV sum;
    7. 10,000 usage rows render ≥ 3 pages, and 10,001 parks with `INVOICE_USAGE_OVER_LIMIT`;
    8. one audit row per save, activation and upload.
- **D2: admin e2e with no new dependency** (`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`).
  - It drives the installed `playwright` 1.63.0 library from vitest against `next start`. There is no `@playwright/test`; adding it would be a separate dependency decision.
  - **Scenarios:** no permission (nav hidden, `/no-access`); READ (read-only; a posted-bill preview only with `billrun_view`); EDIT template (mandatory sections locked, Discount hiding, save → activate with a required note, history, `.hbs` free of `[[`); EDIT profile (format and logo rejections, logo-required, bank warning); escaping (`<script>` shown escaped, no dialog).
  - Script: `npm run test:e2e:invoice-settings` = `next build && vitest run --config vitest.integration.config.ts tests/e2e/invoice-settings-admin.e2e.integration.test.ts`. The test file starts and stops `next start` on a free port.
- **D3: sweep.**
  - Guardrails 43–56 are green as they exist, with these exceptions:
    - **43** has no dedicated test (covered by `bind.test.ts` + journey step 2);
    - **49** is only partly covered (`invoice-template-catalog.integration.test.ts:123`);
    - **50**'s layout-lint half is `tests/guardrails/invoice-layout-lint.test.ts` (added here), and its PDF half is open;
    - **54** is covered by `invoice-render-chromium.e2e.test.ts` + journey step 7.
  - Earlier guardrails are green: compute boundary, rating write boundary, finalization, checksum, route inventory (three POST handlers), seed integrity, `nav-registry-guard`, `status-literal-sweep`.
  - The route × level matrix covers the five routes, the CSV route, the six actions and a seventh, `importAppLogoAction` (bm60 D8).
  - Guardrail 56 grants pass on a fresh bootstrap **and** on one upgraded from before bm50 (the revoke path).
- **D6: docs fold, in one change set:**
  - Part 2 folded into the project overview;
  - X1–X4 and C1–C4 closed;
  - Inv #36 amended (bm48), and Inv #39–#50 marked delivered;
  - R#/D# citations replaced by invariant numbers;
  - the workflow-rules open rows removed;
  - the tracker, `bm00`, the placeholder catalog and known-issues synced.

## Files
- `tests/e2e/invoice-template-journey.integration.test.ts`, `tests/e2e/invoice-settings-admin.e2e.integration.test.ts`, `tests/e2e/helpers/fresh-database.ts`
- `tests/db/helpers/extract-flow-sql.ts` (`runCollection`), the render fixtures (`reset: false`)
- `tests/guardrails/invoice-layout-lint.test.ts`, `tests/services/billing/invoice-golden.test.ts`
- `package.json` script `test:e2e:invoice-settings`
- the docs listed in D6

## Tests and evidence
- The journey passed 8/8 and the admin e2e 5/5. Unit 4378/0, integration 1219/0; `tsc` and ESLint clean (tracker bm63).
- **Criteria → evidence:**

  | Criterion | Evidence |
  |---|---|
  | 1 (all lines, reconciliation) | journey step 2, `bind.test.ts` |
  | 2 (defaults) | journey step 1, guardrail 45 |
  | 3 (profile activation rules) | admin e2e, `activate-profile`, `upload-logo` |
  | 4 (editor and generator) | admin e2e, `generate.test.ts`, `activate-template` |
  | 5 (pinning) | journey step 4, guardrail 46 |
  | 6 (tamper) | journey step 5, guardrails 44 and 47 |
  | 7 (multi-page) | journey step 7 |
  | 8 (annex) | journey step 2, `invoice-usage-annex` |
  | 9 (CSV) | journey step 6, guardrail 55 |
  | 10 (reprint, checksum) | journey step 4 |
  | 11 (authz, audit, escaping) | admin e2e, journey step 8, guardrail 56 |
  | 12 (goldens, full suites) | `invoice-golden.test.ts`, full suites green |

## Later changes and residuals
- **Post-gate 2026-10-12:** review commits `f733095` (SonarCloud accessibility, owner decision A) and `614743a` (`<title>` draft-first fix) edited migration `0046` and the v1 layout/generated files **in place**, and re-pinned the digests in `0046` and `tests/helpers/seeded-invoice-template.ts`. Environments that already ran `0046` must be reset (known-issues §23k/§23l).
- **Open from the sweep:** guardrail 43 has no dedicated test; 49 is partial; 50's PDF-text-layer half is missing (known-issues §23h).
- Invoice Template Phase 3 (planned) rewrites v1 in place once more on a fresh-DB round (D41) and replaces guardrails 48 and 49 with item 67 and guardrail 54 with item 64, and amends guardrails 46 and 53 (a draft in a started run keeps its captured version; only a non-default version is retired, P7) — code-standards Phase 3 _Rules superseded_.
