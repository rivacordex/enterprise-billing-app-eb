# Rating Management — Build Plan (Units, in build order)

Decomposition of the Rating Management module into build units. Source of truth: `ratemgmt-project-overview.md`, `ratemgmt-architecture.md` (18 numbered Invariants, plus 16a and 17a), `ratemgmt-code-standards.md` (grant table §9, guardrail tests §10), `ratemgmt-ai-workflow-rules.md` (unit discipline). Stack per `context/architecture.md` §1 and `ratemgmt-architecture.md` §1.

**Decomposition rules applied:** each unit produces **one visible result**; each stays within **one system boundary** (app repo *or* rating repo — never both, per `ratemgmt-ai-workflow-rules.md` §2.2); **dependencies land just-in-time** (each unit adds only the config keys and infrastructure it needs); units **always done together are merged** (worker image into the engine deployment; the log sweep into the flow template; shrinking-reissue detection into supersession); units with **no standalone visible result are merged or dropped** (app-side read repositories have no consumer in v1 — see *Notes*).

**Legend per unit:** *Repo* = which repository the change lands in · *Boundary* = the layer/owner the unit lives in · *Builds* = what ships · *Visible result* = what you can demonstrate · *Depends on* = what must already exist.

**External prerequisites (not units of this module):** Azure Flexible Server **16** with `pg_partman` + `pg_cron` and the existing daily maintenance job; the `app_runtime` / `app_migrate` roles and the Drizzle migration history; `product`, `ordering`, `inventory` and `billing` schemas populated enough to resolve a price; an Entra tenant and Key Vault with Managed Identity; a Container Apps environment.

---

## Phase A — Schema & access (app repository)

