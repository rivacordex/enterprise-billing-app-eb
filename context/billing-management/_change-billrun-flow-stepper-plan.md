# Plan: Bill Run detail — run-level flow bar as a dot stepper

Status: Draft for review · Date: 2026-10-27
Boundary: **FRONTEND only.** One server component rewritten (`components/billing/run-flow-progress.tsx`), its component test extended, two planning docs touched. No schema, service, action, RBAC, audit or type change. No new dependency.

> **Scope note.** This changes only how the nine-step run-level summary on the **Workflow** tab of the Bill Run detail page is drawn. The data behind it (`RunFlowProgress` from `getStageTimeline`, the five `FlowStepState` values, the run-status floor, the failed-step anchor) is untouched. The per-account `StageTimeline` grid beneath it, the `RunStatusBadge` in the page header, and the CANCELLED suppression in `run-detail-tabs.tsx` are all unchanged.
> Delivery: **one commit**, standalone, recorded as unit **bm87** (`context/billing-management/specs/bm87-run-flow-dot-stepper.md`, 2026-10-28). It does not belong to the Invoice Template Types series (bm74–bm85, delivered 2026-10-26); bm86 is the delivered logo minimum-side change.

### Locked decisions (this revision)

- **Stage set stays the nine pipeline `Stage`s**, not the eleven `RunStatus` values. The existing bar already summarises *where the run is in the pipeline*; the run's lifecycle status is the header badge. Drawing `RunStatus` as a stepper would double-report (PROCESSING/POSTING/DISTRIBUTING are "in-flight" views of the same stages) and would have no honest place for the two `*_FAILED` and `CANCELLED` branches.
- **Same component, same props, same name.** `RunFlowProgressBar({ runId, flow, className })` keeps its signature so `run-detail-tabs.tsx` and the page test need no edit. Only the markup inside changes.
- **Horizontal scroll, never wrap.** A stepper's rail is meaningless once it wraps onto a second line. Nine steps get a minimum width each and the list scrolls horizontally on narrow viewports; on a normal desktop width it fills the row.
- **Colour + shape + text on every node** (ui-context "Rendering rule"). Each dot carries a glyph (check / inner dot / cross / dash / empty), the label stays visible under the dot, and the existing screen-reader state suffix (`— done`, `— in progress`, …) is kept verbatim so the current assertions still hold.
- **Rail fill follows `done` only.** The segment *after* a step is filled (success) when that step is `done`; otherwise it is the neutral border colour. A `failed` or `current` step therefore sits at the end of the filled rail, which is exactly where the run stands.
- **No animation.** The current step is distinguished by the Info ring and filled inner dot, not a pulse. (A `motion-safe:` pulse can be added later without touching structure.)

---

## 0. Engineering review (technical-lead pass)

Grounded in the delivered codebase at `F:\Projects\enterprise-billing-app` (verified, not assumed):

**Verified facts**

- **The component is a server component with no interaction.** `run-flow-progress.tsx` has no `"use client"`, no state, and renders an `<ol>` of nine `<li>` chips plus one conditional `<Link>` to the Distribution tab. A stepper is still pure markup, so it stays a server component.
- **Data contract.** `RunFlowProgress = { steps: RunFlowStep[]; currentStage: Stage | null }` and `RunFlowStep = { stage: Stage; state: FlowStepState }` with `FlowStepState ∈ done | current | failed | skipped | pending` (`types/billing.ts`). `deriveFlowProgress` in `services/billing/read/get-stage-timeline.ts` guarantees **at most one** step is `current`, that a `failed` step takes precedence as `currentStage`, and that the run-status floor marks every step up to the implied one `done` without downgrading a `failed`. The view can rely on these invariants and does not re-derive anything.
- **Labels are single-sourced.** `STAGE_LABELS: Record<Stage, string>` in `types/billing.ts` is shared with the grid header; the stepper keeps using it.
- **Tokens exist.** `--color-success-500/700`, `--color-info-500/700`, `--color-danger-500/700`, `--color-success-50`, `--color-info-50`, `--color-danger-50`, `--color-neutral-100`, `--border-default`, `--border-strong`, `--surface-card`, `--text-disabled` are all defined in `app/globals.css`. No new token.
- **Icons exist.** `Check`, `X`, `Minus` are in the pinned `lucide-react`; `RunStatusBadge` already imports from the same package with `size={12}` and `aria-hidden`.
- **Existing tests.** `tests/components/billing/run-flow-progress.test.tsx` asserts (1) all nine labels render, (2) the Distribution-tab link appears only when distribution is `current`, (3) the sr-only `— done` / `— failed` suffixes render. All three hold against the new markup unchanged. `tests/app/bill-run-detail-page.test.tsx` only checks that the timeline is read for the Workflow tab; untouched.
- **CANCELLED path.** `run-detail-tabs.tsx` replaces the bar with a plain note when `runStatus === "CANCELLED"`. Unchanged.

