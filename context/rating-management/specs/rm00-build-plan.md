# Rating Management — Build Plan (Units, in build order)

Decomposition of the Rating Management module into build units. Sources: `ratemgmt-project-overview.md`, `ratemgmt-update-overview.md` (current update), `ratemgmt-architecture.md` (Invariants 1–28), `ratemgmt-code-standards.md` (grant table §9, guardrail tests §10), `ratemgmt-ai-workflow-rules.md` (unit discipline). Stack: `context/architecture.md` §1 and `ratemgmt-architecture.md` §1 (Kestra OSS on Container Apps, custom worker image, Postgres 16 with `pg_partman`/`pg_cron`, Drizzle for typing only, Python runtime `prp.py`/`rp.py`/`rl.py`).

**Decomposition rules:** each unit produces **one visible result**; stays within **one system boundary**; introduces dependencies **just in time**; units **always done together are merged**; units with **no standalone visible result are merged** into an adjacent unit.

**Legend:** _Repo_ · _Boundary_ · _Builds_ · _Visible result_ · _Depends on_.
**Repo naming:** Phases A–F say "rating repo"; since wfm01 that surface is `workflow-management/**` (flows, worker, dev) plus app-root `infra/bicep/`. Phases G–H say **app** or **wfm**. No non-test unit spans both (`ratemgmt-ai-workflow-rules.md` §2.2).
**External prerequisites (not units):** Azure Flexible Server **16** with `pg_partman` + `pg_cron` and the daily maintenance job; `app_runtime`/`app_migrate` roles and the Drizzle migration history; populated `product`, `ordering`, `inventory`, `billing` schemas; Entra tenant, Key Vault with Managed Identity; a Container Apps environment.

---

## Phase A — Schema & access (app)

