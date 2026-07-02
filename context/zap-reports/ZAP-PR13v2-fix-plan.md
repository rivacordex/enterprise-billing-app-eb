# ZAP PR13 v2 — Security Fix Plan

**Report:** `zap/zap-report-PR13v2.html` (generated 2026-07-02, ZAP 2.17.0)
**Site scanned:** `ebill-dev-app.agreeablehill-80bee1a6.southeastasia.azurecontainerapps.io`
**Summary:** 0 High · 1 Medium · 1 Low · 6 Informational · 0 False Positives

**Context:** Re-scan after the v1 fixes (`context/zap-reports/ZAP-PR13-fix-plan.md`). All v1 Medium/Low alerts (10038, 10020, 10202, 10035, 10021, 10063, 10037, 90004) are cleared. Two actionable alerts remain.

---

## Fix 1 (Medium) — CSP: `style-src` includes `'unsafe-inline'`

- **ZAP rule:** 10055 | **Instances:** Systemic (all routes)
- **Root cause:** `next.config.ts` deliberately keeps `style-src 'self' 'unsafe-inline'` (see comment, lines 3–7) because of exactly two first-party inline `style` usages:
  1. `components/audit-log/audit-log-table.tsx:117` — `style={{ backgroundColor: CATEGORY_BORDER_COLORS[row.category] }}` on the category swatch `<td>`. The map is a **bounded** 5-entry constant (Additive/Change/Removal/Session/Security → CSS vars).
  2. `components/ui/sonner.tsx:27` — Toaster sets 4 CSS custom properties via the `style` prop.

### Deliverables

| #   | Deliverable                   | Change                                                                                                                                                                                                                                                            |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Class-based category swatch   | Replace the `style` prop in `audit-log-table.tsx` with a `CATEGORY_SWATCH_CLASS: Record<AuditEventCategory, string>` map of Tailwind arbitrary-value classes (e.g. `bg-[var(--color-success-500)]`), mirroring the existing `CATEGORY_BORDER_COLORS` entries 1:1. |
| 1.2 | Stylesheet-based Toaster vars | Move the 4 custom properties from the `style` prop in `sonner.tsx` into a `.toaster { … }` rule in `app/globals.css` (component already carries `className="toaster group"`).                                                                                     |
| 1.3 | CSP tightened                 | Remove `'unsafe-inline'` from `style-src` in `next.config.ts`; update the stale comment block.                                                                                                                                                                    |
| 1.4 | Regression guard              | Add ESLint `react/forbid-dom-props` (or equivalent rule) banning the `style` prop, so a new inline style can't silently re-require `'unsafe-inline'` (per `usrmgmt-code-standards.md` §5, which already forbids inline `style` except commented dynamic values).  |

### Risk / rollout note

Removing `'unsafe-inline'` blocks **server-rendered** `style` attributes and `setAttribute('style', …)` app-wide — including any SSR'd inline styles from third-party components (Radix positions floating elements with inline styles; client-side CSSOM writes are unaffected, but SSR'd attributes are dropped at parse time). Mitigation:

1. Land 1.1–1.3 on a branch, deploy to staging.
2. Run browser QA (`/qa`) across the flows that use floating/portal UI: toasts, dropdown menus, dialogs, selects, tooltips, audit-log table.
3. Check the browser console for `Refused to apply inline style` CSP violations on every QA'd page — zero violations required.

**Fallback** if third-party SSR breakage is found and can't be refactored: keep `'unsafe-inline'`, document the constraint in `next.config.ts`, and add `10055 IGNORE` with justification to `infra/zap/rules.tsv` (Medium doesn't block the pipeline gate, but the suppression keeps reports clean and reviewed).

### Measurable outcome

- ZAP rule 10055 produces 0 alerts on re-scan.
- `grep -rn "style={" app components lib` returns no matches (excluding commented, justified dynamic values per code standards).
- No CSP violation reports in console during QA pass.

---

## Fix 2 (Low) — Dangerous JS Functions: `eval(` in `/_next/static/chunks/281kxly9ymb4i.js`