**Issues considered & resolved**

1. **Wrapping.** The chip strip uses `flex-wrap`, which is fine for chips but breaks a rail. Resolution: `overflow-x-auto` on a wrapper, `min-w-[5.5rem]` per step, `flex-1` so the row fills on desktop. Nine × 5.5 rem ≈ 50 rem, comfortably inside the content column at ≥ 1024 px.
2. **Rail drawn per step, not as one background line.** One continuous line behind the dots cannot be partially coloured without measuring. Resolution: each `<li>` draws its own left and right half-segments; the first step hides its left half and the last step its right half. Fill colour of a half-segment is decided per step from `done` (see Locked decisions). No JS, no measurement.
3. **Accessibility anchor.** Add `aria-current="step"` on the `<li>` whose `stage === flow.currentStage`. When `currentStage` is `null` (a COMPLETED run) no step carries it. The `<ol>` gets `aria-label="Run pipeline progress"`.
4. **Keep the test-facing text identical.** The sr-only span stays `<span className="sr-only"> — {STATE_LABELS[state]}</span>`; the visible label stays `STAGE_LABELS[stage]` as its own text node so `getByText("Scoping")` still matches exactly.
5. **Stable hooks for new assertions.** Each `<li>` gets `data-stage` and `data-state` attributes so the new tests assert state without depending on class names (code-standards §9 guardrail idiom: assert behaviour, not styling).
6. **No raw hex** (code-standards §4.3). Every colour is a Tailwind v4 arbitrary value over a semantic token, same form as today.

**Net assessment:** low risk, additive, presentational. The only behavioural additions are `aria-current` and the data attributes.

---

## 1. Goal

Replace the row of bordered chips ("tabbed boxes") that summarises the run's pipeline position with a **horizontal dot stepper**: one rail, nine dots in flow order, the rail filled up to the last `done` step, each dot's state shown by shape and colour, and the stage name under each dot.

Before (today):

```
[✓ Scoping] [✓ Validation] [● Collection] [○ Aggregation] [○ Taxation] [○ Verification] [○ Posting] [○ Rendering] [○ Distribution]
```

After:

```
 (✓)━━━━(✓)━━━━(●)────( )────( )────( )────( )────( )────( )
Scoping Validation Collection Aggregation Taxation Verification Posting Rendering Distribution
 done     done    in progress  not started …
```

A failed step shows `(✕)` in the Danger family at the end of the filled rail; a skipped step shows `(–)` muted with an unfilled rail on both sides.

---

## 2. What exists today (verified — do not re-derive)

- `components/billing/run-flow-progress.tsx` — server component. Three lookup maps (`STEP_MARKS` text glyphs, `STEP_TONES` border/text classes, `STATE_LABELS` sr-only text) and an `<ol className="flex flex-wrap items-stretch gap-1.5">` of `<li>` chips (`rounded-md border-l-2 bg-[color:var(--surface-card)] px-2.5 py-1.5`). Below it, the Distribution-tab hint `<p>` when `distributionStep?.state === "current"`.
- `components/billing/run-detail-tabs.tsx` — renders `<RunFlowProgressBar runId flow={timeline.flow} />` inside the Workflow tab, or the CANCELLED note.
- `services/billing/read/get-stage-timeline.ts › deriveFlowProgress` — the derivation (one `current`, failed anchor, run-status floor, abandoned-distribution handling).
- `types/billing.ts` — `STAGES`, `STAGE_LABELS`, `FLOW_STEP_STATES`, `RunFlowStep`, `RunFlowProgress`.
- `tests/components/billing/run-flow-progress.test.tsx` — five tests (listed in §0).
- Planning docs: `context/billing-management/billmgmt-code-standards.md` §7 file tree **does not list** `run-flow-progress.tsx` (it lists `stage-timeline.tsx`), and `billmgmt-ui-context.md` has no entry for the flow bar's state → family mapping. Both are gaps this change closes.

