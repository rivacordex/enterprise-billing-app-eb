# Enterprise Billing App — Shared UI Context
## Color, Typography & Shape Tokens (all modules)

**Aesthetic:** Formal telecoms / national carrier feel. Deep, corporate **indigo-navy** base; a signature **magenta → violet** energy accent; **cyan "connectivity"** secondary; clean, slightly-cool neutrals. Light-mode-first for data-dense admin screens (tables, forms), with a dark navy chrome (nav/sidebar) echoing the telecom hero look.

This file is the **shared core** inherited by every module (User Management, Product, Customer, Billing Service, Bill Run, Accounting). Each module adds its own `<module>-ui-context.md` that wires these tokens to its domain objects (e.g. `context/user-management/usrmgmt-ui-context.md`); module files must not redefine anything here. All tokens are given as CSS custom properties (usage notes below the tables). Per code-standards §4.3, define these as CSS variables in `globals.css`; never hardcode the hex in a component.

---

## 1. Brand Color Scales

### 1.1 Primary — Telecom Indigo (corporate trust, chrome, primary actions)

| Token | Hex | Typical use |
|---|---|---|
| `--color-primary-50`  | `#EDF0FB` | Tinted backgrounds, selected rows |
| `--color-primary-100` | `#D4DBF4` | Hover wash, subtle fills |
| `--color-primary-200` | `#A9B6E9` | Disabled primary, dividers on tint |
| `--color-primary-300` | `#7C8EDA` | Borders on dark, secondary icons |
| `--color-primary-400` | `#5067C8` | Hover for links/icons |
| `--color-primary-500` | `#2E45A9` | **Base brand** — primary buttons, active nav |
| `--color-primary-600` | `#233686` | Button hover / pressed |
| `--color-primary-700` | `#1B2A68` | Top bar, emphasis surfaces |
| `--color-primary-800` | `#131D49` | Sidebar / nav chrome |
| `--color-primary-900` | `#0C122E` | Deepest navy, app shell footer |

### 1.2 Accent — 5G Magenta (signature highlight, key CTAs, charts)

| Token | Hex | Typical use |
|---|---|---|
| `--color-accent-50`  | `#FDE6F1` | Badge backgrounds, highlight wash |
| `--color-accent-100` | `#FAB9D8` | Subtle accent fills |
| `--color-accent-300` | `#F052A0` | Data-viz series, decorative |
| `--color-accent-500` | `#E6007E` | **Base accent** — featured CTA, active emphasis |
| `--color-accent-600` | `#BC0067` | Accent button hover / text-on-light |
| `--color-accent-700` | `#91004F` | Pressed, high-contrast accent text |

### 1.3 Secondary — Connectivity Cyan (info, links, "online/active" states)

| Token | Hex | Typical use |
|---|---|---|
| `--color-cyan-50`  | `#E2F8FA` | Info wash, tags |
| `--color-cyan-100` | `#B6EEF2` | Subtle fills |
| `--color-cyan-300` | `#4CD3DF` | Data-viz, accents on dark |
| `--color-cyan-500` | `#00A9BC` | **Base** — secondary accent, active indicator |
| `--color-cyan-600` | `#00899A` | Hover / text-on-light (pair with dark text) |
| `--color-cyan-700` | `#006975` | Pressed, high-contrast |

---

## 2. Neutrals (cool gray — text, surfaces, borders)

| Token | Hex | Typical use |
|---|---|---|
| `--color-neutral-0`   | `#FFFFFF` | Base page / card surface |
| `--color-neutral-50`  | `#F7F8FA` | App background, zebra rows |
| `--color-neutral-100` | `#EEF0F4` | Subtle fills, hover rows |
| `--color-neutral-200` | `#E0E4EB` | Default borders, dividers |
| `--color-neutral-300` | `#CAD0DA` | Input borders, disabled borders |
| `--color-neutral-400` | `#99A1B0` | Placeholder, disabled text/icons |
| `--color-neutral-500` | `#6A7283` | Muted / secondary text |
| `--color-neutral-600` | `#4C5462` | Tertiary headings, icons |
| `--color-neutral-700` | `#353B46` | Body text |
| `--color-neutral-800` | `#1F242C` | Strong text, table headers |
| `--color-neutral-900` | `#11141A` | Headings / primary ink |

---

## 3. Semantic Tokens (Light mode — default)

### 3.1 Surface & Text

