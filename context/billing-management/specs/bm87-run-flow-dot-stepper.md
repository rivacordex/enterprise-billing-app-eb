# bm87 — Run-level flow bar redrawn as a dot stepper

**Unit:** bm87 (standalone UI unit; not part of the Invoice Template Types series). **Boundary:** `components/billing/run-flow-progress.tsx` and its component test only. No schema, service, action, type, RBAC or audit change. **Specs from:** `_change-billrun-flow-stepper-plan.md` (the design and the full replacement component); `billmgmt-ui-context.md` "Rendering rule" and §3 (stage-status families); `billmgmt-code-standards.md` §4.3 (semantic tokens, no raw hex) and §9 (guardrail idiom); `billmgmt-architecture.md` Inv #12 (the flow is derived on read, never stored). **Model file:** `components/billing/run-status-badge.tsx` (icon + label pairing over the shared families).

> **Framing.** The Workflow tab of the Bill Run detail page opens with `RunFlowProgressBar`, a run-level summary of the nine pipeline `Stage`s derived by `getStageTimeline › deriveFlowProgress`. Today it is drawn as a strip of nine bordered chips, which reads as a row of tabs or boxes. bm87 redraws the same data as a horizontal **dot stepper**: one rail, a dot per stage, the rail filled up to the last `done` stage, the stage name under each dot. The derivation, the `RunFlowProgress` contract, the Distribution-tab hint and the CANCELLED suppression in `run-detail-tabs.tsx` are unchanged.

## Goal

On any non-cancelled run's Workflow tab, the operator sees one line of nine dots in flow order and can tell at a glance how far the run has progressed, where it stands now, and whether a step has failed, without reading the chip text.

## Design

**Structural decisions**

- **D1: Same component, same contract.** `RunFlowProgressBar({ runId, flow, className })` keeps its name, props and server-component nature. Only the markup inside changes, so `run-detail-tabs.tsx` and `tests/app/bill-run-detail-page.test.tsx` need no edit.
- **D2: Nine pipeline stages, not eleven run statuses.** The stepper summarises *where the run is in the pipeline*; the run's lifecycle status stays in the header `RunStatusBadge`. A `RunStatus` stepper would double-report the in-flight statuses and has no honest place for `*_FAILED` and `CANCELLED`.
- **D3: State → family reuses ui-context §3 one-to-one.** The five `FlowStepState`s are the five `StageStatus`es seen at run level, so the stepper takes §3's families without a new mapping: `done` → Success (`DONE`), `current` → Info (`RUNNING`), `failed` → Danger (`FAILED`), `skipped` → Neutral muted `--text-disabled` (`SKIPPED`), `pending` → Neutral `--text-muted` (`PENDING`). No new colour, radius, type or shadow token; dots are `rounded-full` like every badge (§9), labels are `--text-body-sm` (§8).
- **D4: Colour is never alone (Rendering rule).** Every dot carries a glyph (`Check` / filled inner dot / `X` / `Minus` / empty ring), the stage label stays visible under the dot, and the existing screen-reader suffix (`— done`, `— in progress`, `— failed`, `— skipped`, `— not started`) is kept verbatim.
- **D5: Rail fill follows `done` only.** The half-segment after a step is Success-500 when that step is `done`, otherwise `--border-default`; the half before a step mirrors the previous step. A `failed` or `current` step therefore sits at the end of the filled rail. The first and last steps hide their outer half with `invisible` so every dot stays centred over its label.
- **D6: Scroll, never wrap.** Each step has `min-w-[5.5rem]` and `flex-1`; the `<ol>` sits in an `overflow-x-auto` wrapper. On desktop the row fills the content column; on a narrow viewport it scrolls.
- **D7: Accessibility anchor.** The `<li>` whose `stage === flow.currentStage` carries `aria-current="step"`; a COMPLETED run (`currentStage: null`) has none. The `<ol>` has `aria-label="Run pipeline progress"`. Each `<li>` exposes `data-stage` and `data-state` so tests assert behaviour, not class names.
- **D8: No animation.** The current dot is the Info ring plus a filled inner dot; a `motion-safe:` pulse is an explicit later ask.

## Implementation