---

## 3. Design

### 3.1 State → visual mapping

| `FlowStepState` | Dot                                                                                     | Rail after the dot | Label tone                          | sr-only suffix  |
| --------------- | --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------- | --------------- |
| `done`          | `Check` icon, Success-700 on Success-50 tint, Success-500 ring                          | filled Success-500 | `text-foreground`                   | `— done`        |
| `current`       | filled inner dot Info-500, Info-50 tint, Info-500 ring (2 px)                           | neutral            | Info-700, `font-medium`             | `— in progress` |
| `failed`        | `X` icon, Danger-700 on Danger-50 tint, Danger-500 ring                                 | neutral            | Danger-700, `font-medium`           | `— failed`      |
| `skipped`       | `Minus` icon, `--text-disabled` on Neutral-100 tint, `--border-default` ring            | neutral            | `text-muted-foreground`             | `— skipped`     |
| `pending`       | empty, `--surface-card` fill, `--border-default` ring                                   | neutral            | `text-muted-foreground`             | `— not started` |

Families are the same ones `RunStatusBadge` (ui-context §1) already uses for the equivalent run states, so the stepper and the header badge read as one system. The rail *before* a dot is filled when the **previous** step is `done`; this is the same rule expressed from the other side and is what makes the line continuous.

### 3.2 Markup

```
<div class="space-y-3 {className}">
  <div class="overflow-x-auto">
    <ol aria-label="Run pipeline progress" class="flex min-w-max items-start">
      <li data-stage="scoping" data-state="done" aria-current?="step"
          class="flex min-w-[5.5rem] flex-1 flex-col items-center">
        <div class="flex w-full items-center">
          <span class="h-0.5 flex-1 {left rail tone or invisible on first}"></span>
          <span class="flex size-6 shrink-0 items-center justify-center rounded-full border-2 {dot tone}">
            {glyph}
          </span>
          <span class="h-0.5 flex-1 {right rail tone or invisible on last}"></span>
        </div>
        <span class="mt-1.5 px-1 text-center text-body-sm {label tone}">
          Scoping<span class="sr-only"> — done</span>
        </span>
      </li>
      …
    </ol>
  </div>
  {distribution hint <p> — unchanged}
</div>
```

The first step renders its left half-segment with `invisible` (keeps the dot centred over its label) and the last step does the same on the right.

### 3.3 Component (full replacement of `run-flow-progress.tsx`)

