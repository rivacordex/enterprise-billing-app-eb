# bm66 — Draft PRO-FORMA renders from the captured template

**Unit:** bm66 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** template resolution (`resolve-template.ts`) and its two non-posting callers (the draft-invoice route and the Invoice Settings preview) · **Depends on:** bm65
**Authorizes:** D12, D23, D33, D55 · Inv #42 (amended), #51 (draft half), #53 (draft and preview), #58 (draft half) · code-standards Phase 3 TS rule 1, Next.js rules 3–4, API rule 2 · architecture P2, P3 · UI context §10d (message copy)

## Goal

Make the draft PRO-FORMA for a BAN in a run render with the template versions captured on that BAN's `bill_run_account` row, so activating a new version mid-run no longer changes that run's drafts. The Invoice Settings preview is now the only render that resolves the live, current versions, and it does so for an explicit family.

## Design

**`RenderMode` becomes four explicit kinds** (`types/billing.ts`, replacing `{ kind: "draft" }`):

```ts
export type RenderMode =
  | { kind: "run"; stamps: RunTemplateStamps }          // draft inside a run: the BAN's captured stamps
  | { kind: "final"; bill: PostedBillStamps }           // unchanged
  | { kind: "preview-posted"; bill: PostedBillStamps }  // unchanged
  | { kind: "preview-family"; familyId: string };       // Invoice Settings preview: the family's live versions
```

`resolveTemplate` switches on `mode.kind`, ending in a `never` check.

| Kind | Generated version | CSV version | Profile version | If missing |
|---|---|---|---|---|
| `run` | `versionById(stamps.refBillTemplateVersionId, "generated")` | `versionById(stamps.refCsvTemplateVersionId, "csv")` | `stamps.refInvoiceProfileVersion` (NULL stays NULL, G15 A) | A NULL **generated** stamp throws `TEMPLATE_VERSION_NOT_FOUND` with `detail = { reason: "FAMILY_HAS_NO_ACTIVE_VERSION", familyId: stamps.refBillTemplateFamilyId }`. It never falls back to the default (architecture P3). |
| `preview-family` | `resolveCurrentVersionsForFamily(db, familyId).generated` (bm65) | current CSV | current profile | A family with no version throws the same code and `detail` |
| `final` / `preview-posted` | unchanged (bill stamps; NULL → default, bm53) | unchanged | unchanged | unchanged |

`run` is not a live mode: it never calls `currentVersion`. The only live kinds are `preview-family` (here) and the capture call (bm65).

**Posting is not touched.** `resolveVersionsForPosting` stays for one more unit; bm67 replaces it. Posting's behaviour is unchanged until then.

**The draft route reads the BAN's run row.**
- `buildInvoiceHtml` (`services/billing/render-invoice-template.ts`) keeps `mode: "draft"` as its *public* parameter name, so callers don't churn. Inside its existing repeatable-read transaction (~l.104), it now calls `billRunAccountRepository.readStamps(tx, runId, banId)` (bm65) and passes `{ kind: "run", stamps }`.
- **No row, or the row's status is `EXCLUDED` → `DraftInvoiceNotFoundError` → 404.** A captured row always has a generated stamp unless its family had no ACTIVE version (D55). bm65 also captures every non-EXCLUDED row, so there is no uncaptured live row on a fresh DB.

**The editor preview names a family.**
- `previewInvoiceTemplate` (`services/billing/invoice-template/preview.ts`) gains a required `familyId`:
  - the sample source (`previewSample`, ~l.119) renders with `{ kind: "preview-family", familyId }`;
  - an **unposted** bill source keeps rendering the admin's unsaved structure on that bill's data, so it uses `{ kind: "preview-family", familyId }`, not the run stamps. `preview.ts` builds that mode and passes it to `buildInvoiceHtml` on the override (`override.renderMode`); `buildInvoiceHtml` uses it as given and never constructs a live mode itself (code-standards Phase 3 TS rule 1: only `preview.ts` may construct `preview-family`; guardrail 57).
- A **posted** bill source keeps `preview-posted` (unchanged).
- `previewInvoiceTemplateInputSchema` (`validation/billing/invoice-template-structure.schema.ts`) gains `familyId: templateFamilyIdSchema` (bm64).
- `InvoiceStructureForm` (~l.211) passes the Standard family's id, read once by the page's server read service (`services/billing/read/invoice-template-settings.ts`) through `billTemplateFamilyRepository.findDefault` and handed to the form as a prop.