### Unit rm01 — `rating` schema foundation
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/schema/rating/**` + migrations
- **Builds:** the `rating` schema and all four tables — `udr_rated`, `udr_batch`, `process_log`, `event_catalog` — as one migration, with every constraint that carries an Invariant:
  - `UNIQUE (partition_period, start_datetime, udr_key, is_live)` with `is_live` **`GENERATED ALWAYS`** from `status` (Inv #3)
  - `CHECK (char_length(udr_key) <= 512)`
  - `CHECK (partition_period = rating.period_of(start_datetime))` — the `IMMUTABLE` helper pins the literal to **`UTC`** (Inv #15; rm01 D3), never a business-timezone literal
  - `UNIQUE (file_key, batch_run_num)` on `udr_batch` — the file claim (Inv #7), scoped to the **logical** delivery identity, not the physical filename
  - status / severity / rate-type / rounding-mode CHECK constraints matching the typed unions
  - money columns at `numeric(18,2)` (amounts) and `numeric(18,6)` (rates), both `_raw` and rounded
  - `udr_id` / `log_id` defaulting to `core.generate_ulid()`; `udr_batch.batch_id` on the `UDRBAT` + 8-digit sequence
  - **no foreign key to any other schema, in either direction** (Inv #17)
  - `pg_partman` registration for `udr_rated` and `process_log` — monthly on the `date` control column, premake 4, **DETACH not drop**, on the **existing** daily cron job. **Retention differs per table: `udr_rated` 7 years, `process_log` 24 months** (rm01 D7 — `process_log` is operational telemetry aligned to the 24-month retention of the log *files* it is loaded from)
- **Visible result:** the constraint suite passes against a live database — a second live row for one natural key is rejected; four consecutive supersede-then-insert cycles leave exactly one live row and four superseded rows; a 513-character `udr_key` is rejected by the CHECK rather than by a btree error; a `partition_period` that disagrees with `start_datetime` is rejected, and behaves identically under three session timezones; `pg_partman` creates next month's partitions on the existing schedule.
- **Depends on:** platform Postgres with `pg_partman`/`pg_cron` and the existing maintenance job; `core.generate_ulid()`.
- **Parity note — and a platform-wide finding.** The local dev image is pinned to `postgres:17-bookworm`; **Azure Flexible Server is 16**. That divergence is not rating-specific and predates this module, but it means "it worked locally" does not prove it works in Azure for any partitioned table. **Pin the local image to `postgres:16-bookworm`.** The `pg_partman` signature risk is smaller than it first appears: PGDG ships **pg_partman 5.0.1 for PG 16** as well as 17 (verified), so dropping the local image to 16 does *not* change the partman major, and `rating-partman-setup.sql` uses the same named-parameter `create_parent()` signature as `db/bootstrap/audit-partman-setup.sql` either way. The signature break is **v4 → v5**, not 16 → 17. **What still needs checking once:** the partman version on the actual Azure server — `SELECT extversion FROM pg_extension WHERE extname='pg_partman';` — because Azure builds its own extension packages rather than using PGDG. **Do not rely on this note to remember it:** add a **preflight assertion** to the top of `rating-partman-setup.sql` (and retrofit the existing two) that raises if the installed partman major is below 5, so a mismatch fails loudly at deploy rather than quietly at first partition creation. Tracked in `_risk-database-extension-version-drift.md`.

### Unit rm02 — `event_catalog` seed
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/seeds/`
- **Builds:** the seeded rows mapping every `event_code` to its default severity, X.733 `event_type`, `probable_cause`, description, and `is_auto_clearing` / `clear_event_code`. **`default_severity` is nullable** — NULL means the code is logged and never alarms (rm02 §A, which amends rm01). The sixteen codes: `FILE_NOT_RECEIVED`, `FILE_LATE`, `FILE_KEY_UNRESOLVED`, `PARSE_FAILURE`, `LOOKUP_MISS`, `DUPLICATE_BATCH`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `LOAD_BLOCKED_BILLED`, `CROSS_PERIOD_SUPERSEDE`, `CURRENCY_MISMATCH`, `DB_WRITE_FAILURE`, `TASK_RETRY_OK`, `BATCH_PARTIAL`, `BATCH_COMPLETE`, `CLEARED`.
- **Visible result:** every event code the module can emit resolves from data rather than from code; a catalogued non-alarming code resolves to `perceived_severity` NULL; a deliberately **unknown** code resolves to `INDETERMINATE` — the three outcomes stay distinguishable (rm02 §A1: the resolver keys off **row presence**, never severity nullity; `COALESCE(default_severity,'INDETERMINATE')` is the specific wrong implementation). Changing a severity is demonstrably a migration, not a release.
- **Depends on:** rm01.
- **Kept separate from rm01** because it has its own verifiable result and its own change cadence — severities are re-tuned by migration long after the DDL is settled.

### Unit rm03 — `rating_runtime` role, grants and the boundary
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/bootstrap/rating-db-roles.sql`
- **Builds:** the `rating_runtime` login role with a connection limit; enumerated per-table grants following the pgledger exclusion precedent — `SELECT`/`INSERT` on `udr_rated`, `udr_batch` and `process_log`, `SELECT` only on `event_catalog`, with **`UPDATE` on `udr_rated` restricted to `status` alone** and **no `DELETE`** (Inv #2); `SELECT` only on `product.product_offering`, `product.product_offering_price`, `ordering.order_item_price_override`, `ordering.product_order_item`, `inventory.product_inventory`, `billing.billing_account`, `billing.bill_cycle`; an explicit **`REVOKE`** of every write on `billing.*` (Inv #1); the **column-scoped `GRANT UPDATE`** to `app_runtime` on exactly six `udr_rated` columns; `USAGE` on `rating.udr_batch_seq` and `EXECUTE` on `rating.period_of()` / `core.generate_ulid()` — without which **every** insert fails; **`REVOKE CONNECT ON DATABASE … FROM PUBLIC`** (without it Inv #18 is unenforceable — `PUBLIC` holds `CONNECT` by default); **`REVOKE EXECUTE … FROM PUBLIC` on the four `billing` `SECURITY DEFINER` pgledger functions** (without it `rating_runtime` can post ledger transfers regardless of its table grants — Inv #1); `ALTER DEFAULT PRIVILEGES **FOR ROLE app_migrate**` granting **`SELECT` only** on future `rating` tables, because `ALTER DEFAULT PRIVILEGES` cannot be column-scoped.
- **Visible result:** `rating_runtime` attempting any write to a `billing` table raises a permission error, **and so does calling `billing.pgledger_create_transfer(...)`**; it holds no `DELETE` on `udr_rated`; a role with no explicit `CONNECT` is refused the database; `app_runtime` can update each of the six permitted columns and is refused on every other one, asserted **per column** over an enumeration of `pg_attribute` so a widened grant *or a newly added column* fails the build.
- **Depends on:** rm01.

### Unit rm03a — Kestra database, engine role and its boundary
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/bootstrap/kestra-db-roles.sql` + `.ts`
- **Builds:** the **second logical database** (`kestra`) on the same Flexible Server; the `kestra_engine` login role with a connection limit, `CONNECT` and `CREATE` on that database **and no `CONNECT` on the billing database** (Inv #18); `REVOKE CONNECT ON DATABASE kestra FROM PUBLIC` followed by an explicit grant to `kestra_engine` alone — **the reverse of rm03's revoke**, so `rating_runtime` and `app_runtime` cannot reach the engine's database either; and the same local-dev provisioning in the app repo's `docker-compose.dev.yml` so the two-databases-one-server topology exists on a developer's machine exactly as it does in production.
- **Visible result:** `kestra_engine` connects to the `kestra` database and creates a table there; the same role is refused a connection to the billing database; `rating_runtime` and `app_runtime` are refused a connection to the `kestra` database; all three refusals are `FATAL: permission denied for database`, asserted per role.
- **Depends on:** rm03 (which establishes the bootstrap-script pattern and revokes `PUBLIC CONNECT` on the billing database).
- **Why this is an app-repo unit and not part of rm04.** Creating a role needs `CREATEROLE`, and the only mechanism in this codebase that holds it is `db/bootstrap/` in the app repo (rm03 D11). The rating repo has no SQL runner, no `BOOTSTRAP_DATABASE_URL` consumer and no migration sequence. Earlier drafts listed this as an "external prerequisite", which removed it from the build order and left it with no spec, no owner and no verification while remaining a hard blocker for rm04 — and `ratemgmt-ai-workflow-rules.md` §2.2 requires anything touching both repositories to be **two units, app repo first**. This is that first unit.
- **Ordering is load-bearing.** `kestra_engine` must be created **after** rm03 runs. Created before, it inherits `CONNECT` on the billing database via `PUBLIC` and Inv #18 is silently false from the moment the role exists.
- **Also lands here:** the manual `ALTER ROLE … PASSWORD` step for **both** `rating_runtime` and `kestra_engine`, documented in `infra/docs/db-role-verification.md`. Neither password is committed; both go to Key Vault, consumed in rm04.

---

## Phase B — Engine platform (rating repository)

### Unit rm04 — Kestra deployment and local development environment
- **Repo:** rating repo · **Boundary:** `infra/**` + `worker/**` + `dev/**`
- **Builds:** a **dedicated Kestra instance for rating** — *not* a namespace on the bill run's engine (**decided**; see the note below) — deployed to Container Apps against the `kestra` database rm03a created; the **custom Kestra worker image** with a pinned base **digest** and the rating runtime baked in (ACA has no Docker daemon, so tasks run on the process runner); the **four mounted storage locations**, each with its storage type named: `landing/` **Azure Files** (upstream delivers by SMB), `archive/` **Azure Blob**, `error/` **Azure Blob**, `logs/` **Azure Blob**; **Kestra internal storage pointed at Blob** — a *fifth, separate* configuration item, not one of the four mounts; Key Vault wiring via Managed Identity for the **four** credentials (Kestra Basic Auth, the `rating_runtime` password, the `kestra_engine` password, the storage credential or Managed Identity role assignment backing internal storage); and the **injection of the worker image tag into the flow environment** as `RATING_ENGINE_VERSION`, because `udr_rated.rating_engine_version` is `NOT NULL` and rm08 has no other source for it.
Also builds the **local development stack**, extending the pattern already in `enterprise-billing-app` (`docker-compose.dev.yml` + the custom `infra/docker/postgres` image with `pg_partman`/`pg_cron` baked in):
  - a `docker-compose.dev.yml` in the rating repo that joins the app stack's network and uses **the same Postgres container** — providing the billing database and the `kestra` database on one server, exactly as production does
  - **the same custom worker image** used in production, pinned to the same Kestra base digest
  - **Azurite** standing in for Blob, so Kestra internal storage points at object storage locally too — `ratemgmt-code-standards.md` §3 says internal storage never points at the container filesystem, and that rule has no local carve-out
  - bind-mounted `landing/`, `archive/`, `error/`, `logs/` with committed sample usage fixtures and `.gitkeep`
  - `.env.example` with dummy values only; real values never committed (the app repo's `.gitignore` already excludes `.env*` and personal compose overrides)
- **The one rule that makes the local stack worth having: do NOT mount the Docker socket.** Production runs on Azure Container Apps, which provides **no Docker daemon**, so Kestra's Docker task runner is unavailable there. A local stack with the socket mounted lets a developer write flows on the Docker runner that cannot possibly work in production. Run the **process runner** against the same custom worker image locally, or the environment actively misleads.
- **Visible result:** the engine starts, runs its own migrations against its own database, executes a trivial flow end to end, reads and writes all four mounted locations, resolves `RATING_ENGINE_VERSION` to the running image digest inside a task, and connects to the billing database as `rating_runtime` — while `kestra_engine` is refused a connection to the billing database. **A developer can run the identical worker image and task runner on their machine** and get the same result.
- **Run the process-runner spike before building.** `_newmodule-rating-engine-plan.md` §9.3 lists the custom-image / process-runner constraint as needing validation, and accepting it couples rating's release cycle to Kestra's permanently. Do not treat it as settled because this plan describes its outcome. *(Open item 7.)*
- **Archive is a cross-protocol copy, not a rename.** `landing/` is SMB and `archive/` is Blob, so Inv #9's archive-after-commit is copy-then-delete with a window where the file exists in both or neither. rm09 owns making that window recoverable; rm04 owns making the two locations exist and recording that they are different protocols. `udr_batch.archive_file_path` therefore holds a Blob URI while `source_file` holds an SMB path — they are not comparable strings.
- **Lifecycle policies belong here:** `archive/` 7 years, `error/` and `logs/` 24 months. Without them the retention stated in the overview is a sentence rather than a setting.
- **Depends on:** rm03 (the role it connects as), **rm03a** (the database and engine role it runs on); Container Apps environment; Key Vault + Managed Identity; the app repo's `docker-compose.dev.yml` stack.
- **Worker image, storage mounts and the local stack are merged here** — none has a standalone visible result, all are prerequisites for the engine running at all, and the worker image is built once and run in both places. **The database and its role are not**: they are rm03a, in the other repository.
- **Decided: a separate rating instance, not a shared one.** The bill run module also deploys Kestra. Sharing would have meant one engine, one database and one set of credentials — but it would also mean the rating worker image runs bill-run flows, so every image rebuild revalidates both modules' flows, and rm05's single proxy would give anyone who reaches it the ability to edit bill-run flows too. Rating logic lives in flow definitions, so that is the ability to change how money is calculated in two modules from one login. The cost accepted is two JDBC-queue Kestra instances against one Flexible Server; watch connection count at deployment.
- **Not this module's credential:** the app bearer token (`BILLRUN_APP_TOKEN`) appears in the boundary document's credential list, but rating exposes no HTTP surface and no rating flow calls the app (`ratemgmt-code-standards.md` §4). It belongs to `billmgmt`. Do not provision it here.

### Unit rm05 — Entra reverse proxy
- **Repo:** rating repo · **Boundary:** `infra/**` (identity + network)
- **Builds:** the Kestra UI behind **Container Apps built-in auth (Easy Auth)** with Entra — **decided**; Front Door was the alternative and is not used, so there is no WAF and no separate origin configuration. Easy Auth requires **external ingress**, so "restricted to the corporate network" is implemented as an **IP allow-list on the Container App's ingress**, not a private endpoint. Access logging at the proxy, **shipped to Log Analytics and retained 7 years** — these logs are the module's substitute for `core.AUDIT_LOG` and are the only record of who triggered a reprocess, so a 30-day default silently voids the deviation recorded in `ratemgmt-architecture.md` §7; the documented, signed-off accepted risk that anyone past the proxy holds full instance rights inside Kestra — which, because rating logic lives in the flow definitions, means the ability to change how money is calculated with no per-user record inside the engine.
- **Visible result:** a Billing Ops user signs in with their Entra identity and reaches the Kestra UI; an unauthenticated request is refused at the proxy; a request from outside the allow-listed ranges is refused; the access is recorded in the proxy log and is still queryable after the retention setting is applied.
- **The Entra app-registration client secret is a Key Vault entry**, not a `.env` value. Platform Inv #13 puts the app's Entra secret in `.env` rotated by redeploy; that is the Next.js app, which has a `.env`. rm05 is `infra/**` and has none, and `dev/**` must never hold real credentials. This is a scoped departure from the platform pattern, recorded in `ratemgmt-architecture.md` §7.
- **The proxy covers the UI only.** Kestra OSS serves its UI and REST API on one origin. Rating's engine receives no app-initiated calls, so no API exclusion path is needed — but if that ever changes, an Easy Auth policy in front of `/api/**` will break the caller, and the exclusion must be an explicit, reviewed change rather than a quiet one.
- **Depends on:** rm04.
- **Sequenced here, before any flow work,** so an unprotected engine UI is never the working default.

---

## Phase C — Pipeline spine (rating repository)

### Unit rm06 — Flow template, logging contract and log sweep
- **Repo:** rating repo · **Boundary:** `flows/**`
- **Builds:** the rating flow template with three named, ordered, **stubbed** sections — `prp`, `rp`, `rl` — each carrying an explicit `# STUB:` marker naming its owning spec section; a **manual trigger only** (the `landing/` file trigger is rm07's, and building it here then rewriting it there is duplicated work); the flow-level `concurrency: limit: 1` per `udr_type`; task-to-task handoff by **file URI, never record payload**; error **and** finally handlers that write a terminal-outcome **log line** (there is no app endpoint to POST to — rating exposes no HTTP surface, and a crashed flow cannot insert its own crash); the **`log-sweep` flow** — scheduled, independent of the rating flows — parsing `logs/` into `rating.process_log`; and the log-line contract below.
- **The log line is JSON Lines** — one JSON object per line, UTF-8, newline-delimited (**decided**). Not pipe-delimited: `specific_problem` carries raw error text, which is exactly where pipes, quotes and newlines appear, and `additional_info` is `jsonb`, so a delimited format would embed JSON inside itself anyway. **Fields, matching `rating.process_log` one-for-one:** `log_datetime`, `component`, `log_level`, `perceived_severity` (nullable), `event_code`, `specific_problem`, `managed_object`, `alarm_key`, `source_file`, `batch_id`, `workflow_execution_id`, `additional_info`. `specific_problem` and `managed_object` are **in the contract** — rm09 needs `managed_object` for `LOAD_BLOCKED_BILLED` and rm01 defines `specific_problem` as the actual error message; omitting them here forces a format change to a contract later units already depend on.
- **`partition_period` is not a log-line field.** It is `NOT NULL` on `process_log` with no default, so the **sweep** computes it as `rating.period_of(log_datetime)` at insert. rm03 grants the `EXECUTE` this needs. An INSERT that omits it fails on the first row.
- **`log_level` is the emitter's, `perceived_severity` is the catalog's.** The catalog carries no `log_level`, so the emitting task states it (`DEBUG`/`INFO`/`WARN`/`ERROR`) and the sweep passes it through unchanged. Severity is resolved by lookup and never stated by the emitter (Inv #14). The two are orthogonal and are never derived from each other.
- **Severity resolution has three outcomes, not two** — see `rm02` §A1 and follow it literally. Row found with a severity → that value; row found with `default_severity` NULL → **NULL**, a catalogued non-alarming event; **no row → `INDETERMINATE`**. The resolver must `LEFT JOIN` and test `event_catalog.event_code IS NULL`. `COALESCE(default_severity,'INDETERMINATE')` is the wrong implementation and permanently zeroes success criterion 10.
- **The sweep must be idempotent.** A retry, a restart, or a second scheduled run must not re-insert lines already loaded — `process_log` has no content-unique constraint, and `log_id` is a fresh ULID every time. Ship a mechanism (a swept-file marker, a rename-on-completion, or a per-file offset) and a test that sweeps the same file twice and asserts the row count is unchanged. Also decide and state: file naming and rotation, what happens to a file still open for writing (a torn last line), whether a malformed line is dropped, quarantined or fails the sweep, and where the sweep logs **its own** failures — it can no more sweep its own crash than a rating flow can.
- **Visible result:** a file moves through all three stub sections; every component writes JSON Lines log entries; the sweep loads them into `process_log` with severity resolved from the catalog — an alarming code, a non-alarming code and an uncatalogued code in the same run land as a severity, a NULL and an `INDETERMINATE` respectively; **a deliberately crashed flow still has its logs swept in**; sweeping the same file twice leaves the row count unchanged; and the `log_datetime`-to-`insert_datetime` lag is visible as a health metric.
- **Depends on:** rm01, rm02 (`process_log`, `event_catalog`), rm04 (the engine and its mounts).
- **The sweep is merged with the template** because the two are halves of one contract — the template defines the log-line format, the sweep consumes it, and testing either alone proves little.

---

## Phase D — The three components (rating repository)

### Unit rm07 — PRP: claim, validate, reject
- **Repo:** rating repo · **Boundary:** `flows/**` — the `prp` section
- **Builds:** file pickup from `landing/`; **database-backed claiming** — **derive the `file_key`** from the **filename**, using the extraction rule predefined for the `udr_type`, refusing the file with `FILE_KEY_UNRESOLVED` at `MAJOR` if it does not resolve — never falling back to treating it as new; insert the `udr_batch` row with `status = RECEIVED` as PRP's first action, before anything can fail, assigning `batch_run_num = COALESCE(max,0)+1` within that `file_key`, so the `UNIQUE (file_key, batch_run_num)` constraint decides ownership (Inv #7); file checksum at receipt, compared within the same `file_key`, with a byte-identical redelivery discarded as `DUPLICATE_BATCH` before any parsing cost; parsing and mapping to the `udr_rated` key fields; **canonical `udr_key` serialisation** — sorted keys, UTC, fixed numeric formats; standard validation (malformed, unknown subscriber, out-of-range, already-present duplicates); **reject files** written to `error/` with reason codes; the per-`udr_type` **error threshold** config key (`threshold = 0` yields file-level all-or-nothing); `parsed_count`, `rejected_count` and `discarded_count` stamped on the batch.
- **Visible result:** a 50,000-record file with 37 bad records claims itself in the database, writes a reject file naming the 37 with reason codes, carries the remaining 49,963 forward, and reaches `status = PARTIAL` — while a second concurrent attempt on the same file fails on the claim constraint, and a byte-identical redelivery is discarded before parsing.
- **Depends on:** rm01 (`udr_batch`), rm06 (template + logging), rm04 (`landing/`, `error/`).
- **Config introduced here:** reject threshold per `udr_type`, chunk size per `udr_type`.

### Unit rm08 — RP: price resolution and snapshot
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rp` section
- **Builds:** **event-time price resolution** — the price effective at `start_datetime`, resolved through the **pinned `product_offering` version**, not the current offering, with any `order_item_price_override` applied; **snapshot-on-first-rate** of every resolved input onto the row (`udr_usage_rate`, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`); calculation for `udr_rate_type = FLAT` with the full enum defined but unimplemented; `udr_rate_detail` JSONB typed via `.$type<T>()` from a Zod discriminated union keyed on `udr_rate_type`; both `udr_rated_price_raw` (full precision) and `udr_rated_price` (rounded), with `udr_rounding_mode` recorded per record; `udr_currency` taken from the resolved price row; `rated_datetime`, `rating_engine_version` and `rating_flow_revision` stamped.
- **Visible result:** a record rated today, then re-rated after the underlying price row **and** its override have both changed, reproduces the original amount from its snapshotted inputs — the property that makes a dispute answerable years later.
- **Depends on:** rm03 (`SELECT` on product/ordering/inventory), rm07 (validated records to rate).
- **Config introduced here:** rounding mode per product.
- **Open item to resolve before starting:** whether as-of resolution is a SQL predicate or a per-batch in-memory snapshot. Do **not** copy the existing pull-all-and-filter-in-JS repository pattern — it does not scale to 50,000 records (`ratemgmt-ai-workflow-rules.md` §5.3).

### Unit rm09 — RL: guarded transactional load
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rl` section
- **Builds:** the **pre-load guard** refusing the **whole batch** when any incoming natural key collides with a live `BILL_APPROVED` row, emitting `LOAD_BLOCKED_BILLED` at `MAJOR` with the colliding keys and their `billrun_ref_id`, and setting `udr_batch.status = REFUSED` (Inv #6); the **`CURRENCY_MISMATCH`** assertion that the resolved price currency equals `billing_account.currency`; the insert of rated rows at `status = RATED` — guard, supersede-hook and insert in **one transaction** (Inv #8); `rated_count` stamped and the **arithmetic reconciliation** `parsed = rated + rejected + discarded` asserted, with an imbalance raised as `RECON_IMBALANCE` at `CRITICAL`; **archive-after-commit ordering** — the raw file moves to `archive/` only once the transaction commits (Inv #9); `BATCH_COMPLETE` / `BATCH_PARTIAL` emitted with counts and a reject-file pointer.
- **Visible result:** a clean file loads end to end and reaches `COMPLETE` with counts that reconcile and the raw file in `archive/`; a batch colliding with an approved invoice writes **zero** rows and raises `LOAD_BLOCKED_BILLED`; a simulated failure mid-transaction leaves the file in `landing/`, zero rows loaded, and nothing archived.
- **Depends on:** rm01 (constraints), rm07, rm08.

---

## Phase E — Reprocessing & recovery (rating repository)

### Unit rm10 — Supersession and reprocessing
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rl` section, extended
- **Builds:** **batch-level supersession by `file_key`** — mark every live row from that logical delivery at `batch_run_num < N` as `SUPERSEDED` — **`status` is the only column the update touches**; the lineage is batch-level, recorded once on `udr_batch` as `superseded_by_batch_id` and `supersede_reason` (rm01 D11). There is no `superseded_by_udr_id` column on `udr_rated` and there cannot be one: supersession marks predecessors *before* the successors are inserted, so at supersede time the successor does not exist. Then insert the run-N rows, all inside the existing RL transaction; the supersede query scoped **across all partitions**, not the current period (Inv #5), emitting `CROSS_PERIOD_SUPERSEDE` at `WARNING` when it crosses a boundary; **shrinking-reissue detection** comparing run-N against run-(N−1) counts on `udr_batch`, raising `SHRINKING_REISSUE` at `MAJOR`; `superseded_count` stamped on the batch.
- **Visible result:** a reissued file supersedes exactly the prior run's live rows and leaves one live row per natural key, including rows whose corrected timestamp moved them into a **different partition**; a reissued file **smaller** than its predecessor raises `MAJOR` rather than silently losing the missing records; and — the proof that matters — a test that deliberately **omits** the supersede step aborts on the unique constraint rather than double-loading.
- **Depends on:** rm09.
- **Shrinking-reissue detection is merged here** because it cannot be demonstrated without supersession and is always built alongside it.

### Unit rm11 — Stranded-batch recovery
- **Repo:** rating repo · **Boundary:** `flows/**` — `rating-batch-reconcile`
- **Builds:** a startup/scheduled flow finding `udr_batch` rows stuck at `PROCESSING` beyond a threshold and resolving them explicitly — releasing the claim so the file can be reprocessed — with the outcome logged and alarmed.
- **Visible result:** a worker killed mid-load leaves the source file in `landing/`, no rows in `udr_rated`, and a stranded batch row; reconciliation resolves it and the file reprocesses cleanly. **Without this unit, a killed worker leaves a file permanently claimed and never reprocessed** — the claim constraint that protects correctness becomes the thing that blocks recovery.
- **Depends on:** rm07 (the claim), rm09 (the transaction it recovers from).

---

## Phase F — Completeness & sign-off

### Unit rm12 — Completeness and gap detection
- **Repo:** rating repo · **Boundary:** `flows/**` — `rating-completeness-check`
- **Builds:** the **expected-cadence** configuration per `udr_type`; a scheduled check comparing `rating.udr_batch` against that expectation, raising a **clearable `FILE_NOT_RECEIVED`** at `MAJOR` with an `alarm_key`, and `FILE_LATE` at `WARNING` for an out-of-window arrival; **alarm clearing** — a later successful batch emits a `process_log` row with `event_code = 'CLEARED'` against the same `alarm_key`, **but only for codes whose catalog row has `is_auto_clearing = true`** (rm02 D5). `LOAD_BLOCKED_BILLED`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `FILE_KEY_UNRESOLVED`, `CURRENCY_MISMATCH`, `DUPLICATE_BATCH` and `CROSS_PERIOD_SUPERSEDE` are **never** auto-cleared — a later clean batch does not make the earlier problem untrue, and clearing them erases the evidence; **superseded-never-replaced detection** — natural keys whose rows are all non-live, surfaced as usage that was retired and never re-rated.
- **Visible result:** a file that simply never arrives raises a `MAJOR` where previously there was only silence — and the late file, when it lands, clears that alarm instead of leaving a permanent open condition. Usage superseded and never replaced is queryable rather than invisible.
- **Depends on:** rm01 (`udr_batch`), rm02 (catalog + clearing metadata), rm10 (supersession, so there is something to detect).
- **Config introduced here:** expected cadence and window per `udr_type`.
- **Superseded-never-replaced is merged here** — it is the same class of check (find the gap the pipeline cannot see) and ships in the same session.

### Unit rm13 — Ship gate
- **Repo:** both · **Boundary:** tests / CI
- **Builds:** the assembly and CI wiring that runs the full guardrail suite from `ratemgmt-code-standards.md` §10 (**16 tests, each shipped by its owning unit** — rm13 adds only the no-per-record-fan-out guard, test #15, whose assertion mechanism is settled here), all against a live database, not mocks; one end-to-end journey — file lands → PRP partial → RP rates → RL loads → archive → upstream reissues → supersession → completeness check clean; the CI assertion that no rating migration touches `billing`; SAST and the OWASP ZAP DAST baseline green with no high/critical finding.
- **Visible result:** the complete operator journey passes end to end, every Invariant has a test that fails when the Invariant is deliberately violated, and the ship gate is green.
- **Depends on:** rm01–rm12.

---

## Build-order summary

| Unit | Name | Repo | Boundary | Key just-in-time dependency introduced |
|---|---|---|---|---|
| rm01 | `rating` schema foundation | app | `db/schema/rating/**` | Four tables; the live-row constraint; partman registration |
| rm02 | `event_catalog` seed | app | `db/seeds/` | Severity resolved from data, not code |
| rm03 | `rating_runtime` role & grants | app | `db/bootstrap/` | The rating/billing boundary as a grant; `PUBLIC` loses `CONNECT` and `SECURITY DEFINER` `EXECUTE` |
| rm03a | Kestra database & engine role | app | `db/bootstrap/` | The second database; `kestra_engine`; the reverse `CONNECT` revoke |
| rm04 | Kestra deployment + local dev stack | rating | `infra/**`, `worker/**`, `dev/**` | Dedicated rating instance; custom worker image; four mounts + internal storage; Key Vault (four credentials); image-tag injection; local compose (process runner, **no Docker socket**) |
| rm05 | Entra reverse proxy | rating | `infra/**` | Container Apps Easy Auth; IP allow-list; 7-year proxy access logs |
| rm06 | Flow template + logging + sweep | rating | `flows/**` | JSON Lines log contract; three-outcome severity resolution; idempotent sweep |
| rm07 | PRP — claim, validate, reject | rating | `flows/**` | Reject threshold + chunk size config |
| rm08 | RP — price resolution & snapshot | rating | `flows/**` | Rounding-mode config; the price-provenance columns in use |
| rm09 | RL — guarded transactional load | rating | `flows/**` | The RL transaction boundary; archive-after-commit |
| rm10 | Supersession & reprocessing | rating | `flows/**` | Cross-partition supersede; shrinking-reissue check |
| rm11 | Stranded-batch recovery | rating | `flows/**` | Claim release after a killed worker |
| rm12 | Completeness & gap detection | rating | `flows/**` | Expected-cadence config; alarm clearing |
| rm13 | Ship gate | both | tests / CI | — |

---

## Notes

- **No app-side read-repository unit exists in v1.** `ratemgmt-architecture.md` §2 reserves `db/repositories/rating/**` for read repositories, but in v1 they would have **no consumer** — there is no UI, and the bill run's claim path is out of scope. Per the merge rule, a unit with no standalone visible result is not a unit. The grant assertions in rm03 are raw SQL. Repositories arrive with the bill run's collection stage, in that module's plan.
- **rm01–rm03a are app repo; rm04–rm12 are rating repo.** No unit spans both (`ratemgmt-ai-workflow-rules.md` §2.2). rm13 runs tests across both but changes only CI configuration. **rm03a exists because of that rule** — rm04 needs a database and a role that only the app repo can create, so the app-repo half is its own unit rather than an unowned prerequisite.
- **Phase A must land completely before Phase B starts.** rm04 connects as `rating_runtime`, which rm03 creates against tables rm01 creates, and runs on the database rm03a creates. Within Phase A the order is rm01 → rm02 → rm03 → rm03a, and the rm03-before-rm03a order is load-bearing: `kestra_engine` created before rm03's `REVOKE CONNECT … FROM PUBLIC` inherits access to the billing database and Inv #18 is false from the moment the role exists.
- **rm05 is sequenced before any flow work deliberately.** It has no technical dependency on rm06–rm12, but leaving an unauthenticated engine UI reachable while flows are being written makes the insecure state the working default.
- **Configuration is introduced just in time, one key per unit that needs it** — reject threshold and chunk size at rm07, rounding mode at rm08, expected cadence at rm12. Do not seed a config table up front.
- **Retention is not uniform.** `udr_rated` partitions are detached at 7 years; `process_log` partitions at 24 months (rm01 D7). `archive/` files are kept 7 years; `error/` and `logs/` 24 months. Any document stating a single figure for all of them is stale.
- **`udr_rate_type` is `FLAT` only throughout.** `PER_UNIT`, `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE` and `ZERO_RATED` exist in the enum so the schema is not locked in; implementing their calculation is a later phase and a spec change, not a unit here.
- **The bill run's claim path, adjustments and credit notes, minimum commitments, caps, allowance consumption, and any UI are out of scope** (`ratemgmt-project-overview.md`). No unit builds them.

---

## Configuration

**All rating configuration lives in Kestra.** `core.SYSTEM_CONFIG` covers the rest of the application; nothing about rating goes in it, and no `rating.*` config table exists. This removes what would otherwise have been a fifth platform deviation.

**But Kestra offers two kinds of configuration, and they are not interchangeable here.**

Rating logic lives in the flow definitions, and `rating_flow_revision` is stamped on every rated row precisely so a historical charge can be reproduced. A value that changes the rated number must therefore move **with** the flow revision. The namespace KV store is runtime-editable through the UI and is **not** version-controlled — a value stored there can change without the flow revision changing, and the same revision would then produce different numbers. That is the audit hole the two version columns exist to close.

| Config | Changes the rated output? | Where it lives | Introduced by |
|---|---|---|---|
| **`file_key` derivation rule per `udr_type`** | **Yes** — a wrong rule supersedes the wrong records | **Flow `variables`** | rm07 |
| Reject threshold per `udr_type` | **Yes** — changes which records get billed at all | **Flow `variables`** | rm07 |
| Rounding mode | **Yes** — changes the number | **Flow `variables`** | rm08 |
| Expected cadence and window per `udr_type` | No — drives an alarm only | Namespace KV store | rm12 |
| Chunk size per `udr_type` | No — performance only | Namespace KV store | rm07 |
| Log-sweep schedule and lag threshold | No — operational | Namespace KV store | rm06 |
| Mount paths (`landing/`, `archive/`, `error/`, `logs/`) | No | Container environment variables, set by the Container App definition | rm04 |
| Kestra namespace name (`rating`) | No | Literal in each flow's `namespace:` key | rm06 |

**The mechanism for output-affecting config is flow `variables` — not a namespace file.** Of the places Kestra can hold a value, `variables` declared inside the flow YAML are the only ones that are *literally part of the artefact whose revision is stamped on every rated row*. A namespace file is deployed from git but is **a separate artefact with its own lifecycle**: it can be redeployed without the flow revision changing, and the same revision would then produce different numbers. That is precisely the audit hole the two version columns exist to close, so a namespace file is **not** an acceptable home for anything in the "Yes" rows above. The KV store is acceptable for the "No" rows.

**There is one config key, and one only, per row above.** "Failure policy per `udr_type`" appears in the plan file and the overview as though it were separate from the reject threshold. It is not: the threshold *is* the policy, expressed as a count of rejected records, where `0` means file-level all-or-nothing. Do not build two keys.

**No separate threshold stamp is needed.** An earlier draft called for stamping the effective reject threshold on `udr_batch`. It is unnecessary: `udr_batch` already records `workflow_flow_revision`, and with the threshold held as a flow variable, the value that applied to any batch is recoverable by reading that revision. Stamping it would duplicate a fact already reachable. *(This holds only while flow revisions remain retrievable — Open item 4, Kestra database backup retention.)*

**Rounding mode is one value in v1, not a per-product map** — which is why the table above calls the key "rounding mode" and rm08's entry should be read the same way. The design allows per-product rounding, but v1 has a single `udr_type` and no second rounding rule, so a per-product mapping inside the flow would be a catalogue growing in the wrong place. Ship one flow variable. When a second rounding rule genuinely appears, rounding mode is a **product attribute** and belongs on `product.product_offering_price` — a product-module change, not a rating one. `udr_rounding_mode` is still stamped per rated row, so the record stays self-describing either way.

**A change to output-affecting config is a flow deployment**, reviewed like any other change to how money is calculated. It is never a UI edit (`ratemgmt-ai-workflow-rules.md` §1.3).

---

## Open items to resolve before the units they block

This table and the one in `_newmodule-rating-engine-plan.md` §14 are **the same list**. If you close an item, close it in both.

| # | Open item | Blocks | Owner |
|---|---|---|---|
| 1 | **`udr_key` field list** — which fields compose the key for `RAN_USAGE`. The canonicalisation rule and the 512-character cap are settled; only the field list is open. | rm07 | Defined at PRP build from the actual feed format |
| 2 | **Price as-of resolution mechanism** — SQL predicate vs per-batch snapshot. | rm08 | Decide before starting; do not default to the existing JS-filter pattern |
| 3 | ~~Where per-`udr_type` configuration lives~~ — **RESOLVED.** All rating configuration lives in Kestra; output-affecting values in flow `variables`, the rest in the namespace KV store. No `rating.udr_type_config` table, no rating rows in `SYSTEM_CONFIG`, therefore no platform deviation. See §Configuration. | — | Closed |
| 3a | **Database/extension version drift** — local dev is PG 17, Azure is PG 16, Azure's `pg_partman` version is **unverified**, and both mitigations (the preflight assertion, pinning the local image to 16) are **proposed, not implemented**. Do not read `_risk-database-extension-version-drift.md` as done. It also blocks rm04, whose local stack uses the app repo's Postgres container. | rm01, **rm04** | Platform — run the Azure check before rm01 ships |
| 4 | **Kestra database backup retention** aligned to the 7-year rating retention — because rating logic lives in flow definitions, Kestra's database holds part of the audit trail. Needs a stated retention and a restore test, not just a raise. | rm04 | Raise at deployment |
| 5 | **Flow definition version-control and deployment process** — deferred by decision, but `ratemgmt-code-standards.md` §3 already forbids editing a flow in the Kestra UI, and the rating repo's layout has **no deployment pipeline file**. rm06 cannot deploy a flow by a mechanism that is simultaneously mandatory and undefined. | **rm06**, rm05 sign-off | Deferred; must land before rm06 |
| 6 | **Success criterion "no per-record fan-out" assertion mechanism** — how to assert task count is bounded by chunk count. A design guard, not a release blocker. | rm13 | Revise at ship-gate spec |
| 7 | **Process-runner / custom-image spike** — validate that the process runner against a custom image behaves as assumed on Container Apps. Accepting it couples rating's release cycle to Kestra's permanently. This plan describes the outcome; that is not the same as having validated it. | rm04 | Spike before rm04 starts |
| 8 | **Testing approach for rating logic held in flow definitions** — the only rule today is "flow definitions parse and deploy". rm06 introduces the logging contract, whose test must assert the log-line format, and no test in `ratemgmt-code-standards.md` §10 covers it. | rm06 | Decide with item 5 |
| 9 | **`ban_id` at rating time** — currently accepted as resolved at bill run rather than stamped at rating. | rm08 sign-off | Accepted; revisit if the bill run needs it earlier |
| 10 | **Platform design review for the second database and the `core.AUDIT_LOG` exemption** — `platform-architecture.md` §5 states one logical database per server, and changes to Platform Invariants require a documented review. rm03a implements the deviation; the review has not happened. | rm03a | Platform |

---

# Phase G — PER_UNIT RAN-Usage Update (rm14–rm22)

**This phase supersedes the "`udr_rate_type` is `FLAT` only throughout" note above.** It implements the `PER_UNIT` calculation, the real subscriber resolver (replacing rm08's placeholder), and the PRP integrity checks defined in `_change-rating-configuration-plan.md` and `ratemgmt-update-overview.md`. Design and Invariants: `ratemgmt-architecture.md` (Inv 20–25; X1/X2). Same decomposition rules as above; same repo-split rule (`ratemgmt-ai-workflow-rules.md §2.2` — app repo *or* `workflow-management/`, never both). Workstream C (Product-management UI) is **not** in this phase — `_futurebuild-product-mgmt-ui-plan.md`.

**Repo naming:** the second repo is now the `workflow-management/` spin-off subdirectory (`wfm-architecture.md §4`), not a flat "rating repo". Units below say **app** or **wfm**.

## Phase G.1 — Scope & app-repo foundation

### Unit rm14 — Scope reconciliation + rm-spec banners
- **Repo:** app (docs) · **Boundary:** `context/rating-management/**` + `context/product-management/specs/`
- **Builds:** update `ratemgmt-project-overview.md` FLAT-only → `PER_UNIT` + the real resolver (the arch, code-standards and ai-workflow-rules docs are already updated); add a **forward-reference banner** (not a rewrite) to `rm01/rm06/rm07/rm08/rm09/rm10/rm12` and to `pm57a` (`lkp_subscriber_ref_id` = `party_role_id`).
- **Visible result:** the doc set consistently authorizes `PER_UNIT` + the real resolver; the FLAT-only scope no longer reads the new code as a regression; the delivered rm/pm specs point forward without losing the record of what shipped.
- **Depends on:** none. **Do this first** (`ratemgmt-ai-workflow-rules.md §0` rule 2).

### Unit rm15 — `udr_rated` shape migration (rename + X1 + X2)
- **Repo:** app · **Boundary:** `db/migrations/0034_rating.sql` + `db/schema/rating/udr-rated.ts` + `db/repositories/billing/rated-lines.repository.ts`
- **Builds:** **gated on a fresh-install check** (verify no environment holds live `rating.udr_rated` data — the G-RC6 discipline; record the check). Then, **edit-in-place**: rename `udr_subscriber_ref_id` → **`udr_subscription_ref_id`** (+ rename the index `udr_rated_subscriber_start_idx`); change `rating.period_of()`'s literal to the **config TZ `Asia/Kuala_Lumpur`** so `partition_period` **is the billing month** (X1); tighten the live-row constraint to **`UNIQUE (partition_period, udr_key, is_live)`** (X2, `start_datetime` dropped); regenerate the Drizzle journal + snapshot for `0034` (the one place `no drizzle-kit generate` is relaxed, as in pm57a D1); update the sample seed + the bill-run read path for the renamed column.
- **Visible result:** the constraint suite passes at the new shape — a second live row per `(partition_period, udr_key)` is rejected; `period_of()` truncates in `+8` and behaves identically across ≥3 session timezones; a grep proves zero `udr_subscriber_ref_id` remaining in the app repo.
- **Depends on:** rm01, rm14; the fresh-install verification gate. **If any environment holds rated data, this ships as a forward migration instead of edit-in-place.**

### Unit rm16 — `rating_runtime` grant extension
- **Repo:** app · **Boundary:** `db/bootstrap/rating-db-roles.sql`
- **Builds:** add `rating_runtime` `SELECT` on the resolver/validation read set — `customer.party_role`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` — enumerated per table (never `ON ALL TABLES`); extend the per-table grant-assertion test.
- **Visible result:** `rating_runtime` can `SELECT` exactly those four new tables and nothing more; the assertion proves the read set equals the enumerated list; no write anywhere new.
- **Depends on:** rm03 (the role + enumerated-grant pattern), rm14.

### Unit rm17 — `perUnitRateDetailSchema`
- **Repo:** app · **Boundary:** `validation/rating/udr-rate-detail.schema.ts`
- **Builds:** add the `PER_UNIT` variant to the discriminated union — `{ rateType: "PER_UNIT", ratePerUnit, quantity, amountRaw }` (money/decimal as `string`); it types `udr_rated.udr_rate_detail` and is the source of truth the `rp.py` Python mirror must match; tests (a valid `PER_UNIT` detail passes; `FLAT` still passes; an extra key or wrong discriminant is rejected).
- **Visible result:** the Zod suite proves `PER_UNIT` validates, `FLAT` still validates, and a malformed detail is rejected before any write.
- **Depends on:** rm14 (the column already exists from rm08).

### Unit rm18 — Sample product / customer / ratecard seed + MNO-key shape + new event codes
- **Repo:** app · **Boundary:** `db/seeds/**` + `validation/customer/**` + `db/seeds/rating-event-catalog.ts`
- **Builds:** the resolvable **Sample 5G** dataset — a product offering with specs `udrType="RAN_USAGE"`, `singleSubInstPerCust="true"`, `productCardLookUp="RATECARD_RAN_USAGE_LKP"` and a **scalar** `usage_rate` price (`ratePerUnit`, `unit_of_measure="Mbps"`); a customer `party_role` with `party_role_specification = {"mnoPublicKey1":"MNO-001"}` plus the MNO-key validation shape; an ACTIVE `ratecard_version` + `ratecard_ran_usage_lkp` rows whose `lkp_subscriber_ref_id = party_role_id`; and the **new `event_catalog` rows** — `UNKNOWN_SUBSCRIBER`, `CARD_DRIVEN_RATING_UNSUPPORTED`, `SUBSCRIBER_REF_MISMATCH` (factor-2), `PRODUCT_PIN_MISMATCH` (factor-3), `SERVICE_CODE_MISMATCH`, `RATECARD_COVERAGE_GAP` (ratecard→input), `INPUT_UNMAPPED` (input→ratecard), `UDRTYPE_MISMATCH`, `MNO_KEY_NOT_UNIQUE`.
- **Visible result:** one customer, one RAN_USAGE subscription, an active ratecard and a scalar price — a dataset the flow can resolve and rate end-to-end; every new event code resolves in the catalog (`INDETERMINATE` count stays zero).
- **Depends on:** rm02 (catalog), rm15 (schema shape), rm16 (grants). **MNO-key shape and event-catalog rows are merged here** — none is a standalone unit and all are seeded in the same session to make the sample rateable.

## Phase G.2 — Runtime & flow (workflow-management)

### Unit rm19 — Runtime rename + RP `PER_UNIT` computation
- **Repo:** wfm · **Boundary:** `workflow-management/worker/workflow-engine/runtime/rp.py` (+ the rename in `rl.py`)
- **Builds:** the **wfm half of the rename** — `udr_subscriber_ref_id` → `udr_subscription_ref_id` across `rp.py` and `rl.py` (the `COPY` column list + writes), atomic across both modules; then in `rp.py`: derive `udr_rate_type` from the resolved `component_type` (`usage_rate → PER_UNIT`); compute `PER_UNIT = ratePerUnit × usage_volume` in `Decimal`, rounded once per `udr_rounding_mode` (`HALF_UP`); emit the `perUnitRateDetailSchema` JSON (Python mirror of rm17); source `udr_usage_unit` from the resolved component `unit_of_measure`; raise `CARD_DRIVEN_RATING_UNSUPPORTED` for a `usage_rate` with `plaSpecId = 'PLA_USAGE_RATE'`. Built on the **existing placeholder resolver** (the real one is rm20).
- **Visible result:** RP produces `PER_UNIT` rated chunks — `udr_rate_type="PER_UNIT"`, `udr_rated_price_raw = ratePerUnit × usage_volume`, `udr_rated_price = round(raw, HALF_UP)`, a valid `udr_rate_detail` — and both runtime modules write the renamed column (rm08's FLAT assertions refreshed to PER_UNIT: **regression R1**).
- **Depends on:** rm15 (renamed column + shape), rm17 (schema mirror), rm18 (a scalar price to resolve). **The wfm rename is merged into this unit** (no standalone result; keeps the rp+rl rename atomic).

### Unit rm20 — RP: consume resolved subscription + drop the feed-unit price join
- **Repo:** wfm · **Boundary:** `runtime/rp.py`
- **Builds:** RP consumes the `product_inventory_id` **PRP resolves and carries** (rm21); the OV-5 price-path rewrite — remove the `pw.unit_of_measure = r.usage_unit` predicate, `_FEED_UNIT_TO_CATALOG` / `_map_feed_unit`, and the `usage_unit` chunk column; select the offering's single `usage_rate` lane directly (the unit now comes from the product, rm19). *(Decision A, eng review: resolution moved to PRP/rm21 — the identity locks that need the resolved `party_role_id` are PRP hard-stops that run before RP rates.)*
- **Visible result:** RP prices a record on the carried `product_inventory_id` with no feed-unit dependency; a single-lane `usage_rate` resolves without a feed unit; `LOOKUP_MISS` fires only for a genuinely missing `usage_rate` lane.
- **Depends on:** rm18 (seed), rm19 (PER_UNIT compute). *(The real resolved value arrives with rm21; rm20's change is valid on the placeholder-carried id.)*

### Unit rm21 — PRP: validations, cross-checks, identity locks + flow config
- **Repo:** wfm · **Boundary:** `runtime/prp.py` + `flows/rating-engine/rating-engine-ran-usage.yaml`
- **Builds:** in `prp.py` — **resolve factor 1** (`mno → party_role_specification->>'mnoPublicKey1' → party_role_id → the RAN_USAGE-offering-filtered ACTIVE subscription, date window in the config TZ → product_inventory_id`; empty `{}` → `UNKNOWN_SUBSCRIBER`) and **write `product_inventory_id` into the chunk** for RP; load the ACTIVE ratecard + subscription/customer extracts; **widen dedup** to the identity key `(partition_period-as-billing-month | mno | cu | polygon)`; the **three-factor identity lock** (resolved `party_role_id` = ratecard `lkp_subscriber_ref_id` = the resolved offering **family id** pinned by the flow variable) — all hard-stop; `service_code` verify vs the matched ratecard row; **ratecard→input completeness** governed by `ratecard_coverage_enforcement` (`HARD_STOP`/`WARN`) + **input→ratecard** hard-stop; `udrType` confirmation; emit the new event codes. In the flow YAML — `feed_profile` → the **7-column, no-unit** shape; `file_key_rule` → `^(?P<file_key>rating-input-file-\d{12})(?:_v\d+)?\.udr$`; `ratecard_coverage_enforcement: HARD_STOP`; `reject_threshold: "0"`; the `subscription_product_name` pin; remove the `subscriber_ref_column` placeholder.
- **Visible result:** a clean 7-column `.udr` file passes; each forced integrity failure (missing MNO key, wrong `lkp_subscriber_ref_id`, wrong family pin, `service_code` mismatch, missing ratecard polygon under `HARD_STOP`, unmapped input row) hard-stops the **whole batch** with the correct event code; the same missing-polygon file under `WARN` rates and logs the gap; a same-cell/same-billing-month duplicate is rejected while a same-cell/different-month pair is kept (**regression R2**); an unmapped input row hard-stops rather than a per-record `LOOKUP_MISS` (**regression R3**).
- **Depends on:** rm16 (grants — PRP's new customer/product reads), rm18 (seed). **Resolution + flow config are merged here** — `feed_profile`/`file_key_rule`/the coverage+threshold vars are exactly what PRP consumes, and they ship together.

### Unit rm22 — E2E journey + regressions + RL verification (ship gate)
- **Repo:** both · **Boundary:** tests / CI + `runtime/rl.py` (verification)
- **Builds:** refresh the rm13 end-to-end journey to **PER_UNIT** (file lands → PRP → RP → RL → `udr_rated` at PER_UNIT → reissue → supersession); the RL **"verified no-change" checklist** (COPY column list uses the renamed column; the new `raw ≠ rated` divergence loads; `udr_rate_detail` PER_UNIT variant carried as opaque text; reconciliation `parsed = rated + rejected + discarded` still balances with input→ratecard now a PRP hard-stop); the three CRITICAL regressions **R1** (FLAT→PER_UNIT assertions refreshed, never deleted), **R2** (dedup widening), **R3** (input→ratecard hard-stop); and a grep gate asserting **zero** `udr_subscriber_ref_id` across both repos.
- **Visible result:** the full PER_UNIT operator journey is green end to end; every changed Invariant (20–25, X1, X2) has a test that fails when it is deliberately violated; RL loads PER_UNIT rows and supersedes a reissue correctly; the ship gate passes.
- **Depends on:** rm14–rm21. **RL verification is merged here** — RL needs no logic change beyond the rename (done in rm19), so it has no standalone result and rides the ship gate.

---

## Phase G — Build-order summary

| Unit | Name | Repo | Boundary | Key just-in-time dependency introduced |
|---|---|---|---|---|
| rm14 | Scope reconciliation + banners | app | `context/**` | PER_UNIT authorized in the docs; rm/pm banners |
| rm15 | `udr_rated` shape (rename + X1 + X2) | app | `db/migrations` + schema | Billing-month `period_of`; `(partition_period, udr_key)` live key; `udr_subscription_ref_id` |
| rm16 | `rating_runtime` grant extension | app | `db/bootstrap/` | `SELECT` on `customer.party_role` + product ratecard/specs |
| rm17 | `perUnitRateDetailSchema` | app | `validation/rating/` | The PER_UNIT rate-detail type + mirror contract |
| rm18 | Sample seed + MNO shape + event codes | app | `db/seeds/` + `validation/customer/` | A rateable Sample-5G dataset; the new event codes |
| rm19 | Runtime rename + RP PER_UNIT compute | wfm | `runtime/rp.py`, `rl.py` | PER_UNIT math in-engine; wfm rename (R1) |
| rm20 | RP real subscriber resolver | wfm | `runtime/rp.py` | `party_role_spec` → RAN_USAGE subscription; feed-unit join removed |
| rm21 | PRP checks + identity locks + flow config | wfm | `runtime/prp.py` + flow YAML | Three-factor lock; completeness; 7-col feed; `file_key_rule`; `reject_threshold:"0"` (R2, R3) |
| rm22 | E2E + regressions + RL verification | both | tests / CI | The PER_UNIT ship gate; R1–R3; zero stale rename refs |

## Phase G — Notes

- **`PER_UNIT` is in scope; no other rate type is.** The `FLAT`-only note above is superseded for `PER_UNIT` only — `TIERED_*`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED` remain a spec change, not a unit. Card-driven `usage_rate` rating is out of scope (raise `CARD_DRIVEN_RATING_UNSUPPORTED`).
- **Open item #1 (the `udr_key` field list) is now closed for `RAN_USAGE`:** `mno_public_id | commercial_unit | polygon_id` (no datetime); identity for uniqueness/dedup is `(partition_period, udr_key)`.
- **The X2 grain is table-wide.** `UNIQUE (partition_period, udr_key, is_live)` binds every `udr_type` on the shared `udr_rated`. Correct for the monthly RAN feed; a future sub-monthly `udr_type` needs a `udr_type`-scoped partial index (not a change to this one). This is the one deferred design item this phase leaves open.
- **rm14–rm18 are app repo; rm19–rm21 are wfm; rm22 spans both (tests only).** No non-test unit spans repos (`§2.2`). App-repo units land before the wfm units that depend on them.
- **The rename is one logical change split across two repos by the repo rule:** the app-repo call sites in rm15, the wfm call sites (`rp.py`+`rl.py`) atomically in rm19. Do not land one without scheduling the other in the same cycle.
