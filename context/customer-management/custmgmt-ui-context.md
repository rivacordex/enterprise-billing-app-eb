# Enterprise Billing App — Customer Management Module

## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Customer Management domain objects (code-standards §4.1), plus this module's exclusions. Per code-standards §4.3, define these as CSS variables in `globals.css`; never hardcode the hex in a component.
>
> **Invoice Template Binding update (planned 2026-10-10):** View Customer becomes three tabs with a read-only Accounts tab, and Manage Customer gains a Billing account panel and one onboarding field. **No new color, hex value, font, radius or elevation token** is introduced; the update wires existing shared and Accounting tokens to the new elements. See §9.

---

## 0. Module Scope & Exclusions

Module-specific semantic wiring below covers the named components from code-standards §4.1: **`OrganizationStatusBadge`**, **`CustomerStatusBadge`**, **`OrganizationTypeBadge`**, **`PreferredIndicator`**, the **`StatusTransitionControl`** option styling, **`InconsistencyBanner`**, **`SpecificationEditor`**, and the flattened contact-medium type icons (phone/email/address).

Two deliberate exclusions (same rules as User Management and Product Management):

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used in Customer Management v1.** Architecture §5 states the module has **no AI/ML components**; the AI tokens (ui-context §4) remain reserved for later modules and must not appear on any v1 screen. Defining them in `globals.css` is fine; using them here is a scope violation.
2. **Marketing gradients stay off both admin pages.** `/customer/view/**` and `/customer/manage/**` are data-dense, search-first admin screens — keep them flat. `--gradient-chrome` remains fine in the shared nav/sidebar chrome (unchanged by the new "Customer" nav section).

---

## 1. Organization Status (`OrganizationStatusBadge`)

**Authoritative mapping for `OrganizationStatus`.** Render as a pill (`--radius-pill`), `-bg` tint with `-fg` text, plus icon. `SUSPENDED` maps to the danger family per the base status table (ui-context §3.4 lists "suspended" as a danger example); the two terminal states (`DISSOLVED`, `MERGED`) share the neutral/archived treatment used for `RETIRED`/`DELETED` elsewhere but keep distinct icons so they never read as identical:

| `OrganizationStatus` | Meaning                                                        | Base / icon color     | `-fg` text            | `-bg` tint            | Icon                         |
| -------------------- | -------------------------------------------------------------- | --------------------- | --------------------- | --------------------- | ---------------------------- |
| `REGISTERED`         | Created, awaiting activation (initial status on every new org) | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50  | clipboard                    |
| `ACTIVE`             | Trading, eligible for an active customer role                  | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50  | check-circle                 |
| `INACTIVE`           | Dormant, reversible; not a problem state                       | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | pause-circle                 |
| `SUSPENDED`          | Reversible hold, needs attention                               | `#D92D2D` danger-500  | `#8A1717` danger-700  | `#FDEAEA` danger-50   | alert-octagon                |
| `DISSOLVED`          | Terminal; never physically deleted                             | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted)   |
| `MERGED`             | Terminal; folded into another org                              | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | git-merge (render row muted) |

---

## 2. Customer / Party Role Status (`CustomerStatusBadge`)

**Authoritative mapping for `CustomerStatus`.** Same construction as §1. `VALIDATED` is a mid-flow checkpoint (data confirmed, not yet billable) and gets the info family to sit visually between `INITIALIZED` (warning) and `ACTIVE` (success); `SUSPENDED` again maps to danger per ui-context §3.4:

| `CustomerStatus` | Meaning                                                       | Base / icon color     | `-fg` text            | `-bg` tint            | Icon                                       |
| ---------------- | ------------------------------------------------------------- | --------------------- | --------------------- | --------------------- | ------------------------------------------ |
| `INITIALIZED`    | Created, no validation yet (initial status on every new role) | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50  | pencil-line                                |
| `VALIDATED`      | Confirmed, not yet billable                                   | `#1A73D9` info-500    | `#0C4084` info-700    | `#E7F1FD` info-50     | shield-check                               |
| `ACTIVE`         | Billable, in force                                            | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50  | check-circle                               |
| `SUSPENDED`      | Reversible hold, needs attention                              | `#D92D2D` danger-500  | `#8A1717` danger-700  | `#FDEAEA` danger-50   | alert-octagon                              |
| `CLOSED`         | Terminal; hidden by default, never reopened                   | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted / strikethrough) |

**`StatusTransitionControl`** renders only the next-states the transition map allows (code-standards §2.2/§3.3) — style each offered option with its target status's badge color as a leading swatch/icon so the dropdown previews the destination state, not just plain text.

---

## 3. Organization Type (`OrganizationTypeBadge`)

Categorical, not a lifecycle status — deliberately calmer, same construction as the module's `RoleBadge` precedent (usrmgmt):

| `OrganizationType` | Base                  | `-fg` text            | `-bg` tint           | Icon       |
| ------------------ | --------------------- | --------------------- | -------------------- | ---------- |
| `COMPANY`          | `#2E45A9` primary-500 | `#1B2A68` primary-700 | `#EDF0FB` primary-50 | building-2 |
| `GOVERNMENT`       | `#00899A` cyan-600    | `#006975` cyan-700    | `#E2F8FA` cyan-50    | landmark   |

