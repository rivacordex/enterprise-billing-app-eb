# rm31 — Reversal notes for dropping `udr_rated.state` / `.district` (docs) — Spec

- **Unit:** rm31 of Phase J (`rm00-build-plan.md`) · **Status:** Delivered 2026-10-27 in the planning tree (uncommitted at the time of writing); this spec is the as-built record, written after the fact in rm24's shape.
- **Repo:** app (docs only) · **Boundary:** `context/rating-management/**` — the five context files and the specs named below. No code, no tests, no billing document (plan §7's billing lines and the `db/migrations/README.md` note are rm33's).
- **Authorizes from:** `_change-rating-drop-udr-rated-geo-columns-plan.md` D1, D4, D5, D8, D9 and §7; `ratemgmt-ai-workflow-rules.md` §0 rule 10 (delivered specs are records), §0.1 rule 3 (document amendments first), §4 (waiver by name).
- **Depends on:** none. **Done first:** a rule that still says "bm48 is not reversed" or "`0045` stays as it is" would read rm32/rm33 as a regression.

## Goal

After this unit, no rating context document asserts that the `state`/`district` columns stay without a dated note that says they are removed in Phase J and points at the plan; the rm32 waiver is recorded by name; the Phase H update overview is rolled into the project overview and the update overview describes Phase J. Nothing about `udr_resource` is changed, weakened or removed.

## Design

- **Sync before editing.** The codebase's `context/rating-management/` copies were diffed against the planning tree first. `ratemgmt-architecture.md` was ahead (the §2 boundary row and Inv 26 gained the bm49 consumer-dependency sentence at rm24–rm30) and was pulled across; `ratemgmt-code-standards.md` differed only in table whitespace and was left; `rm28`'s one difference is a real place name in the codebase copy (`Selangor|…`) where the planning copy has `STATE-1|…` — the anonymised planning version is kept.
- **Inline dated notes for context files, blockquote banners for specs.** Context rules carry the house `*(Reversed 2026-10-27, drop-geo plan D-n: …)*` italic suffix on the same line (the form rm30 used for its amendments); delivered specs get a `> **Reversed 2026-10-27 (Phase J, …)**` blockquote under the header bullets. Originals are never deleted. The four Phase H specs are marked "Reversed … — the `state`/`district` … only" and each ends with an explicit "Nothing about `udr_resource` changes: …" sentence (owner, 2026-10-27).
- **Minimal set (plan D9).** Only rules that forbid the change, statements that assert the columns exist or stay, and the one architecture invariant that defines them are annotated. Trackers, delivered-spec prose about `udr_resource`, and the rating code-standards guardrail table are left alone.
- **Scope statement is "this round only".** Every note that mentions the `0045` rewrite or the fresh-DB setup says it applies to this round and that later column removals are forward migrations (owner, 2026-10-27).
- **Roll-up precedent.** The Phase H update overview is folded into `ratemgmt-project-overview.md` exactly as the Phase G overview was at rm24 — labelled sections, compressed, with the new update overview's header carrying the "Earlier updates" number map so existing cross-references still resolve.

## Implementation (as delivered)

### 1. `ratemgmt-ai-workflow-rules.md`
- §0.1 scope line (`:55`): extended to govern Phase J; D-numbers cited; "where a rule below says the columns stay, its dated note wins".
- Rule 10 (`:69`): reversed — PRP keeps the labels only as inputs to `udr_resource` and the `|` check; RP/RL stop carrying and writing; rm33 removes them; no consumer since bm71.
- Rule 17 (`:82`): one-time exception — `0045` rewritten in place for this round only; the rule stands; later removals are forward migrations (README rule 4, APP-03 cited).
- §4, after the bm48 waiver (`:157`): **Recorded waiver — drop-geo rm32 only**, one unit for PRP/RP/RL, ordered commits RL → RP → PRP → tests, not precedent.

