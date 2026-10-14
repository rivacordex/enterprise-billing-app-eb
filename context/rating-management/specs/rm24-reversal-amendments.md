# rm24 — Reversal amendments (docs) — Spec

- **Unit:** rm24 of Phase H (`rm00-build-plan.md`)
- **Repo:** app (docs only) · **Boundary:** `context/**` plus `_newmodule-rating-engine-plan.md` (planning root). No code, no tests.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` §7 and R1–R8; `ratemgmt-architecture.md` Inv 19, 27, 28; `ratemgmt-ai-workflow-rules.md` §0.1 rules 3, 20, 21, 24.
- **Depends on:** none. **Do this first** (§0.1 rule 3): a test or document that still says "canonical" or "reserved" reads the new behaviour as a regression.

## Goal

After this unit, a search of the planning tree for the rule "`udr_key` is canonicalised" or "`udr_resource` is reserved, do not populate" finds only dated notes that say the rule was reversed on 2026-10-13, so no document contradicts Inv 27–28.

## Design

- **Notes, not rewrites, for delivered specs and design plans.** They are the record of what shipped (`ratemgmt-ai-workflow-rules.md` §0 rule 10). Add a blockquote directly under the original text; never delete or edit the original. The note's shape:
  `> **Reversed 2026-10-13 (raw-key update).** <one sentence on what is now true>. See `_updatemodule-rating-udr-key-resource-plan.md` (R1/R5) and `ratemgmt-architecture.md` Inv 27/28.`
- **In-place edits for living documents** (`ratemgmt-project-overview.md`, `ratemgmt-progress-tracker.md`): they describe current state, so the text is corrected, not annotated.
- **Fix one mis-citation.** The canonical rule is cited as "rm01 §4.2" in rm07, `prp.py` and several documents, but rm01 has no such section. The rule's source is `_newmodule-rating-engine-plan.md` §4.2 (line 129) and rm07 D2. Every citation is corrected to the real source.
- **Already carrying the update (verify only, do not edit):** `ratemgmt-architecture.md` (Inv 3, 14, 19, 26, 27, 28), `ratemgmt-code-standards.md` (§0.1, §5.2, §5.4, §9, §10), `ratemgmt-ai-workflow-rules.md` (§0.1), `ratemgmt-update-overview.md`, `rm00-build-plan.md` (Phase H) and the plan itself.
- **Billing documents get dated notes only,** on the lines named below, and are flagged to the billing owner. No billing design decision changes: bm49 already stopped reading the bm45 appendix, and the billing plan removes the flow's appendix write in its slice 2.
- **Out of scope:** `prp.py` comments and docstrings (rm26), the Drizzle comment (rm25), any code.

## Implementation

### 1. Design plan — `_newmodule-rating-engine-plan.md`
Add a reversal note under each of:
- §4.2, the paragraph beginning "`udr_key` requires a **canonicalisation rule**" (line 129): the key now stores the feed's raw values; the shape (sorted names, `name=value`, joined by `|`) is unchanged.
- §14 item 1 (line 523), "The canonicalisation *rule* is fixed (§4.2)".
- The PRP description (line 67) where PRP "computes the canonical `udr_key`".
- The column table row that lists `udr_resource` under "Subscriber & product" (line 115): it is now populated with `state|district|polygon_start_date` (Inv 28).

### 2. `rm01-rating-schema-foundation.md`
- Under **D10** (`udr_resource` is reserved and stays NULL, line 167): note that the column is now populated and has defined meaning (Inv 28); the reasoning in D10 (an implementer's assumption asserted as meaning) is answered by the owner's explicit decision and the format being specified in Inv 28.
- Under the column table row `udr_resource | text | NULL | reserved (D10)` (line 206): the same one-line note below the table.
- Do **not** add a note for "§4.2": rm01 has none. State this in the note under D10 so the next reader does not search for it.

### 3. `rm07-prp-claim-validate-reject.md`
- Add one banner directly under the existing forward-reference banner at the top: the `udr_key` canonicalisation described in this spec (D2 and every other mention — lines 7, 10, 12, 18, 32, 38, 41, 82) is superseded by raw values (Inv 27).
- Under **D2** (lines 38–41) add the dated note, and in it correct "(rm01 §4.2)" to "`_newmodule-rating-engine-plan.md` §4.2".
- Do not edit the body. `rm08`, `rm09`, `rm10`, `rm12`, `rm13`, `rm21` and `rm22` contain no canonical-rule wording (verified by search); leave them untouched.

### 4. Living documents — edit in place
- `ratemgmt-project-overview.md`:
  - Core user flow step 3 (line 42): replace "It computes the canonical `udr_key` — sorted keys, UTC, fixed numeric formats — because two logically identical keys serialised differently would be two live rows and one double bill." with "It builds `udr_key` from the feed's raw values — key names sorted, `name=value` joined by `|`, no trimming or case folding (Inv 27); records that differ only in case or whitespace are different keys, an accepted risk."
  - Features, "Validation and rejection" (line 81): replace "Canonical `udr_key` serialisation, indexed directly, so serialisation differences cannot manufacture duplicate live rows." with "`udr_key` holds the feed's raw values (sorted `name=value|…`), indexed directly." Leave the 512-character sentence as is.
  - Features, "Storage and partitioning" bm48 bullet (line 121): append "`udr_resource` carries `state|district|polygon_start_date` of the matched cell (Inv 28); the invoice reads State, District and the start date from it."
- `ratemgmt-progress-tracker.md`: add one entry at the top of the update log: "Raw `udr_key` / `udr_resource` update planned — units rm24–rm29 (`rm00-build-plan.md` Phase H); specs written; no code yet."

### 5. Billing documents — dated notes only, flagged to the billing owner
Each note reads: `> **Superseded 2026-10-14.** rating now stores `udr_key` raw; the invoice reads the polygon from the `polygon_id=` segment of `udr_key` and State, District and the start date from `udr_resource` (billing plan D8, D31). The flow's appendix is no longer read (bm49) and is removed in billing slice 2.`
- `bm45-invoice-usage-appendix.md`: D2 (lines 24–34), §Implementation §1 (line 56), the "Canonical udr_keys" fixture instruction (line 74), checklist lines 87 and 95.
- `bm48-rating-udr-rated-geo.md`: G13 row (line 20), the evidence note (line 34), line 114 ("keep the canonical-key logic byte-identical"), checklist line 154. Add a note that bm48's `state`/`district` columns are unchanged.
- `billmgmt-architecture.md`: the X1 "Resolved" paragraph (line 345) and the Inv #36/#47 wording that says geo comes from `udr_rated.state/district` — add that the invoice now reads `udr_resource`.
- `billmgmt-known-issues.md`: the bm45 D2 coupling paragraph (lines 653–661) and line 938.