- **ZAP rule:** 10110 | **Instances:** 1 | **Evidence:** `eval(`
- **Investigation so far (local workspace):**
  - The flagged chunk `281kxly9ymb4i.js` does **not exist** in the current local build (`.next/static/chunks/`).
  - `grep -rl "eval(" .next/static` over the current local build (37 JS files) finds **zero** matches.
  - No `eval(` in the dist files of any client-side runtime dependency (sonner, next-themes, better-auth, react-hook-form, zod, radix-ui, lucide-react, cva, tailwind-merge, clsx); Next's compiled React Flight client contains `eval` only in `*.development.js` builds, not production.
  - **Working hypothesis:** the deployed staging revision was built from an older commit or a non-production build variant that bundled a dev artifact. The rest of the report's chunk names (e.g. `0ha4m18glnjqn.js`) match the current local build, so the delta is narrow.
- **Mitigating control already in place:** prod CSP is `script-src 'self'` with no `'unsafe-eval'` — any actual `eval()` call would throw at runtime. Rule 10110 is a passive string match, not proof of exploitability.

### Deliverables

| #   | Deliverable             | Change                                                                                                                                                                                                                     |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Source identification   | Fetch `/_next/static/chunks/281kxly9ymb4i.js` from staging; locate the `eval(` occurrence and attribute it to the owning module (surrounding identifiers / sourcemap). Record findings in `context/zap-reports/`.          |
| 2.2 | Deployed-revision check | Compare the staging container's `BUILD_ID` / image tag against `main`. If stale, redeploy the current build — expected to clear the alert given 2× negative grep of the current build output.                              |
| 2.3 | Fix or suppress         | If the `eval` survives a fresh deploy: remove/replace the offending dependency, or — if it's an unreachable guarded path — add `10110 IGNORE <justification>` to `infra/zap/rules.tsv` citing the `script-src` mitigation. |
| 2.4 | Build-time guard        | Add a guard after `npm run build` in the `Dockerfile` builder stage (line 35, where `next build` actually runs): `RUN ! grep -rl "eval(" .next/static` — fails the image build if `eval(` ever enters a shipped chunk.     |

### Measurable outcome

- ZAP rule 10110 produces 0 alerts on re-scan (or has a reviewed `rules.tsv` suppression with justification).
- CI grep guard is green on the shipping build.

---

## Informational alerts (no code change required)

| Alert (rule)                                   | Instances | Disposition                                                                                                                                             |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication Request Identified (10111)      | 1         | No action — ZAP correctly detected the `/login` flow (`_csrf`, `email`, `password`). Confirms authenticated scanning works.                             |
| Modern Web Application (10109)                 | 4         | No action — informational only.                                                                                                                         |
| Session Management Response Identified (10112) | 3         | No action — detects `__Secure-better-auth.state` and `csrf_token` cookies; expected better-auth behaviour.                                              |
| Non-Storable Content (10049)                   | 4         | No action — `no-store` on dynamic pages is correct for an authenticated billing app. _Optional:_ allow public caching for `robots.txt` / `sitemap.xml`. |
| Storable and Cacheable Content (10049)         | Systemic  | No action — all instances are content-hashed `/_next/static/*` assets with `max-age=31536000`; correct and contains nothing sensitive.                  |
| Storable but Non-Cacheable Content (10049)     | 1         | No action — favicon with `max-age=0`. _Optional:_ add a longer `Cache-Control` for `/favicon.ico`.                                                      |

_Optional tidy-up:_ since all 10049 findings are verified-correct behaviour, add `10049 IGNORE` to `infra/zap/rules.tsv` with the justification above to keep future reports focused.

---

## Sequencing

1. **PR A — Fix 1** (deliverables 1.1–1.4): refactor two inline styles → tighten CSP → staging deploy → QA pass.
2. **PR B — Fix 2** (deliverables 2.1–2.4): investigate chunk → redeploy/fix/suppress → add CI grep guard. Independent of PR A; can run in parallel.
3. **Re-scan gate:** re-run the ZAP baseline stage (`infra/zap-scan-stage.yml`) against the staging revision containing both PRs.

## Definition of Done

Re-run of `zap-baseline.py` against staging produces:

- **0 Medium alerts** (rule 10055 cleared or suppressed-with-justification)
- **0 Low alerts** (rule 10110 cleared or suppressed-with-justification)
- No new High/Critical alerts introduced
- CI `eval(`-grep guard merged and green