**Render errors reach the user with their code.**
- The draft route today turns every failure into `500 { error: "Could not render the draft invoice." }`. It now returns `422 { "error": { "code": <InvoiceErrorCode>, "message": <safe text> } }` for an `InvoiceRenderError`, following general code-standards §5.5–§5.6.
- 404 and 500 are unchanged for not-found and unexpected errors.
- `InvoicePreviewModal` (`components/billing/invoice-preview-modal.tsx`, ~l.104) reads the JSON body on 422 and shows the code's message from a new shared map, `describeInvoiceRenderCode(code)` (`lib/invoice-render-messages.ts`). Today it holds the existing codes plus the UI context §10d copy for `TEMPLATE_VERSION_NOT_FOUND`:

  | Code | Message |
  |---|---|
  | `TEMPLATE_VERSION_NOT_FOUND` | "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account." |
  | `INVOICE_RECONCILIATION_FAILED` | "The invoice lines do not add up to the bill total. Rerun this account; if it repeats, report it." |
  | `INVOICE_USAGE_OVER_LIMIT` | "This account has more than 10,000 billed usage records, over the invoice limit." |
  | any other code | today's generic text |

  bm70 and bm71 add their own codes to this map. The message renders in Danger `-fg`, keeping the existing error-state layout and Retry button.

**Deliberately not done:**
- Posting is unchanged (bm67).
- No new route.
- No change to the stored-invoice or CSV routes, which already use bill stamps.
- No UI to show which version a draft used.

**Visible result:**
1. Trigger a run.
2. Activate a new Standard version (e.g. change the footnote once bm72 exists, or any structure toggle today).
3. Open a BAN's draft PRO-FORMA: it still renders with the captured version.
4. The Invoice Settings live preview renders the new one.

A fixture BAN with a NULL generated stamp shows the "no active version" message in the preview modal instead of a generic error.

## Implementation

### 1. Types

`types/billing.ts` (~l.952): replace `RenderMode` as above, and export `RunTemplateStamps` (from bm65) from the same file. Update `ResolvedTemplate` callers if any narrow on `"draft"`.

### 2. Resolver

