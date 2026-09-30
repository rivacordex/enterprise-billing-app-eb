# pm68 — Ship gate

**Unit:** pm68 (Part 5, last unit). **Boundary:** guardrail re-scoping and verification, the §8 sweep, the doc amendments, Appendix A rows **A10–A14** cleared **by grep**, and the Part 5 hand-off register written. **No feature code.** If this unit finds itself writing behaviour, a previous unit was incomplete and the fix belongs there.
**Specs from:** `pm00-build-plan.md` Part 5 › pm68, the C-table, and the hand-off register · `prodmgmt-code-standards.md` §9 (guardrails 1/13 re-scoped, 36/37/39/40 new), §8, Appendix A **A10–A14** · `prodmgmt-architecture.md` §1, §2, §4, §6, §7 · `prodmgmt-ai-workflow-rules.md` §2.4, §7.2, §7.5, §7.6, §8 (the whole run list), Appendix A **W6–W8**.
**Depends on:** **pm57a–pm67** (the full Part 5 build sequence).

**The gate is never folded into the last feature unit** (workflow §2.4). It is where the permission map, the doc amendments and the Appendix A rows are cleared **by grep**, and where the re-scoped guardrails are **proven rather than assumed**. Guardrails 36/37/39/40 land **with the units they cover** (§2.2) — deferring them here would repeat the pm24 finding this module has already paid for once.

---

## Goal

Prove, item by item and by command rather than by memory, that the rate card ships whole: four new guardrails landed with their units, two re-scoped ones passing, `EXPECTED_PRODUCT_ACTION_FILES` moved by exactly three, `product_offering_price` and `0006_product.sql` byte-identical, and no document still describing a card shape, a permission count or a repository path the code does not have.

---

## Design

### D1. Guardrails 36/37/39/40 are **verified as landed with their units**, not landed here

| #      | Subject                       | Landed at                           | What this gate re-verifies                                                                                                                                                                                                               |
| ------ | ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **36** | A version is exactly its file | pm63                                | Activation is two status flips and **writes no rows**; a version's stored row count equals its `row_count` (RV3, D-A7); no `retired_at` / `carried_row_count` column exists; **no path selects from a `SUPERSEDED` version**.            |
| **37** | Upload is the only write path | pm60                                | The repository exports no update or delete of a **lookup row**; the one delete export, `deleteDraftVersion`, is version-level and **`DRAFT`-guarded** (D-A11); a direct `UPDATE`/`DELETE` against an `ACTIVE` version's row is rejected. |
| **39** | One `ACTIVE` per card         | pm57 (index) + pm63 (service, race) | A direct SQL insert producing a second `ACTIVE` is rejected **by the partial unique index**, not by application code.                                                                                                                    |
| **40** | No cache on the card          | pm65                                | No `unstable_cache`, `revalidate`, React `cache()` or module store wraps any card read; the page is `force-dynamic`.                                                                                                                     |

**If any of the four was not landed with its unit, that is a finding this gate records — it does not quietly land it here.** Landing a guardrail at the gate makes it a formality; landing it with the unit makes it a test.

> **Not built:** guardrail **35** (reserved column) — `rate_per_unit` is now a plain nullable column (D-A2), no CHECK, nothing to guard. Guardrail **38** (partition-key parity) — this delivery makes no `product_offering_price` change and no `rp.py`/bill-run partition amend, so there is no three-site parity to check. Neither guardrail exists in the code and neither is verified here.

### D2. The two re-scoped guardrails, and the sentence that must not be inherited

