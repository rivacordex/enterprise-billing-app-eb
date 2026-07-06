# Enterprise Billing App — User Management Module
## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to User Management domain objects, plus this module's exclusions.

---

## 0. Module Scope & Exclusions

New module-specific semantic tokens below wire each to a named component from code-standards §4.8 / §9: **user-status** (the exact `PENDING | ACTIVE | DISABLED | DELETED` set + locked overlay, §1 → `StatusBadge`), **auth-method** (`SSO | LOCAL`, §2 → `AuthMethodBadge`), **RBAC role + permission-level** (§3 → `RoleBadge`, `PermissionLevelTag`), and **audit-event category** colors (§4 → `AuditLogTable`). Per code-standards §4.3, define these as CSS variables in `globals.css`; never hardcode the hex in a component.

Two deliberate exclusions:

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used in User Management v1.** Architecture §7 states the module has **no AI/ML components**, so the AI tokens (ui-context §4) are *reserved for later modules* (e.g. billing-anomaly flags) and must not appear on any v1 admin screen. Defining them is fine; using them here is a scope violation.
2. **Marketing gradients are reserved for `/login` and the `/no-access` empty state.** `--gradient-brand`, `--gradient-5g`, and `--gradient-ai` must not appear on the four admin pages — keep Users, Roles, System Configuration, and Audit Log flat for data-density. `--gradient-chrome` (nav/sidebar depth) is fine in the app chrome.

---

## 1. User Status (`StatusBadge`)

**User-status mapping (authoritative for `UserStatus`).** `StatusBadge` (code-standards §4.8) maps the four `UserStatus` values to fixed tokens from ui-context §3.4. Render each as a pill (`--radius-pill`) pairing the `-bg` tint with its `-fg` text, plus an icon so the two red states stay distinguishable without relying on color alone:

| `UserStatus` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `ACTIVE` | May sign in and act | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `PENDING` | Pre-created, awaiting first login | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | clock |
| `DISABLED` | Access actively revoked (reversible) | `#D92D2D` danger-500 | `#8A1717` danger-700 | `#FDEAEA` danger-50 | ban |
| `DELETED` | Tombstoned / archived; hidden behind "Show deleted" | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render muted / strikethrough) |

**Locked indicator (overlay, not a `UserStatus`).** A lockout (`locked_until`) is a transient flag on an otherwise `ACTIVE` user; show a danger lock chip beside the status — base `#D92D2D` danger-500, `-bg` `#FDEAEA` danger-50, icon `lock` — cleared on `USER_UNLOCKED`.

---

## 2. Auth-Method Badges (`AuthMethodBadge`)

`auth_method` is `SSO | LOCAL`, mutually exclusive per user. Two fixed pill tokens, deliberately calmer than status so they don't compete in the Users table:

| `AuthMethod` | Meaning | Base | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `SSO` | Microsoft Entra ID (connectivity) | `#00899A` cyan-600 | `#006975` cyan-700 | `#E2F8FA` cyan-50 | shield-check |
| `LOCAL` | Email + password credential | `#4C5462` neutral-600 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | key |

---

## 3. RBAC — Role & Permission-Level Badges

**Role badges (`RoleBadge`)** for the three seeded roles. ADMIN carries corporate-authority indigo; since only ADMIN holds v1 grants, MANAGER/USER badges usually sit on accounts that land on `/no-access`:

| Role | Base | `-fg` text | `-bg` tint |
|---|---|---|---|
| `ADMIN` | `#2E45A9` primary-500 | `#1B2A68` primary-700 | `#EDF0FB` primary-50 |
| `MANAGER` | `#00899A` cyan-600 | `#006975` cyan-700 | `#E2F8FA` cyan-50 |
| `USER` | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 |

**Permission-level ramp (`PermissionLevelTag`)** for `READ ⊂ EDIT ⊂ DELETE`, used in the `PermissionMatrixEditor` and role detail. A deliberate low→high risk ramp (blue → amber → red) so escalating power reads at a glance:

| Level | Conveys | Base | `-fg` text | `-bg` tint |
|---|---|---|---|---|
| `READ` | View only | `#1A73D9` info-500 | `#0C4084` info-700 | `#E7F1FD` info-50 |
| `EDIT` | Mutate | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 |
| `DELETE` | Destructive / tombstone | `#D92D2D` danger-500 | `#8A1717` danger-700 | `#FDEAEA` danger-50 |

`audit_log` is READ-max — render its EDIT/DELETE cells in the matrix as disabled (`--text-disabled` on `--surface-sunken`), never as an empty actionable cell.

---

## 4. Audit-Log Event Categories (`AuditLogTable`)

Color-code the audit feed by event **family** (not per-event) so scanning is fast. Use the matching status `-bg`/`-fg` pair as a left-border accent or category tag:

| Category | Events | Color family |
|---|---|---|
| Additive | `USER_CREATED`, `USER_ENABLED`, `ROLE_CREATED`, `ROLE_ASSIGNED` | success (green) |
| Change | `USER_UPDATED`, `ROLE_UPDATED`, `PERMISSION_MAPPING_CHANGED`, `SYSTEM_CONFIG_CHANGED`, `USER_AUTH_METHOD_CHANGED` | info (blue) |
| Removal | `USER_DISABLED`, `USER_DELETED`, `ROLE_DELETED`, `ROLE_REVOKED` | danger (red) |
| Session | `SSO_LOGIN`, `LOCAL_LOGIN`, `USER_FIRST_LOGIN` | cyan (connectivity) |
| Security | `USER_LOCKED`, `USER_UNLOCKED`, `USER_PASSWORD_RESET`, `USER_PASSWORD_CHANGED` | warning (amber) |

**Datetime display (all admin tables/details, um29).** Datetimes are stored UTC and displayed in the configured business timezone (`APP_TIMEZONE`). Audit rows show the local wall-clock with an `Intl` offset suffix — `2026-06-17 17:14:22 (GMT+8)` — and keep the raw UTC ISO instant in the hover `title` for forensics; when the zone is `UTC` the suffix is the literal `… UTC` (no parentheses), unchanged from today. The `<time dateTime>` attribute stays ISO-8601 UTC (machine-readable) while the visible `title` shows the configured zone. Use `IBM Plex Mono` for the timestamp column to keep figures tabular (ui-context §5). DST is not handled in v1 (um29 §2.2).

---

## 5. Module Typography Notes

Use `--font-mono` for `user_id`, the Entra object id (`provider_account_id`), session-token excerpts, and `AUDIT_LOG` timestamps, and enable `tabular-nums` on `failed_login_count` and any count column so the Users and Audit Log tables stay aligned. `--action-cta-bg` is the featured CTA in this module (e.g. "Invite user").

---

## 6. Module Usage Notes

- **Module badges (§1–4)** render dark `-fg` text on the light `-bg` tint — never white-on-tint. The two danger states (`DISABLED`, Locked), `DELETED`, and the auth/role/level tags are differentiated by icon and label (ban / lock / archive / shield-check / key), so meaning never depends on color alone.
