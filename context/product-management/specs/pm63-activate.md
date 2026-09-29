# pm63 — Activate

**Unit:** pm63 (Part 5). **Boundary:** `services/product/ratecard/activate-version.ts` (new), `actions/product/activate-ratecard-version.action.ts` (new — `EXPECTED_PRODUCT_ACTION_FILES` **+1**), the `RATECARD_VERSION_ACTIVATED` audit type and its ripple, guardrails 36 and 39, and this unit's live-DB and concurrency tests. **No UI** — pm66 builds the dialog.
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow steps 7–8; goals 4, 6) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7, RC11**, **RV1, RV3**, **D-A7** · `prodmgmt-architecture.md` §3.6, §5 (Audit), Inv. **#45, #46, #57** · `prodmgmt-code-standards.md` §1.13, §1.37, §1.43, §3.21, §3.22, §6.30, §6.33, §6.35, §7.9, guardrails 36/39 · `prodmgmt-ai-workflow-rules.md` §1 (permanent rules), §4.3, §5.6, §7.4, §8.6, §8.7.
**Depends on:** **pm61** (a `DRAFT` to activate), **pm62** (the diff — the control the gate depends on), **pm60** (the lock and the status write).
**Scope note — carry-forward was removed (D-A7):** mediation filters retired polygons out of the CUPS file upstream, so an upload is the authoritative current state and a version is exactly its file. There is no `retired_at`, no `carried_row_count`, no RV9 and no `carryForwardRetiredRows`.

**Activation is now small, and the one failure mode left is the quiet one.** A status read outside the transaction produces two `ACTIVE` versions, or a supersede of the wrong one, and no error reports it. Its own unit, its own concurrency tests, its own review.

---

## Goal

Promote a `DRAFT` to `ACTIVE` and demote the prior `ACTIVE` to `SUPERSEDED` — two status flips, in one transaction under one lock read on `tx`, writing **no lookup rows**.

---

## Design

### D1. One transaction, one lock, and the status read on `tx`

`activateVersion` locks the card's current `ACTIVE` version `FOR UPDATE`, **re-reads its status inside the transaction immediately before the decision** (§1.13, §1.37), then promotes, demotes and writes the audit event — and commits.

**This is the TOCTOU bug this module has paid for four times** (pm14, pm15, pm16, pm20). A pre-transaction status read is a **review-blocking defect on sight** (workflow §1, permanent rules). The locked read comes from pm60 (`findActiveForUpdate`); this unit supplies the decision, never its own unlocked read.

The `DRAFT` being promoted is locked too. Two users activating two different drafts of one card must serialize, not interleave.

### D2. The three steps, in order, in one transaction

1. **Lock** the card's current `ACTIVE` (if any) and the target `DRAFT`; re-read both statuses on `tx`.
2. **Promote / demote** — the `DRAFT` becomes `ACTIVE`; the prior `ACTIVE` becomes `SUPERSEDED` with `superseded_by_version_id` set; `activated_by` / `activated_at` written.
3. **Audit** — write the event, with counts from pm62's diff computed against the locked outgoing version (D5).

**No row writes, no `INSERT … SELECT`** (D-A7). The new version's rows are exactly its uploaded file; a key the upload dropped is simply not in it, and stays readable in the superseded version. Activation and rollback (pm64) now have the same shape.

### D3. A second `ACTIVE` is refused by the index, not by this code

