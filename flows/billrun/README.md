# `flows/billrun/` — template skeletons, NOT deployed

bm16-spec §Design "Deliberate deviation recorded (item-2 decision)". Unlike
`flows/rating/` (a reserved, untouched sibling — rating keeps ALL its flow
YAML in a separate repo, none in this one), this billing app repo carries
**template skeletons** for the bill-run processing pipeline: key sections plus
commented key activities, **no business logic**. They exist so the app-side
stage contract (inputs, per-account fan-out, the six stages, the terminal/
error/finally hooks) is documented and versioned alongside the M2M handler it
feeds (`services/billing/handle-stage-signal.ts`), and so a reviewer can see
the whole contract without leaving this repo.

**The real flow is built and deployed elsewhere.** `bill_run_processing.template.yml`
is never deployed to Kestra from this repo — the real `bill_run_processing`
flow (and its distribution-stage sibling, bm20) is authored, versioned, and
released from a **separate workflow-management repository**, built to the
contract this template documents. That repo, its owning team, and its deploy
pipeline are **not yet named in this codebase** (bm16-spec review fold T3) —
whoever stands up the real Kestra deployment must fill in this section before
the placeholder flow goes live:

- **Repo:** _TBD — the separate workflow-management repo url/name._
- **Owner:** _TBD — the team that authors/releases `bill_run_processing`._
- **Deploy step:** _TBD — how a new flow revision reaches the `billrun`
  Kestra namespace (`BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_NAMESPACE`,
  `lib/config.ts`)._

**Every real activity is a `# STUB:` marker naming what replaces it** — see
the template's `validation`/`collection`/`aggregation`/`taxation`/
`verification` tasks. The placeholder flow performs the **data flow** for
real (claims `RATED → BILL_DRAFT`, aggregates into a `customer_bill`, writes
one tax line, verifies) so a demo against the `_SAMPLE_*` seed (bm15)
produces real seeded-derived bills; only the **sophistication** (real
correlation, price/tax rules, plausibility checks) is stubbed.

**Live-Kestra smoke gate (bm16-spec review fold T3, closed by bm21).** This
unit's "end-to-end against the deployed placeholder flow" verification item
can only be proven against a real, deployed Kestra instance — out of scope
here and CI-doubled (the M2M ingest path is unit/integration-tested via a
signed test caller instead, per bm16-spec §Dependencies "Test double", and
`tests/db/billing-e2e-happy-path.integration.test.ts` doubles the whole flow
via its own `simulateProcessorAggregation`/`simulateProcessorTaxation`
helpers). A live-Kestra smoke run — trigger a real bill run against this
template's contract and confirm it reaches `PROCESSED` — is an explicit
**phase-2 exit criterion**, not a CI gate:

**Phase 2 is not fully ship-ready until ALL THREE of the following are
resolved**, in this order:

1. **Repo/Owner/Deploy step named** — the three `_TBD_` lines above are
   filled in with the real separate workflow-management repo, its owning
   team, and its deploy step (how a new flow revision reaches the `billrun`
   Kestra namespace). This file staying `_TBD_` IS the signal that phase 2
   is not yet ship-ready on this criterion — do not read a green CI
   pipeline as satisfying it.
2. **A real `billrun` engine is deployed**, reachable at
   `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_NAMESPACE` (`lib/config.ts`), running
   the real `bill_run_processing` flow built to this template's contract
   (and, once bm20's distribution stage matters here too, a real
   `bill_run_distribution` flow).
3. **The smoke run has actually executed at least once** —
   `npm run billrun:live-kestra-smoke` (`scripts/billrun-live-kestra-smoke.ts`,
   bm21) against that real engine and a real, `db:seed-sample`-seeded
   database, driving trigger → claim → `PROCESSED`. Wired as the
   `billrun_live_kestra_smoke` stage in `infra/azure-pipelines.yml`
   (`runBillrunLiveKestraSmoke` parameter, off by default — queue manually,
   or via a scheduled trigger with the parameter set to true, once step 2 is
   met). The script itself refuses to run against the STUB engine client
   (fails loud, never a silent pass) so a misconfigured run can never be
   mistaken for this criterion being met.
