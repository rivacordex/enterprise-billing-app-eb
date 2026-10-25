# bm75 — Network-blocked, script-free invoice rendering

**Unit:** bm75 (Invoice Template Types · Part 6, unit 2 of 12). **Boundary:** RENDER: `services/billing/render-invoice.ts` and its tests. **Specs from:** `billmgmt-update-overview.md` › Features › Rendering safety; `billmgmt-architecture.md` Inv #47 (amended) and Inv #64, contradiction T4; `billmgmt-code-standards.md` › Invoice Template Types, General rule 6, guardrail item 74 (draft/final half); `bm00-build-plan.md` Part 6, unit 75. **Model file:** `invoice-editor/src/server/render.ts:76-88` (the editor's proven blocked render).

> **Framing.** `renderPdfFromHtml` launches Chromium, opens `browser.newPage()` with the network open and JavaScript on, and calls `setContent(html, { waitUntil: "networkidle" })` (`render-invoice.ts:110-113`). Today the only barrier to a layout fetching a URL from the server is the text lint. From bm78, layouts arrive by **upload**, skipping code review, and pattern lints can be evaded. bm75 makes the renderer itself refuse every network request and run no script, for **every** Chromium render.
>
> It also exposes the hardened page as a reusable helper, so bm76 (the visible-text check) and bm78 (the upload gate's probe render) render through the **same** context instead of launching Chromium themselves. Draft and final renders never fail because a fetch was blocked; they log it. Failing on a fetch is the upload gate's job (bm78). Preview is sandboxed HTML in an iframe, not Chromium, and is untouched.

## Goal

Every Chromium render in the app runs in one hardened browser context: JavaScript off, offline, and every request except `data:`/`about:` aborted and recorded. Draft and final invoice PDFs come out unchanged and log any blocked URL with the version ids, and a reusable `withHardenedPage` helper is exported for later units.

## Design

**Structural decisions**

- **One factory, one file.** All Chromium use stays in `services/billing/render-invoice.ts`. A new exported `withHardenedPage(html, use)` owns `chromium.launch`, `browser.newContext({ javaScriptEnabled: false, offline: true })`, `context.newPage()`, the route block, `setContent`, and the bounded close. `renderPdfFromHtml` becomes a thin caller of it. A guardrail forbids any other file from calling `chromium.launch`, `browser.newContext` or `browser.newPage`.
- **The semaphore and close bound are unchanged.** `MAX_CONCURRENT_RENDERS = 2`, the FIFO `renderSemaphore` and the `BROWSER_CLOSE_TIMEOUT_MS = 1_500` race keep their values and behaviour. `withHardenedPage` runs inside the same semaphore, so a later gate render counts against the same cap.
- **Block, record, continue.** The route handler `continue()`s only URLs whose scheme is `data:` or `about:`, and `abort("blockedbyclient")`s everything else, pushing the URL to a `blockedUrls` array. `withHardenedPage` returns `{ value, blockedUrls }` and never throws for a blocked request; the caller decides. `offline: true` is the second fence: even a request that escaped the route would fail.
- **Draft and final renders log, never throw.** `renderPdfFromHtml` logs one `logger.warn("INVOICE_RENDER_BLOCKED_FETCH", { layoutVersionId, generatedVersionId, count, urls })`, with at most the first 5 URLs, when `blockedUrls` is non-empty, and returns the PDF. A posted invoice is therefore never failed or parked by this (Inv #40 unchanged, Inv #64).
- **No output change.** Fonts are inline `data:` URIs in `shell.hbs`, and the logo is inlined as a `data:` URI (`read-profile.ts:150`). The seeded Standard v1 renders the same PDF content, and its HTML golden is unchanged.
- **No new error code, dependency or config.** Playwright 1.63 already supports `newContext({ javaScriptEnabled, offline })` and `page.route`.

## Implementation

### 1. `services/billing/render-invoice.ts`

Replace `renderPdfFromHtml` and add the exported helper. Everything above `PdfRenderOptions` is unchanged except the two callers, which pass the version ids for the log line.

```ts
import { chromium, type Page } from "playwright";

import { createSemaphore } from "@/lib/concurrency";
import { logger } from "@/lib/logger";
// … existing imports unchanged …

// bm75 (Inv #64) — the ONE hardened Chromium context. JavaScript off, offline, every request
// except data:/about: aborted and recorded. Draft/final renders log blocked URLs and never
// throw for them; the upload gate (bm78) fails on them. No other file may launch Chromium
// (guardrail 74, tests/guardrails/chromium-single-factory.test.ts).
const ALLOWED_SCHEMES = ["data:", "about:"] as const;
const MAX_LOGGED_URLS = 5;

export interface HardenedPageResult<T> {
  value: T;
  blockedUrls: string[];
}

export function withHardenedPage<T>(
  html: string,
  use: (page: Page) => Promise<T>,
): Promise<HardenedPageResult<T>> {
  return renderSemaphore.run(async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        offline: true,
      });
      const page = await context.newPage();
      const blockedUrls: string[] = [];
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (ALLOWED_SCHEMES.some((s) => url.startsWith(s))) {
          return route.continue();
        }
        blockedUrls.push(url);
        return route.abort("blockedbyclient");
      });
      await page.setContent(html, { waitUntil: "networkidle" });
      const value = await use(page);
      return { value, blockedUrls };
    } finally {
      // Unchanged bounded close (see BROWSER_CLOSE_TIMEOUT_MS above).
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS)),
      ]);
    }
  });
}

export interface PdfRenderOptions {
  pageSetup: LayoutPageSetup;
  footerHtml: string;
  // bm75 — for the blocked-fetch log line only.
  layoutVersionId: string;
  generatedVersionId: string;
}

async function renderPdfFromHtml(
  html: string,
  { pageSetup, footerHtml, layoutVersionId, generatedVersionId }: PdfRenderOptions,
): Promise<Buffer> {
  const { value: pdf, blockedUrls } = await withHardenedPage(html, (page) =>
    page.pdf({
      format: pageSetup.format,
      landscape: pageSetup.orientation === "landscape",
      printBackground: pageSetup.printBackground,
      margin: pageSetup.margin,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: footerHtml,
    }),
  );
  if (blockedUrls.length > 0) {
    logger.warn("INVOICE_RENDER_BLOCKED_FETCH", {
      layoutVersionId,
      generatedVersionId,
      count: blockedUrls.length,
      urls: blockedUrls.slice(0, MAX_LOGGED_URLS),
    });
  }
  return pdf;
}
```

The two callers pass the ids from the `resolved` they already receive:

```ts
const { html, footerHtml, pageSetup, resolved } = await buildInvoiceHtml({ runId, banId, mode: "draft" });
return renderPdfFromHtml(html, {
  pageSetup,
  footerHtml,
  layoutVersionId: resolved.layout.billTemplateVersionId,
  generatedVersionId: resolved.generated.billTemplateVersionId,
});
```

(The same applies to `renderFinalInvoice`, with `mode: "final"` and `invoiceNo`.)

**Comments:** replace the "D9 … byte-identical to before bm47" comment above `PdfRenderOptions` with: "bm75: the context is hardened (Inv #64); the semaphore, the per-render launch (D19) and the bounded close are unchanged."

### 2. Guardrail: `tests/guardrails/chromium-single-factory.test.ts` (new)

DB-free, static source scan in the style of `tests/guardrails/phase3-boundaries.test.ts`. It walks `app/`, `actions/`, `services/`, `lib/`, `db/` and `scripts/` (`.ts`/`.tsx`, excluding `node_modules`), and fails if any file **other than** `services/billing/render-invoice.ts` matches `/\bchromium\.launch\b|\.newContext\(|\bbrowser\.newPage\(/`. The test asserts:
- the set of matching files is exactly `["services/billing/render-invoice.ts"]`
- that file contains `javaScriptEnabled: false`, `offline: true` and `page.route("**/*"`

**Mutation check:** adding `chromium.launch()` to a scratch file under `services/` makes the test fail. The spec's author confirms this once while writing the test, then deletes the scratch file.

### 3. `tests/services/billing/render-invoice.service.test.ts` (changed)

The `playwright` mock moves from `browser.newPage` to the context chain:
- `chromium.launch` → `{ newContext, close }`
- `newContext` → `{ newPage }`
- `newPage` → `{ route, setContent, pdf }`
- `route` captures its handler

The existing cases (draft and final render, semaphore cap, bounded close, close-failure swallowing, the render error propagating) keep their assertions. Add:
- `newContext` is called once per render with `{ javaScriptEnabled: false, offline: true }`, and `route` with `"**/*"`
- **blocked URL:** invoking the captured handler with a fake route whose `request().url()` is `https://x.example/a.png` calls `abort("blockedbyclient")` and not `continue()`. The render still resolves the PDF bytes. `logger.warn` is called once with `"INVOICE_RENDER_BLOCKED_FETCH"`, both version ids, `count: 1` and the URL.
- **allowed URL:** a `data:image/png;base64,…` request calls `continue()`, and no warn is logged.
- **log cap:** 7 blocked URLs log `count: 7` and exactly 5 `urls`.
- the `buildInvoiceHtml` mock returns `resolved: { layout: { billTemplateVersionId: "BTV00000001" }, generated: { billTemplateVersionId: "BTV00000002" } }`

### 4. `tests/services/billing/invoice-render-chromium.e2e.test.ts` (extended, `RUN_CHROMIUM_E2E=1`)

Real Chromium through `withHardenedPage`. It reuses the existing gate and harness, but no longer launches its own `chromium` for the new cases. The existing seeded-template render is kept as is.
- **No hit reaches the network:** start a local `http.createServer` on an ephemeral port that counts requests. Render HTML containing `<img src="http://127.0.0.1:{port}/a.png">`, `<link rel="stylesheet" href="http://127.0.0.1:{port}/s.css">`, a CSS `background:url(http://127.0.0.1:{port}/b.png)` and an `@font-face` `src:url(http://127.0.0.1:{port}/f.woff2)`. Then:
  - the server's hit count stays `0`
  - `blockedUrls` contains the four URLs
  - `page.pdf()` inside `use` returns bytes starting `%PDF-`
- **No script runs:** HTML `<p id="t">static</p><script>document.getElementById("t").textContent="ran"</script>`, then `use = (p) => p.innerText("#t")`, returns `"static"`.
- **Inline data still renders:** a `data:image/png;base64,…` `<img>` and a `data:font/woff2` `@font-face` produce no `blockedUrls`.
- **The seeded Standard v1 is unchanged:** the existing case renders through `renderPdfFromHtml`'s options and asserts `%PDF-`, the same page count as before (recorded in the test), and `blockedUrls` empty. That proves the fonts and logo are inline.

### 5. Golden

`tests/services/billing/invoice-golden.test.ts` is an HTML golden, independent of Chromium. Re-run it **unchanged**; no snapshot is regenerated.

## Dependencies

- **Packages:** none (Playwright 1.63 is installed).
- **Units:** none. Independent of bm74; must land before bm76.
- **Environment:** `RUN_CHROMIUM_E2E=1` with the Chromium binary installed (`npx playwright install chromium`, already part of local setup).

## Verification checklist

- [ ] `withHardenedPage` is exported from `services/billing/render-invoice.ts`. It creates its context with `{ javaScriptEnabled: false, offline: true }` and routes `"**/*"`, continuing only `data:`/`about:`.
- [ ] `renderDraftInvoice` and `renderFinalInvoice` go through it. A blocked URL logs `INVOICE_RENDER_BLOCKED_FETCH` with both version ids, at most 5 URLs and the count, and the PDF is still returned. Nothing throws.
- [ ] `MAX_CONCURRENT_RENDERS`, the semaphore and `BROWSER_CLOSE_TIMEOUT_MS` are unchanged. A queued third render still waits (existing semaphore case green).
- [ ] `tests/guardrails/chromium-single-factory.test.ts` passes, and fails when a scratch file adds `chromium.launch`. Guardrail item 74, draft/final half.
- [ ] `render-invoice.service.test.ts` passes with the context-chain mock and the four new cases.
- [ ] With `RUN_CHROMIUM_E2E=1`, `invoice-render-chromium.e2e.test.ts` shows zero hits on the stub server, script not run, data URIs allowed, and Standard v1 rendering with no blocked URL.
- [ ] `invoice-golden.test.ts`, `post-run.service.test.ts`, `draft-invoice-route.test.ts` and `invoice-template-journey.integration.test.ts` pass unchanged.
- [ ] `tsc --noEmit`, ESLint and Prettier pass. `git diff --stat` touches only `services/billing/render-invoice.ts` and the four test files above.
- [ ] `billmgmt-architecture.md` Inv #64 is marked "built (bm75), draft/final half" with the test files. `billmgmt-progress-tracker.md` records bm75.
