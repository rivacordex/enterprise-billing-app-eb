# rm04 — Kestra deployment and local development environment — Spec

- **Unit:** rm04 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase B — the first rating-repo unit)
- **Repo:** rating repo · **Boundary:** `worker/**` + `infra/**` + `dev/**` + a rating-repo `azure-pipelines.yml`
- **Builds:** a dedicated Kestra OSS engine for rating on Azure Container Apps (process runner, custom worker image), its four storage locations, its four Key Vault credentials, the image-tag injection, and a local Docker-Compose stack running the identical image and topology.
- **Depends on:** rm03 (`rating_runtime`), **rm03a** (the `kestra` database and `kestra_engine` role this deploys against); the **shared** platform footprint the app repo's `infra/bicep/**` already provisions (ACR, Container Apps Environment, Key Vault, Flexible Server); Container Apps environment; Key Vault + Managed Identity; the app repo's `docker-compose.dev.yml` stack.
- **Sources:** `ratemgmt-architecture.md` §1 (stack additions), §4 (four credentials), §7 (deviations 1, 2, 8), Inv #18 · `ratemgmt-code-standards.md` §3 (workflow-definition standards), §8 (file organization) · `rm00-build-plan.md` Unit rm04 + Open items 4, 7 · `_newmodule-rating-engine-plan.md` §9 (the Kestra bet), §11 (storage).

> **Codebase-grounded (verified 2026-08-26).** The Bicep module style (`infra/bicep/modules/{container-app,container-app-job,key-vault,acr,postgres}.bicep`), the 5-stage Azure DevOps pipeline (`infra/azure-pipelines.yml`, blue-green, image→ACR), the digest-pinned `postgres:17-bookworm` custom image, the **single-database** `docker-compose.dev.yml`, the `BOOTSTRAP_DATABASE_URL` bootstrap-runner pattern (`db/bootstrap/*.ts` via `--env-file=.env`), the Container-Apps-injects-Key-Vault-refs-as-env-vars secret model (`lib/config.ts`, no Azure SDK in code), and the **absence** of any Azure Blob/Files SDK or existing Kestra deployment were all read directly from `enterprise-billing-app`. Rating is the platform's **first** real Kestra deployment and **first** file storage.

---

## Goal

Stand up a **dedicated, process-runner Kestra OSS engine for rating** on Azure Container Apps — running the custom worker image against the `kestra` database and `kestra_engine` role rm03a created — with its four storage locations, four Key Vault credentials, and image-tag injection wired, plus a **local Docker-Compose stack that runs the byte-identical worker image and topology**, so a trivial flow executes end to end in both places while `kestra_engine` is proven to hold no reach into the billing database.

---

## Design

### D0. Prerequisite — the process-runner spike (Open item 7), gating

**Do not build the rest of this unit until the spike passes.** On a real Container Apps environment, prove that a custom Kestra image running the **process runner** (ACA has no Docker daemon) can: execute a Python task, read and write a mounted **Azure Files** share, read and write an **Azure Blob** container through Kestra internal storage, and resolve its own image tag from an env var. Accepting the process-runner/custom-image constraint couples rating's release cycle to Kestra's **permanently** (`_newmodule-rating-engine-plan.md` §9.3). This spec describes the intended outcome; that is not the same as having validated it. The spike's result is recorded in `ratemgmt-progress-tracker.md` and closes Open item 7.

### D1. Dedicated engine, shared platform footprint

rm00 rm04 fixed a **dedicated** rating Kestra instance (not a namespace on the bill run's engine — sharing would run bill-run flows on the rating worker image and let anyone past rm05's proxy edit bill-run flows). Everything else is **shared**, referenced as existing resources exactly as `infra/bicep/modules/postgres.bicep` references the existing Flexible Server.

| Concern | Owned by rm04 (rating repo) | Shared (app repo owns, rm04 references) |
| --- | --- | --- |
| Compute | Container App `rating-engine`; its User-Assigned Managed Identity | Container Apps Environment; Log Analytics |
| Registry | the worker image | the ACR |
| Secrets | four secret **references** + MI access | the Key Vault |
| Database | connects to the `kestra` DB as `kestra_engine` | the Flexible Server (the `kestra` DB itself is rm03a) |
| Storage | the four locations + internal-storage container | — (new resources, but in the shared storage account if one exists, else a rating storage account) |

### D2. Process runner + custom worker image, pinned by digest