### 2. `ratemgmt-code-standards.md`
- §0.1 data rule 1 (`:68`): amended — still no new column and no grant change; the one migration touched is `0045`, in place, this round only.
- Data rule 2 (`:69`): from rm32 `udr_resource` is the last `COPY_COLUMNS` entry, after `rated_datetime`.
- Data rule 3 (`:70`): reversed — columns removed in Phase J; `udr_resource` is the only geo carrier.

### 3. `ratemgmt-architecture.md` (after sync)
- Header (`:3`): "The geo-column removal (…) reverses Inv 26."
- Inv 26 (`:154`): reversal note — billing slice 2 shipped at bm71 so there is no consumer; Phase J removes the columns; `0045` rewritten under the round's fresh-DB setup; the invariant's substance (geo frozen at rating, write-once, never joined at render) lives entirely in Inv 28.

### 4. `ratemgmt-project-overview.md`
- Storage bullet for `udr_rated.state/.district` (`:121`): reversal note.
- Phase H rolled in (2026-10-27): overview paragraph; goals 20–25; "Raw-key / `udr_resource` flow (Phase H)" under the core user flow; features section "Raw `udr_key` and `udr_resource` cell label (Phase H)"; Phase H in-scope and out-of-scope bullets (the bm48 bullet keeps its reversal note); success criteria 32–36. Every `udr_resource` statement from the old update overview survives in condensed form.

### 5. `ratemgmt-update-overview.md`
- Replaced: now describes Phase J (reference, scope, "fresh database, this round only", the Earlier-updates map Phase H goals 1–10 → overview 20–25, flow, features, criteria 1–12 → 32–36; overview; 7 goals; 8-step flow incl. the release step; features by component; in/out of scope; 8 success criteria). The Phase H text is in git history and in the project overview.

### 6. `specs/rm00-build-plan.md`
- rm23 entry: "Reversed 2026-10-27 (Phase J …)" blockquote.
- New **Phase J** section after Phase I: intro (owner decision, eng review, this-round-only posture, what is reversed, spec file names), rm31 / rm32 / rm33 entries in the plan's unit shape.
- Summary table: rm23 row marked "reversed by Phase J"; rm31–rm33 rows added.
- Notes: rm23 bullet annotated (test name kept, re-scoped to `udr_resource`).

### 7. Delivered Phase H specs — banners only
- `rm26`, `rm27`, `rm28`, `rm29`: one blockquote under the header bullets, "Reversed … — the `state`/`district` <chunk columns | pass-through | COPY columns | seed fields and assertions> only", naming what rm32/rm33 change and ending "Nothing about `udr_resource` changes: …". Bodies untouched.

### 8. Verification searches (run from the planning root)
```
grep -n -E "columns (are )?(stay|untouched|exactly as they are)|bm48 is not reversed" context/rating-management/*.md | grep -v -E "Reversed 2026-10-27|removed by|Phase J"
grep -rn "Partly reversed" context/rating-management/
```
Both must return nothing. Every line in `git diff context/rating-management/` that mentions `udr_resource` must be either an in-place append (original text kept verbatim) or the codebase-synced architecture lines.

## Dependencies

None. Markdown only. (rm32 and rm33 cite the notes this unit added.)

## Verification checklist

- [x] The two searches in §8 return nothing (run 2026-10-27).
- [x] `git diff` on `rm26`–`rm29` shows only added lines (the banner); no original line changed or deleted.
- [x] The context-file diffs are in-place appends: each annotated line reappears verbatim inside its replacement; the two `ratemgmt-architecture.md` lines that differ otherwise are the codebase sync.
- [x] No `udr_resource` statement is removed or weakened anywhere; the Phase H roll-up carries each one in condensed form.
- [x] The rm32 waiver is recorded by name under §4 and is marked "not precedent".
- [x] Every mention of the `0045` rewrite or the fresh-DB setup says "this round only" and that later removals are forward migrations.
- [x] `rm00` names `rm32-runtime-drop-geo-columns.md` and `rm33-schema-seeds-tests-drop-geo-columns.md`.
- [x] `ratemgmt-completed-tracker.md` carries the Phase J row and the rm31 entry (2026-10-27).
- [ ] Committed as one rm31 change (rating docs only, separate from the uncommitted Types-batch billing edits).
