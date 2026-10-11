# bm63 — Invoice Template ship gate

**Unit:** bm63 (Invoice Template update, Part 4). **Boundary:** cross-cutting tests, docs and the tracker. **Nothing new is built** (the bm13/bm21/bm35/bm39/bm46 discipline). This unit audits, assembles and signs off bm47–bm62. If a check fails, the fix goes in the owning unit's area as a defect fix with its own commit, never as new scope here.

**Specs from:** `billmgmt-project-overview.md` Invoice Template update success criteria 1–12; Inv #39–#50; code-standards guardrails 43–56 plus the 1–35 that cover the touched files; workflow rules §1.7 (prove behavior at the right layer: unit + golden + e2e), §7.6 (fold at the ship gate), §8.

**Depends on:** bm47–bm62. bm48 is included (G1 = R9). **bm61 requires G14** — if G14 is still open, this gate cannot pass; see D5.

**Gates:** every G-item cited by bm47–bm62 must be recorded as **decided** in all three trackers before sign-off. The open items as of 2026-10-07 are G4, G5, G6, G8, G9, G10, G11, G12, G13, G14 and G16.

## Goal

Declare the Invoice Template update shippable. Show overview success criteria 1–12 working end to end on a fresh database: a journey that renders with the default, activates and pins versions, survives a re-activation and a tamper, plus an admin browser e2e across both screens, with guardrails 43–56 and the relevant earlier ones green. Then fold Part 2 into the project overview.

## Design

### D1 — Full journey on a fresh database (`tests/e2e/invoice-template-journey.integration.test.ts`)

This runs against disposable Postgres plus Azurite plus the app's services. A live-Kestra run is **not** required, because Part 2 changes no flow (§1.7: the render layer is app-side). It uses the `ci` seed through the existing app-side processing test harness.

1. **Fresh setup:** `db:migrate`, the bootstraps, and `db:setup` (incl. `db:seed-invoice-templates`). Assert: `bill_format` = `[INVOICE]`; the defaults are ACTIVE with `is_default`; the seed blobs verify (criterion 2).
2. **No admin activity:** process, approve (a second user) and post a run. Every account renders from the default loaded from blob, with no issuer or payment block (G15 A). Every invoice lists all RECURRING and USAGE lines with discounts, and `Σ net_amount = subtotal` (criterion 1). The usage annex is grouped state → district with correct subtotals, and NULL-geo rows appear under "Unassigned region" (criterion 8). The stamps are the default ids plus a NULL profile.
3. **Activate template v2 and profile v1:** done through the **actions** (save draft, then activate; profile save draft, then upload logo, then activate under the G14-decided rule). Post the next run's accounts and assert stamps v2 / profile 1.
4. **Activate template v3 and profile v2.** Assert:
   - the step-3 bill's four stamps and stored PDF bytes are unchanged (criterion 5);
   - a new draft preview shows v3 and the profile v2 issuer/bank details;
   - reprint (`GET stored-invoice`) returns byte-identical stored bytes;
   - `charge_checksum` recomputed from the lines equals the stored value (criterion 10).
5. **Tamper:** change one byte of the stored v3 `invoice.hbs`, clear the memo and post a third run's accounts. Accounts pinned to v3 park with `TEMPLATE_CHECKSUM_MISMATCH`, accounts pinned to other versions render, and no legacy render occurs. Then change one byte of the logo blob: the affected renders park with `ASSET_CHECKSUM_MISMATCH` (criterion 6).
6. **CSV:** for a bill from step 3, one row per line and the `net_amount` SQL sum equals the subtotal (criterion 9).
7. **Multi-page:** the 10,000-row usage fixture renders ≥ 3 pages with "Page X of Y" on every page, a repeated header, line groups kept whole and an unclipped watermark (criterion 7). 10,001 rows park the account with `INVOICE_USAGE_OVER_LIMIT`.
8. **Audit:** every save, activation and upload in steps 3–4 wrote exactly one `AUDIT_LOG` row of the right type (criterion 11).

### D2 — Admin browser e2e without a new dependency

**The repo has no Playwright e2e suite** (no `@playwright/test`, no `playwright.config`; verified 2026-10-07). Adding `@playwright/test` would be a new dependency and a stop-and-ask (workflow rules §6.13). The admin e2e therefore uses the **already-installed `playwright` library** (`chromium.launch()`, as the renderer does) from a vitest integration test (`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`) against `next start` on a test port with the journey database:

