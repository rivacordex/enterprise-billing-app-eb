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

**Live-Kestra smoke gate (bm16-spec review fold T3).** This unit's
"end-to-end against the deployed placeholder flow" verification item can only
be proven against a real, deployed Kestra instance — out of scope here and
CI-doubled (the M2M ingest path is unit/integration-tested via a signed test
caller instead, per bm16-spec §Dependencies "Test double"). A live-Kestra
smoke run — trigger a real bill run against this template's contract and
confirm it reaches `PROCESSED` — is registered as a **phase-2 exit
criterion**, not a CI gate, to be run at least once against the real engine.
It belongs in **bm21** (the phase-2 exit-criteria unit), not yet specced in
this repo as of bm16 — see `billmgmt-progress-tracker.md`.
