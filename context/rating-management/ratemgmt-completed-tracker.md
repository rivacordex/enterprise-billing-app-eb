# Rating Management — Completed Tracker

Archive of delivered work for the Rating Management module. Compacted 2026-10-15 from `ratemgmt-progress-tracker.md` (Phases A–H, rm01–rm29). Per-unit narrative, review-fix logs and test enumerations are trimmed to key facts and decisions. Full history: `git log -- context/rating-management/ratemgmt-progress-tracker.md`. Per-unit detail: `context/rating-management/specs/rm*.md`. Unit list: `specs/rm00-build-plan.md`.

> **Pending restructure — `context/workflow-management/specs/wfm01-engine-restructure.md`.** Older entries cite `rating-engine/flows/`, `rating-engine/worker/`, `rating-engine/dev/`, `infra/bicep/modules/rating-engine-*`. After `wfm01` these are `workflow-management/flows/rating-engine/`, `workflow-management/worker/workflow-engine/`, `workflow-management/dev/`, `infra/bicep/modules/workflow-engine-*`. Historical entries are not rewritten.

## Phases

| Phase | Units        | Scope                                             | Ship gate                     | Status                                   |
| ----- | ------------ | ------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| A–F   | rm01–rm13    | Rating engine v1 (schema, engine, PRP/RP/RL, recovery, completeness) | rm13 (`072a37f`) | Completed; live Kestra execution never run |
| G     | rm14–rm23    | PER_UNIT RAN-usage update                         | rm22 (`8882008`)              | Completed (2026-10-05); rm23 delivered as billing bm48 (`b4d28e4`) |
| H     | rm24–rm29    | Raw `udr_key` + `udr_resource` cell label         | rm29 (`1ab2bd1`, fixes `f1d6550`) | Completed, DB-verified (2026-10-15); image tag release PENDING OPS |

Trust `git log` / `git show` over this file if they disagree.

---

# Phase H — Raw `udr_key` and `udr_resource` (rm24–rm29) — COMPLETED 2026-10-15

Reverses the canonical (lower-cased/trimmed) `udr_key`: PRP builds the key from raw feed values and matches the rate card exactly (Inv 27). Populates `udr_resource` = `state|district|polygon_start_date` from the matched card cell, written once by RL (Inv 28). No schema change, no migration, no grant change, no billing code.

| Unit | Name                                               | Commit    | Review / follow-up fixes                         |
| ---- | -------------------------------------------------- | --------- | ------------------------------------------------ |
| rm24 | Reversal amendments (docs)                         | `8adcb07` | `ab73f04`, `814c12b`, `8c52328`, `d8ddd02`       |
| rm25 | `udr_resource` contract + `RATECARD_LABEL_INVALID` | `56e372f` | `ab73f04`, `814c12b`, `17dfbd7`, `d8ddd02`       |
| rm26 | PRP: raw key, exact match, cell label              | `ccc6c45` | `6dd480d`, `d8ddd02`                             |
| rm27 | RP: carry `udr_resource`                           | `dd95e65` | —                                                |
| rm28 | RL: write `udr_resource`, raw-key guards           | `e955d7d` | `f1d6550`                                        |
| rm29 | Seeds, write-once proof, E2E, ship gate            | `1ab2bd1` | `f1d6550`                                        |

## Phase H per-unit notes

**rm24** — Docs only. Dated reversal notes in the design plan, rm01, rm07, rm04 and the billing docs; in-place raw-key edits to `ratemgmt-project-overview.md`; the canonical rule's source corrected to `_newmodule-rating-engine-plan.md` §4.2. **Billing lines changed (billing owner told, §0.1 rule 21):** `billmgmt-architecture.md` 197 (Inv #36), 214 (Inv #47), 351 (X1) — reworded "Superseded" → "Amended" 2026-10-15; `billmgmt-known-issues.md` 594, 861; `bm45` 34, 58, 79, 95, 106; `bm48` 22, 38, 121, 164; `billmgmt-code-standards.md` 599, 628. **Billing hits left for the billing owner (not named by plan §7):** `bm15:52`, `billmgmt-project-overview.md:375`, `billmgmt-ai-workflow-rules.md:115`, `bm46:27`, `bm45:8`, `billmgmt-completed-tracker.md` 841/851/2833.

