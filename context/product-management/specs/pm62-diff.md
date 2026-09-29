# pm62 — Diff (read-only)

**Unit:** pm62 (Part 5). **Boundary:** `services/product/ratecard/diff-versions.ts` (new) and its tests. **Read-only** — no write, no transaction, no action file, no audit event, no permission row, no component. pm66 renders it; pm63 quotes its counts.
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow step 6; goal 3) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7, RC15**, **D-A6, D-A7** · `prodmgmt-architecture.md` §3.6, §3.7 · `prodmgmt-code-standards.md` §2.28, §3.8, §3.23, §4.25, §6.33, §6.35, §7.9 · `prodmgmt-ui-context.md` §10.2 · `prodmgmt-ai-workflow-rules.md` §3.8, §4.3.
**Depends on:** **pm60** (the reads), **pm61** (a `DRAFT` to diff).

**Why this lands before Activate, though it could technically follow.** RC7's gate is only worth something if the review is real. **Without the diff, "review before activating" is a button, not a review** (build plan, Sequencing notes Part 5). Sequencing it first also means pm63's confirmation dialog is never built against counts nobody has verified.

---

## Goal

Compare a version against the current `ACTIVE` in memory and return three named buckets — added, changed, removed — so the person about to activate can see what will change before it does.

---

## Design

### D1. Three named buckets

```
{ added, changed, removed }
```

(§2.28). The service returns them in this order, and the UI renders them in this order (§4.25, ui-context §10.2), so the rendering order is a property of the contract rather than a decision pm66 re-makes.

### D2. Bucketing rules, per key

For each key `(mno_public_key, commercial_unit_public_key, polygon_id)`:

| Outgoing `ACTIVE`                   | Incoming version | Bucket                                                 |
| ----------------------------------- | ---------------- | ------------------------------------------------------ |
| absent                              | present          | **`added`**                                            |
| present, any non-key column differs | present          | **`changed`** — carries the outgoing and incoming rows |
| present                             | absent           | **`removed`** — carries the outgoing row               |
| present, identical                  | present          | _no bucket_ — unchanged rows are not reported          |

**A key present in both versions with any non-key difference is `changed`** — the non-key columns are `lkp_subscriber_ref_id` and `service_code`, and a difference in either one (or both) puts the key in `changed` exactly once. No key ever lands in two buckets, so the bucket counts sum to the number of distinct changed/added/removed keys and never disagree with the row count. Write that in the doc-block — it is the first thing a reader will wonder about.

### D3. "Removed" means exactly that

A key present in the outgoing version and absent from the upload is bucketed **`removed`** (§4.25, ui-context §10.2, D-A6). With carry-forward gone (D-A7), the label is literal: the row is **not in the new version** and stays readable in the superseded one, which is retained immutably for audit and rollback. Mediation has already filtered retired polygons out of the file upstream, so the upload is the authoritative current state.

The bucket carries the **outgoing row** so pm66 can show what is leaving. It carries no date and no outcome copy — how a future consumer resolves past periods is out of scope.

It is the one change a user cannot undo without a rollback — which is why ui-context §10.2 gives it danger tint, a deliberate departure from §1's neutral end-of-life treatment.

### D4. In memory, keyed on a delimiter that cannot collide

5,500 rows against 5,500 rows keyed on three columns is **a map comparison** — **no set-based SQL diff, no temp table** (§6.33, RC15, workflow §3.8). Two full reads and a pass over both.

The key is the three columns **joined by a delimiter that cannot occur in them** (§6.33). The columns are free-text RevOps data (§2.20) with no character excluded by rule, so a naive concatenation makes `("AB","C")` and `("A","BC")` the same key. Use the same delimiter pm58 chose for its duplicate-key check and say so — **two different delimiters in two files is the beginning of two different answers**.

### D5. The query budget is two reads and nothing more

Requesting a diff issues **two full row reads** — the selected version and the current `ACTIVE` — and nothing else (§3.23). **Never a query per row, never one query per bucket.**

Both reads go through pm60 by **version id** for the selected version and through `getCurrentActive` for the other. Reading a version by id here is a **display path, not a resolution path**, which is the §6.35 exception the doc-block should name (pm60 D5).

### D6. No `ACTIVE` version, and the other degenerate cases