### 6. Verification search
Run from the planning root and record the output in the change description:
```
grep -rn "canonical_udr_key\|canonical .udr_key\|canonicalisation" context _newmodule-rating-engine-plan.md
grep -rn "udr_resource" context _newmodule-rating-engine-plan.md | grep -i "reserved\|deferred semantics\|stays NULL"
```
Every remaining hit must sit directly under or beside a "Reversed 2026-10-13" or "Superseded 2026-10-14" note.

## Dependencies

None. Markdown only.

## Verification checklist

- [ ] The two searches in §6 return only hits adjacent to a dated reversal note.
- [ ] `git diff` on `rm01`, `rm07`, `_newmodule-rating-engine-plan.md`, `bm45`, `bm48` and the two billing documents shows **only added lines** (blockquotes); no original line is changed or deleted.
- [ ] `ratemgmt-project-overview.md` step 3 and the "Validation and rejection" bullet describe raw keys; the 512-character sentence is intact.
- [ ] No citation of "rm01 §4.2" remains anywhere except inside the note that explains the correction.
- [ ] The architecture, code-standards, ai-workflow-rules, update-overview and `rm00` files were read and needed no edit.
- [ ] The billing owner is told which lines changed (list in the change description).
- [ ] The diff contains no code, no test and no file outside `context/**` and `_newmodule-rating-engine-plan.md`.