The partial unique index on `card_name WHERE status = 'ACTIVE'` (pm57 D5, Inv. #45) is the enforcement. **The service-layer status check stays** — the index changes the **failure mode**, it does not replace the check (§6.30).

Both matter: the check gives a typed refusal with a message; the index guarantees the invariant even against a direct SQL write or a race the lock somehow missed. Guardrail 39 (landed at pm57) asserts the index arm; this unit asserts the service arm and the **race**.

**Concurrency is proven, not assumed** — this module's own standing lesson. Two concurrent activations of two drafts for one card, looped 4×, must serialize on the lock and produce exactly one `ACTIVE`. Same for the activate-vs-rollback pair, which pm64 owns from its side.

### D4. `ratecard : EDIT`, and the diff is the gate

Activation is `ratecard : EDIT` — **the same level as upload**, so one RevOps user is never blocked mid-task (RC7, §8). **It is gated by the diff review, not by a higher level** (architecture §4).

That is a deliberate design choice and it is worth stating in review: the control on the act with billing consequence is the **information in front of the user** (pm62's three buckets, rendered by pm66's confirmation), not a second permission. If that trade is ever questioned, the answer is to strengthen the confirmation, not to invent a `ratecard : APPROVE`.

### D5. The audit payload is the durable record of what an activation moved

`RATECARD_VERSION_ACTIVATED`, written in the **same transaction** as the data change (§1.43). Its payload carries the **superseded version id** and the **change counts** from the diff (added / changed / removed).

That payload is load-bearing rather than decorative: it is the durable record of which version replaced which, and of what moved between them. **If an auditor later asks what an activation did, this payload is the honest answer** — "here is which version replaced which, and here is what moved."

The counts come from pm62's diff, computed **inside the transaction against the locked outgoing version**, not from counts the client supplied. A client-supplied count in an audit record is a record of what someone was shown, not of what happened.

Full three-part ripple, including the `tests/components/audit-log-filters.test.tsx` assertion that **`tsc` does not catch** (§6.18, workflow §7.4). Second of three; pm64 lands the third.

### D6. Versions are immutable, and activation writes no rows

Activation changes **statuses and provenance columns** only. It inserts, edits and deletes **no lookup row** (RC11, RV3, Inv. #46). There is no `updateLookupRow` to call — pm60's surface does not have one, which is what makes this true by construction rather than by discipline.

---

## Implementation

### I1. `services/product/ratecard/activate-version.ts`

D2's three steps in one transaction, using pm60's locked read, `setVersionStatus` and the audit write. Framework-agnostic, no `next/*` (§7.2). Typed result union, never a throw (general §2.9). Doc-block states D1's `tx`-read rule and D6's no-row-writes rule, and notes that carry-forward was removed (D-A7) — its absence is the thing a reader familiar with the earlier carry-forward design will question.

### I2. `actions/product/activate-ratecard-version.action.ts`

`requirePermission('ratecard', 'EDIT')` → `isRedirectError` catch → `safeParse` the version id against its `RCV` format schema → one service call → `revalidatePath('/products/rate-card')` → typed result (§3.7, §3.22).

### I3. Guardrails

- **36 — a version is exactly its file** (§9, RV3, D-A7): after every activation the incoming version's stored row count equals its `row_count`, and neither version's rows changed.
- **39** was landed at pm57 (the index arm). This unit adds the **service** arm and the race.

### I4. Tests — live-DB, with the races looped 4×

1. Activation promotes the `DRAFT`, demotes the prior `ACTIVE` to `SUPERSEDED`, writes `superseded_by_version_id`, `activated_by` and `activated_at` — **in one transaction**.
2. **No lookup row is written**: both versions' rows are byte-identical before and after, and the incoming version's stored rows equal its `row_count` (D6).
3. A second `ACTIVE` for one `card_name` is refused **by the partial unique index**; and the service refuses it first with a typed code.
4. **Two concurrent activations for one card, looped 4×**, serialize on the lock and leave exactly one `ACTIVE`.
5. Exactly **one** audit event, in the same transaction, carrying the superseded id and the change counts **computed inside the transaction**.
6. `ratecard : READ` is refused at the action guard with no partial effect.

### I5. Documentation

1. **Code-standards §7 tree** — `activate-version.ts` and its action marked landed under **pm63**.
2. **Code-standards §3.21** — second of three movements recorded.
3. **Architecture §5 (Audit)** — second of three types marked landed; the payload's contents confirmed against D5.
4. **`pm00-build-plan.md`** — the hand-off register reaffirmed: the diff, the DRAFT gate, immutability and rollback are the controls around every activation with billing consequence. This delivery stands up the table; no consumer is built.

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run test` (live-DB integration **and** concurrency, against disposable ephemeral Postgres 16 containers — never the dev stack's own `DATABASE_URL`), `npx tsc --noEmit`, `npm run lint`.

**Prerequisites:** pm60, pm61, pm62 merged. **G-RC3** for the permission the guard names.

---

## Verification checklist

Transaction and lock

- [ ] Promote, demote and the audit event are **one transaction**.
- [ ] The outgoing `ACTIVE`'s status is read on `tx`, `FOR UPDATE`, **immediately before the decision** — no pre-transaction read anywhere in the path.
- [ ] The target `DRAFT` is locked too.
- [ ] Two concurrent activations for one card, **looped 4×**, serialize and leave exactly one `ACTIVE`.

Enforcement and immutability

- [ ] A second `ACTIVE` is refused by the **index**, and by the service check before it.
- [ ] **No lookup row is written** — no `INSERT … SELECT`, no update; both versions byte-compared before and after.
- [ ] The incoming version's stored rows equal its `row_count`.
- [ ] `ratecard : READ` is refused at the action guard with no partial effect.

Audit and lists

- [ ] Exactly one `RATECARD_VERSION_ACTIVATED`, in the same transaction, carrying the superseded id and the change counts **computed server-side inside the transaction**.
- [ ] All three parts of the audit ripple landed, including the assertion `tsc` does not catch.
- [ ] `EXPECTED_PRODUCT_ACTION_FILES` +1; running total now **two of three**.
- [ ] `revalidatePath` names `/products/rate-card` only.

Guardrails

- [ ] **36** (a version is exactly its file) landed and green.
- [ ] **39**'s service arm and race added to the index arm pm57 landed.
- [ ] `tsc --noEmit`, ESLint, Prettier and the unit's suites green.

**Definition of done:** activating a card version promotes one and supersedes one — two status flips under one lock, no rows written — so each version remains exactly its uploaded file, and the audit row says exactly what moved. This delivery stands up the table; no consumer is built.
