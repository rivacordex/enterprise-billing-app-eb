# bm18 — Rendering Foundation + Draft PRO-FORMA Preview

**Unit:** bm18 (Phase 2 · Phase H). **Boundary:** app rendering — `services/billing/render-invoice.ts` (draft mode), a session-guarded PDF Route Handler, `components/billing/invoice-preview-modal.tsx`, and the app runtime image (`Dockerfile`). **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §6/§15 **D16/D17/D18/D19**, `billmgmt-architecture.md` §1 (PDF rendering), `billmgmt-ui-context.md` §6c, `bm00-build-plan.md` Unit 18.

> **Framing.** Rendering is **app-side** (D-push): the app renders and — later, bm19 — stores invoice artifacts; the workflow management component only transports them (bm20). This unit stands up the renderer and the **on-demand draft (PRO-FORMA) preview** reviewers use before approval. It stores nothing.

## Goal

Bake Playwright/headless Chromium into the app runtime image and build `render-invoice.ts` (draft mode) plus a session-guarded PDF route and `InvoicePreviewModal`, so a `billrun_view` reviewer can, on demand, preview an account's draft invoice as a **watermarked PRO-FORMA PDF that carries no invoice number and is never stored**.

## Design

**Structural decisions**

- **Playwright, in-app, Chromium baked into the image (D16/D17).** `render-invoice.ts` runs in the Node app process; the deployed image gains Chromium via Playwright. This is the platform's first in-app document rendering — a real infra change now (Chromium is a runtime dependency, not just a CI/test one).
- **Draft = ephemeral (D18).** A draft is rendered **on demand** and **streamed** to the browser; nothing is written to `bill_run_invoices` (which doesn't exist yet — bm19) or blob. A rerun/reject leaves no artifact because none was created.
- **Draft ≠ a valid invoice.** A pre-approval invoice has **no invoice number** (the number is `document_id`, consumed only at posting). So the draft renders with the number field as **"— pending posting —"** and a diagonal watermark **"DRAFT · PRO-FORMA · NOT A VALID INVOICE"** (Danger family at low opacity, `billmgmt-ui-context.md` §6c) on every page. It can never be mistaken for an issued invoice.
- **One throwaway template.** A single hand-built HTML/CSS invoice template (header, bill-to, period, line items, totals, tax) — **not** the production template system (`bill_template_version`/`bill_format`/i18n stays deferred, D18). It reads the account's `customer_bill` + its claimed `udr_rated` charge lines.
- **A session-guarded PDF route — a new route type.** The preview is served by a **session-guarded** Route Handler (`getSession` + `billrun_view`), distinct from the M2M `app/api/billrun/*` handlers (which are session-_less_). It streams `application/pdf` inline. This is a deliberate, reviewed addition to code-standards §3.5's "`app/api/*` = M2M only" — a _human-facing, session-guarded_ binary route, placed under the authenticated `(app)` segment (not `app/api/`) to keep the M2M namespace M2M-only.
- **Launch-per-render for now (D19).** A single browser launched per render is fine at draft volume (one account at a time). Pooling, one context/page per invoice, font pinning, and ~500-invoice throughput are deferred to the real-rendering/production-hardening pass (surfaced in bm19's caveats, not built here).

## Implementation

### 1. `Dockerfile` — Chromium in the runtime image

- Add a build step installing Chromium + its OS deps for Playwright (`npx playwright install --with-deps chromium`), in the runtime stage (not just the builder), so the deployed image can render. Pin the Playwright version (lockfile) so the browser build is reproducible.
- `docker-compose.dev.yml` — ensure local dev runs against the same image path (or documents `npx playwright install chromium` for a bare `npm run dev`).
- Note the **image-size increase** (Chromium ~heavy) in `infra/docs/` — accepted, since rendering is genuinely in scope.

### 2. `services/billing/render-invoice.ts` (new) — draft mode

- `renderDraftInvoice({ runId, banId }): Promise<Buffer>`:
  1. Read the account's `customer_bill` (trial) + its `customer_bill_tax_item`s + the claimed `rating.udr_rated` charge lines by `(billrun_ref_id=runId, billrun_ban_id=banId)` — `app_runtime` `SELECT` (rating rm03). Not-found → typed error → 404 at the route.
  2. Build the invoice **HTML** from the throwaway template (a server-rendered string or a small React-to-HTML render), with the **draft** flags: watermark on, invoice-number = "— pending posting —".
  3. Launch Chromium (`playwright.chromium.launch()`), new page, `page.setContent(html, { waitUntil: 'networkidle' })`, `page.pdf({ format: 'A4', printBackground: true, margin, displayHeaderFooter, headerTemplate/footerTemplate })`; close the browser in a `finally`.
  4. Return the PDF `Buffer`. **No write** to any table or blob.
- Money renders through the existing `lib/` `formatCurrency`; dates through `formatDatetime`; amounts come pre-summed from `customer_bill`/lines (no JS float math).

### 3. `app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route.ts` (new) — session-guarded PDF

- `GET`: `getSession` → require `billrun_view` → parse `[runId]` (`BRN` schema) + `[banId]` → `renderDraftInvoice(...)` → `new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="DRAFT-<ban>.pdf"' } })`. 403 without permission, 404 on unknown run/account, HTTPS-only. Added to the authz-sweep inventory as a **session-guarded** route (not M2M).

### 4. `components/billing/invoice-preview-modal.tsx` (new) — `InvoicePreviewModal`

- Opens the account's draft-invoice route in an embedded `<iframe>` (or a new tab) with a clear "Draft / PRO-FORMA — not a valid invoice" banner (Warning family) around it, and a Close. Reachable from **Customers & Bills** (the account row / bill drawer, per the mockup's "Preview PRO-FORMA →"). Low-emphasis trigger (quiet secondary/ghost — never the featured petrol or a danger role, `billmgmt-ui-context.md` §7).

### 5. Config / env

- No new env for draft rendering. (Blob/`invoices/` config lands in bm19.)

## Dependencies

- **New npm package:** `playwright` (or `playwright-core` + the Chromium browser installed in the image) — pinned in the lockfile (its own requested dependency change, per code-standards). This is the one package install for the phase.
- **Prerequisites:** bm16 (a trial `customer_bill` + its claimed `udr_rated` lines exist to render from); the `_SAMPLE_*` seed (bm15) for demo data; `lib/formatCurrency`/`formatDatetime` (exist).

## Verification checklist

- [ ] The app runtime image builds with Chromium; `renderDraftInvoice` produces a valid PDF in a container built from the `Dockerfile` (not only on a dev machine with a system Chromium).
- [ ] A `billrun_view` reviewer opens `InvoicePreviewModal` for an account and sees a real PDF: every page carries the **"DRAFT · PRO-FORMA · NOT A VALID INVOICE"** watermark, the invoice-number field reads **"— pending posting —"**, and the line items/totals match the account's trial `customer_bill` + claimed `udr_rated`.
- [ ] The draft is **never stored** — no row in any table, no blob object; a second preview re-renders fresh; a rerun/reject on the account leaves no artifact.
- [ ] The PDF route is **session-guarded**: `billrun_view` required (403 otherwise, verified by direct request not just UI), `getSession` present, HTTPS-only, unknown run/account → 404; it is **not** under `app/api/` and does not use the M2M bearer path.
- [ ] Money/date rendering goes through the shared `lib/` formatters; no inline `toFixed`, no client-side sum.
- [ ] `playwright` is pinned in the lockfile; the image-size note is in `infra/docs/`; browser is closed in a `finally` (no leaked processes across renders).
- [ ] `tsc`/lint/tests green (incl. the route × level check for the new session-guarded route); `billmgmt-progress-tracker.md` updated (bm18 delivered).

## Phase-2 review folds (2026-08-28)

**T9 (P2, eng §16) — bound the launch-per-render.** D19 defers pooling, but the interactive draft route is unbounded (any `billrun_view` user, repeatable) and Chromium now shares the app image, so a few active reviewers can OOM the container. Add a small **concurrency guard** now (a process-level semaphore / single-flight, 1–2 renders in flight, queue the rest) around `renderDraftInvoice`, plus a per-session rate limit on the draft route. Full pooling / one-context-per-invoice / font-pinning stay deferred (D19). Verification addition: N concurrent draft requests never exceed the in-flight cap; excess requests queue rather than launch.

**D-T2 (P2, design §17) — draft render loading + error states.** The 1–3s Chromium render (longer when queued behind the T9 guard) currently shows nothing. `InvoicePreviewModal` opens immediately with a **PDF-shaped skeleton** (`pdfwrap` frame + shimmer lines) and a caption **"Rendering draft invoice…"**; a queued render reads **"Queued — rendering shortly"**; a slow/failed render (timeout or Chromium error) shows an **inline retry** with a plain-language reason. Verification addition: clicking Preview shows an immediate skeleton then the PDF; a forced render error shows the retry state, never a frozen/empty modal.

**D-T5 (P2, design §17) — watermark legibility + modal a11y (shared with bm19, `ui-context` §6c).** The PRO-FORMA watermark must not degrade the figures the reviewer opened the modal to validate. In `ui-context` §6c: cap watermark opacity so overlaid line-item/total figures stay **≥ 4.5:1** (tested), OR tile the "DRAFT · PRO-FORMA" band to avoid the number column / sit it in the page margins as a repeating diagonal — unmistakable but never over the totals. Add the modal a11y contract to `InvoicePreviewModal` (and `StoredInvoiceModal`, bm19): **focus trap, `Esc` to close, focus return to the trigger, and an accessible `<iframe>` title** ("Draft PRO-FORMA invoice — BAN…" for drafts; the real `INV…` for stored). Verification additions: figures stay AA-legible under the watermark; the modal traps focus, closes on `Esc`, returns focus, and the PDF frame has a screen-reader label.