```tsx
// The Workflow tab's run-level flow stepper (2026-09-18, redrawn 2026-10-27) —
// the nine pipeline steps in order on one rail, summarising where the WHOLE run
// stands, above the per-account grid. Server component; read-only. Semantic
// tokens only, and every state carries a glyph and a text label as well as a
// colour (ui-context "Rendering rule") so the stepper is not colour-only.
//
// The rail is drawn per step as two half-segments so it can be partially
// filled without measuring: the half after a step is filled when THAT step is
// `done`; the half before a step is filled when the PREVIOUS step is `done`.
// The first/last steps hide their outer half (`invisible`, not removed, so the
// dot stays centred over its label).
//
// `distribution` is the one step with no per-account column (see
// `TIMELINE_STAGES`): it is tracked per (target, artifact) in
// `bill_run_distribution`, and its run report belongs to no account at all. So
// when the run reaches it, the stepper points the operator at the Distribution
// tab, which holds the real per-artifact delivery log.

import Link from "next/link";
import { Check, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { STAGE_LABELS } from "@/types/billing";
import type { FlowStepState, RunFlowProgress } from "@/types/billing";

const DOT_TONES: Record<FlowStepState, string> = {
  done: "border-[color:var(--color-success-500)] bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
  current:
    "border-[color:var(--color-info-500)] bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
  failed:
    "border-[color:var(--color-danger-500)] bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
  skipped:
    "border-[color:var(--border-default)] bg-[color:var(--color-neutral-100)] text-[color:var(--text-disabled)]",
  pending:
    "border-[color:var(--border-default)] bg-[color:var(--surface-card)] text-muted-foreground",
};

const LABEL_TONES: Record<FlowStepState, string> = {
  done: "text-foreground",
  current: "font-medium text-[color:var(--color-info-700)]",
  failed: "font-medium text-[color:var(--color-danger-700)]",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
};

const STATE_LABELS: Record<FlowStepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  skipped: "skipped",
  pending: "not started",
};

const RAIL_FILLED = "bg-[color:var(--color-success-500)]";
const RAIL_EMPTY = "bg-[color:var(--border-default)]";

// Glyph per state — paired with the colour, never the colour alone.
function StepGlyph({ state }: { state: FlowStepState }): React.JSX.Element | null {
  switch (state) {
    case "done":
      return <Check size={14} aria-hidden="true" />;
    case "failed":
      return <X size={14} aria-hidden="true" />;
    case "skipped":
      return <Minus size={14} aria-hidden="true" />;
    case "current":
      return (
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-[color:var(--color-info-500)]"
        />
      );
    default:
      return null;
  }
}

export interface RunFlowProgressBarProps {
  runId: string;
  flow: RunFlowProgress;
  className?: string;
}

export function RunFlowProgressBar({
  runId,
  flow,
  className,
}: RunFlowProgressBarProps): React.JSX.Element {
  // Only when distribution is genuinely IN PROGRESS. `currentStage` also anchors
  // on a FAILED step, so keying the hint on it would sit this calm, info-toned
  // copy over a failed delivery; gate on the step's own `current` state instead.
  const distributionStep = flow.steps.find((s) => s.stage === "distribution");
  const atDistribution = distributionStep?.state === "current";

  return (
    <div className={cn("space-y-3", className)}>
      <div className="overflow-x-auto">
        <ol
          aria-label="Run pipeline progress"
          className="flex min-w-max items-start"
        >
          {flow.steps.map((step, i) => {
            const prev = flow.steps[i - 1];
            const isFirst = i === 0;
            const isLast = i === flow.steps.length - 1;
            return (
              <li
                key={step.stage}
                data-stage={step.stage}
                data-state={step.state}
                aria-current={step.stage === flow.currentStage ? "step" : undefined}
                className="flex min-w-[5.5rem] flex-1 flex-col items-center"
              >
                <div className="flex w-full items-center">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-0.5 flex-1",
                      isFirst
                        ? "invisible"
                        : prev?.state === "done"
                          ? RAIL_FILLED
                          : RAIL_EMPTY,
                    )}
                  />
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                      DOT_TONES[step.state],
                    )}
                  >
                    <StepGlyph state={step.state} />
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-0.5 flex-1",
                      isLast
                        ? "invisible"
                        : step.state === "done"
                          ? RAIL_FILLED
                          : RAIL_EMPTY,
                    )}
                  />
                </div>
                <span
                  className={cn(
                    "mt-1.5 px-1 text-center text-body-sm",
                    LABEL_TONES[step.state],
                  )}
                >
                  {STAGE_LABELS[step.stage]}
                  <span className="sr-only"> — {STATE_LABELS[step.state]}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {atDistribution && (
        <p className="text-body-sm text-[color:var(--color-info-700)]">
          This run is at the distribution step. Delivery is tracked per
          artifact, not per account — open the{" "}
          <Link
            href={`/billing/bill-runs/${runId}?tab=distribution`}
            className="underline underline-offset-2"
          >
            Distribution tab
          </Link>{" "}
          for the per-artifact delivery log and the rerun controls.
        </p>
      )}
    </div>
  );
}
```

Notes on the code:

- `flow.steps` is always the full `STAGES` list in order (guaranteed by `deriveFlowProgress`), so index-based `prev` is safe. If a caller ever passed an empty list the component renders an empty `<ol>`, which is what `run-detail-tabs.tsx` already does for non-Workflow tabs.
- The `STEP_MARKS` text-glyph map is removed; `lucide-react` icons replace it, matching `RunStatusBadge`.
- `size-6` / `size-2` are Tailwind v4 size utilities already used in `components/accounts/*` (verified; `tailwindcss ^4` is pinned).