**rm25** — `validation/rating/udr-resource.schema.ts` (strict builder + parser, `str.isspace()`-parity blank rule, whitespace-only segment refused, date shape-checked only — see decisions) and `validation/rating/udr-key.ts` (`buildRawUdrKey`, code-unit sort to match Python `sorted()`, no normalisation). `RATECARD_LABEL_INVALID` (PRP, MAJOR, not auto-clearing) → catalog 28 → 29. `udr-rated.ts` comment only. SonarQube CPD exclusion for `db/seeds/**/*.data.ts` in `sonar-project.properties`.

**rm26** — `prp.py`: `canonical_udr_key` / `_normalise_value` deleted; `build_udr_key` (raw) for both card index and row validation; `RatecardCell` carries `polygon_start_date` + `udr_resource`; chunk gains nullable `udr_resource` after `district`; post-claim `RATECARD_LABEL_INVALID` refusal via shared `_refuse_claimed_batch`; serialisation-collision guard kept (fires only on `|`/`=` collisions). Review fixed rm23's test, which still matched lower-cased polygon ids, and the `runtime/README.md` wording.

**rm27** — `rp.py` `_GEO_COLUMNS` = `("state", "district", "udr_resource")`; pricing untouched. New `rm27-rp-carry-udr-resource` suite on the maintained `rating-ran-harness`.

**rm28** — `rl.py`: `udr_resource` appended to `COPY_COLUMNS`; `_resource_value`: RAN_USAGE absent → `KeyError`, NULL/`""` → `ValueError`; non-RAN + value → `ValueError` (fail loud, review decision); non-RAN absent/NULL → NULL. Guards, supersede SQL and constraint untouched. Live cases on `rating-ran-harness` (not the legacy rm09 block, which still uses the pre-rm21 PRP CLI).

**rm29** — Seeds emit raw keys and `udr_resource` built from the stored card cell; the 3,800 capacity anchor polygons are now seeded onto the usage card (`STATE-ANCHOR`/`DIST-ANCHOR`, `POLY-ANC-<scenario>-<n>`); only `POLY-APX-UNMAPPED` stays NULL. rm01 15b, grants 10a, rm23, rm13 extended; new DB-free `rm29-raw-key-gates.test.ts` (grep gate incl. SQL `lower(`/`upper(`/`btrim(`/`trim(` and retired canonical wording in flow YAML). Flow YAML PRP comment corrected (moves `rating_flow_revision` on next deploy).

**Final verification (2026-10-15):** `tsc`, ESLint, Prettier clean; DB-free guardrails 143/143; full unit suite 8718 passed (failures = recorded baseline only). Disposable `postgres:17` via `rmtest-runner:local`: grants 40/40, rm01 28/28, rm02, rm06, rm07 36/36, rm12, rm13, rm23 2/2, rm27 5/5, rm09 21/21 outside the legacy block, capacity suites green. Capacity seed run twice: 3,804 card cells, 3,805 live rows, the only NULL is `POLY-APX-UNMAPPED`. Diff gate: no migration, bootstrap, `udr_rated` schema or billing file.

## Phase H key decisions (2026-10-15, user)

- **Version bump once, at rm29.** Image tag and `rating_engine_version` move together; intermediate builds were never deployed.
- **`polygon_start_date` in `udr_resource` is text, shape-checked only** (`YYYY-MM-DD`, never a `Date`). Code-standards §0.1 TS rules 2–4 and the rm25 spec amended to match (`formatUdrResource({ state, district, polygonStartDate })`, `buildRawUdrKey(columns, keyColumns)`).
- **No guard on `|` / `=` inside raw key values.** Feeds and cards are assumed clean; a value guard (PRP, `buildRawUdrKey`, card upload) is deferred.
- **MNO lookup `.strip()` kept** for subscriber resolution only (the key keeps the raw value). The conflict with code-standards §0.1 general rule 1 / workflow §0.1 rule 30 is accepted; docs not amended.
- **`RATECARD_LABEL_INVALID` re-drop: no dedup change.** A byte-identical re-drop is discarded as `DUPLICATE_BATCH` (`(file_key, checksum)` regardless of status). Ops workaround: fix the card, delete the REFUSED `rating.udr_batch` row (admin role; no FK/trigger references it, no `udr_rated` rows exist), clear the alarm, re-drop.
- **RL handles `udr_resource` for RAN_USAGE only;** an unmatched key already fails at PRP (`INPUT_UNMAPPED` whole-batch), so no RL shape check.
- **No real place names in rating test data** (`STATE-1`, `STATE-2`, …). Billing/customer/product files still carry real names.
- **OI-R4 (no reader of `udr_resource` yet):** outcome recorded here only; the plan copy is restored to the owner version (`e955d7d`) and still shows it open. Billing slice 2 is the first consumer. The plan-line-72 review comment (`_GEO_OPTIONAL_COLUMNS` vs `_resource_value`) is pending the owner; code follows `_resource_value`.