### 1. `components/billing/run-flow-progress.tsx` (rewritten markup)

Full replacement body is in `_change-billrun-flow-stepper-plan.md` §3.3. Shape:

```tsx
import { Check, Minus, X } from "lucide-react";
// DOT_TONES / LABEL_TONES: Record<FlowStepState, string> over the §3 families
// STATE_LABELS unchanged (sr-only suffixes). STEP_MARKS text glyphs removed.
const RAIL_FILLED = "bg-[color:var(--color-success-500)]";
const RAIL_EMPTY = "bg-[color:var(--border-default)]";

<div className="overflow-x-auto">
  <ol aria-label="Run pipeline progress" className="flex min-w-max items-start">
    {flow.steps.map((step, i) => (
      <li key={step.stage} data-stage={step.stage} data-state={step.state}
          aria-current={step.stage === flow.currentStage ? "step" : undefined}
          className="flex min-w-[5.5rem] flex-1 flex-col items-center">
        <div className="flex w-full items-center">
          <span aria-hidden="true" className={cn("h-0.5 flex-1", i === 0 ? "invisible" : flow.steps[i - 1].state === "done" ? RAIL_FILLED : RAIL_EMPTY)} />
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border-2", DOT_TONES[step.state])}>
            <StepGlyph state={step.state} />
          </span>
          <span aria-hidden="true" className={cn("h-0.5 flex-1", i === flow.steps.length - 1 ? "invisible" : step.state === "done" ? RAIL_FILLED : RAIL_EMPTY)} />
        </div>
        <span className={cn("mt-1.5 px-1 text-center text-body-sm", LABEL_TONES[step.state])}>
          {STAGE_LABELS[step.stage]}
          <span className="sr-only"> — {STATE_LABELS[step.state]}</span>
        </span>
      </li>
    ))}
  </ol>
</div>
{/* Distribution-tab hint <p>: unchanged */}
```

`flow.steps` is always the full ordered `STAGES` list (guaranteed by `deriveFlowProgress`), so the index-based previous-step lookup is safe.

### 2. `tests/components/billing/run-flow-progress.test.tsx` (extended)

The five existing tests stay as written and must remain green. Add:

- **exactly one `aria-current="step"`**, on the `currentStage` item
- **a `failed` step is the anchor** (`data-state="failed"` on the `aria-current` item)
- **no anchor on a finished run** (all `done`, `currentStage: null`)
- **rail fill:** in `collection` (current, after two `done`) the first `aria-hidden` span is filled and the second empty; in `aggregation` both are empty

### 3. Docs (on delivery)

- `billmgmt-code-standards.md` §7: `run-flow-progress.tsx` line in the file tree (added with this spec).
- `billmgmt-ui-context.md` §3: the stepper note (added with this spec); §11 `RunFlowProgress` row reworded to "dot stepper" when built.
- `billmgmt-progress-tracker.md`: one bullet under the Workflow-tab entry.

## Dependencies

- None on bm74–bm85; bm87 can land before, between or after them.
- `lucide-react` (pinned) for `Check`, `X`, `Minus`; Tailwind v4 `size-*` utilities, already in use under `components/accounts/`.

## Verification checklist

- [ ] Workflow tab of a PROCESSING run: filled rail through the last `done` stage, Info dot at the current stage, muted empty rings after it.
- [ ] PROCESSING_FAILED run: Danger `X` dot at the failed stage, which is the `aria-current="step"` item; the Distribution hint is absent.
- [ ] INVOICED / DISTRIBUTING / COMPLETED: rail filled through Posting / Rendering / Distribution respectively; COMPLETED has no `aria-current`.
- [ ] A run whose only accounts are EXCLUDED shows `Minus` dots with an unfilled rail.
- [ ] CANCELLED still shows the plain note, not the stepper.
- [ ] At ~800 px width the row scrolls horizontally and never wraps.
- [ ] Every state is distinguishable with colour removed (glyph + label + sr-only suffix).
- [x] `tsc --noEmit`, ESLint, Prettier pass; `run-flow-progress` and `bill-run-detail-page` suites green; no raw hex in the component.
- [x] Docs: §3 Implementation step 3 applied, and the bm87 row recorded in `bm00-build-plan.md` status.