`services/billing/invoice-template/resolve-template.ts`:
- Replace the `if (mode.kind === "draft")` branch (~l.124) with a `switch` over the four kinds; `versionById` and `defaultVersion` are reused.
- Add `function familyNotActive(familyId: string | null): InvoiceRenderError`, which returns the `TEMPLATE_VERSION_NOT_FOUND` error with the D55 `detail`.
- Update the header comment block (~l.13–31) to describe `run` and `preview-family`, and to name capture and preview as the only live resolutions (Inv #53).

### 3. Binder entry point

`services/billing/render-invoice-template.ts`:
- `BuildInvoiceHtmlParams.override` gains a required `renderMode: Extract<RenderMode, { familyId: string }>`, built by the caller (`preview.ts`). It is a required field of the override, so an override without a family is a type error; there is no runtime guard and no separate `familyId` parameter. The existing draft-only check (~l.96) stays.
- In the read transaction:

  ```ts
  if (override) {
    renderMode = override.renderMode;                             // preview-family, built by preview.ts
  } else if (mode === "draft") {
    const stamps = await billRunAccountRepository.readStamps(tx, runId, banId);
    if (!stamps || stamps.status === "EXCLUDED") return null;   // → DraftInvoiceNotFoundError
    renderMode = { kind: "run", stamps };
  } else {
    renderMode = { kind: mode, bill: stamps };                    // final / preview-posted, unchanged
  }
  ```

  > **Corrected 2026-10-16 (bm67).** This section first gave `buildInvoiceHtml` an optional `familyId` and had it construct `{ kind: "preview-family", … }`. That contradicted code-standards Phase 3 TS rule 1 ("only `preview.ts` may construct it") and bm67's guardrail 57, which forbids `preview-family` in `render-invoice-template.ts`. The override now carries the mode `preview.ts` built. The behaviour is the same: an unposted-bill preview renders the named family's live versions.

  `readStamps` returns the status alongside the four stamps; widen its bm65 signature to `RunTemplateStamps & { status: AccountStatus }`.

### 4. Preview

- `services/billing/invoice-template/preview.ts`:
  - `PreviewInvoiceTemplateParams` gains `familyId: string`;
  - `previewSample` resolves `{ kind: "preview-family", familyId }`;
  - the unposted-bill branch passes `override.renderMode: { kind: "preview-family", familyId }` to `buildInvoiceHtml`.
- `validation/billing/invoice-template-structure.schema.ts`: `previewInvoiceTemplateInputSchema` adds `familyId`.
- `actions/billing/invoice-settings/preview-invoice-template.action.ts`: pass it through. The existing `invoice_settings : READ` gate and the `billrun_view` check for bill sources are unchanged.
- `services/billing/read/invoice-template-settings.ts`: the page data adds `standardFamilyId`.
- `components/billing/invoice-settings/invoice-structure-form.tsx`: a new prop `familyId`, passed into the action call (~l.211).

### 5. Draft route and modal

- `app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route.ts`, the catch block (~l.90): `if (error instanceof InvoiceRenderError) return Response.json({ error: { code: error.code, message: describeInvoiceRenderCode(error.code) } }, { status: 422 });`. Log the code and `detail` with the `lib/` logger, never the stack in the body.
- New `lib/invoice-render-messages.ts`: `export function describeInvoiceRenderCode(code: InvoiceErrorCode): string`, an exhaustive `switch` with a default. It is shared by the route and the modal.
- `components/billing/invoice-preview-modal.tsx`: on `response.status === 422`, parse `{ error: { code } }` and `setErrorMessage(describeInvoiceRenderCode(code))`; otherwise keep `describeRenderError(status)`.

### 6. Tests

- `tests/services/billing/invoice-template/resolve-template.test.ts` (or the existing resolver test file):
  - `run` resolves exactly the stamped ids, even after a newer ACTIVE exists;
  - a NULL generated stamp throws `TEMPLATE_VERSION_NOT_FOUND` with `detail.reason = "FAMILY_HAS_NO_ACTIVE_VERSION"` (and never the default);
  - `preview-family` resolves the family's current non-default ACTIVE, else its default;
  - `final` and `preview-posted` are unchanged.
- New `tests/db/draft-uses-run-stamps.integration.test.ts`:
  1. trigger (bm65 capture), then activate a new generated version;
  2. `renderDraftInvoice` HTML equals a render forced to the captured version, and differs from one forced to the new version (assert on the `template.version` field in the bound input, not on bytes);
  3. an EXCLUDED BAN gets 404;
  4. the NULL-stamp fixture (bm65 §8 case 3) gets 422 with code `TEMPLATE_VERSION_NOT_FOUND`.
- `tests/components/billing/invoice-preview-modal.test.tsx`: a 422 with that code shows the §10d message.
- `tests/actions/preview-invoice-template.action.test.ts` (or the existing preview tests): `familyId` is required and validated (a bad id gets 422).
- `tests/guardrails/invoice-settings-authz-matrix.test.ts`: the preview row is unchanged (READ).
- The existing pinning guardrail 46 (`invoice-version-pinning.integration.test.ts`) still passes, since posting is unchanged. Update only its draft-preview expectation: "a new draft preview uses v3" now reads "a draft in a run started after v3's activation uses v3".

## Dependencies

- **Packages:** none.
- **Units:** bm65 (stamps, `readStamps`, `resolveCurrentVersionsForFamily`) and bm64 (`templateFamilyIdSchema`, `billTemplateFamilyRepository`).
- **Environment:** a fresh database per the bm64 runbook.

## Verification checklist

- [ ] No `kind: "draft"` remains in `RenderMode` or any caller (`grep -rn 'kind: "draft"'` returns nothing). Every `switch (mode.kind)` ends in a `never` check.
- [ ] `run` never calls `currentVersion` (code review and unit test). The only live resolutions are capture (bm65) and `preview-family`.
- [ ] The mid-run activation test passes: drafts keep the captured version, and the editor preview shows the new one.
- [ ] The NULL-stamp draft returns 422 `TEMPLATE_VERSION_NOT_FOUND`; the modal shows the §10d message; nothing falls back to the default.
- [ ] Posting, CSV and the stored-invoice routes behave exactly as before (guardrails 43–47 and 55 green).
- [ ] The preview action requires `familyId`; the authz matrix is unchanged; READ users can still preview.
- [ ] `npm run typecheck`, `npm run lint`, and the unit, integration and component suites are green.
- [ ] Docs:
  - architecture Inv #42's amendment note and Inv #51/#53 (draft and preview halves) marked "built (bm66)";
  - code-standards Next.js rules 3–4 and API rule 2 marked "built (bm66)";
  - the new 422 contract for the draft route recorded in code-standards API rules;
  - the `describeInvoiceRenderCode` map recorded in UI context §10d;
  - progress tracker updated.

## Open questions

None that need a decision. Two notes:
1. **A new contract for the draft route.** It now returns `422 { error: { code, message } }` for render failures. Code-standards Phase 3 API rules only said "same status codes". The 422 follows the general §5.6 envelope, and the code-standards API rule should be updated to say so.
2. **Message copy.** The copy for the pre-existing codes `INVOICE_RECONCILIATION_FAILED` and `INVOICE_USAGE_OVER_LIMIT` is proposed wording, like the §10d copy, and can be edited freely before build.