## Phase H outstanding

- **Release step — PENDING OPS.** Dev compose keeps `RATING_ENGINE_VERSION: dev-local` (rm04 D6 sentinel). Runbook: (1) queue `infra/azure-pipelines.yml` with `buildRatingEngine=true` (needs the rm04 D0 spike) → `workflow-engine:<tag>`; (2) deploy infra with `workflowEngineVersion=<tag>` and `workflowEngineImageName` pinned; (3) run `azure-pipelines-deploy.yml` with `workflowEngineImageTag=<tag>`; (4) record tag + date here. **Infra-owner gap:** `azure-pipelines-deploy.yml` (~355) updates only `--image`, so an image-only deploy keeps a stale `RATING_ENGINE_VERSION` (Inv #12).
- **For billing:** the billing flow's appendix CTE (`bill_run_processing.yml` ~1030, lower+btrim) no longer matches raw keys, so a seeded capacity appendix shows every polygon unmapped (bm49 no longer reads it; slice 2 removes the write). The `ci`/`volume` sample profiles (bm26, `seedSampleCharges`) still seed RAN_USAGE rows with a JSON key, FLAT, NULL `udr_resource` and no card.
- **Docs:** AGENTS.md says the plan "is not in this repo" (it is now).
- **Test-harness baseline — FIXED 2026-10-19:** rm08 (13), the rm09 legacy block (9), rm10 (5) and rm11 (2) were rewritten onto `tests/helpers/rating-ran-harness.ts` (the rm21 7-column `.udr` profile, `--subscription-product-name`, PER_UNIT, a ratecard per graph, one MNO per case). Test-only; no runtime change. Re-scoped: rm08 #11 (`LOOKUP_MISS` now from a record dated before the price starts — an unknown subscriber is a PRP `UNKNOWN_SUBSCRIBER` hard-stop since rm21), rm08 #13 (the catalog price edit flips the offering to DRAFT and back, pm36's DRAFT guard), rm10 #10 (`SHRINKING_REISSUE` under `ratecard_coverage_enforcement = WARN`; HARD_STOP refuses a smaller reissue as `RATECARD_COVERAGE_GAP` first). rm09's legacy block now runs `bootstrap-db-roles.sql` before the rating roles; rm12 test 1/2/3 has a 60 s timeout (~7 s on Windows). Result with a host Python 3.14 venv (`RATING_PYTHON3`): rm08 16/16, rm09 30/30, rm10 9/9, rm11 9/9, rm12 13/13; full integration project 1388 passed / 0 failed (6 skipped). Note: the live-row key is `(partition_period, udr_key, is_live)` — no `start_datetime` — so each case seeds its own MNO.
- **rm13 live no-fan-out guard (Test #15) — rewritten and RUN 2026-10-19 (owner decision):** first-ever live run. The old test dropped a 50,000-row pre-rm21 CSV for a dummy key (the `.udr` trigger never fires on it; rm21 would refuse it). Now it seeds (idempotently, `RATING_FANOUT_DATABASE_URL`) a `_SAMPLE_-RM13` customer/MNO/product (`_SAMPLE_-RM13 Fan-out Product`) and a 10,000-cell card, checks the deployed flow's `subscription_product_name` is that product, and drops `rating-input-file-202606150000_v<N>.udr` (June 2026) via temp-name + rename. Run on the local dev stack: the deployed flow was repointed (rev 8) for the run and restored to the exact revision-7 source (now **revision 9**, byte-identical; restore needs `Content-Type: application/x-yaml; charset=utf-8` or Kestra decodes UTF-8 comments as Latin-1). Result: execution SUCCESS, task runs within `fixed + ceil(10000/chunk)`; `UDRBAT00000005` COMPLETE 10,000/10,000, archived. **Left in the dev DB by decision:** the `_SAMPLE_-RM13` graph and its 10,000 `RATED` June-2026 rows (on its own bill cycle). `db/seeds/sample/sample-5g-fixture.ts` `insertRanRatecard` now inserts lkp rows in batches of 2,000 (Postgres 65,535-parameter cap).

---

# Phase G — PER_UNIT RAN-usage (rm14–rm23) — COMPLETED 2026-10-05

| Unit | Name                                                  | Commit    | Review / follow-up fixes   |
| ---- | ----------------------------------------------------- | --------- | -------------------------- |
| rm14 | Scope reconciliation + rm-spec banners (docs)         | —         | —                          |
| rm15 | `udr_rated` shape migration (rename + X1 + X2)        | `6205e70` | `0230658`                  |
| rm16 | `rating_runtime` grant extension                      | `d748eed` | —                          |
| rm17 | `perUnitRateDetailSchema`                             | `23dc4ca` | `657c910`                  |
| rm18 | Sample 5G seed + MNO-key shape + ten event codes      | `e397e2b` | `e26c46a`, `caa07ab`       |
| rm19 | Runtime rename + RP `PER_UNIT` computation            | `777f16f` | `0993650`                  |
| rm20 | RP price-path rewrite (drop feed-unit join)           | `d4c51d2` | `22f9994`                  |
| rm21 | PRP resolution + identity locks + checks + flow config | `967d1d7` | `795a1d7`, `3e16a4a`       |
| rm22 | PER_UNIT ship gate: E2E + rename gate + RL verify     | `8882008` | —                          |
| rm23 | Ratecard geo on `udr_rated` (as billing bm48)         | `b4d28e4` | —                          |

## Phase G per-unit notes

**rm15** — `0034` edited in place (fresh-install gate clean 2026-10-01): `udr_subscriber_ref_id` → `udr_subscription_ref_id` (+ index); X1 `rating.period_of()` → `Asia/Kuala_Lumpur` (`partition_period` is the billing month); X2 live key → `(partition_period, udr_key, is_live)`. Call-site sweep reached billing tests and scripts. Drizzle meta regeneration is a no-op (migrator never reads snapshots).

**rm16** — `rating_runtime` gains `customer` USAGE + SELECT on `customer.party_role`, `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` (enumerated, no write).

**rm17** — `PER_UNIT` branch of `udr_rate_detail` (`ratePerUnit`/`quantity`/`amountRaw`), both variants `z.strictObject`; rating-owned `decimal-string.ts` (numeric(18,6) / numeric(20,6)); `amountRaw === rate × qty` exact refine; shared golden fixtures `tests/fixtures/udr-rate-detail-golden.json` (Python parity in rm08).

**rm18** — Ten new event codes (catalog 18 → 28; the spec's "nine" was a counting error); `mnoKeySpecSchema`; `db:seed-sample-5g` (offering `"Sample 5G Services"`, direct inserts). Pure-insert builders later shared in `db/seeds/sample/sample-5g-fixture.ts`.

**rm19** — wfm half of the column rename in `rp.py`/`rl.py`; `derive_rate_type` (`usage_rate` + no `plaSpecId` → PER_UNIT; `PLA_USAGE_RATE` → `CARD_DRIVEN_RATING_UNSUPPORTED`, exit 1, no manifest, one `process_log` line; `flat_fee` → FLAT, currently unreachable); PER_UNIT `rate × qty` in `Decimal`, scale-6 raw, one rounding to numeric(18,2); `_exceeds_integer_capacity` fail-closed guard; `udr_usage_unit` = catalog unit (`Mbps`).

**rm20** — RP drops the feed `usage_unit`: no unit join predicate, `price_windows` partitioned by `(product_offering_id, component_type)` (single `usage_rate` lane; accepted risk, Inv #23).

**rm21** — `prp.py` rewrite: `resolve_pin` + `extract_ratecard` before the claim; `udrType` confirmation; factor-1 MNO resolution cached per `(mno, config_tz_date)`; identity locks; `SERVICE_CODE_MISMATCH`, `INPUT_UNMAPPED`, ratecard coverage (`HARD_STOP`/`WARN`) — all whole-batch hard-stops (REFUSED, zero rows); reject threshold checked before completeness; dedup on `(KL billing month, cell)` (R2); `product_inventory_id`/`party_role_id`/`family_id` stamped onto chunks. Flow YAML: 7-column profile, `.udr` file key, `reject_threshold: "0"`. rm07 suite DB-verified 23/23 (first rm06–rm10 DB run).

**rm22** — rm13 E2E refreshed to PER_UNIT and run 3/3 green (first full `prp→rp→rl` chain anywhere); rename gate `check:rating-rename-gate` in CI. Flagged cross-boundary fixes: `storage._local_path` cross-platform (`url2pathname`); billing `flows/bill-run-processor/` stale `udr_subscriber_ref_id` joins renamed.

**rm23 / bm48** — Migration `0045`: nullable `udr_rated.state`/`district` (write-once); PRP stamps the matched cell's labels (blank → NULL); RP passes through; RL requires them for RAN_USAGE. Inv #26. One PR under a recorded §4.1/§4.3 waiver.

---

# Phases A–F — Rating engine v1 (rm01–rm13) — COMPLETED

| Unit  | Delivered (compact)                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rm01  | `rating` schema foundation — `0034_rating.sql` (schema, `period_of()`, `udr_batch_seq`, four tables, bootstrap partitions), Drizzle typing, `rating-partman-setup` (7yr/24mo). DB-verified 2026-09-06. |
| rm02  | `event_catalog` seed + `RATING_EVENT_CODES` (16 → 18 with rm11 `BATCH_STRANDED` and bm25 `LOAD_BLOCKED_INFLIGHT`; 29 after Phases G–H). `ON CONFLICT DO UPDATE`.                              |
| rm03  | `rating_runtime` role — connection-limited, `PUBLIC` revokes, column-scoped grants, six-column `app_runtime` boundary. `grants` suite (now 40/40).                                                |
| rm03a | `kestra` DB + `kestra_engine` role (`REVOKE CONNECT FROM PUBLIC`).                                                                                                                           |
| rm04  | Kestra deploy + local dev — pinned worker Dockerfile, `kestra.yml`, Bicep gated by `deployRatingEngine=false`, local compose, `runtime/` foundation. D0 ACA process-runner spike never run.    |
| rm05  | Entra reverse proxy / Container Apps Easy Auth for the Kestra UI. Bicep clean; not deployed.                                                                                                 |
| rm06  | Flow template, `rating-logger` / `log_sweep.py`, `emit_terminal_log.py`, `deploy_rating_flows` CI stage.                                                                                     |
| rm07  | PRP claim/validate/reject — `file_key` from filename, `DUPLICATE_BATCH` pre-claim, claim before parse, six reject codes, chunked Parquet + manifest.                                          |
| rm08  | RP as-of price resolution + snapshot through the pinned offering (FLAT at v1; PER_UNIT from rm19).                                                                                           |
| rm09  | RL guarded transactional load — `BILL_APPROVED`/in-flight `BILL_DRAFT` guard, `CURRENCY_MISMATCH`, supersede hook, streamed `COPY` at `RATED`, reconciliation, archive after commit.          |
| rm10  | Supersession & reprocessing — in-txn `supersede_batch` by `file_key`; `CROSS_PERIOD_SUPERSEDE`, `SHRINKING_REISSUE`.                                                                        |
| rm11  | Stranded-batch reconcile — reaps non-terminal `udr_batch` past a KV threshold to `FAILED`, `BATCH_STRANDED` on the delivery alarm key. DB-verified 9/9.                                       |
| rm12  | Completeness & gap detection — hourly `FILE_NOT_RECEIVED`/`FILE_LATE` raise/clear; superseded-never-replaced via the orphan index. DB-verified.                                               |
| rm13  | Ship gate — §10 guardrails in CI, no-fan-out test #15, E2E journey, `rating-migration-boundary` check, off-by-default fan-out and ZAP stages.                                                  |
| bm25  | (billing-owned) Rating in-flight guard — RL refuses `BILL_DRAFT` collisions (`LOAD_BLOCKED_INFLIGHT`), backed by the `rating.rating_status_guard` trigger. Pure-DB suites 88/88.               |

## Phases A–F key decisions

- **2026-08-28 — flow definitions live in this repo** (now `workflow-management/flows/rating-engine/`), deployed by `deploy_rating_flows`.
- **2026-08-27 — rm04 engine infra lives in this repo** (shares `main.bicep`'s deployment graph).
- **2026-08-27 — D0 is a deploy gate:** `deployRatingEngine` defaults `false` and gates every rm04 resource.
- **rm01 ripple:** every integration `beforeAll` drops the `rating` schema before `core`.

---

# Open questions and follow-ups carried forward

**High priority**

- **`rl.py` `period_of` truncates in UTC** (still true 2026-10-15, `rl.py:208`), while the DB `period_of()`, the `udr_rated_period_matches_check` CHECK and PRP use `Asia/Kuala_Lumpur` (X1). A month-boundary event (e.g. `2026-09-01 00:30 +08`) fails the COPY. It fails closed (no corruption) but a valid boundary batch cannot load. Fix: truncate in KL in `build_chunk_rows` and `scan_and_guard`. Needs owner acknowledgement.
- **Release / deploy prerequisites:** rm04 D0 spike; rm05 Entra provisioning + D10 sign-off; rm06 `deploy_rating_flows` gaps (ADO→webserver network, KV read grant, `kestra` CLI flags); rm13 `pip install --require-hashes` on a hosted agent; the first live Kestra execution of every flow (none has run).

**Runtime follow-ups**

- **`rp.py` `--subscriber-ref-column` still `required=True`;** the flow passes the literal `product_inventory_id`. A follow-up `rp` unit should read the stamped column by a fixed name and drop the arg; do not remove it from the flow before then.
- **Repair the legacy rm08–rm11 suites** to the post-rm21 PRP CLI (29 baseline failures).
- **bm25 supersede-vs-inflight:** a reissue whose prior-run row is held in flight but absent from the incoming set trips `rating_status_guard` as a raw exception (batch stranded at `PROCESSING`, reaped to `FAILED`). Add a pre-supersede in-flight refusal once bm27 produces real `BILL_DRAFT` claims.
- **RL-alarm clearing:** `PARSE_FAILURE`, `LOOKUP_MISS`, `BATCH_PARTIAL`, `TASK_RETRY_OK`, `DB_WRITE_FAILURE` have no `CLEARED` emitter.
- **PRP dedup** matches `(file_key, checksum)` regardless of status (rm11 item 1, rm26 re-drop). Excluding REFUSED/FAILED batches is a future unit.
- **As-of subscription status (rm21):** `_RESOLVE_SQL` gates on the current `pi.status = 'ACTIVE'`. The as-of form needs `inventory_status_history` + a grant change + spec amendment; revisit when subscription lifecycle and historical re-rating are real.
- **`.udr` header + datetime format unconfirmed (rm21):** PRP keeps header-skip + `datetime.fromisoformat`; confirm with upstream before the first live feed.
- **Multi-unit `usage_rate` (rm20, accepted risk):** enforce "≤1 `usage_rate` unit per offering" on the product write side when Workstream C ships.
- **`db:seed-sample-5g`** itself has not been run end-to-end (the suites use the shared fixture builders).
- **Phase B:** carry escalation E1 (pgledger `SECURITY DEFINER` `FROM PUBLIC` revoke) to the billing module.

**Per-unit notes still open**

- **rm06** — `log_sweep.py` malformed-line summary uses an uncatalogued code under `INDETERMINATE`; commit→rename residual window (duplicates, never loss); generic `STUB_EXECUTION_*` codes.
- **rm07** — file-trigger plugin props and chunk-size KV read unconfirmed vs Kestra v1.3.35; `RATING_USAGE_WEBHOOK_KEY` is dead wiring; `event_time_assumed_tz` default to confirm.
- **rm09** — `LOOKUP_MISS` folds into `discarded_count`; `PARTIAL` on any shortfall; Blob archive path authored-not-run; `CURRENCY_MISMATCH` inner join misses an unresolved BAN; a REFUSED/FAILED file re-refuses every cycle until removed.
- **rm10** — cross-period detection correlates by `udr_key` alone; `SHRINKING_REISSUE` compares `parsed_count`, not live rows.
- **rm11** — "on flow start" trigger uses a `Schedule` backfill, unconfirmed vs v1.3.35.
- **rm12** — cross-midnight attribution by `received_at` UTC day (false `FILE_NOT_RECEIVED`); raise/clear idempotency depends on the 5-min sweep lag; KV config is a delimiter scalar.
- **rm13** — rating migrations identified by filename; the scanner can't catch an unqualified `SET search_path = billing` write.
- **rm03 / rm03a** — `kestra_engine` `CONNECTION LIMIT 20` is a placeholder; `grants` suite never extended with rm03a assertions; E1 (above).
- **rm04 / rm05** — Managed-Identity Blob auth unconfirmed; `requireAuthentication` omitted (not on the Container Apps schema); Entra sign-in-log export is a manual tenant-scoped step.
- **Naming quirks (cosmetic)** — `event_catalog_default_severity_check`; `RATING_EVENT_CODES` in a sibling `.data.ts`; `.integration.` infix on test files.

**Environment notes**

- Rating DB-gated suites run on a disposable Postgres only (billing known-issues §13). The working recipe is a throwaway runner container (`rmtest-runner:local`: Python 3.12 + polars + psycopg + Node 22, `RATING_PYTHON3=/app/.venv/bin/python3`) against a sentinel-marked `postgres:17`; create `app_runtime`/`app_migrate` first on a bare cluster.
