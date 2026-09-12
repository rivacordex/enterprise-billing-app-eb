# `workflow-management/` — the workflow-management surface

Spin-off subdirectory of the app repo (a monorepo today, structured so it can
later become its own repo) holding the **Kestra workflow-management platform** the
Rating and Billing modules both run on. Authority: `context/workflow-management/
wfm-architecture.md`; executable restructure spec: `context/workflow-management/
specs/wfm01-engine-restructure.md`.

```
workflow-management/
  flows/                 # function-first flow definitions (one dir per solution function)
    rating-engine/       # function 1 — rating (real flows, computation stubbed)
    bill-run-processor/  # function 2 — bill-run processing (template skeleton this phase)
    bill-run-distributor/# function 3 — bill-run distribution (template skeleton this phase)
  worker/
    workflow-engine/     # THE ONE shared process-runner image (Python toolchain + Postgres client)
  kestra/kestra.yml      # platform config (datasource, storage, default-namespace)
  dev/                   # local docker-compose stack, sample fixtures, .env.example
```

**One shared engine image.** ACA has no Docker daemon, so Kestra runs as a
**process runner** on one custom image (`worker/workflow-engine/`, `FROM` a
digest-pinned Kestra base) that serves all functions. Bill run carries no worker
of its own — it rides the shared image.

**Topology is a deploy parameter** (`collapsed` default | `split-by-module` |
`enterprise`). The app addresses the engine **by name** and never learns the
instance count (`services/billing/engine-registry.ts`). The Azure bicep stays at
the app-root `infra/` (the solution deploys as one app), named `workflow-engine`.

**Naming rule.** Flow directories are named for the **solution function**, never
the module abbreviation or the logical-engine name. Logical-engine names
(`rating`, `billrun`) live only in each flow's `namespace:` and the app registry.