---

## 4. Preferred Indicator (`PreferredIndicator`)

One shared marker, identical in the contact list (preferred contact) and the contact-method rows (preferred method) — code-standards §4.1 requires the same icon in both contexts, never a different one per surface:

| Token            | Hex                  | Use                                         |
| ---------------- | -------------------- | ------------------------------------------- |
| `--preferred-fg` | `#E6007E` accent-500 | Filled star icon, `PreferredIndicator` only |

Reserve `accent-500` for this single marker in the module (no other Customer Management element uses the accent scale) so "preferred" stays instantly scannable against the status badges in §1–2.

---

## 5. Inconsistency Banner (`InconsistencyBanner`)

Cross-status warning (e.g. ACTIVE customer on a SUSPENDED organization) per code-standards §4.3 — **warn-only styling, never blocking/destructive**, since the platform does not cascade the mismatch:

| Token                     | Value                 | Role                               |
| ------------------------- | --------------------- | ---------------------------------- |
| `--banner-warning-border` | `#E08600` warning-500 | Left border / outline              |
| `--banner-warning-bg`     | `#FEF4E6` warning-50  | Banner fill                        |
| `--banner-warning-fg`     | `#8A5200` warning-700 | Banner text                        |
| Icon                      | `alert-triangle`      | Paired with text, never color-only |

---

## 6. Specification Editor & Contact Medium Icons

**`SpecificationEditor`** — raw JSON textarea for `party_role_specification` (code-standards §1.8: well-formedness only, no shape validation):

| State                                     | Token                                                                                  | Role                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Default                                   | `--surface-sunken` bg, `--border-default`, `--font-mono`                               | Textarea chrome                               |
| Invalid JSON (client-side parse feedback) | `--border` → `#D92D2D` danger-500; caption `#8A1717` danger-700 on `#FDEAEA` danger-50 | Inline "Invalid JSON" message under the field |
| Valid JSON                                | No special treatment — default chrome; do not add a success flash                      | —                                             |

**Contact medium type icons** (flattened `phone_*` / `email_*` / `ga_*` columns) — quiet neutral icons, no color coding by type since none carries status meaning:

| Method  | Icon      | Color                 |
| ------- | --------- | --------------------- |
| Phone   | `phone`   | `#4C5462` neutral-600 |
| Email   | `mail`    | `#4C5462` neutral-600 |
| Address | `map-pin` | `#4C5462` neutral-600 |

---

## 7. Module Typography & Surface Notes

Use `--font-mono` for the sequence IDs (`ORG…`, `PTRL…`, `CTMD…`) and `status_reason` display in audit/history views. `status_reason` input fields and the `SpecificationEditor` use `--text-body-sm`. Selected search result row uses the shared `--surface-selected`; the three detail sections (Organization, Customer Role, Contact Details) are `--surface-card` on `--surface-app` with `--border-default`; once the Invoice Template Binding update lands they sit in tabs (Organization + Customer Role on **Profile**, Contact Details on **Contacts**) instead of one fixed top-to-bottom stack (§9.1). "Add new customer" and "Add contact" are record-creation buttons and use `--action-primary-bg` (`#2E45A9`), never `--action-cta-bg` (ui-context §3.3).

---

## 8. Module Usage Notes

- **Badges (§1–3)** render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair icon + label. This matters most here because two entities share the same status vocabulary at different lifecycle stages: `SUSPENDED` (org) and `SUSPENDED` (customer) are visually identical by design (same real-world meaning), while the four neutral terminal/dormant states (`INACTIVE`, `DISSOLVED`, `MERGED`, `CLOSED`) are disambiguated only by icon and label — color alone never carries the distinction.
- `PreferredIndicator` (§4) is the only accent-scale usage in the module — keep it that way so it doesn't compete with status badges for attention.

---

## 9. Invoice Template Binding update — UI deltas (2026-10-10)

Scope: `custmgmt-update-overview.md`, binding plan D5–D16, `custmgmt-architecture.md` Inv. #11–#18. Every value below is an **existing** token from `context/ui-context.md` or `acctmgmt-ui-context.md`; nothing new goes into `globals.css`.

### 9.1 View Customer tab strip

Follow the existing `?tab=` link-strip precedent (`components/billing/run-detail-tabs.tsx`): a flat bar of plain links, not a `components/ui` tabs primitive.

| Element                | Token                                          | Hex                    | Rule                                                                                  |
| ---------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| Strip baseline         | `--border-default`, 1px bottom                 | `#E0E4EB`              | Full width under the tabs; `--radius-none`                                            |
| Active tab underline   | `--color-primary-500`, 2px bottom              | `#2E45A9`              | Never the accent scale — accent stays reserved for `PreferredIndicator` (§4)          |
| Active tab label       | `--text-primary`, `--text-body-sm`, 600        | `#11141A`              | Set `aria-current="page"`                                                             |
| Inactive tab label     | `--text-muted`, `--text-body-sm`, 500          | `#6A7283`              | Hover → `--text-primary`                                                              |
| Focus                  | `--border-focus` 2px ring                      | `#2E45A9`              | Keyboard focus on each tab link                                                       |
| `InconsistencyBanner`  | unchanged §5 tokens                            | —                      | Renders **above** the strip, so it shows on every tab                                 |