| Token | Value | Role |
|---|---|---|
| `--surface-app`        | `#F7F8FA` (neutral-50)  | Page background |
| `--surface-card`       | `#FFFFFF` (neutral-0)   | Cards, panels, modals |
| `--surface-raised`     | `#FFFFFF` + shadow      | Dropdowns, popovers |
| `--surface-sunken`     | `#EEF0F4` (neutral-100) | Wells, code/data areas |
| `--surface-selected`   | `#EDF0FB` (primary-50)  | Selected table row |
| `--surface-nav`        | `#131D49` (primary-800) | Sidebar / left nav |
| `--surface-topbar`     | `#1B2A68` (primary-700) | Top app bar |
| `--text-primary`       | `#11141A` (neutral-900) | Headings, key labels |
| `--text-body`          | `#353B46` (neutral-700) | Body copy |
| `--text-muted`         | `#6A7283` (neutral-500) | Secondary / helper text |
| `--text-disabled`      | `#99A1B0` (neutral-400) | Disabled text |
| `--text-on-brand`      | `#FFFFFF`               | Text on indigo/accent surfaces |
| `--text-link`          | `#2E45A9` (primary-500) | Inline links |
| `--text-link-hover`    | `#233686` (primary-600) | Link hover |

### 3.2 Borders & Lines

| Token | Value | Role |
|---|---|---|
| `--border-subtle`   | `#EEF0F4` (neutral-100) | Hairlines, internal dividers |
| `--border-default`  | `#E0E4EB` (neutral-200) | Card / table borders |
| `--border-strong`   | `#CAD0DA` (neutral-300) | Input borders |
| `--border-focus`    | `#2E45A9` (primary-500) | Focus ring (2px outline) |
| `--border-accent`   | `#E6007E` (accent-500)  | Active/featured emphasis |

### 3.3 Interactive (controls)

| Token | Value | Role |
|---|---|---|
| `--action-primary-bg`        | `#2E45A9` (primary-500) | Primary button |
| `--action-primary-bg-hover`  | `#233686` (primary-600) | Primary hover |
| `--action-primary-bg-active` | `#1B2A68` (primary-700) | Primary pressed |
| `--action-cta-bg`            | `#E6007E` (accent-500)  | Featured CTA |
| `--action-cta-bg-hover`      | `#BC0067` (accent-600)  | CTA hover |
| `--action-secondary-bg`      | `#FFFFFF`               | Secondary button fill |
| `--action-secondary-border`  | `#CAD0DA` (neutral-300) | Secondary button border |
| `--action-secondary-text`    | `#353B46` (neutral-700) | Secondary button text |
| `--action-ghost-hover`       | `#EEF0F4` (neutral-100) | Ghost/icon button hover |
| `--action-disabled-bg`       | `#E0E4EB` (neutral-200) | Disabled control |

### 3.4 Status / Feedback

Each status has a base (icon/border/button), a `-fg` for text-on-tint, and a `-bg` tint for banners/badges.

| Status | Base | Text-on-tint (`-fg`) | Tint bg (`-bg`) |
|---|---|---|---|
| Success (active, paid, verified) | `#1F9D57` `--color-success-500` | `#0F5C32` `--color-success-700` | `#E6F6EC` `--color-success-50` |
| Warning (pending, trial ending)  | `#E08600` `--color-warning-500` | `#8A5200` `--color-warning-700` | `#FEF4E6` `--color-warning-50` |
| Danger (suspended, failed, overdue) | `#D92D2D` `--color-danger-500` | `#8A1717` `--color-danger-700` | `#FDEAEA` `--color-danger-50` |
| Info (notes, neutral system msgs) | `#1A73D9` `--color-info-500` | `#0C4084` `--color-info-700` | `#E7F1FD` `--color-info-50` |

Modules map their domain statuses (user status, invoice status, bill-run state, etc.) onto these families in their own ui-context file — never invent new status hues per module.

---

## 4. AI & Accent Variants (Iris/Violet family)

A distinct **Iris/violet** family separates AI-assisted features (smart grouping, anomaly/billing-risk flags, suggestions, natural-language search) from standard brand actions — so "AI did this" is always visually legible. **Only use in modules that ship AI/ML features**; modules without AI components must not use these tokens (defining them in `globals.css` is fine).

| Token | Hex | Use |
|---|---|---|
| `--ai-50`   | `#F0EDFF` | AI suggestion background, chips |
| `--ai-100`  | `#DAD2FF` | AI hover wash |
| `--ai-300`  | `#A793FF` | AI borders, secondary icons |
| `--ai-500`  | `#6D45F0` | **Base AI** — assistant icon, AI buttons |
| `--ai-600`  | `#5A2FD8` | AI hover / text-on-light |
| `--ai-700`  | `#4621B0` | Pressed, high-contrast AI text |