| Scenario                        | Assertion                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User with no `invoice_settings` | The nav hides "Invoice Settings". Visiting either page redirects to `/no-access` (criterion 11).                                                                                                                                                                                                                                       |
| READ user                       | Both pages render read-only. No Save, Activate or Upload control. Preview works. A posted-bill preview source is offered only with `billrun_view`.                                                                                                                                                                                     |
| EDIT user, template             | A mandatory checkbox can't be unticked. Hiding Discount removes the column and its total from the preview iframe. Save draft, then Activate (the note is required; an empty note shows the server message). v n+1 is ACTIVE and v n RETIRED in history. The Generated .hbs tab has no hidden-section markup and no `[[` (criterion 4). |
| EDIT user, profile              | Invalid TIN, SST, postcode, SWIFT, email and colour are rejected inline. Logo rejections: > 500 KB, < 300 px, PNG-as-SVG, SVG `<script>`. Activate without a logo is refused. With a logo and a note it succeeds. The bank-change warning shows (criterion 3).                                                                         |
| Escaping                        | A customer name `<script>alert(1)</script>` shows escaped in the preview iframe, with no dialog fired (criterion 11).                                                                                                                                                                                                                  |

Browser automation runs headless, isolated, with no network beyond the test server.

If the team prefers `@playwright/test` (traces, a runner), that is a separate dependency decision to raise; it isn't assumed here.

### D3 — Guardrail and matrix sweep

- Guardrails **43–56** all present and green, each in the file its unit created.
- Earlier guardrails covering touched files: compute boundary, rating write boundary, finalization guard, checksum serialization, route inventory (still exactly three `app/api/billrun` POST handlers), seed integrity (`_SAMPLE_` marker, `db:seed-sample` prod guard), `nav-registry-guard`, `status-literal-sweep`.
- **Route × level matrix** (`invoice-settings-authz-matrix.test.ts`) covers the **five new routes**: the settings index, company profile, invoice template, the `.hbs` files route and the logo route. It also covers the CSV route and the **six actions**: save/activate profile, upload logo, save/activate template, preview.
- ZAP and Semgrep scopes include the new routes (confirm the authz-sweep inventory lists them).
- `information_schema` grant assertions (guardrail 56) pass on a database bootstrapped from scratch **and** on one upgraded from a pre-bm50 bootstrap (the revoke path).

### D4 — Success-criteria evidence table

The PR description carries a table mapping each overview Part 2 success criterion (1–12) to the test(s) that prove it, with links. A criterion without a green test blocks sign-off.

### D5 — If G14 is still open

bm61 isn't built, so criteria 3 (profile activation part), 5 (profile half), 10 and 11 can't be fully shown. **The gate does not pass.** It does not get a partial sign-off and it does not fold early. Record the blocked state in the progress tracker and stop.

### D6 — Docs (the fold, §7.6)

All of the following in one change set:

- `billmgmt-project-overview.md`: move the Invoice Template update section to delivered (status, the delivered design and the user flows; drop any "planned" callout).
- `billmgmt-architecture.md`: close X1–X4 and the "Other open items" that are resolved. Set Inv #36 to the bm48 amendment. Inv #39–#50 note "delivered (bm47–bm62)". Correct the stack/infra rows to match what bm52 built and the G16 outcome.
- `billmgmt-code-standards.md`: close C1–C4. Replace R#/D# citations with invariant numbers and delete the stale "no Part 2 invariants yet" sentence (workflow rules §7.4). Confirm every binding name added during bm47–bm62.
- `billmgmt-ai-workflow-rules.md`: remove the Part 2 rows from the §5 open table.
- `billmgmt-progress-tracker.md`: bm47–bm63 delivered, with commit hashes.
- `bm00-build-plan.md`: the Part 4 status set to delivered.
- `invoice-template/placeholder-catalog.md`: final placeholder roots.
- `billmgmt-known-issues.md`: the residuals the units recorded (pre-bm54 unstamped bills, mid-run activation, ratecard grants not seeded, orphan blobs tolerated).

## Implementation

1. Write the journey test (D1) and the admin e2e (D2). Add an `npm run test:e2e:invoice-settings` script that starts `next start` on a free port, runs the e2e file and stops the server. This is a `package.json` scripts change only.
2. Run the sweep (D3) and fix defects in their owning areas.
3. Write the evidence table (D4).
4. Docs (D6).

## Dependencies

- **npm:** none. Specifically **no `@playwright/test`**; this uses the installed `playwright` 1.63.0.
- **Prerequisite units:** bm47–bm62, all green. All G-items decided.

## Verification checklist

- [ ] The D1 journey passes on a fresh database and shows criteria 1, 2, 5, 6, 7, 8, 9 and 10.
- [ ] The admin e2e passes and shows criteria 3, 4 and 11.
- [ ] Criterion 12: golden-render snapshots pass for each layout version, the bm18/bm19 tests run against the binder, and `npm run typecheck`, `npm run lint`, the vitest suite and the e2e all pass.
- [ ] Guardrails 43–56 and the relevant earlier ones are green. The route × level matrix covers the five routes, the CSV route and the six actions.
- [ ] No open G-item remains: G4–G14 and G16 are recorded as decided in all three trackers.
- [ ] Part 2 is folded into the project overview and removed from the update overview. Architecture, code-standards, workflow rules, the tracker, the build plan, the catalog and known-issues are synced.
