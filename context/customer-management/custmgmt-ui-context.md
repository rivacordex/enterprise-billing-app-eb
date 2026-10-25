# Enterprise Billing App — Customer Management Module

## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Customer Management domain objects (code-standards §4.1), plus this module's exclusions. Per code-standards §4.3, define these as CSS variables in `globals.css`; never hardcode the hex in a component.
>
> **Invoice Template Binding update (delivered cm17–cm22; signed off 2026-10-25):** View Customer became three tabs with a read-only Accounts tab, and Manage Customer gained a Billing account panel and one onboarding field. **No new color, hex value, font, radius or elevation token**; existing shared and Accounting tokens are wired to the new elements. See §9 (the record).
>
> **Invoice Template Types update (planned 2026-10-25):** the BAN's template becomes a **template type**. The panel's Reset button becomes a per-BAN **type select + Save**, the label shows the type and its active version, and the onboarding field's wording changes. **No new color, hex value, font, radius, elevation or AI token**; only existing tokens. See §10, which supersedes §9.4 and three §9.5 rows. Template types themselves (list, upload, retire, export) are styled in `billmgmt-ui-context.md` §10e, not here.

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

## 9. Invoice Template Binding update — UI deltas (2026-10-10; delivered, signed off 2026-10-25)

Scope: `custmgmt-project-overview.md` › Invoice Template Binding (folded at sign-off), `custmgmt-architecture.md` Inv. #11–#18. **This section is the delivered record; §10 supersedes §9.4 and the §9.5 rows marked below.** Every value below is an **existing** token from `context/ui-context.md` or `acctmgmt-ui-context.md`; nothing new goes into `globals.css`. **Built** by cm18–cm21 (`custmgmt-progress-tracker.md`); the tables below describe the components as built.

### 9.1 View Customer tab strip

Follow the existing `?tab=` link-strip precedent (`components/billing/run-detail-tabs.tsx`): a flat bar of plain links, not a `components/ui` tabs primitive.

| Element                | Token                                          | Hex                    | Rule                                                                                  |
| ---------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| Strip baseline         | `--border-default`, 1px bottom                 | `#E0E4EB`              | Full width under the tabs; `--radius-none`                                            |
| Active tab underline   | `--color-primary-500`, 2px bottom              | `#2E45A9`              | Never the accent scale — accent stays reserved for `PreferredIndicator` (§4)          |
| Active tab label       | `--text-primary`, `--text-body-sm`, 600        | `#11141A`              | Set `aria-current="page"`                                                             |
| Inactive tab label     | `--text-muted`, `--text-body-sm`, 500          | `#6A7283`              | Hover → `--text-primary`                                                              |
| Focus                  | `--focus-ring` (2px white + 2px `#2E45A9` box-shadow) | `#2E45A9`       | `focus-visible` on each tab link (as built in `customer-detail-tabs.tsx`; the copied `run-detail-tabs.tsx` classes had no focus ring) |
| `InconsistencyBanner`  | unchanged §5 tokens                            | —                      | Renders **above** the strip, so it shows on every tab                                 |

### 9.2 Accounts tab content

Reuse the Accounting module's components and status mapping (`acctmgmt-ui-context.md` §1–§2: `doc-state-badge.tsx`, `payment-status-badge.tsx`, `amount-cell`); never restyle a document, payment or account state here.

| Element                                         | Token                                                            | Hex                                | Rule                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| FA summary card and each BAN card               | `--surface-card`, `--border-default`, `--radius-md`              | `#FFFFFF`, `#E0E4EB`               | Card heading `--text-h3`                                                     |
| Amounts (receivable, unapplied cash, deposits, BAN A/R) | `--acct-amount` / `--acct-amount-negative`, `tabular-nums` | `#11141A` / `#8A1717`              | Negative shown with parentheses; color only reinforces                       |
| IDs (`FIN…`, `BAN…`, document ids)              | `--font-mono`, `--text-mono`                                     | —                                  | Same as other module IDs (§7)                                                |
| BAN state chip (`active` / `suspended` / `closed`) | Accounting §2 account mapping                                 | success / warning / neutral        | `closed` BAN card also renders muted. The same `BanStateChip` is shown on the FA summary card, which also mutes when closed |
| Document state and payment status               | Accounting §2 mapping via the owning badge components            | —                                  | No customer-side copy of the mapping                                         |
| Document row deep-link                          | `--text-link`, hover `--text-link-hover`                         | `#2E45A9` / `#233686`              | The document id links to `/accounts/transactions?party=…&fa=…&doc=…` only when the viewer holds `accounts_transactions : READ`; otherwise it is plain mono text. No action buttons in the tab |