| #                    | Re-scope                                                                                                                                                                                                                                                                                                                                                                                                       | Proof required                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **1 — authz matrix** | Gains **four** `/products/rate-card` rows at both levels, **in both directions**: `READ` reaches the list, rows and diff and is refused all three mutations **at the action guard**; `EDIT` reaches all three.                                                                                                                                                                                                 | The four rows, run both ways.                  |
| **13 — schema-diff** | **Re-baselined for the TWO NEW TABLES ONLY**: `ratecard_version` and `RATECARD_RAN_USAGE_LKP`, both partial unique indexes (`ACTIVE`, `DRAFT`), the row-key uniqueness constraint and its index. **`rate_per_unit` is a plain nullable `numeric(18,6)` with no CHECK**; `service_code` is a plain `text` column. **No `product_offering_price` change appears in the diff.** An **exact diff**, not a removal. | The diff, against a database built from empty. |

**"The pricing update adds no row to the authz matrix" must not be carried forward into this gate** (§9, workflow §7.5). **This update adds four**, and this gate says how many **explicitly**. Inheriting that sentence is a named failure mode, not a hypothetical.

> **Not built:** the extensions of guardrail **16** (grandfathering — no card ever chooses an offering because nothing consumes the card) and guardrail **27** (`service_code` price-completeness CHECK — `service_code` is not on `product_offering_price`). Neither extension exists in this delivery.

### D3. The §8 sweep — the items that are not numbered guardrails

Each is checked by command, not by reading:

1. **`EXPECTED_PRODUCT_ACTION_FILES` moved by exactly three** (§3.21) — `upload-`, `activate-`, `rollback-ratecard-version.action.ts`. Assert the **total**, not three separate increments.
2. **The three audit types** are present in `AUDIT_EVENT_TYPES`, in `AUDIT_EVENT_CATEGORY_MAP` **and** in the count/optgroup assertions of `tests/components/audit-log-filters.test.tsx` — **the last of which `tsc` does not catch** (§6.18). This has bitten every write unit in this module's history; check it by running the test, not by reading the file.
3. **`product_offering_price` and `0006_product.sql` are BYTE-IDENTICAL** to `main` — this delivery touches no delivered table (plan §11, RC12). Assert by `git diff` producing nothing on either path.
4. **The upload query budget holds** (§3.23) — **including after a failed upload**. No per-row query, no `Promise.all` over rows (and no referential/RV8 query — this delivery has none). The page budget too: one versions query + count; one paged rows query + count; two full reads for a diff.
5. **The CSV parser is imported in exactly one file** (§7.10) — by grep.
6. **`ratecard` carries no grant overlap** with `products`, `product_orders` or `product_inventory` **in either direction**. Holding `products : DELETE` grants nothing on the rate card.
7. **`types/rbac.ts` has 15 members**, counted in the file.
8. **No backfill or data-fix script exists** anywhere in the result (pm57 D12) — the **absence** asserted, not merely unwritten.
9. **No `app/api/product*` path**; §5.3's absence guardrail unchanged.
10. **No `db/schema/rate-card*` file**; no `lib/ratecard*` helper; no `landing/` or staging folder; no second parser import; **no file under `workflow-management/**`** (§7.12) — this delivery makes no rating/flow change.
11. **The upload contract is OR7′ + D-A8, by grep.** The ten header strings (`MNO Name` … `Rate per Unit`) are spelled **once**, in the header map in `validation/product/ratecard.schema.ts` — the parser, the service, the UI sniff, the seed and the tests import it. `RateCardUploadViolation` has exactly **three** members, and `SNAPSHOT_DATE_NOT_CONSTANT` appears nowhere in the tree. No code reads `snapshot_date` from a file; it is set in `upload-version.ts` from the upload instant in the app timezone.

### D4. Doc amendments — landed, and each checked where it lives

Every one of these was supposed to land with its unit (workflow §7.1). This gate **verifies** them and records any that did not:

| Doc                                       | Amendment                                                                                                                                                   | Owed by     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `prodmgmt-architecture.md` §1             | Permission count 14 → 15 (**C5**, W7) — **already correct in the tree; verify-only**                                                                        | pm57a       |
| `prodmgmt-architecture.md` §2             | Repository path flat (**C6**, W6) — **already flat; verify-only**                                                                                           | pm60        |
| `prodmgmt-code-standards.md` Status block | The pm35–pm45 drift (**W8**)                                                                                                                                | this unit   |
| `prodmgmt-ui-context.md` §10.1            | Badge `RateCardStatusBadge` (**C1**) — **already renamed; verify-only**                                                                                     | pm65        |
| workflow §3.11 + code-standards §3.17     | `tab` admitted as a third param (**C3**)                                                                                                                    | pm65        |
| `prodmgmt-ui-context.md` §10.6            | Exports removed/deferred (**C4**); Discard: **C2 reopened & resolved via D-A11** (replace-on-reupload) — the standalone discard dialog stays removed        | pm65 / pm66 |
| `prodmgmt-code-standards.md` §4 item 23   | `RateCardDiffBadge` admitted (**C9**) — **DONE 2026-09-27**: added as the ninth binding name ("Nine, and no more") + §7 tree entry; verify-only at the gate | pm65        |
| `prodmgmt-code-standards.md` §4.31        | The page's one CTA is **Activate** (**C10**) — **still pending**: §4.31 currently reads "Upload new version"                                                | pm66        |
| `context/architecture.md` §3              | The parse-and-discard follow-up (§6.36) — **proposed, not written** (workflow §7.9)                                                                         | pm61        |

