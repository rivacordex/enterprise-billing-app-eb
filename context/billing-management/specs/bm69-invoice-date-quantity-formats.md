# bm69 — Invoice dates DD/MM/YYYY and Mbps quantities

**Unit:** bm69 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** formatting (the shared calendar-date formatter in `lib/` and the invoice Handlebars helpers) · **Depends on:** nothing new
**Authorizes:** D21 · Inv #46 (still nine helpers) · code-standards Phase 3 Styling rule 4, general code-standards §2.13 · workflow rules §4.2, general ai-workflow-rules §2.8

## Goal

Make every date on the invoice print as `DD/MM/YYYY` and every quantity print as a whole number, or with exactly 2 decimals when it has a fraction, both with thousands separators. Screens elsewhere in the app keep their current date format.

## Design

**The shared formatter gains a style; its default stays.** `lib/formatters.ts` `formatCalendarDate(ymd, style: "long" | "iso" = "long")` (~l.115) gains a third style, `"dmy"`, returning `${day}/${month}/${year}`.
- It reuses the function's existing validation (the `YYYY-MM-DD` match and the impossible-day check), so an invalid input still comes back unchanged.
- The default stays `"long"` (`05 Sep 2026`), so its 14 app callers (bill-runs pages, `bill-line-table`, `customer-bill-table`, `run-action-card`, the rate-card page and others) are untouched.
- No string is sliced or reordered outside this function (general §2.13).
- This is the platform half and lands as its own first commit (general ai-workflow-rules §2.8).

**The invoice helpers switch to it** (`services/billing/invoice-template/helpers.ts`):

| Helper | Today | After bm69 | Example |
|---|---|---|---|
| `date` | `formatCalendarDate(ymd)` → `05 Sep 2026` | `formatCalendarDate(ymd, "dmy")` | `2026-10-15` → `15/10/2026` |
| `period` | `05 Sep 2026 – 30 Sep 2026` | `dmy` on both ends | `01/09/2026 – 30/09/2026` |
| `qty` | always 3 decimals (~l.84–94) | whole number when the fraction is zero, else exactly 2 decimals, grouped by `locale` | `1500` → `1,500`; `1500.000000` → `1,500`; `1500.5` → `1,500.50`; `0.25` → `0.25` |
| `money`, `price`, `int`, `amt`, `unitCode`, `asset` | — | unchanged | — |

- The `qty` decision reads the decimal **string**: a fraction made only of zeros counts as whole. Then `formatNumberString` (private to `helpers.ts`, ~l.41) is called with `{ minimumFractionDigits: 0, maximumFractionDigits: 0 }` or `{ minimumFractionDigits: 2, maximumFractionDigits: 2 }`. No `Number()` is applied to the value, keeping the existing D6 rule of the file.
- Display rounding to 2 decimals affects printing only; no stored amount changes.
- Null, undefined or empty values still render `—`.
- Still exactly nine helpers, and `KNOWN_HELPERS` is unchanged (Inv #46).

**What else changes.** Only the Handlebars invoice renders, which in this build means v1:
- the identification date and billing period;
- the line table's service period and quantity;
- the usage annex's start date;
- the notes' due date.

The CSV export does **not** use these helpers (`invoice-csv.ts` builds its own cells), so CSV output is unchanged. No other module uses `helpers.ts`.

**Deliberately not done:** no change to `formatCurrency` or money output; no change to app screens; no new helper; no layout file change (bm70–bm72 rewrite v1).

**Visible result:** today's v1 invoice preview, draft or posted, shows `Date: 15/10/2026`, `Billing period: 01/09/2026 – 30/09/2026`, and quantities such as `1,500` instead of `1,500.000`. The bill-runs list still shows `01 Sep 2026`.

## Implementation

### 1. Commit 1: the platform option (`lib/`)

- `lib/formatters.ts`: widen `style` to `"long" | "iso" | "dmy"` and add the `dmy` branch next to `iso`. Update the comment above the function with the three outputs.
- `tests/lib/formatters.test.ts`:
  - `formatCalendarDate("2026-10-15", "dmy") === "15/10/2026"`;
  - `("2024-02-29", "dmy") === "29/02/2024"`;
  - `("2025-02-29", "dmy")` returns the input unchanged;
  - existing `long`/`iso` cases unchanged.
- **CI proof that other modules are unchanged:** the full unit suite is green with no snapshot or expectation edits outside `tests/lib/formatters.test.ts`. That's the evidence general §2.8 asks for.

### 2. Commit 2: the invoice helpers

- `services/billing/invoice-template/helpers.ts`:
  - `date` and `period` pass `"dmy"`;
  - `qty` gets the whole-or-2-decimals logic, via a small private `isWholeDecimalString(s)` (regex `^-?\d+(\.0*)?$`);
  - update the D6 comment.
- `tests/services/billing/invoice-template/helpers.test.ts`:
  - update the `date` and `period` expectations (~l.92–110) to `05/09/2026` and `01/08/2026 – 31/08/2026`;
  - add `qty` cases: `"1500"`, `"1500.000000"`, `"1500.5"`, `"1500.005"` (→ `1,500.01`, display rounding), `"0.25"`, `null`;
  - assert `KNOWN_HELPERS` still has nine keys.

### 3. Goldens and dependent tests

- `tests/services/billing/invoice-golden.test.ts`: regenerate the v1 structural goldens; only date and quantity text changes.
- `tests/services/billing/render-invoice-template.test.ts`, `build-invoice-html.test.ts`, `tests/e2e/invoice-template-journey.integration.test.ts`: update any asserted date or quantity strings.
- Search `tests/` for the old date format next to an invoice render (`grep -rn "Sep 2026" tests/services/billing tests/e2e`) and update only invoice-render assertions.

## Dependencies

- **Packages:** none. `Intl.NumberFormat` and the existing `lib/formatters.ts` cover it.
- **Units:** none; can land any time before bm70 (page 1 prints dates and quantities).
- **Environment:** none beyond the normal unit test run. The goldens need no database.

## Verification checklist

- [ ] Commit 1 touches only `lib/formatters.ts` and `tests/lib/formatters.test.ts`, and the whole unit suite is green with no other expectation changes.
- [ ] `formatCalendarDate`'s default is still `"long"`; `grep -rn "formatCalendarDate(" app components` shows no call sites changed.
- [ ] The helper tests pass: `date` gives `DD/MM/YYYY`, and `qty` gives whole or 2 decimals; nine helpers.
- [ ] The v1 goldens regenerated; the invoice CSV tests (`invoice-csv.test.ts`, `invoice-csv.integration.test.ts`) are unchanged and green.
- [ ] Layout lint (`tests/guardrails/invoice-layout-lint.test.ts`) is green, with no helper outside the nine.
- [ ] `npm run typecheck` and `npm run lint` are green.
- [ ] Docs:
  - code-standards Phase 3 Styling rule 4 marked "built (bm69)";
  - UI context §10d's format line confirmed;
  - progress tracker updated.

## Open questions

None.
