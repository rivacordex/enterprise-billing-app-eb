# Accounting Module — UI Context

This file extends the shared `context/ui-context.md` — all brand scales, neutrals, semantic tokens, typography, radii, and elevation apply unchanged and are **not** redefined here. Per the shared rule ("modules map their domain statuses onto these families — never invent new status hues"), everything below is an **alias** of an existing shared token wired to an Accounting domain object. Components reference the alias, never the hex (code-standards §4).

**No AI features in this module** (architecture §5): `--ai-*` tokens and `--gradient-ai` must not appear on any `/accounts/**` or accounts-settings surface.

---

## 1. Module Color Aliases

Define in `globals.css` alongside the shared tokens; values are references, hex shown for review only.

### 1.1 Money & ledger surfaces

| Token | References | Hex | Use |
|---|---|---|---|
| `--acct-amount` | `--text-primary` | `#11141A` | Default amount text (`amount-cell`); sign shown by parentheses, not color |
| `--acct-amount-negative` | `danger-700` | `#8A1717` | Negative/parenthesised amounts — reinforces, never replaces, the parentheses |
| `--acct-balance-ok` | `success-500` | `#1F9D57` | Ledger Explorer zero-sum strip when `Σ = 0` (V1) |
| `--acct-balance-broken` | `danger-500` | `#D92D2D` | Zero-sum strip on imbalance; GL journal total row when `Σ debit ≠ Σ credit` (V6) |
| `--acct-context-strip-bg` | `--surface-selected` | `#EDF0FB` | Persistent party/FA/BAN context strip background |
| `--acct-context-strip-border` | `--border-default` | `#E0E4EB` | Context strip border |

### 1.2 Ledger account kind chips (Ledger Explorer, statements)

| Token pair (bg / text) | References | Hex | Use |
|---|---|---|---|
| `--acct-chip-ban-bg` / `--acct-chip-ban-fg` | `primary-50` / `primary-700` | `#EDF0FB` / `#1B2A68` | `ban.*` receivables accounts |
| `--acct-chip-fa-bg` / `--acct-chip-fa-fg` | `cyan-50` / `cyan-700` | `#E2F8FA` / `#006975` | `fa.*` unapplied-cash & deposits accounts |
| `--acct-chip-sys-bg` / `--acct-chip-sys-fg` | `neutral-100` / `neutral-600` | `#EEF0F4` / `#4C5462` | `sys.*` system accounts |

### 1.3 Posting-nature series (GL Journal drill-down, any chart)

One fixed color per Q19 posting nature so a nature never renders two ways:

| Nature | References | Hex |
|---|---|---|
| `revenue` | `primary-500` | `#2E45A9` |
| `revenue_adj` | `accent-300` | `#F052A0` |
| `write_off` | `danger-500` | `#D92D2D` |
| `rounding` | `neutral-400` | `#99A1B0` |
| `cash` | `cyan-500` | `#00A9BC` |
| `deposit_movement` | `warning-500` | `#E08600` |

---

## 2. Domain Status → Shared Status Family Mapping

Badges follow the shared rule: dark `-fg` text on light `-bg` tint, icon + label always.

| Domain value | Family | bg / fg |
|---|---|---|
| Document `draft` | Neutral | `neutral-100` / `neutral-600` |
| Document `pending_approval` | Warning | `warning-50` / `warning-700` |
| Document `posted` | Success | `success-50` / `success-700` |
| Document `reversed` | Danger | `danger-50` / `danger-700` |
| Document `cancelled` | Neutral (muted) | `neutral-100` / `neutral-400` |
| Payment status `paid` | Success | `success-50` / `success-700` |
| Payment status `due` | Warning | `warning-50` / `warning-700` |
| **Derived** overdue (Q8 — prop-driven, never stored) | Danger | `danger-50` / `danger-700` |
| Payment status `in_dispute` | Info | `info-50` / `info-700` |
| Account `active` | Success | `success-50` / `success-700` |
| Account `suspended` | Warning | `warning-50` / `warning-700` |
| Account `closed` | Neutral | `neutral-100` / `neutral-600` |
| Catalog `active` (cycle, reason code, GL code) | Success | `success-50` / `success-700` |
| Catalog `retired` | Neutral | `neutral-100` / `neutral-400` |
| Period `open` | Success | `success-50` / `success-700` |
| Period `closed` | Neutral | `neutral-100` / `neutral-600` |

Owning components: `doc-state-badge.tsx`, `payment-status-badge.tsx` (code-standards §4.1) — no page renders a status color outside these.

---

## 3. Typography — module deltas

No new sizes or families. Module wiring of the shared scale:

| Surface | Token | Note |
|---|---|---|
| All domain ids (`FIN…`, `BAN…`, `PAY…`, `DLN…`, `pglt_…`), ledger account names, GL codes, cheque/bank refs | `--text-mono` | Mono everywhere an id appears, including table cells and the context strip |
| Amounts (all tables, statements, journal) | `--text-body` + `tabular-nums`, right-aligned | Sans, not mono — per shared §5 numeric rule; 2 dp always |
| Ledger/journal dense tables | `--text-body-sm` | With `--radius-none` grid treatment |
| GL journal total row, zero-sum strip figure | `--text-h4` + `tabular-nums` | The only emphasized numerals |
| Column headers (Debit / Credit / Balance) | `--text-overline` | Debit vs credit is communicated by **column position**, never by color |

---

## 4. Border Radius — module wiring

Shared scale unchanged: `--radius-none` for all ledger/journal/statement grids and the balance-check strip (full-bleed), `--radius-sm` for the context strip and filter controls, `--radius-md` for cards/panels, `--radius-pill` for every status badge and account-kind chip.

---

## 5. Explicitly Not Used

- `--ai-*` family and `--gradient-ai` — no AI features in this module.
- `--gradient-brand` / `--gradient-5g` — no marketing surfaces in Accounts; all five pages plus Settings are data-dense admin chrome (shared §4 note).
- `--action-cta-bg` (magenta CTA) — the module's highest-emphasis action (Post / Approve) uses `--action-primary-bg`; magenta is reserved for platform-level featured CTAs, and money actions must not look like marketing.