| Case                                             | Behaviour                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `ACTIVE` version exists for the card          | Every uploaded key is **`added`**; the other two buckets are empty. This is the first-ever upload and it is the **normal** first case, not an error.                   |
| The selected version **is** the current `ACTIVE` | Every bucket is empty. Do not special-case it into an error — pm66 renders an empty diff, which is the truth.                                                          |
| The selected version is `SUPERSEDED`             | Diffs against the current `ACTIVE` in the same direction. pm64 computes the rollback's counts **in the other direction**; that is pm64's, not a flag on this function. |

None of these throws. A read-only service that throws on an ordinary state forces every caller to guard, and one of them will forget.

### D7. This service computes nothing about activation

It does not write anything, does not lock anything and does not open a transaction. It reads two row sets and compares them. Activation is pm63's, and the separation is what lets the diff be shown repeatedly, cheaply, without side effects.

It also performs **no resolution** — no as-of window, no `polygon_start_date <= event_time` logic, no effectivity (§1.35). A diff compares two versions at rest. The moment this file contains an effectivity window, it has stopped being a diff and become a consumer this delivery does not build.

---

## Implementation

### I1. `services/product/ratecard/diff-versions.ts`

One exported function: two version ids (or one id plus "the current ACTIVE") in, the three buckets out, with counts and rows per bucket. In memory (D4). Framework-agnostic, no `next/*` (§7.2). Doc-block carries D2's one-bucket-per-key rule, D3's meaning of `removed`, D4's delimiter note and D5's display-path exception.

### I2. Tests

1. A `DRAFT` diffed against the current `ACTIVE` returns the three bucket counts and their rows, in contract order.
2. A key whose `lkp_subscriber_ref_id` differs lands in `changed`, carrying the outgoing and incoming rows.
3. A key whose `service_code` differs lands in `changed`, carrying the outgoing and incoming rows.
4. A key whose `lkp_subscriber_ref_id` **and** `service_code` both differ lands in `changed` **once**, and the bucket counts sum to the number of changed keys — **not more** (D2).
5. An unchanged key appears in **no** bucket.
6. A key absent from the upload is bucketed **`removed`**, carrying the outgoing row.
7. **No `ACTIVE` version** → everything `added`, no error (D6).
8. Diffing a version against itself returns three empty buckets, no error.
9. **5,500 against 5,500 is one map comparison** — assert the query count is **two**, and that no SQL is issued per row or per bucket (D5).
10. Adversarial key values cannot collide across different tuples (D4) — a property test, and the delimiter is **the same one pm58 uses**, asserted by a shared constant rather than by two literals.
11. The module opens no transaction, writes nothing, and contains no effectivity window (D7).

### I3. Documentation

1. **Code-standards §7 tree** — `diff-versions.ts` marked landed under **pm62**.
2. **Code-standards §2.28** — marked landed; the three buckets of D1 and the one-bucket-per-key rule of D2 recorded.
3. **Code-standards §6.33** — the shared-delimiter requirement recorded (it currently says _"a delimiter that cannot occur in them"_ without saying that pm58 and pm62 must agree).

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npm run test` (live-DB for the read paths), `npx tsc --noEmit`, `npm run lint`.

**Prerequisites:** pm60 and pm61 merged.

---

## Verification checklist

Buckets

- [ ] Exactly three named buckets — `added`, `changed`, `removed` — returned in that order.
- [ ] A `changed` bucket carries the outgoing and incoming rows.
- [ ] A key with any non-key difference is counted **once**, in `changed`; bucket counts do not exceed the changed-key count.
- [ ] An unchanged key appears in no bucket.
- [ ] The `removed` bucket carries the outgoing row; no date, no carry-forward copy.

Computation

- [ ] The diff is **in memory** — no set-based SQL diff, no temp table.
- [ ] The query budget for a diff is **exactly two** reads; nothing per row, nothing per bucket.
- [ ] The key delimiter is shared with pm58 via one constant, and cannot collide across different tuples.

Degenerate cases

- [ ] No `ACTIVE` version → everything `added`, no throw.
- [ ] A version diffed against itself → three empty buckets, no throw.
- [ ] A `SUPERSEDED` version diffs in the forward direction; the reverse direction is pm64's.

Boundaries

- [ ] Read-only: no write, no transaction, no lock, no action file, no audit event, no permission row.
- [ ] **No effectivity window and no resolution of any kind** (§1.35).
- [ ] No `next/*` import.
- [ ] `tsc --noEmit`, ESLint, Prettier and the unit's tests green.

**Definition of done:** before anyone activates a card version, they can see the three things that will change — which polygons are new, which changed a non-key column, and which are removed from the new version — computed from two reads and no writes at all.