### 3.4 Visual / a11y details

- Dot ring is 2 px so the Danger/Info/Success ring reads at a glance against the 2 px rail.
- The label is centred under the dot and may run to two lines ("Verification", "Distribution") inside the 5.5 rem minimum; `items-start` on the `<ol>` keeps all dots on one baseline regardless.
- Screen readers hear the list as "Run pipeline progress, list, 9 items: Scoping — done, Validation — done, Collection — in progress (current step), …".
- Focus is not involved: nothing in the stepper is interactive, same as today.

---

## 4. Files touched

Codebase (`F:\Projects\enterprise-billing-app`, read-only from this repo — the implementer applies these):

| File                                                   | Change                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `components/billing/run-flow-progress.tsx`             | Rewrite markup per §3.3. Props/export unchanged.                       |
| `tests/components/billing/run-flow-progress.test.tsx`  | Keep the five existing tests; add the four in §5.                      |

Planning (`F:\Projects\_plan_enterprise-billing-app`), minimal diffs only:

| File                                                              | Change                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context/billing-management/billmgmt-code-standards.md` §7        | Add one line `run-flow-progress.tsx        # RunFlowProgressBar (run-level dot stepper)` next to `stage-timeline.tsx`.                                            |
| `context/billing-management/billmgmt-ui-context.md`               | Add a short "Flow stepper" mapping (the §3.1 table, families only) under the existing Rendering rule, so the state → family choice is recorded once.                 |
| `context/billing-management/billmgmt-progress-tracker.md`         | On delivery: one bullet under the Workflow-tab entry noting the stepper redraw (date, no data change).                                                                |

Nothing else. The `bm00-build-plan.md` bm87 row and unit section are part of this change.

---

## 5. Testing (mirror `tests/components/billing/run-flow-progress.test.tsx`)

Existing five tests stay as written. Add:

1. **Marks exactly one current step.** `steps({ scoping: "done", validation: "current" })`, `currentStage: "validation"` → `getAllByRole("listitem").filter(li => li.getAttribute("aria-current") === "step")` has length 1 and `data-stage="validation"`.
2. **A failed step is the current step.** `steps({ scoping: "done", validation: "failed" })`, `currentStage: "validation"` → the `aria-current="step"` item has `data-state="failed"`.
3. **No current step on a finished run.** All nine `done`, `currentStage: null` → no `aria-current` anywhere, and every item has `data-state="done"`.
4. **Rail fills after done steps only.** `steps({ scoping: "done", validation: "done", collection: "current" })` → within the `collection` item, the first rail span (`aria-hidden`) has the filled class and the second has the empty class; within `aggregation`, both are empty. (Assert via `querySelectorAll('[aria-hidden="true"]')` on the item; a class-name assertion is acceptable here because the fill *is* the behaviour under test, and the two class constants are exported for the test if preferred.)

Run: `npx vitest run tests/components/billing/run-flow-progress.test.tsx tests/app/bill-run-detail-page.test.tsx` plus `npm run lint` (import boundaries, `set-state-in-effect` — not applicable, no hooks) and `npx tsc --noEmit`.

Manual check (local stack, `README.md` bring-up): open a run on the Workflow tab in each of PROCESSING (mixed done/current), PROCESSING_FAILED (red dot at the failure), INVOICED (rail filled through Posting), DISTRIBUTING (Distribution hint shows), COMPLETED (all green, no current), and a run with an `EXCLUDED`-only account set (skipped dots). Resize to ~800 px and confirm the row scrolls rather than wraps.

---

## 6. Open questions for review

1. **bm numbering.** Resolved: unit **bm87** (bm86 was already taken by the logo minimum-side change, delivered 2026-10-26).
2. **Mockup.** A one-file HTML mockup of the stepper in all five states (PROCESSING, failed, skipped, INVOICED, COMPLETED) can be added as `mockup-billing-billrun-stepper.html` beside the existing `mockup-billing-billrun.html` if a visual sign-off is wanted before implementation.
3. **Current-step pulse.** Deliberately omitted (Locked decisions). Say if a `motion-safe:animate-pulse` ring on the current dot is wanted; it is a one-class addition.