### rm01 — `rating` schema foundation
- **Boundary:** `db/schema/rating/**` + migration.
- **Builds:** the four tables (`udr_rated`, `udr_batch`, `process_log`, `event_catalog`) as one migration with every Invariant-bearing constraint: live-row `UNIQUE` with `is_live` `GENERATED ALWAYS` from `status` (Inv #3); `CHECK (char_length(udr_key) <= 512)`; `CHECK (partition_period = rating.period_of(start_datetime))` via an `IMMUTABLE` helper (Inv #15); `UNIQUE (file_key, batch_run_num)` on `udr_batch` (Inv #7); status/severity/rate-type/rounding CHECKs; money `numeric(18,2)` and rates `numeric(18,6)`, raw and rounded; ULID `udr_id`/`log_id`, `UDRBAT`+8-digit `batch_id`; **no cross-schema FK** (Inv #16); `pg_partman` registration (monthly, premake 4, **detach not drop**, on the existing daily job; `udr_rated` 7 years, `process_log` 24 months).
- **Visible result:** the constraint suite passes on a live DB — second live row rejected; four supersede cycles leave one live and four superseded rows; 513-character key rejected by the CHECK; mismatched `partition_period` rejected under three session timezones; next month's partitions created on the existing schedule.
- **Depends on:** platform Postgres with `pg_partman`/`pg_cron`; `core.generate_ulid()`.
- **Parity note:** local dev was PG 17 vs Azure 16. Pin the local image to `postgres:16-bookworm` (PGDG ships `pg_partman` 5.0.1 for 16, so the major does not change; the break is v4→v5). Add a **preflight assertion** to the partman setup that fails if the installed major is below 5; verify Azure's version once (`_risk-database-extension-version-drift.md`).
- _Later phases changed:_ live-row key and `period_of()` literal → rm15; `udr_resource` reserved (D10) → populated by Phase H (rm26–rm28). The canonical `udr_key` rule was never rm01's (it is rm07 D2 / `_newmodule-rating-engine-plan.md` §4.2) and is reversed by rm26.

### rm02 — `event_catalog` seed
- **Boundary:** `db/seeds/`.
- **Builds:** rows mapping every `event_code` to default severity, X.733 type, probable cause, description, `is_auto_clearing`/`clear_event_code`. `default_severity` is **nullable** (NULL = logged, never alarms). Sixteen codes: `FILE_NOT_RECEIVED`, `FILE_LATE`, `FILE_KEY_UNRESOLVED`, `PARSE_FAILURE`, `LOOKUP_MISS`, `DUPLICATE_BATCH`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `LOAD_BLOCKED_BILLED`, `CROSS_PERIOD_SUPERSEDE`, `CURRENCY_MISMATCH`, `DB_WRITE_FAILURE`, `TASK_RETRY_OK`, `BATCH_PARTIAL`, `BATCH_COMPLETE`, `CLEARED`.
- **Visible result:** a severity resolves from data; a non-alarming code resolves to NULL; an unknown code to `INDETERMINATE` — three distinguishable outcomes (resolver keys off **row presence**; `COALESCE(default_severity,'INDETERMINATE')` is the wrong implementation).
- **Depends on:** rm01. Separate from rm01 because severities are re-tuned by migration on their own cadence.

### rm03 — `rating_runtime` role, grants and the boundary
- **Boundary:** `db/bootstrap/rating-db-roles.sql`.
- **Builds:** the `rating_runtime` login role (connection limit); enumerated grants — `SELECT`/`INSERT` on `udr_rated`, `udr_batch`, `process_log`, `SELECT` on `event_catalog`, `UPDATE` on `udr_rated` limited to `status`, **no `DELETE`** (Inv #2); `SELECT` only on seven product/ordering/inventory/billing tables; explicit `REVOKE` of every `billing.*` write (Inv #1); column-scoped `GRANT UPDATE` to `app_runtime` on exactly six `udr_rated` columns; `USAGE` on `udr_batch_seq` and `EXECUTE` on `period_of()`/`core.generate_ulid()`; `REVOKE CONNECT … FROM PUBLIC`; `REVOKE EXECUTE … FROM PUBLIC` on the four `billing` `SECURITY DEFINER` pgledger functions; `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate` granting **`SELECT` only** on future `rating` tables.
- **Visible result:** a `billing` write by `rating_runtime` raises a permission error, as does `billing.pgledger_create_transfer(...)`; no `DELETE` on `udr_rated`; a role without explicit `CONNECT` is refused; `app_runtime` updates each of the six columns and is refused on every other, asserted per column over `pg_attribute`.
- **Depends on:** rm01.

### rm03a — Kestra database, engine role and its boundary
- **Boundary:** `db/bootstrap/kestra-db-roles.sql` + `.ts`.
- **Builds:** the second database (`kestra`); `kestra_engine` with `CONNECT`+`CREATE` there and **no `CONNECT` on billing** (Inv #18); `REVOKE CONNECT ON DATABASE kestra FROM PUBLIC` then an explicit grant to `kestra_engine` only; matching local-dev provisioning; the manual `ALTER ROLE … PASSWORD` steps for `rating_runtime` and `kestra_engine` in `infra/docs/db-role-verification.md` (passwords to Key Vault).
- **Visible result:** `kestra_engine` connects to `kestra` and creates a table, is refused billing; `rating_runtime` and `app_runtime` are refused `kestra` — three `permission denied` refusals asserted per role.
- **Depends on:** rm03. **Ordering is load-bearing:** create `kestra_engine` after rm03, or it inherits billing `CONNECT` through `PUBLIC`. An app-repo unit because only `db/bootstrap/` holds `CREATEROLE`.

---

## Phase B — Engine platform (rating repo)

### rm04 — Kestra deployment and local development environment
- **Boundary:** `infra/**` + `worker/**` + `dev/**`.
- **Builds:** a **dedicated Kestra instance for rating** (decided: not shared with the bill run — one engine's image rebuild must not revalidate another module's flows) on Container Apps against the `kestra` database; the **custom worker image** (pinned base digest, rating runtime baked in; process runner, no Docker daemon); four mounts — `landing/` Azure Files, `archive/`, `error/`, `logs/` Azure Blob — plus Kestra internal storage on Blob; Key Vault wiring for four credentials; injection of the image tag as `RATING_ENGINE_VERSION`; lifecycle policies (`archive/` 7 years, `error/`/`logs/` 24 months); the **local stack** (compose joined to the app stack, same Postgres, same worker image, Azurite, bind mounts, `.env.example`). **Do not mount the Docker socket** — production has no Docker daemon.
- **Visible result:** the engine starts, runs its migrations, executes a trivial flow, reads/writes all four locations, resolves `RATING_ENGINE_VERSION` to the image digest, connects as `rating_runtime`; `kestra_engine` is refused billing; a developer runs the identical image locally.
- **Depends on:** rm03, rm03a; Container Apps; Key Vault.
- **Notes:** run the **process-runner spike first** (open item 7). Archive is a cross-protocol copy (SMB → Blob), so `archive_file_path` and `source_file` are not comparable strings; rm09 makes the window recoverable. `BILLRUN_APP_TOKEN` is not this module's credential.

### rm05 — Entra reverse proxy
- **Boundary:** `infra/**` (identity + network).
- **Builds:** Kestra UI behind Container Apps **Easy Auth** with Entra (decided over Front Door); an IP allow-list on external ingress; proxy access logs shipped to Log Analytics and **retained 7 years** (the module's substitute for `core.AUDIT_LOG`); the Entra client secret in Key Vault (a scoped departure from platform Inv #13, recorded in `ratemgmt-architecture.md` §7); the signed-off accepted risk that anyone past the proxy can edit flows.
- **Visible result:** an Entra user reaches the UI; an unauthenticated or non-allow-listed request is refused; access is recorded and still queryable after retention is applied.
- **Depends on:** rm04. Sequenced before flow work so an unprotected UI is never the default. The proxy covers the UI only.

---

## Phase C — Pipeline spine (rating repo)

### rm06 — Flow template, logging contract and log sweep
- **Boundary:** `flows/**`.
- **Builds:** the flow template with three named, ordered **stub** sections `prp`/`rp`/`rl` (`# STUB:` markers), manual trigger only, `concurrency: limit: 1` per `udr_type`, file-URI handoff, error and `finally` handlers writing a terminal-outcome log line; the scheduled, flow-independent **`log-sweep`** loading `logs/` into `process_log`; the log-line contract.
- **Log line = JSON Lines** (decided), keys matching `process_log` one-for-one: `log_datetime`, `component`, `log_level`, `perceived_severity` (nullable), `event_code`, `specific_problem`, `managed_object`, `alarm_key`, `source_file`, `batch_id`, `workflow_execution_id`, `additional_info`. `partition_period` is **not** a line field: the sweep computes `rating.period_of(log_datetime)`. `log_level` is the emitter's; severity comes from the catalog with the three outcomes (rm02). The sweep is **idempotent** (swept-file marker or offset) with a test that sweeps one file twice; define torn last lines, malformed lines and where the sweep logs its own failures.
- **Visible result:** a file moves through all three stubs; logs are swept with an alarming, a non-alarming and an uncatalogued code landing as a severity, NULL and `INDETERMINATE`; a crashed flow's logs are still swept; sweeping twice leaves the row count unchanged; sweep lag is a health metric.
- **Depends on:** rm01, rm02, rm04. The sweep is merged with the template (two halves of one contract).

---

## Phase D — The three components (rating repo)

### rm07 — PRP: claim, validate, reject
- **Boundary:** `flows/**` — `prp`.
- **Builds:** pickup from `landing/`; **database-backed claim** — derive `file_key` from the **filename** (rule per `udr_type`; unresolvable → `FILE_KEY_UNRESOLVED` at `MAJOR`), insert the `udr_batch` row at `RECEIVED` first with `batch_run_num = COALESCE(max,0)+1`; checksum with byte-identical redelivery discarded as `DUPLICATE_BATCH`; parse and map to the `udr_rated` key fields; `udr_key` serialisation (sorted names, `name=value`, joined by `|`; **value normalisation removed by rm26**); validation (malformed, unknown subscriber, out-of-range, duplicates); reject files in `error/` with reason codes; per-`udr_type` error threshold (`0` = all-or-nothing); `parsed`/`rejected`/`discarded` counts.
- **Visible result:** a 50,000-record file with 37 bad records claims itself, writes a reject file naming the 37, carries 49,963 forward and reaches `PARTIAL`; a concurrent second attempt fails on the claim constraint; a byte-identical redelivery is discarded before parsing.
- **Depends on:** rm01, rm04, rm06. **Config:** reject threshold and chunk size per `udr_type`.

### rm08 — RP: price resolution and snapshot
- **Boundary:** `flows/**` — `rp`.
- **Builds:** event-time price resolution through the **pinned `product_offering` version** with `order_item_price_override`; **snapshot** of every resolved input (`udr_usage_rate`, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`); `FLAT` calculation (enum fully defined; `PER_UNIT` added by rm19); `udr_rate_detail` typed from a Zod discriminated union; `udr_rated_price_raw` and rounded `udr_rated_price` with `udr_rounding_mode`; `udr_currency` from the price row; version columns stamped.
- **Visible result:** a record re-rated after its price row and override both changed reproduces the original amount from its snapshot.
- **Depends on:** rm03, rm07. **Config:** rounding mode (one flow variable). **Resolve first:** SQL predicate vs per-batch snapshot for as-of resolution — do not copy the pull-all-and-filter-in-JS pattern.

### rm09 — RL: guarded transactional load
- **Boundary:** `flows/**` — `rl`.
- **Builds:** the pre-load guard refusing the **whole batch** on a collision with a live `BILL_APPROVED` row (`LOAD_BLOCKED_BILLED` at `MAJOR`, `REFUSED`; Inv #6); `CURRENCY_MISMATCH` assertion; insert at `RATED` — guard, supersede hook and insert in **one transaction** (Inv #8); `parsed = rated + rejected + discarded` with `RECON_IMBALANCE` at `CRITICAL`; **archive-after-commit** (Inv #9); `BATCH_COMPLETE`/`BATCH_PARTIAL`.
- **Visible result:** a clean file loads to `COMPLETE` with reconciling counts and the raw file archived; a batch colliding with an approved invoice writes zero rows; a simulated mid-transaction failure leaves the file in `landing/` and zero rows.
- **Depends on:** rm01, rm07, rm08.

---

## Phase E — Reprocessing & recovery (rating repo)

### rm10 — Supersession and reprocessing
- **Boundary:** `flows/**` — `rl`, extended.
- **Builds:** batch-level supersession by `file_key` — live rows at `batch_run_num < N` become `SUPERSEDED` (**`status` is the only column touched**; lineage on `udr_batch`: `superseded_by_batch_id`, `supersede_reason`); run-N insert in the same RL transaction; supersede scoped **across all partitions** (Inv #5) with `CROSS_PERIOD_SUPERSEDE` at `WARNING`; **shrinking-reissue** detection (`SHRINKING_REISSUE` at `MAJOR`); `superseded_count`.
- **Visible result:** a reissue supersedes exactly the prior run's live rows, including rows that moved partition; a smaller reissue raises `MAJOR`; a test that omits the supersede step aborts on the unique constraint.
- **Depends on:** rm09.

### rm11 — Stranded-batch recovery
- **Boundary:** `flows/**` — `rating-batch-reconcile`.
- **Builds:** a startup/scheduled flow resolving `udr_batch` rows stuck at `PROCESSING`, releasing the claim, with the outcome logged and alarmed.
- **Visible result:** a worker killed mid-load leaves the file in `landing/`, no `udr_rated` rows and a stranded batch; reconciliation resolves it and the file reprocesses cleanly.
- **Depends on:** rm07, rm09.

---

## Phase F — Completeness & sign-off (rating repo)

### rm12 — Completeness and gap detection
- **Boundary:** `flows/**` — `rating-completeness-check`.
- **Builds:** expected cadence per `udr_type`; a scheduled check raising a clearable `FILE_NOT_RECEIVED` at `MAJOR` (with `alarm_key`) and `FILE_LATE` at `WARNING`; **alarm clearing** by a later successful batch only for codes with `is_auto_clearing = true` (never `LOAD_BLOCKED_BILLED`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `FILE_KEY_UNRESOLVED`, `CURRENCY_MISMATCH`, `DUPLICATE_BATCH`, `CROSS_PERIOD_SUPERSEDE`); superseded-never-replaced detection.
- **Visible result:** a file that never arrives raises a `MAJOR`; the late file clears it; retired-and-never-re-rated usage is queryable.
- **Depends on:** rm01, rm02, rm10. **Config:** expected cadence and window.

### rm13 — Ship gate
- **Boundary:** tests / CI (both repos).
- **Builds:** CI assembly of the guardrail suite (`ratemgmt-code-standards.md` §10; rm13 adds only the no-per-record-fan-out test #15); one end-to-end journey (file → PRP partial → RP → RL → archive → reissue → supersession → completeness clean); a CI assertion that no rating migration touches `billing`; SAST and OWASP ZAP baseline green.
- **Visible result:** the full operator journey passes and every Invariant has a test that fails when it is violated.
- **Depends on:** rm01–rm12.

---

## Phase G — PER_UNIT RAN-usage update (rm14–rm23)

Supersedes the "`FLAT` only" scope of rm08. Implements `PER_UNIT`, the real subscriber resolver and the PRP integrity checks (`_change-rating-configuration-plan.md`; Inv 20–25, X1/X2). Workstream C (Product-management UI) is not in this phase.

### rm14 — Scope reconciliation + rm-spec banners
- **Repo:** app (docs). **Builds:** FLAT-only → `PER_UNIT` + real resolver in `ratemgmt-project-overview.md`; forward-reference **banners** (not rewrites) on `rm01/06/07/08/09/10/12` and `pm57a`.
- **Visible result:** the doc set authorizes `PER_UNIT`; delivered specs point forward. **Depends on:** none — do first.

### rm15 — `udr_rated` shape migration (rename + X1 + X2)
- **Repo:** app. **Boundary:** `db/migrations/0034_rating.sql`, `udr-rated.ts`, `rated-lines.repository.ts`.
- **Builds:** gated on a recorded **fresh-install check**; edit-in-place: `udr_subscriber_ref_id` → `udr_subscription_ref_id` (+ index); `period_of()` literal → `Asia/Kuala_Lumpur` so `partition_period` is the billing month (X1); live-row key → `UNIQUE (partition_period, udr_key, is_live)` (X2); **no Drizzle meta regeneration** (a no-op here — `migrate()` reads neither a `_journal.json` hash nor `00XX_snapshot.json` for hand-authored migrations; validated by applying cleanly to an empty database, per the rm15 record); seed and bill-run read path updated. If any environment holds rated data, ship as a forward migration instead.
- **Visible result:** a second live row per `(partition_period, udr_key)` is rejected; `period_of()` behaves identically across three timezones; zero `udr_subscriber_ref_id` left. **Depends on:** rm01, rm14.

### rm16 — `rating_runtime` grant extension
- **Repo:** app. **Boundary:** `db/bootstrap/rating-db-roles.sql`.
- **Builds:** `SELECT` on `customer.party_role`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` (enumerated; Step 7a) and `USAGE` on `customer`; extended grant assertion.
- **Visible result:** exactly those four new tables are readable, no new write. **Depends on:** rm03, rm14.

### rm17 — `perUnitRateDetailSchema`
- **Repo:** app. **Boundary:** `validation/rating/udr-rate-detail.schema.ts`.
- **Builds:** the `PER_UNIT` variant `{ rateType, ratePerUnit, quantity, amountRaw }` (strings; `amountRaw = ratePerUnit × quantity` checked); the contract the Python mirror matches.
- **Visible result:** `PER_UNIT` and `FLAT` validate; a malformed detail is rejected. **Depends on:** rm14.

### rm18 — Sample seed + MNO-key shape + new event codes
- **Repo:** app. **Boundary:** `db/seeds/**`, `validation/customer/**`, `db/seeds/rating-event-catalog.ts`.
- **Builds:** the Sample-5G dataset (offering with `udrType`, `singleSubInstPerCust`, `productCardLookUp` and a scalar `usage_rate` in Mbps; customer `party_role_specification = {"mnoPublicKey1":"MNO-001"}`; ACTIVE ratecard rows with `lkp_subscriber_ref_id = party_role_id`); event codes `UNKNOWN_SUBSCRIBER`, `CARD_DRIVEN_RATING_UNSUPPORTED`, `SUBSCRIBER_REF_MISMATCH`, `PRODUCT_PIN_MISMATCH`, `SERVICE_CODE_MISMATCH`, `RATECARD_COVERAGE_GAP`, `INPUT_UNMAPPED`, `UDRTYPE_MISMATCH`, `MNO_KEY_NOT_UNIQUE`.
- **Visible result:** a dataset the flow can resolve and rate end to end; every new code resolves (`INDETERMINATE` count zero). **Depends on:** rm02, rm15, rm16.

### rm19 — Runtime rename + RP `PER_UNIT` computation
- **Repo:** wfm. **Boundary:** `runtime/rp.py`, `rl.py`.
- **Builds:** the wfm half of the rename (atomic across `rp.py` and `rl.py`, incl. the `COPY` list); `udr_rate_type` from `component_type`; `ratePerUnit × usage_volume` in `Decimal`, rounded once (`HALF_UP`); the `perUnitRateDetailSchema` JSON; `udr_usage_unit` from the product; `CARD_DRIVEN_RATING_UNSUPPORTED` for `PLA_USAGE_RATE`.
- **Visible result:** RP emits `PER_UNIT` chunks and both modules write the renamed column (rm08 FLAT assertions refreshed: **R1**). **Depends on:** rm15, rm17, rm18.

### rm20 — RP: consume resolved subscription, drop the feed-unit join
- **Repo:** wfm. **Boundary:** `runtime/rp.py`.
- **Builds:** RP consumes the `product_inventory_id` PRP carries; removes `pw.unit_of_measure = r.usage_unit`, `_FEED_UNIT_TO_CATALOG`, `_map_feed_unit` and the `usage_unit` chunk column; selects the offering's single `usage_rate` lane.
- **Visible result:** RP prices on the carried id with no feed-unit dependency. **Depends on:** rm18, rm19.

### rm21 — PRP: validations, identity locks, flow config
- **Repo:** wfm. **Boundary:** `runtime/prp.py` + `flows/rating-engine/rating-engine-ran-usage.yaml`.
- **Builds:** factor-1 resolution (`mnoPublicKey1` → `party_role_id` → RAN_USAGE-filtered ACTIVE subscription → `product_inventory_id`; `{}` → `UNKNOWN_SUBSCRIBER`); dedup on `(billing month | mno | cu | polygon)`; the **three-factor identity lock** (party_role, ratecard `lkp_subscriber_ref_id`, offering family pin), all hard-stop; `service_code` verify; ratecard↔input completeness (`ratecard_coverage_enforcement`) and input→ratecard hard-stop; `udrType` confirmation; flow config (7-column no-unit `feed_profile`, `file_key_rule`, `reject_threshold: "0"`).
- **Visible result:** each forced failure hard-stops the whole batch with the right code; `WARN` rates and logs the gap; same-cell/same-month duplicate rejected, different-month kept (**R2**); unmapped input row hard-stops (**R3**). **Depends on:** rm16, rm18.

### rm22 — E2E, regressions and RL verification (ship gate)
- **Repo:** both. **Builds:** the rm13 journey refreshed to `PER_UNIT`; the RL "verified no-change" checklist; regressions R1–R3; a grep gate for zero `udr_subscriber_ref_id`.
- **Visible result:** the `PER_UNIT` journey is green and every changed Invariant (20–25, X1, X2) has a failing-on-violation test. **Depends on:** rm14–rm21.

### rm23 — Ratecard geo on `udr_rated` (delivered as billing bm48)
- **Repo:** app + wfm (rating module only, no billing code). **Spec of record:** `context/billing-management/specs/bm48-rating-udr-rated-geo.md` — this entry only reserves the number and points at it; do not restate the spec here.
- **Delivered:** nullable `state`/`district` on `rating.udr_rated` (migration `0045`, write-once at INSERT, no role may UPDATE); PRP selects them from the matched ratecard cell, RP passes them through, RL appends them to `COPY_COLUMNS` (required for `RAN_USAGE`, `NULL` otherwise); the Inv #26 amendment; tests in `rm01`, `grants`, `rm07`, `rm09`, `rm13` and the new `rm23-udr-geo-frozen`. Landed as one PR with ordered commits under the bm48-only waiver (`ratemgmt-ai-workflow-rules.md` §4).
- **Visible result:** a newly rated `RAN_USAGE` row carries the matched cell's `state`/`district`; re-versioning the card does not change it. Some tests are authored but python-gated and unrun per the billing tracker (2026-10-12).
- **Depends on:** rm15, rm21. Phase H builds on it: rm26 reuses PRP's cell match, and `state`/`district` stay unchanged.

---

## Phase H — Raw `udr_key` and `udr_resource` update (rm24–rm29)

Implements `_updatemodule-rating-udr-key-resource-plan.md` and `ratemgmt-update-overview.md`: `udr_key` stores the feed's values raw; the rate-card match is exact; `udr_resource = state|district|polygon_start_date` is written at INSERT. Design: `ratemgmt-architecture.md` Inv 27–28 (amends 3, 14, 19, 26). Standards: `ratemgmt-code-standards.md` §0.1 and §10 tests 17–20. Workflow: `ratemgmt-ai-workflow-rules.md` §0.1. **No schema change, no migration, no grant change;** fresh DB this round. PRP, RP and RL are **three separate units with no waiver** (§0.1 rule 12); RL lands last because it raises on a `RAN_USAGE` chunk without `udr_resource`.

### rm24 — Reversal amendments (docs)
- **Spec:** `rm24-reversal-amendments.md`
- **Repo:** app (docs). **Boundary:** `context/**`.
- **Builds:** dated **reversal notes** (original text kept) under `_newmodule-rating-engine-plan.md` §4.2, rm07 D2 and rm01 D10; the remaining "canonical `udr_key`" wording in `ratemgmt-project-overview.md`, `rm07` and `rm21` (and `LOOKUP_MISS` → `INPUT_UNMAPPED` where it names the batch reason); the "FLAT/canonical" notes in this plan; the billing-side lines named in the plan §7 (bm45 D2, bm48 G13/D2, billing Inv #36/#47, known-issues), flagged to the billing owner. The architecture, code-standards, ai-workflow-rules and update-overview amendments are already in place — verify only.
- **Visible result:** a search of `context/**` for `canonical_udr_key`, "canonical `udr_key`" and "`udr_resource` … reserved" returns only the dated reversal notes.
- **Depends on:** none. **Do first** (§0.1 rule 3).

### rm25 — App-surface prerequisites: `udr_resource` contract and event code
- **Spec:** `rm25-udr-resource-contract-and-event-code.md`
- **Repo:** app. **Boundary:** `validation/rating/`, `db/seeds/`, `db/schema/rating/udr-rated.ts` (comment only).
- **Builds:** `udr-resource.schema.ts` (`udrResourceSchema`, `formatUdrResource`); a `buildRawUdrKey` helper for seeds and tests; the `RATECARD_LABEL_INVALID` event-catalog row and `RATING_EVENT_CODES` constant (`MAJOR`, `PRP`, not self-clearing — open item 11, closed 2026-10-14); the `udr_resource` comment in `udr-rated.ts` replaced with the format.
- **Visible result:** the Zod suite passes — `state|district|date` and blank-segment values validate, a wrong segment count or a non-ISO date is rejected, `formatUdrResource` round-trips; the new code resolves in `event_catalog` (`INDETERMINATE` count zero).
- **Depends on:** rm02, rm24. The helper, event code and comment have no standalone result, so they are one unit.

### rm26 — PRP: raw key, exact match, cell label
- **Spec:** `rm26-prp-raw-key-and-cell-label.md`
- **Repo:** wfm. **Boundary:** `runtime/prp.py`.
- **Builds:** `build_udr_key` replacing `canonical_udr_key`/`_normalise_value` (raw values; sorted names; `name=value|…`); the exact-match ratecard index and the collision guard reworded (it now fires only on a serialisation collision); `polygon_start_date` in `_RATECARD_SQL`; `RatecardCell.udr_resource` built once per card cell; `udr_resource` on `ParsedRow`, the chunk frame and the Parquet schema; the `|`-in-label hard-stop with the catalogued code. Tests 17 (PRP half), 18 and 20, with `rm07` refreshed.
- **Visible result:** for rate-card cell `ABCD_25 DISTRICT2` / `STATE-1` / `DISTRICT-1` / `2026-01-01` the PRP chunk carries `udr_key` with `polygon_id=ABCD_25 DISTRICT2` and `udr_resource = STATE-1|DISTRICT-1|2026-01-01`; a case-different polygon refuses the whole batch as `INPUT_UNMAPPED`; a card label containing `|` fails the batch before rating; a blank key field is still `MISSING_KEY_FIELD`.
- **Depends on:** rm21, rm23, rm25.

### rm27 — RP: carry `udr_resource`
- **Spec:** `rm27-rp-carry-udr-resource.md`
- **Repo:** wfm. **Boundary:** `runtime/rp.py`.
- **Builds:** `udr_resource` added to RP's pass-through columns (beside `state`/`district`) and to its output schema; no pricing change.
- **Visible result:** every rated Parquet row carries `udr_resource` unchanged and the `PER_UNIT` amounts are identical to before (R1 intact); `rm08` tests pass, with any key literal updated.
- **Depends on:** rm26. Kept separate from rm26 and rm28 because §4.3 forbids one unit spanning pipeline components.

### rm28 — RL: write `udr_resource`, raw-key guards verified
- **Spec:** `rm28-rl-write-udr-resource.md`
- **Repo:** wfm. **Boundary:** `runtime/rl.py`.
- **Precondition (done 2026-10-14):** the cross-batch `udr_key` trace (plan OI-R3) is recorded in the rm28 spec; no RL change is needed for raw keys.
- **Builds:** `"udr_resource"` appended to `COPY_COLUMNS` after `"district"` and added to the named optional allowlist (required for `RAN_USAGE`, `NULL` otherwise). **No change** to the collision guard, supersession or the live-row constraint — tests prove they work on raw keys. Tests 17 (RL half) and 19 (RL part) in `rm09`.
- **Visible result:** loaded rows carry `udr_resource`; a `RAN_USAGE` chunk without it makes RL raise; a non-RAN chunk writes `NULL`; an identical raw-key batch colliding with a live `BILL_APPROVED` row is still refused whole (`LOAD_BLOCKED_BILLED`); two `RATED` rows whose keys differ only in case both load (accepted behaviour, asserted); a reissue of the same `file_key` still supersedes the raw-key rows.
- **Depends on:** rm27.

### rm29 — Seeds, write-once proof, E2E and ship gate
- **Spec:** `rm29-raw-key-ship-gate.md`
- **Repo:** both (tests/CI). **Boundary:** `db/seeds/sample/**`, `tests/**`.
- **Builds:** sample seeds (`udr-rated-sample.ts`, `seed-billrun-sample.ts`, `capacity-usage-card.ts`) and `rating-ran-harness.ts` emitting raw keys and a populated `udr_resource` (one RAN row left `NULL`); `rm01-schema`, `rm23-udr-geo-frozen` (value unchanged after a card re-version; `UPDATE` refused for `rating_runtime`, `app_runtime`, `billrun_runtime`) and `grants` (`udr_resource` in no role's UPDATE list); the `rm13` journey refreshed; test 19 in full; grep and diff gates — no `casefold`/`.lower(` on key values, no `db/migrations/**` or `db/bootstrap/**` change, no billing file touched; the worker image tag / `rating_engine_version` bumped once, here.
- **Visible result:** guardrail tests 1–20 are green against a live DB; the `rm13` journey's rated row has the raw key and the expected `udr_resource`; the sample billrun seed leaves rows that billing slice 2 can read from `udr_rated` alone.
- **Depends on:** rm24–rm28. Seeds and the image bump have no standalone result, so they ride the gate.

---

## Build-order summary

| Unit | Name | Repo | Boundary | Key just-in-time dependency introduced |
| --- | --- | --- | --- | --- |
| rm01 | `rating` schema foundation | app | `db/schema/rating/**` | Four tables; live-row constraint; partman registration |
| rm02 | `event_catalog` seed | app | `db/seeds/` | Severity resolved from data |
| rm03 | `rating_runtime` role & grants | app | `db/bootstrap/` | The rating/billing boundary as a grant |
| rm03a | Kestra database & engine role | app | `db/bootstrap/` | Second database; reverse `CONNECT` revoke |
| rm04 | Kestra deployment + local stack | rating | `infra/`, `worker/`, `dev/` | Dedicated instance; worker image; mounts; no Docker socket |
| rm05 | Entra reverse proxy | rating | `infra/` | Easy Auth; IP allow-list; 7-year proxy logs |
| rm06 | Flow template + logging + sweep | rating | `flows/` | JSON Lines contract; idempotent sweep |
| rm07 | PRP — claim, validate, reject | rating | `flows/` | Reject threshold + chunk size |
| rm08 | RP — price resolution & snapshot | rating | `flows/` | Rounding-mode config; provenance columns |
| rm09 | RL — guarded transactional load | rating | `flows/` | RL transaction boundary; archive-after-commit |
| rm10 | Supersession & reprocessing | rating | `flows/` | Cross-partition supersede; shrinking-reissue |
| rm11 | Stranded-batch recovery | rating | `flows/` | Claim release after a killed worker |
| rm12 | Completeness & gap detection | rating | `flows/` | Expected cadence; alarm clearing |
| rm13 | Ship gate | both | tests / CI | — |
| rm14 | Scope reconciliation + banners | app | `context/**` | `PER_UNIT` authorized in the docs |
| rm15 | `udr_rated` shape (rename + X1 + X2) | app | migration + schema | Billing-month `period_of`; new live-row key |
| rm16 | `rating_runtime` grant extension | app | `db/bootstrap/` | Four extra read tables |
| rm17 | `perUnitRateDetailSchema` | app | `validation/rating/` | `PER_UNIT` detail contract |
| rm18 | Sample seed + MNO shape + event codes | app | `db/seeds/` | A rateable Sample-5G dataset |
| rm19 | Runtime rename + RP `PER_UNIT` | wfm | `rp.py`, `rl.py` | `PER_UNIT` math; wfm rename (R1) |
| rm20 | RP carried subscription | wfm | `rp.py` | Feed-unit join removed |
| rm21 | PRP checks + identity locks + config | wfm | `prp.py`, flow YAML | Three-factor lock; completeness (R2, R3) |
| rm22 | E2E + regressions + RL verification | both | tests / CI | `PER_UNIT` ship gate |
| rm23 | Ratecard geo on `udr_rated` (delivered as bm48) | app + wfm | migration `0045`, PRP/RP/RL | `state`/`district` frozen at rating |
| rm24 | Reversal amendments (docs) | app | `context/**` | Raw-key rules documented; "canonical" retired |
| rm25 | `udr_resource` contract + event code | app | `validation/`, `db/seeds/` | `udrResourceSchema`; `RATECARD_LABEL_INVALID` |
| rm26 | PRP raw key + exact match + label | wfm | `prp.py` | `build_udr_key`; per-cell label |
| rm27 | RP carries `udr_resource` | wfm | `rp.py` | One extra pass-through column |
| rm28 | RL writes `udr_resource` | wfm | `rl.py` | `COPY` column; OI-R3 trace |
| rm29 | Seeds, write-once, E2E, ship gate | both | seeds / tests / CI | Tests 17–20; image bump |

---

## Notes

- **rm23 is a reserved, delivered unit** (billing bm48); its number matches the `rm23-udr-geo-frozen` test name already in use.
- **No app-side read-repository unit exists.** `db/repositories/rating/**` would have no consumer; the grant assertions are raw SQL. Billing's own repository reads `udr_rated`.
- **Repo order:** app units land before the wfm units that depend on them (rm01–rm03a → Phase B+; rm15–rm18 → rm19–rm21; rm24–rm25 → rm26–rm28). rm03 before rm03a is load-bearing (`PUBLIC` `CONNECT`).
- **Configuration is introduced just in time,** one key per unit that needs it. Phase H introduces none.
- **Retention is not uniform:** `udr_rated` 7 years, `process_log` 24 months, `archive/` 7 years, `error/`/`logs/` 24 months.
- **Rate types:** `FLAT` (rm08) and `PER_UNIT` (rm19). `TIERED_*`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED` stay a spec change, not a unit; card-driven `usage_rate` raises `CARD_DRIVEN_RATING_UNSUPPORTED`.
- **`udr_key` field list** (open item 1) is closed for `RAN_USAGE`: `mno_public_id | commercial_unit | polygon_id`, identity `(partition_period, udr_key)`. The "canonical" value rule is **reversed by Phase H**; the shape stays.
- **The X2 grain is table-wide.** `UNIQUE (partition_period, udr_key, is_live)` binds every `udr_type`; a sub-monthly `udr_type` needs a `udr_type`-scoped partial index.
- **Out of scope:** the bill run's claim path, adjustments and credit notes, minimum commitments, caps, allowances, any UI, Workstream C, and (Phase H) any new `udr_rated` column, cutover guard or normalised uniqueness index.

---

## Configuration

**All rating configuration lives in Kestra.** Nothing about rating goes in `core.SYSTEM_CONFIG`, and no `rating.*` config table exists.

Rating logic lives in flow definitions and `rating_flow_revision` is stamped on every rated row, so a value that changes the rated number must move **with** the flow revision. The namespace KV store is runtime-editable and not version-controlled; a namespace file is a separate artefact with its own lifecycle. Neither may hold an output-affecting value. Those live in **flow `variables`**.

| Config | Changes rated output? | Where | Introduced by |
| --- | --- | --- | --- |
| `file_key` derivation rule per `udr_type` | Yes | Flow `variables` | rm07 |
| Reject threshold per `udr_type` (the failure policy; `0` = all-or-nothing — one key, not two) | Yes | Flow `variables` | rm07 |
| Rounding mode (one value in v1) | Yes | Flow `variables` | rm08 |
| Expected cadence and window per `udr_type` | No | Namespace KV | rm12 |
| Chunk size per `udr_type` | No | Namespace KV | rm07 |
| Log-sweep schedule and lag threshold | No | Namespace KV | rm06 |
| Mount paths | No | Container environment variables | rm04 |
| Kestra namespace (`rating`) | No | Literal in each flow's `namespace:` | rm06 |

No separate threshold stamp is needed: `udr_batch` records the flow revision, which recovers the value (while flow revisions remain retrievable — open item 4). A second rounding rule would be a product attribute on `product.product_offering_price`, a product-module change. A change to output-affecting config is a flow deployment, never a UI edit.

---

## Open items to resolve before the units they block

This table and `_newmodule-rating-engine-plan.md` §14 are the same list; close an item in both.

| # | Open item | Blocks | Owner |
| --- | --- | --- | --- |
| 1 | ~~`udr_key` field list~~ — closed for `RAN_USAGE` (see Notes). | — | Closed |
| 2 | Price as-of resolution mechanism — SQL predicate vs per-batch snapshot. | rm08 | Decide before starting |
| 3 | ~~Where per-`udr_type` config lives~~ — resolved: Kestra (see Configuration). | — | Closed |
| 3a | Database/extension version drift — local PG 17 vs Azure 16; Azure's `pg_partman` unverified; preflight assertion and local pin proposed, not implemented (`_risk-database-extension-version-drift.md`). | rm01, rm04 | Platform |
| 4 | Kestra database backup retention aligned to 7 years, with a restore test. | rm04 | At deployment |
| 5 | Flow-definition version control and deployment process — mandatory (no UI edits) but undefined. | rm06, rm05 sign-off | Must land before rm06 |
| 6 | Assertion mechanism for "no per-record fan-out". | rm13 | Ship-gate spec |
| 7 | Process-runner / custom-image spike on Container Apps. | rm04 | Before rm04 |
| 8 | Testing approach for rating logic in flow definitions (the log-line format needs a test). | rm06 | With item 5 |
| 9 | `ban_id` at rating time — accepted as resolved at bill run. | rm08 sign-off | Accepted |
| 10 | Platform design review for the second database and the `core.AUDIT_LOG` exemption. | rm03a | Platform |
| 11 | ~~Name, severity and self-clearing flag of the `\|`-in-label event code~~ — closed 2026-10-14: `RATECARD_LABEL_INVALID`, `MAJOR`, `PRP`, not self-clearing. | — | Closed |
| 12 | ~~Trace every cross-batch `udr_key` comparison~~ — closed 2026-10-14 (table in the rm28 spec; plan OI-R3 closed). | — | Closed |
| 13 | Confirm no consumer besides billing's usage query reads `udr_resource` (plan OI-R4). | rm29 sign-off | Rating + Billing |