### 9.3 Accounts tab states

| State (plan §7.2)   | Treatment                                                                                    | Hex                             | Icon          |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | ------------- |
| Locked              | Muted card: `--surface-sunken` fill, `--text-muted` text "Requires accounts access"          | `#EEF0F4` / `#6A7283`           | `lock`        |
| Not onboarded       | Info family: `info-50` fill, `info-700` text "Accounts are created when the customer is validated" | `#E7F1FD` / `#0C4084`     | `info`        |
| Onboarded, empty    | Plain `--text-muted` sentence "No transactions yet." in the document list area; no illustration or gradient | `#6A7283`        | —             |
| Loading (Suspense)  | `components/ui/skeleton` blocks on `--surface-sunken`                                        | `#EEF0F4`                       | —             |
| Unavailable (read failed; added in the cm20 review) | Danger family, `role="alert"`: `danger-50` fill, `danger-700` text "Account details could not be loaded. Try again, or open the customer in the Accounts module." (`AccountsUnavailableCard`; also used by the Manage Customer Billing account panel) | `#FDEAEA` / `#8A1717` | `alert-triangle` |

### 9.4 Template binding label (View Customer and Manage Customer)

The binding is a reference, not a status, so it gets **no badge color**. **Superseded by §10.1** when the Invoice Template Types update ships: the three text parts below are removed.

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
| "Reset to follow active template" button **(superseded, §10.2)** | `--action-secondary-bg` / `-border` / `-text`, `--radius-sm`                          | `#FFFFFF` / `#CAD0DA` / `#353B46` | Secondary: a reset is neither a record creation (`--action-primary-bg`) nor the screen's featured action (`--action-cta-bg`) |
| Disabled (viewer lacks `accounts_transactions : EDIT`)         | `--action-disabled-bg`, `--text-disabled`, `EDIT_DISABLED_TITLE` tooltip              | `#E0E4EB` / `#99A1B0`            | Same pattern as `components/accounts/edit-access.ts`; UX only. The tooltip copy reads "Requires accounts configuration edit access" (written for `accounts_config`); reused unchanged, raised in cm21 |
| Disabled (BAN `NULL` or closed) **(the `NULL` caption is superseded, §10.2)** | Same disabled tokens, plus a `--text-caption` / `--text-muted` caption under the button | `#E0E4EB` / `#99A1B0` / `#6A7283` | "Already following the active template" (`NULL`) or "Billing account is closed" (closed wins). Every v1 BAN is `NULL`, so the button is always disabled in v1. A closed BAN row renders at 60% opacity |
| `CONFLICT` / `BAN_CLOSED` / `TEMPLATE_NOT_BINDABLE` / `BAN_NOT_FOUND` / `FORBIDDEN` message | Danger family inline alert (`components/ui/alert`, `alert-circle` icon)          | `#FDEAEA` / `#8A1717`            | Icon + text, never color-only. `VALIDATION_ERROR` and a thrown action error show the generic "Something went wrong. Please try again." |
| Onboarding "Invoice template" field **(wording superseded, §10.3)** | Read-only `Input`, styled like Currency (`bg-muted/50`, `text-muted-foreground`)      | —                                | As built (cm18): a read-only field showing "Follow active template", not a select; help text via `FieldDescription` ("Invoices use the active template. Per-customer templates are not available yet.") |

> **Amended 2026-10-25:** the Invoice Template Types replacements for this panel are in **§10.2–§10.3**.

### 9.6 Typography, radius and AI — no change

| Concern            | Decision                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Color palette      | No new hex and no new semantic token; §9.1–§9.5 reuse `ui-context.md` §3 and `acctmgmt-ui-context.md` §1–§2. |
| Typography         | No new font or size; tabs use `--text-body-sm`, card headings `--text-h3`, IDs and versions `--text-mono`.   |
| Border radius      | No new step; tab strip `--radius-none`, cards and panel `--radius-md`, the hand-styled Reset button `--radius-sm`, the onboarding field `rounded-lg` 8px as built (`components/ui/input`; corrected 2026-10-25, shared §6), state chips `--radius-pill`. |
| AI / accent        | Still none: no `--ai-*`, no `--gradient-*` on these pages. The accent scale stays reserved for `PreferredIndicator`. |