### 9.2 Accounts tab content

Reuse the Accounting module's components and status mapping (`acctmgmt-ui-context.md` §1–§2: `doc-state-badge.tsx`, `payment-status-badge.tsx`, `amount-cell`); never restyle a document, payment or account state here.

| Element                                         | Token                                                            | Hex                                | Rule                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| FA summary card and each BAN card               | `--surface-card`, `--border-default`, `--radius-md`              | `#FFFFFF`, `#E0E4EB`               | Card heading `--text-h3`                                                     |
| Amounts (receivable, unapplied cash, deposits, BAN A/R) | `--acct-amount` / `--acct-amount-negative`, `tabular-nums` | `#11141A` / `#8A1717`              | Negative shown with parentheses; color only reinforces                       |
| IDs (`FIN…`, `BAN…`, document ids)              | `--font-mono`, `--text-mono`                                     | —                                  | Same as other module IDs (§7)                                                |
| BAN state chip (`active` / `suspended` / `closed`) | Accounting §2 account mapping                                 | success / warning / neutral        | `closed` BAN card also renders muted                                         |
| Document state and payment status               | Accounting §2 mapping via the owning badge components            | —                                  | No customer-side copy of the mapping                                         |
| Document row deep-link                          | `--text-link`, hover `--text-link-hover`                         | `#2E45A9` / `#233686`              | The row links into the Accounts module; no action buttons in the tab         |

### 9.3 Accounts tab states

| State (plan §7.2)   | Treatment                                                                                    | Hex                             | Icon          |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | ------------- |
| Locked              | Muted card: `--surface-sunken` fill, `--text-muted` text "Requires accounts access"          | `#EEF0F4` / `#6A7283`           | `lock`        |
| Not onboarded       | Info family: `info-50` fill, `info-700` text "Accounts are created when the customer is validated" | `#E7F1FD` / `#0C4084`     | `info`        |
| Onboarded, empty    | Plain `--text-muted` sentence in the document list area; no illustration or gradient         | `#6A7283`                       | —             |
| Loading (Suspense)  | `components/ui/skeleton` blocks on `--surface-sunken`                                        | `#EEF0F4`                       | —             |

### 9.4 Template binding label (View Customer and Manage Customer)

The binding is a reference, not a status, so it gets **no badge color**.

| Part                                     | Token                                   | Hex       |
| ---------------------------------------- | --------------------------------------- | --------- |
| "Follows active template"                | `--text-body`, `--text-body-sm`         | `#353B46` |
| "(currently: <name> vN)"                 | `--text-body`; `vN` in `--font-mono`    | `#353B46` |
| "as of now"                              | `--text-muted`, `--text-caption`        | `#6A7283` |
| Leading icon                             | `file-text`, neutral-600                | `#4C5462` |

### 9.5 Manage Customer — Billing account panel and onboarding field

| Element                                                        | Token                                                                                 | Hex                              | Rule                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Panel                                                          | `--surface-card`, `--border-default`, `--radius-md`                                   | `#FFFFFF` / `#E0E4EB`            | Same chrome as the existing Manage Customer sections                                         |
| "Reset to follow active template" button                       | `--action-secondary-bg` / `-border` / `-text`, `--radius-sm`                          | `#FFFFFF` / `#CAD0DA` / `#353B46` | Secondary: a reset is neither a record creation (`--action-primary-bg`) nor the screen's featured action (`--action-cta-bg`) |
| Disabled (viewer lacks `accounts_transactions : EDIT`)         | `--action-disabled-bg`, `--text-disabled`, `EDIT_DISABLED_TITLE` tooltip              | `#E0E4EB` / `#99A1B0`            | Same pattern as `components/accounts/edit-access.ts`; UX only                                |
| `CONFLICT` / `BAN_CLOSED` / `TEMPLATE_NOT_BINDABLE` message    | Danger family inline alert (`components/ui/alert`)                                    | `#FDEAEA` / `#8A1717`            | Icon + text, never color-only                                                                |
| Onboarding "Invoice template" select                           | Standard select (`--border-strong`, `--radius-sm`)                                    | `#CAD0DA`                        | Single option, pre-selected; help text `--text-caption`, `--text-muted`                     |

### 9.6 Typography, radius and AI — no change

| Concern            | Decision                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Color palette      | No new hex and no new semantic token; §9.1–§9.5 reuse `ui-context.md` §3 and `acctmgmt-ui-context.md` §1–§2. |
| Typography         | No new font or size; tabs use `--text-body-sm`, card headings `--text-h3`, IDs and versions `--text-mono`.   |
| Border radius      | No new step; tab strip `--radius-none`, cards and panel `--radius-md`, buttons and select `--radius-sm`, state chips `--radius-pill`. |
| AI / accent        | Still none: no `--ai-*`, no `--gradient-*` on these pages. The accent scale stays reserved for `PreferredIndicator`. |
