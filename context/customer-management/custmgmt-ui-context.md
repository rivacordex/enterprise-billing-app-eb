# Enterprise Billing App — Customer Management Module
## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Customer Management domain objects (code-standards §4.1), plus this module's exclusions. Per code-standards §4.3, define these as CSS variables in `globals.css`; never hardcode the hex in a component.

---

## 0. Module Scope & Exclusions

Module-specific semantic wiring below covers the named components from code-standards §4.1: **`OrganizationStatusBadge`**, **`CustomerStatusBadge`**, **`OrganizationTypeBadge`**, **`PreferredIndicator`**, the **`StatusTransitionControl`** option styling, **`InconsistencyBanner`**, **`SpecificationEditor`**, and the flattened contact-medium type icons (phone/email/address).

Two deliberate exclusions (same rules as User Management and Product Management):

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used in Customer Management v1.** Architecture §5 states the module has **no AI/ML components**; the AI tokens (ui-context §4) remain reserved for later modules and must not appear on any v1 screen. Defining them in `globals.css` is fine; using them here is a scope violation.
2. **Marketing gradients stay off both admin pages.** `/customer/view/**` and `/customer/manage/**` are data-dense, search-first admin screens — keep them flat. `--gradient-chrome` remains fine in the shared nav/sidebar chrome (unchanged by the new "Customer" nav section).

---

## 1. Organization Status (`OrganizationStatusBadge`)

**Authoritative mapping for `OrganizationStatus`.** Render as a pill (`--radius-pill`), `-bg` tint with `-fg` text, plus icon. `SUSPENDED` maps to the danger family per the base status table (ui-context §3.4 lists "suspended" as a danger example); the two terminal states (`DISSOLVED`, `MERGED`) share the neutral/archived treatment used for `RETIRED`/`DELETED` elsewhere but keep distinct icons so they never read as identical:

| `OrganizationStatus` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `REGISTERED` | Created, awaiting activation (initial status on every new org) | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | clipboard |
| `ACTIVE` | Trading, eligible for an active customer role | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `INACTIVE` | Dormant, reversible; not a problem state | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | pause-circle |
| `SUSPENDED` | Reversible hold, needs attention | `#D92D2D` danger-500 | `#8A1717` danger-700 | `#FDEAEA` danger-50 | alert-octagon |
| `DISSOLVED` | Terminal; never physically deleted | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted) |
| `MERGED` | Terminal; folded into another org | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | git-merge (render row muted) |

---

## 2. Customer / Party Role Status (`CustomerStatusBadge`)

**Authoritative mapping for `CustomerStatus`.** Same construction as §1. `VALIDATED` is a mid-flow checkpoint (data confirmed, not yet billable) and gets the info family to sit visually between `INITIALIZED` (warning) and `ACTIVE` (success); `SUSPENDED` again maps to danger per ui-context §3.4:

| `CustomerStatus` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `INITIALIZED` | Created, no validation yet (initial status on every new role) | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | pencil-line |
| `VALIDATED` | Confirmed, not yet billable | `#1A73D9` info-500 | `#0C4084` info-700 | `#E7F1FD` info-50 | shield-check |
| `ACTIVE` | Billable, in force | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `SUSPENDED` | Reversible hold, needs attention | `#D92D2D` danger-500 | `#8A1717` danger-700 | `#FDEAEA` danger-50 | alert-octagon |
| `CLOSED` | Terminal; hidden by default, never reopened | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted / strikethrough) |

**`StatusTransitionControl`** renders only the next-states the transition map allows (code-standards §2.2/§3.3) — style each offered option with its target status's badge color as a leading swatch/icon so the dropdown previews the destination state, not just plain text.

---

## 3. Organization Type (`OrganizationTypeBadge`)

Categorical, not a lifecycle status — deliberately calmer, same construction as the module's `RoleBadge` precedent (usrmgmt):

| `OrganizationType` | Base | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|
| `COMPANY` | `#2E45A9` primary-500 | `#1B2A68` primary-700 | `#EDF0FB` primary-50 | building-2 |
| `GOVERNMENT` | `#00899A` cyan-600 | `#006975` cyan-700 | `#E2F8FA` cyan-50 | landmark |

---

## 4. Preferred Indicator (`PreferredIndicator`)

One shared marker, identical in the contact list (preferred contact) and the contact-method rows (preferred method) — code-standards §4.1 requires the same icon in both contexts, never a different one per surface:

| Token | Hex | Use |
|---|---|---|
| `--preferred-fg` | `#E6007E` accent-500 | Filled star icon, `PreferredIndicator` only |

Reserve `accent-500` for this single marker in the module (no other Customer Management element uses the accent scale) so "preferred" stays instantly scannable against the status badges in §1–2.

---

## 5. Inconsistency Banner (`InconsistencyBanner`)

Cross-status warning (e.g. ACTIVE customer on a SUSPENDED organization) per code-standards §4.3 — **warn-only styling, never blocking/destructive**, since the platform does not cascade the mismatch:

| Token | Value | Role |
|---|---|---|
| `--banner-warning-border` | `#E08600` warning-500 | Left border / outline |
| `--banner-warning-bg` | `#FEF4E6` warning-50 | Banner fill |
| `--banner-warning-fg` | `#8A5200` warning-700 | Banner text |
| Icon | `alert-triangle` | Paired with text, never color-only |

---

## 6. Specification Editor & Contact Medium Icons

**`SpecificationEditor`** — raw JSON textarea for `party_role_specification` (code-standards §1.8: well-formedness only, no shape validation):

| State | Token | Role |
|---|---|---|
| Default | `--surface-sunken` bg, `--border-default`, `--font-mono` | Textarea chrome |
| Invalid JSON (client-side parse feedback) | `--border` → `#D92D2D` danger-500; caption `#8A1717` danger-700 on `#FDEAEA` danger-50 | Inline "Invalid JSON" message under the field |
| Valid JSON | No special treatment — default chrome; do not add a success flash | — |

**Contact medium type icons** (flattened `phone_*` / `email_*` / `ga_*` columns) — quiet neutral icons, no color coding by type since none carries status meaning:

| Method | Icon | Color |
|---|---|---|
| Phone | `phone` | `#4C5462` neutral-600 |
| Email | `mail` | `#4C5462` neutral-600 |
| Address | `map-pin` | `#4C5462` neutral-600 |

---

## 7. Module Typography & Surface Notes

Use `--font-mono` for the sequence IDs (`ORG…`, `PTRL…`, `CTMD…`) and `status_reason` display in audit/history views. `status_reason` input fields and the `SpecificationEditor` use `--text-body-sm`. Selected search result row uses the shared `--surface-selected`; the three detail sections (Organization, Customer Role, Contact Details) are `--surface-card` on `--surface-app` with `--border-default`, in the fixed top-to-bottom order per code-standards §4.5. `--action-cta-bg` is the featured CTA for "Add new customer" and "Add contact".

---

## 8. Module Usage Notes

- **Badges (§1–3)** render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair icon + label. This matters most here because two entities share the same status vocabulary at different lifecycle stages: `SUSPENDED` (org) and `SUSPENDED` (customer) are visually identical by design (same real-world meaning), while the four neutral terminal/dormant states (`INACTIVE`, `DISSOLVED`, `MERGED`, `CLOSED`) are disambiguated only by icon and label — color alone never carries the distinction.
- `PreferredIndicator` (§4) is the only accent-scale usage in the module — keep it that way so it doesn't compete with status badges for attention.