ACA provides no Docker daemon, so Kestra's Docker task runner is unavailable and tasks run on the **process runner**, inside the worker container. The rating runtime is therefore baked into a **custom image**, and a Kestra version bump rebuilds and revalidates it (coupling accepted, §9.3). **Pin the Kestra base by digest** — `kestra/kestra:<KESTRA_VERSION>@sha256:<digest>` — exactly as the postgres image pins `@sha256`. `udr_rated.rating_engine_version` is this image's tag (Inv #12); an unpinned base makes a historical charge irreproducible (`ratemgmt-code-standards.md` §3.10).

### D3. What the worker image contains — Kestra OSS + Python + the billing-data toolchain

The runtime the flows call. Every entry is pinned; the whole set is chosen for **handling billing data safely at 100k–5M records/month**.

| Component | Version pin | Why it is in the image (billing-data rationale) |
| --- | --- | --- |
| Kestra OSS | `<KESTRA_VERSION>@sha256:<digest>` | The engine. OSS edition (architecture §4). JRE ships in the base. |
| Python | 3.12 (stable) | The process-runner task language for PRP/RP/RL. |
| `psycopg[binary]` (psycopg 3) | pinned + hash | **Load-bearing.** `COPY` for the RL bulk insert (row-by-row INSERT will not survive Inv #10's volume); **server-side cursors** for chunked reads (never load 5M rows); and **one explicit transaction** around RL's guard + supersede + insert (Inv #8 — separate Kestra query tasks cannot share a transaction, so RL *is* a Python psycopg task). |
| `polars` + `pyarrow` | pinned + hash | Memory-bounded, streaming columnar processing of 50k-record chunks, and a **typed** Parquet/Arrow intermediate for passing chunk data between PRP→RP→RL as **file URIs** (rm00: tasks pass file references, never payloads). JSON between tasks would stringify `Decimal`/timestamps and lose type; Parquet preserves it. polars over pandas: lower memory, streaming, faster here. |
| `azure-storage-blob` + `azure-identity` | pinned + hash | The **cross-protocol archive** (landing SMB → archive Blob) and reject/log writes to Blob, authenticated by **Managed Identity** (`DefaultAzureCredential`). No Azure storage SDK exists in the app repo; rating is first. |
| Kestra Azure Blob storage plugin | with the base | Kestra internal storage → Blob (D4). |
| Kestra Postgres plugin | with the base | Simple lookups from flows; the **transactional** RL stays a psycopg Python task, not a chain of query tasks. |

**stdlib, but mandated as hard billing rules (stated so they read as design, not preference):**

- **`decimal.Decimal` for every money and rate value — never `float`.** This mirrors `services/accounts/money.ts` (integer sen) and the `numeric(18,6)` rate columns. A float silently zeroes a sub-cent rate (`$0.0035/MB → 0.00`). Set an explicit `decimal` context (precision, `ROUND_HALF_UP`/`ROUND_HALF_EVEN`/`ROUND_DOWN` mapped from `udr_rounding_mode`), and round **once, per record** (rm08; `_newmodule-rating-engine-plan.md` §4.5).
- **`datetime` + `timezone.utc`** for `udr_key` canonicalization and any period math, consistent with `rating.period_of()` (rm01 D3). The UTC decision must hold on the Python side too.
- **`hashlib`** for the receipt checksum that discards a byte-identical redelivery as `DUPLICATE_BATCH` (rm07).
- **`json`** (or `orjson` for throughput) to emit the JSON Lines log contract (rm06).

**Deliberately not in v1:** `pandas` (polars is the default), CDR/ASN.1/TAP parsers (the feed format is Open item 1 — add the parser in rm07 once the format is known), `pydantic` (the `udr_rate_detail` discriminated-union validation is TS-side in `validation/rating/`; Python parse-validation stays light until rm07). **Everything is pinned by version + hash** (`requirements.txt --require-hashes`), the same reproducibility contract as the base digest.

### D4. Storage — four locations plus a fifth internal-storage config

| Location | Type | Why | Retention (lifecycle policy, set here) |
| --- | --- | --- | --- |
| `landing/` | **Azure Files (SMB)** | Upstream delivers by SMB; not negotiable from rating's side. | until archived |
| `archive/` | **Azure Blob** | The evidentiary record; Azure Files performs poorly on many small files and its locking makes the archive move non-atomic (§11). | **7 years** |
| `error/` | **Azure Blob** | Reject files with reason codes. | **24 months** |
| `logs/` | **Azure Blob** | Component log files pending sweep (rm06). | **24 months** |
| Kestra internal storage | **Azure Blob** (a *fifth*, separate config item, not one of the four mounts) | Kestra persists task-passing files here; it must not point at the container filesystem (code-standards §3.4). | engine-managed |

**The archive is a cross-protocol copy, not a rename.** `landing/` is SMB and `archive/` is Blob, so Inv #9's archive-after-commit is copy-then-delete with a window where the file exists in both or neither. **rm09 owns making that window recoverable; rm04 owns only making the two locations exist and recording that they are different protocols** — `udr_batch.archive_file_path` holds a Blob URI while `source_file` holds an SMB path, and the two are **not comparable strings**. Lifecycle policies live here, or the retention stated in the overview is a sentence rather than a setting.

### D5. Four credentials, in Key Vault via Managed Identity

Container Apps injects Key Vault secret references as plain env vars (the app's established pattern; `lib/config.ts` makes no Azure SDK call). Values are provisioned manually once per environment and stored in Key Vault, exactly like `rating_runtime`'s password (`infra/docs/db-role-verification.md`).

| Credential | Direction | Store | Blast radius |
| --- | --- | --- | --- |
| Kestra Basic Auth | human/app → engine | Key Vault | instance-admin on the engine |
| `rating_runtime` password | engine → billing DB | Key Vault via MI | `SELECT`/`INSERT` on `rating.*`, `UPDATE (status)` on `udr_rated`, read-only on seven tables (rm03) |
| `kestra_engine` password | engine → its own DB | Key Vault via MI | `CONNECT`+`CREATE` on the `kestra` DB only; **no CONNECT on billing** (Inv #18, rm03a) |
| internal-storage credential | engine → Blob | **prefer a Managed Identity role assignment** (Storage Blob Data Contributor) over a KV secret | read/write on the internal-storage container only |

**Not this module's credential:** the app bearer token (`BILLRUN_APP_TOKEN`) is in the boundary doc's list but rating exposes no HTTP surface and no rating flow calls the app (code-standards §4). It belongs to `billmgmt`; do not provision it here.

### D6. Image-tag injection as `RATING_ENGINE_VERSION`

`udr_rated.rating_engine_version` is `NOT NULL` and rm08 has no other source. The Container App sets `RATING_ENGINE_VERSION` to the **deployed image digest/tag**; the local compose sets it too. A task resolves it from the environment. Because a rolling Container Apps revision can swap the image mid-batch across chunk tasks, this is stamped **per row**, not per batch (Inv #12).

### D7. Kestra configuration

`kestra.yml`: **datasource** = the `kestra` DB via `kestra_engine` (the OSS JDBC queue is Postgres rows, §9.1 — watch connection count, since the bill run's engine also lives on this Flexible Server, rm00 rm04 note); **storage** = Azure Blob; **Basic Auth** = the one shared credential; **namespace** = `rating`. Kestra runs its **own schema migrations on startup** — `kestra_engine` holds `CREATE` on the `kestra` DB (rm03a) and no CONNECT on billing (Inv #18), so those migrations cannot reach revenue tables.

### D8. Ingress is restricted until rm05 fronts it

rm05 adds Container Apps Easy Auth + an IP allow-list. rm04 must **not** expose the UI unprotected — rm00 rm05 sequences the proxy before flow work precisely so the insecure state is never the working default. **rm04 provisions the Container App with ingress disabled or internal-only; rm05 turns on external ingress behind Easy Auth.** Stating the boundary here keeps rm04 and rm05 from fighting over the ingress block.

### D9. Local dev stack — identical image, same topology, no Docker socket

Extends the app's `docker-compose.dev.yml`. The **same** postgres container provides the billing DB and the `kestra` DB (the local `kestra` database and role are **rm03a's** provisioning, not rm04's); the **same** worker image runs the **process runner**; **Azurite** stands in for Blob (code-standards §3 forbids internal storage on the container filesystem, with no local carve-out); `landing/`, `archive/`, `error/`, `logs/` are bind-mounted with committed sample fixtures and `.gitkeep`; `.env.example` carries dummy values only. **Never mount the Docker socket** — a local Docker runner lets a developer write flows that cannot run on ACA, and the environment then actively misleads.

### D10. Backup and retention (Open item 4)

The `kestra` DB holds **part of the rating audit trail** (flow revisions, §9.2), so its backup retention is **7 years**, matching rating, and a **restore test** proves a flow revision is recoverable. Honest limit (§9.2): Flexible Server PITR restores the whole server, so this is a retention setting plus a tested procedure, not isolation. Raised at deployment; closes Open item 4.

### D11. CI/CD — mirror the app's Azure DevOps

A rating-repo `azure-pipelines.yml` mirroring `infra/azure-pipelines.yml`: build the worker image → push to the **shared ACR** (tag `$(Build.BuildId)-$(gitSHA)`) → apply the engine Bicep → deploy the Container App revision. The **flow**-deployment pipeline (deploying `flows/**` to Kestra) is Open item 5 / rm06's problem; rm04 builds only the image and applies infra.

---

## Implementation

### 1. `worker/Dockerfile` — the custom image

```dockerfile
# Pin the Kestra base BY DIGEST (code-standards §3.10). Fill <KESTRA_VERSION>/<digest>
# with the chosen stable OSS release before first build.
FROM kestra/kestra:<KESTRA_VERSION>@sha256:<digest>

USER root
# Python 3.12 + build essentials for psycopg/pyarrow wheels, then the rating runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 python3-pip \
 && rm -rf /var/lib/apt/lists/*

COPY worker/requirements.txt /tmp/requirements.txt
RUN pip3 install --require-hashes --no-deps -r /tmp/requirements.txt

# Rating runtime code (parsers, RL loader, log emitter) is copied in a later unit;
# rm04 bakes only the interpreter + libraries so the image is stable across rm07–rm12.
USER kestra
```

### 2. `worker/requirements.txt` — pinned, hashed

```
psycopg[binary]==<ver>        --hash=sha256:...
polars==<ver>                 --hash=sha256:...
pyarrow==<ver>                --hash=sha256:...
azure-storage-blob==<ver>     --hash=sha256:...
azure-identity==<ver>         --hash=sha256:...
# orjson optional (JSON Lines throughput); stdlib json is acceptable.
```

### 3. `infra/kestra.bicep` — the engine Container App

Declares, in the app's `modules/container-app.bicep` style:
- a **User-Assigned Managed Identity** for the engine, granted `AcrPull` on the shared ACR and `Key Vault Secrets User` on the shared Key Vault;
- the **Container App** `rating-engine` on the **existing** Container Apps Environment (referenced, not created): the worker image by digest; **secret references** for the four D5 credentials; env vars including `RATING_ENGINE_VERSION` (D6), the `kestra` DB DSN (via the `kestra_engine` secret), and the Blob/Files settings; **ingress disabled or internal-only** (D8); an Azure Files **volume mount** for `landing/`; probes on Kestra's health endpoint;
- `activeRevisionsMode: 'Single'` for v1 (the engine is stateful against one DB; blue-green multi-revision is rm05+/later), min 1 replica — the JDBC queue makes multi-replica scaling a deliberate later decision, not a default.

### 4. `infra/storage.bicep` — locations + lifecycle + role assignments

- an **Azure Files** share for `landing/`;
- **Blob containers** `archive`, `error`, `logs`, and `kestra-internal`;
- **management-policy lifecycle rules**: `archive` 7 years, `error`/`logs` 24 months (D4);
- **role assignments**: the engine MI gets `Storage Blob Data Contributor` on the Blob containers and SMB access to the Files share (D5 internal-storage credential preference).

### 5. Key Vault secret references

The four D5 secrets are **referenced** by `infra/kestra.bicep`; their values are set manually per environment (superuser/provisioning step), documented alongside rm03/rm03a in `infra/docs/db-role-verification.md` (extended, not created). No secret value in Bicep parameters or `.env` templates.

### 6. `kestra/kestra.yml` — engine config

Datasource → `kestra` DB as `kestra_engine`; `kestra.storage.type: azure`; Basic Auth from the injected secret; default namespace `rating`; internal storage → the `kestra-internal` Blob container. Startup migrations enabled (Kestra default).

### 7. `dev/docker-compose.dev.yml` + Azurite + fixtures

- joins the app stack's docker network and uses the **same** postgres container (billing + `kestra` DBs);
- an **`azurite`** service for Blob; the worker image built from `worker/Dockerfile`, process runner;
- bind mounts `landing/ archive/ error/ logs/` with `.gitkeep` + committed sample usage fixtures;
- `.env.example` dummy values; **no Docker socket mount**;
- `RATING_ENGINE_VERSION` set to a local sentinel (e.g. `dev-local`).

### 8. `azure-pipelines.yml` — build/push/apply/deploy

Stages mirroring `infra/azure-pipelines.yml`: **build** (lint the Dockerfile/Bicep, validate `requirements.txt` hashes) → **containerize** (build + push worker image to shared ACR) → **infra** (`az deployment` of `infra/*.bicep`) → **deploy** (update the `rating-engine` revision to the new image digest). No flow deployment here (Open item 5 / rm06).

### 9. Backup/retention (D10)

Set the `kestra` DB's backup retention to 7 years in the Flexible Server config (or document the server-level policy that covers it), and add a **restore-test procedure** to `infra/docs/db-role-verification.md` that restores a flow revision and asserts it is byte-identical. Closes Open item 4.

---

## Dependencies (packages to install)

**Worker image (Python, pinned + hashed in `worker/requirements.txt`):** `psycopg[binary]`, `polars`, `pyarrow`, `azure-storage-blob`, `azure-identity`. **stdlib (no install):** `decimal`, `datetime`/`zoneinfo`, `hashlib`, `json`. **Optional:** `orjson`.

**Kestra plugins:** Azure Blob storage plugin, Postgres plugin (bundled with, or added to, the pinned base).

**App repo:** none — rm03a already added `db/bootstrap/kestra-db-roles.{sql,ts}`; rm04 is rating-repo infra. **Rating-repo tooling:** Docker, Bicep, and the `az` CLI in the pipeline; no npm packages.

---

## Verification checklist

Run against a real Container Apps environment except where marked *(local)*. Items 1–4 gate the rest.

**The spike (D0)**

1. A custom Kestra image on the **process runner** executes a Python task on ACA. *(spike, Open item 7)*
2. That task reads and writes the mounted **Azure Files** `landing/` share. *(spike)*
3. That task reads and writes an **Azure Blob** container through Kestra internal storage. *(spike)*
4. That task resolves `RATING_ENGINE_VERSION` from its environment. *(spike)*

**Engine up (D1, D2, D7)**

5. The `rating-engine` Container App starts, and Kestra **runs its own migrations against the `kestra` database** on startup.
6. A **trivial flow** executes end to end and reaches success.
7. The worker image base is **digest-pinned**; `docker inspect` shows the `@sha256` matches the intended Kestra release.
8. `python3 --version` is 3.12 and `pip freeze` inside the running container matches `requirements.txt` exactly (versions + no extras).

**Boundary (Inv #18, rm03/rm03a)**

9. The engine connects to the billing DB as `rating_runtime` and can `SELECT` `billing.billing_account`.
10. `kestra_engine` is **refused** a connection to the billing DB (`FATAL: permission denied for database`).
11. `rating_runtime` and `app_runtime` are **refused** a connection to the `kestra` DB.

**Storage (D4)**

12. All four locations exist; the engine reads and writes each — `landing/` over SMB, `archive/`/`error/`/`logs/` over Blob.
13. Kestra internal storage points at the `kestra-internal` **Blob** container, not the container filesystem.
14. Lifecycle policies are applied: `archive` 7 years, `error`/`logs` 24 months — asserted against the storage-account management policy.
15. `udr_batch.archive_file_path` accepts a Blob URI and `source_file` an SMB path; a test asserts they are not compared as equal strings.

**Credentials (D5)**

16. The four secrets resolve from Key Vault as env vars at container start; none appears in Bicep parameters, `.env` templates, or logs.
17. `BILLRUN_APP_TOKEN` is **not** provisioned for this engine.

**Image-tag injection (D6)**

18. A task reads `RATING_ENGINE_VERSION` and it equals the deployed image digest/tag.

**Billing-data toolchain (D3)**

19. A task computes `Decimal('0.0035') * Decimal('1000')` and gets `Decimal('3.5000')` — proving no `float` path; a `float` variant is asserted to be absent/forbidden in the runtime helpers.
20. A task canonicalizes a timestamp to UTC and its month matches `rating.period_of()` for the same instant.
21. `psycopg` performs a `COPY` into a scratch table and a server-side-cursor read back, in one transaction.

**Local parity (D9)**

22. *(local)* A developer runs the **identical** worker image and process runner via `dev/docker-compose.dev.yml` and reproduces items 5, 6, 12 against **Azurite** and the local `kestra` DB.
23. *(local)* The Docker socket is **not** mounted — asserted by inspecting the compose file and the running container.

**Backup (D10)**

24. The `kestra` DB backup retention is 7 years; the restore-test procedure restores a flow revision and asserts it is byte-identical. *(deploy-time)*

**Build hygiene**

25. The rating-repo `azure-pipelines.yml` builds and pushes the worker image to the **shared ACR** and applies the engine Bicep; a red Bicep or an unhashed `requirements.txt` fails the build.
26. No secret, connection string, or password is committed anywhere in the rating repo.
