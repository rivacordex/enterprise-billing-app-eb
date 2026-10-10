# Billing Module — Design Review Backlog

Design-level findings raised in code review that are **deliberately not fixed in
code yet**. Each needs an owner decision or belongs to a later unit. Pick items
up when the named unit is scheduled; move them to `billmgmt-progress-tracker.md`
when work starts, and delete them here when done.

Source: `/code-review xhigh` of `7cfbe4d..HEAD`, 2026-10-09.

## DR-01 — Invalid ACTIVE profile stamps permanently (DECIDED: option A, build in bm61)

- **Finding.** `resolveVersionsForPosting` (`services/billing/invoice-template/resolve-template.ts`)
  stamps the ACTIVE `invoice.profile` version onto the bill without validating
  it, and the finalization guard (0033) makes the stamp immutable.
- **Failure.** If the ACTIVE profile version is invalid (blank required key,
  unknown logo asset, unreadable logo blob), every bill posted under it renders
  with `INVOICE_PROFILE_INVALID`. `retryRenderInvoice` resolves the same stamp
  and fails again, so the accounts stay render-pending and block distribution.
- **Why not fixed at posting.** bm54 D1: posting reads DB rows only and must
  never fail or slow because of a template (a bad template parks the *render*,
  Inv #40).
- **Decision (owner, 2026-10-09): option A** — make it impossible for an invalid
  version to become ACTIVE. Activation (bm61) must run the full validity gate
  (`readInvoiceProfile` + `inlineLogo`) and refuse with `INVOICE_PROFILE_INVALID`.
  Recorded in `specs/bm00-build-plan.md` Unit 61. Rejected: B (validate at
  posting — breaks the posting rule), C (restamp path — conflicts with Inv #41).
- **Open until:** bm61 ships (blocked on G14). Until then no profile is
  activatable from the app, so the gap is only reachable via hand-edited rows.
- **Add with bm61:** a guardrail/test that activating an invalid version is
  refused and leaves the previous ACTIVE version untouched.

## DR-02 — CSV template version resolved on every render and posting

- **Finding.** `resolveTemplate` and `currentVersions` always resolve the CSV
  template version, although no PDF render or preview reads it.
- **Cost.** 1–2 extra queries per render; in `postAccount` they run while the
  bill row lock is held (~5 extra round trips per account). A missing or corrupt
  CSV catalog row also fails an unrelated PDF render with
  `TEMPLATE_VERSION_NOT_FOUND`.
- **Why it cannot simply be removed.** bm53 D1 / Inv #41: posting stamps four
  versions, one of which is `ref_csv_template_version_id`, so posting must
  resolve the CSV version. Only the *render and preview* paths could skip it,
  which changes the `ResolvedTemplate` type that bm62 (CSV export) consumes.
- **Proposed direction.** Split resolution: an always-needed part (generated,
  layout, profile) and a CSV part called only by posting and bm62.
  Cross-check against bm53 D1 and bm62 before changing the type.
- **Owner:** design decision needed (bm53 contract). Pick up before bm62.

## DR-03 — Sample-bill preview bypasses `bind()` (bm55)

- **Finding.** `services/billing/invoice-template/preview.ts` hand-assembles an
  `InvoiceRenderInput` from an unvalidated `sample-data.json` and skips
  `bind()`, though the file header says the HTML comes from the real bind
  pipeline. Fields the binder adds or changes (`paymentTermsDays`, `template.*`,
  `company`, `payment`) must be copied by hand, and drift against the
  `InvoiceRenderInput` type only shows up at execute time as PREVIEW_FAILED.
- **Decision (owner, 2026-10-09):** leave for bm55 to decide when it is picked
  up. Minimum: validate `sample-data.json` against the render-input type.

## DR-04 — Unused version-stamp columns and exports (ACCEPTED)

- `refBillFormatId` / `refBillTemplateVersionId` on `lockBillForPosting`,
  `findForAccount`, `findPreviewTarget`; `listVersions`
  (invoice-profile repository); `loadCsvMap` / `csvColumnMapSchema` (`load.ts`).
- **Decision (owner, 2026-10-09):** keep — reserved for bm56 / bm62. Revisit if
  those units change shape.

## DR-05 — One-time flat fees are never billed and never reported (DECIDED: option a, OPEN)

Source: `/code-review xhigh` of `efaff82..HEAD` + uncommitted, 2026-10-10.

- **Finding.** The recurring resolver (`_bm29_resolved` in
  `bill_run_processing.yml`) reads only the recurring `flat_fee` lane, and no
  step bills a `oneTime` flat fee. pm46a retired `RECURRING_PRICE_UNSUPPORTED`,
  the one HARD failure that used to surface such a fee (when it was dated after
  the recurring one and superseded it in the shared lane).
- **Failure.** An offering with a 5,500 recurring fee and a 1,000 one-time
  Activation Fee (the demo seed's shape) bills 5,500, posts and completes; the
  1,000 is dropped with no stage finding, no exception and no Uncharged entry.
  Not billing one-time fees predates pm46a (an earlier-dated one-time fee was
  already dropped silently), but pm46a removed the only visible case.
- **Decision (owner, 2026-10-10): option a** — keep billing recurring and usage
  as now, and **report** each unbilled one-time fee without failing the
  account: a non-blocking finding on the account (stage finding / exception
  surface) naming the subscription, the price row and the amount, so an
  operator sees it before approval. Rejected for now: (b) building one-time
  billing (a separate unit, to be planned later); (c) accept and document only.
- **Owner / next step.** A billing unit (number TBD in `specs/bm00-build-plan.md`)
  with its own spec: where the finding is recorded (stage finding vs exception
  surface), whether it is per run or per account, and that it never blocks
  approval. Until then the gap stands; known-issues §22 points here.