### Signature Gradients (hero, AI surfaces, charts, login)

| Token | Value |
|---|---|
| `--gradient-brand`   | `linear-gradient(135deg, #2E45A9 0%, #E6007E 100%)` (indigo → magenta) |
| `--gradient-5g`      | `linear-gradient(120deg, #00A9BC 0%, #6D45F0 50%, #E6007E 100%)` (cyan → iris → magenta) |
| `--gradient-ai`      | `linear-gradient(135deg, #6D45F0 0%, #E6007E 100%)` (iris → magenta) |
| `--gradient-chrome`  | `linear-gradient(180deg, #1B2A68 0%, #0C122E 100%)` (nav/sidebar depth) |

> Reserve `--gradient-5g` / `--gradient-brand` for marketing-style moments (login, empty states, dashboards), not data-dense admin chrome — keep tables and forms flat for legibility. `--gradient-chrome` (nav/sidebar depth) is fine in the app chrome.

---

## 5. Typography

Recommended families: **IBM Plex Sans** for UI (engineered, telecom-native feel) with **Inter** as a metrically-friendly fallback; **IBM Plex Mono** for IDs, invoice/account numbers, API keys, and tabular figures.

```
:root {
  --font-sans: "IBM Plex Sans", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", "Consolas", monospace;
}
```

| Token | Size / Line height | Weight | Use |
|---|---|---|---|
| `--text-display` | 32px / 40px | 600 | Page hero / module title |
| `--text-h1` | 28px / 36px | 600 | Page title |
| `--text-h2` | 22px / 30px | 600 | Section heading |
| `--text-h3` | 18px / 26px | 600 | Card / panel heading |
| `--text-h4` | 16px / 24px | 600 | Sub-heading, table group |
| `--text-body-lg` | 16px / 24px | 400 | Emphasis body |
| `--text-body` | 14px / 22px | 400 | **Default body / table cells** |
| `--text-body-sm` | 13px / 20px | 400 | Dense tables, secondary |
| `--text-caption` | 12px / 16px | 400 | Helper text, timestamps |
| `--text-overline` | 11px / 16px | 600, +0.06em, UPPER | Labels, table headers, badges |
| `--text-mono` | 13px / 20px | 400 | IDs, invoice/account numbers, keys |

**Weights:** Regular 400 (body), Medium 500 (controls, emphasis), SemiBold 600 (headings). Avoid 700+ in dense UI. Enable `font-variant-numeric: tabular-nums` for all numeric/currency columns so billing figures align.

---

## 6. Border Radius Scale

Restrained, corporate — not playful. Default UI radius is small.

| Token | Value | Use |
|---|---|---|
| `--radius-none` | `0` | Tables, full-bleed bars, data grids |
| `--radius-xs`   | `2px` | Tags, checkboxes, inline chips |
| `--radius-sm`   | `4px` | Inputs, buttons, dropdowns |
| `--radius-md`   | `6px` | **Default** — cards, menus, popovers |
| `--radius-lg`   | `8px` | Modals, larger panels |
| `--radius-xl`   | `12px` | Feature cards, dashboard tiles |
| `--radius-2xl`  | `16px` | Hero / marketing surfaces |
| `--radius-pill` | `9999px` | Status pills, avatars, toggles |

---

## 7. Elevation (supporting)

Cool, low-spread shadows to keep the formal flatness.

| Token | Value |
|---|---|
| `--shadow-sm` | `0 1px 2px rgba(17,20,26,0.06)` |
| `--shadow-md` | `0 2px 8px rgba(17,20,26,0.08)` |
| `--shadow-lg` | `0 8px 24px rgba(17,20,26,0.12)` |
| `--focus-ring` | `0 0 0 2px #FFFFFF, 0 0 0 4px #2E45A9` |

---

## 8. Usage Notes

- Pair each status **base** color with its `-fg` token (not white) when used as text on the `-bg` tint.
- For tints like `cyan-600` and `warning-50`, use **dark text** (`neutral-900`) for small or body-size labels, or step the base to `cyan-700` / `warning-700`. For long body text on `accent-500` magenta, prefer `accent-600` or darker.
- Default focus indicator: 2px `--border-focus` ring with a white inset (`--focus-ring`) for visibility on both light surfaces and dark chrome.
- Badges/pills render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair color with an icon and label so meaning never depends on color alone.