**Not built:** the `prodmgmt-architecture.md` §3.5 / `prodmgmt-code-standards.md` §6.29 _"stale pm51 partition"_ amendment (that was **pm59's**, and pm59 is withdrawn — this delivery makes no `lead()` partition change), and the `ratemgmt-architecture.md` `rm08` amendment (Phase B, out of scope). Neither is verified here.

**Every `C` row above must be resolved where it was found** (build plan). A conflict closed by editing one side and moving on is how the original defect was created (workflow §7.10).

### D5. Appendix A rows A10–A14 — cleared by grep, never from memory

| Row     | Clears with                         | Expected state at this gate                                                                                                                                                                           |
| ------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A10** | The `rateCardLookUp`-is-a-name rule | **Retired.** `rateCardLookUp` stays a validated name only (Inv. #42 unamended), so the rule is not superseded and there is nothing to track.                                                          |
| **A11** | `0041` live in `main`               | Clear — the two new card tables (§6.23).                                                                                                                                                              |
| **A12** | `0041` live in `main`               | Clear — both card tables in `db/schema/product.ts`, no `rate-card*` file.                                                                                                                             |
| **A14** | **A future consumer**               | **Stays open.** pm65's page banner — _"No consumer reads this table yet"_ — is true and **stays** until a consumer exists; it is meant to be deleted then, not now (plan §8). Annotate; do not clear. |

**Not built:** **A13** (the `product_offering_price` uniqueness re-key under its new name) — this delivery makes no price-table change and no re-key (plan §11), so the row has no code to clear against and is retired.

**A row that outlives its code is drift** (workflow §7.2). Equally, **a row cleared early is a lie** — A10 and A14 both look clearable and are not. Record the grep for each, cleared or not.

### D6. Part 4's Appendix A rows are not this gate's

Rows **A1–A9** belong to pm56, Part 4's ship gate. This delivery is **decoupled from Part 4** (plan §1, §11) — it touches no delivered table and depends on no Part 4 unit. If Part 4 has not shipped, say so; do not clear its rows from here and do not treat their state as this gate's problem.

### D7. The Part 5 hand-off register

Written here (build plan). It carries **OR3, OR4, OR7′ (resolved 2026-09-25 — carried as a record; reopened only by a change to the RevOps export layout), OR-RET, H1, H4, H5, H6, H7** with their reopening triggers, plus the items Part 5's own units generated. (**Retired:** OR5 — one seeded card, D-A5; OR11 — Part 4 decoupled; OR12 — no rate significance; RC5 — no rating consumer, so no accepted drift. See plan §12.)

- **D-A11 (pm57a D2 / pm61 D12)** — an open `DRAFT` is **replaced** by the next upload for the card (via `deleteDraftVersion`), so a wrong upload no longer bricks the card. This **supersedes the earlier "abandoned draft blocks the next upload" hand-off**: there is no standalone discard control (C2's dialog is still not built), but the trap it named is gone. Reopening trigger: a request for an explicit discard button, or for the discard to be audited as its own event.
- **pm64 D2** — **a rollback loses the keys added since** the target version was superseded. That is what rolling back means; the way to keep them is a corrected upload. Reopening trigger: a user expecting a merge.
- **pm66 D9** — raising `bodySizeLimit` **further** triggers the RC15 revisit: past ~50k rows the schema is unchanged and the **loader** must change.
- **pm57a D4 (as-of index dropped)** — the original `0041`'s `..._as_of_idx` is not carried; with `polygon_start_date` out of the row key nothing reads rows by date here. Consequence for the future consumer: it inherits an **as-of index creation on a populated table** (likely `CREATE INDEX CONCURRENTLY`), a different operation from creating it empty. Reopening trigger: the rating consumer's plan.
- **D-A9 / D-A10 (row-key shape)** — `polygon_start_date` is out of the key and `state`/`district` are non-key; both are flagged as _candidate_ future key components. These are planner's calls made before the consumer exists. Reopening trigger: the rating consumer needing as-of-by-date or per-district resolution — resolved by a **new version** under the new key (versions are immutable and per-version rekeyable), not a live-row rewrite.
- **OR-RET** — over the long run `RATECARD_RAN_USAGE_LKP` accumulates one slice per version; a retention/purge policy for superseded versions is deferred to a later plan (plan §12). Reopening trigger: storage growth becomes a concern. Not a stand-up blocker — the hot path stays version-scoped by the leading `ratecard_version_id` index.
- **C9** and **C10** — the two conflicts Part 5's specs found that the original C-table did not carry.

**Recorded here, not written into the `ratemgmt-*` or `billmgmt-*` docs** — cross-module doc edits need their own approval (workflow §7.9). None of these is a defect; each is scoped out by the update overview.

---

## Implementation

### I1. Run the gate

Full CI suite green on a database **built from scratch**: `npx tsc --noEmit`, ESLint, Prettier, the full test suite, SAST and the DAST baseline clean. `next build`.

Green and unchanged: **View Product, Manage Products, Orders, Subscriptions and every Administration route**; the **rating and bill-run flows**.

### I2. Verify D1 and D2, by command

Each of the six guardrails (four new, two re-scoped) run and its result recorded with the command that produced it. D2's byte-identical `product_offering_price` / `0006_product.sql` statement written out.

### I3. Sweep D3

Ten items, ten commands, ten recorded outputs.

### I4. Land and verify D4, D5, D7

The doc amendments checked where they live; any that did not land with its unit recorded as a finding **and landed here with that fact noted**. The four Appendix A rows (A10, A11, A12, A14) grepped. The hand-off register written.

Also: **`prodmgmt-code-standards.md`'s Status block** and **workflow Appendix A W8** — the pm35–pm45 delivery-record drift. `dev1` now carries Part 3 plus pm46 onward, so the claim is true by construction; the Status block still says otherwise. **Correct it, with the verification command and its output** — or restate it as open with the reason (workflow §8.16).

### I5. The evidence table

The gate's deliverable is not a checklist of ticks but a table saying, **item by item, how each claim was proved**: the command, its output, and the date. A gate that asserts is a gate that will be re-run by the next person; a gate that evidences is a gate that closes.

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run test`, `next build`, `npm run db:migrate` (from empty), `npm run db:seed`, `npm run db:seed-demo`, the rating and bill-run flow runs (asserted **unchanged**), the SAST and DAST baselines, plus targeted `grep`s for D3 and D5.

**Prerequisites:** pm57a–pm67 merged. No Part 4 dependency — this delivery is decoupled (plan §1, §11).

---

## Verification checklist

Guardrails

- [ ] **36, 37, 39, 40** verified as **landed with their units**; any that was not is recorded as a finding.
- [ ] Guardrails **35** (reserved column) and **38** (partition parity) are **withdrawn** and are not verified — `rate_per_unit` is a plain nullable column, and no `product_offering_price` partition exists.
- [ ] **1** gains four `/products/rate-card` rows at both levels in both directions; the pricing update's _"adds no row"_ sentence is **not** inherited, and the count is stated.
- [ ] **13** re-baselined for the **two new tables only**, passing as an exact diff from an empty database; **no `product_offering_price` change appears**.
- [ ] The extensions of **16** (grandfathering) and **27** (`service_code` price CHECK) are **withdrawn** and not verified.

The §8 sweep

- [ ] `EXPECTED_PRODUCT_ACTION_FILES` moved by **exactly three**, asserted as a total.
- [ ] **`product_offering_price` and `0006_product.sql` are byte-identical** to `main` — `git diff` produces nothing.
- [ ] Three audit types in `AUDIT_EVENT_TYPES`, in `AUDIT_EVENT_CATEGORY_MAP` **and** in the filter test's count/optgroup assertions — the last verified by **running** the test.
- [ ] The upload query budget holds **including after a failed upload** (no referential/RV8 query); the page budget holds.
- [ ] The CSV parser is imported in **exactly one** file.
- [ ] `ratecard` has **no grant overlap** with `products`, `product_orders` or `product_inventory` in either direction.
- [ ] `types/rbac.ts` has **15** members, counted in the file.
- [ ] **No backfill script exists** — absence asserted.
- [ ] No `app/api/product*`; no `db/schema/rate-card*`; no `lib/ratecard*`; no `landing/` or staging folder; no second parser import; no `workflow-management/**` file.
- [ ] The ten header strings are spelled once (the header map); `RateCardUploadViolation` has three members; `SNAPSHOT_DATE_NOT_CONSTANT` appears nowhere; `snapshot_date` is set only by the upload service (D-A8).

Documentation

- [ ] Every row of D4's table verified **where it lives**; anything that did not land with its unit is recorded as a finding.
- [ ] **C1, C2, C3, C4, C5, C6, C8, C9, C10** each resolved and recorded — none closed by editing one side. (**C7 withdrawn** — it was pm59's stale pm51 partition instruction.)
- [ ] Appendix A **A11, A12 cleared by grep**, with the greps recorded; **A13 retired** (no price-table re-key).
- [ ] **A10 and A14 left open**, annotated, with their future-consumer clearing conditions stated.
- [ ] Code-standards' **Status block** and workflow **W8** corrected with the verification command, or restated as open with the reason.
- [ ] The cross-module edit (`context/architecture.md` §3) is **proposed, not written**.
- [ ] **No doc still describes a card shape, a permission count or a repository path the code does not have**, and no Appendix A row outlives its code.

Build gates

- [ ] `tsc --noEmit`, ESLint, Prettier, the full suite, SAST and the DAST baseline clean, on a database **built from scratch**.
- [ ] View Product, Manage Products, Orders, Subscriptions and every Administration route green and **unchanged**.
- [ ] The rating and bill-run flows green and **unchanged** — this delivery touches neither.
- [ ] No `TODO`, commented-out code or `console.*` on the branch; no secret.

Hand-off

- [ ] The Part 5 hand-off register is written, carrying the surviving ORs, OR-RET, H1/H4/H5/H6/H7, and the items Part 5's own units generated (D7), each with its reopening trigger and owner.

**Definition of done:** Revenue Operations owns a rate card end to end — uploaded, validated, reviewed, activated, rolled back — nothing consumes it yet and the page says so in a banner that is meant to be deleted, and the evidence table records, line by line, the command that proved each of those claims rather than the memory that asserted it.