---

## 10. Invoice Template Types update — UI deltas (2026-10-25; planned, not built)

Scope: `custmgmt-update-overview.md` (the Customer Management part), `custmgmt-architecture.md` Inv. #19–#22, `custmgmt-code-standards.md` §10 (copy owned by `components/customers/billing-account-messages.ts`). Every value is an **existing** token from `context/ui-context.md`; nothing new goes into `globals.css`. Template-type screens in Invoice Settings are Billing's (`billmgmt-ui-context.md` §10e).

### 10.1 Template type label (View Customer Accounts tab and Manage Customer panel) — replaces §9.4

Still a reference, not a status: **no badge**, except the warning treatment for a type that isn't usable.

| Part | Token | Hex | Rule |
| --- | --- | --- | --- |
| Field label "Invoice template type" | `--text-muted`, `--text-caption` | `#6A7283` | Above or before the value, like the card's other field labels |
| Type name: "Standard (default)" or "{type name}" | `--text-body`, `--text-body-sm` | `#353B46` | Plain text; the name is not mono |
| " · v{N}" (active version) | `--text-body`; `v{N}` in `--font-mono` | `#353B46` | The version the next run will capture |
| "· not usable" (`NOT_USABLE`) | Warning family: `--color-warning-700` text + `alert-triangle` icon (warning-500) | `#8A5200` / `#E08600` | Text **and** icon, never color alone; only after an SQL bypass |
| Leading icon | `file-text`, neutral-600 | `#4C5462` | Unchanged from §9.4 |

### 10.2 Manage Customer — Billing account panel: type select and Save (replaces three §9.5 rows)

| Element | Token | Hex | Rule |
| --- | --- | --- | --- |
| `TemplateTypeSelect` (one per open BAN) | `components/ui/select` as built: `rounded-lg` 8px, `--border-default` | `#E0E4EB` | Label "Invoice template type". Options "Standard (default)" first, then usable types by name. Never restyle the primitive |
| Save button | `--action-secondary-bg` / `-border` / `-text`, `--radius-sm` (hand-styled, like the delivered Reset button) | `#FFFFFF` / `#CAD0DA` / `#353B46` | Secondary: binding is neither a record creation nor the screen's featured action. Disabled when the selection is unchanged |
| Disabled select and Save (viewer lacks `accounts_transactions : EDIT`) | `--action-disabled-bg`, `--text-disabled`, `EDIT_DISABLED_TITLE` tooltip | `#E0E4EB` / `#99A1B0` | Unchanged pattern from §9.5; UX only |
| Closed BAN | No select; caption "Billing account is closed" in `--text-caption` / `--text-muted` | `#6A7283` | Unchanged from §9.5 |
| Caption "Changes apply from the next bill run start or rerun." | `--text-caption`, `--text-muted` | `#6A7283` | Once, under the panel |
| Retired-type save failure ("This invoice template type is no longer available…") | Danger family inline alert, `alert-circle` icon | `#FDEAEA` / `#8A1717` | Same treatment as the other §9.5 result messages; the panel then reloads |
| `CONFLICT` / `BAN_CLOSED` / `BAN_NOT_FOUND` / `FORBIDDEN` | Unchanged from §9.5 | — | — |

**Removed:** the "Reset to follow active template" button and the "Already following the active template" caption.

### 10.3 Onboarding field

| Element | Token | Rule |
| --- | --- | --- |
| Read-only field "Invoice template type" | Unchanged styling (read-only `Input` like Currency: `bg-muted/50`, `text-muted-foreground`) | Value "Standard (default)"; help text "New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account." Still not a select |

### 10.4 Typography, radius and AI — no new token

| Concern | Decision |
| --- | --- |
| Color palette | No new hex and no new semantic token. The Warning family (`ui-context.md` §3.4) is used for the first time on these screens, for `NOT_USABLE` only. |
| Typography | No new font or size: `--text-body-sm` for names, `--font-mono` for `v{N}`, `--text-caption` for labels and the caption. |
| Border radius | No new step: the select is `rounded-lg` as built by `components/ui/select`; Save is `--radius-sm`; the panel and cards stay `--radius-md`. |
| AI / accent | Still none. The accent scale stays reserved for `PreferredIndicator`. |
