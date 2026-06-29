# Spec: um29 — Timezone Handling

- **Boundary:** BACKEND (with thin display thread-through into existing components).
- **Builds:** a single, configurable **business timezone** (`APP_TIMEZONE`, an IANA name) read from the environment, validated fail-fast at boot, and threaded through every datetime the app displays or reasons about — so stored-UTC instants are rendered in the configured zone, and the Audit Log day filter resolves the correct **local** day instead of a UTC day.
- **Visible result:** With `APP_TIMEZONE=Asia/Kuala_Lumpur`, every admin datetime (Users, Roles, System Configuration, Audit Log) **displays** in UTC+8 instead of UTC; the Audit Log "from/to" date filter returns the correct local day (today it is off by 8 hours across the UTC-midnight boundary); the active zone is shown **read-only** on the System Configuration page. With `APP_TIMEZONE` unset, output is byte-identical to today (default `UTC`).
- **Source:** `_change-system-timezone-plan.md` (whole doc); `usrmgmt-architecture.md` §1 (single TypeScript runtime, `lib/` cross-cutting config), §2 (folder ownership — `lib/`, `services/`, `components/`, `db/` boundary; UI never reads config directly), §3 (storage model — datetimes are `timestamptz` UTC instants), §6 (`system_config:READ` gates the System Configuration page), Inv. #14 (DB access only in `db/**`), Inv. #17 (stateless — no per-request mutable config); `um24-spec` (audit-log "always UTC" decision — **partially reversed here**, see §2.4); `um28-side-panel-system-config` (introduces `lib/locale.ts`, `services/system-config/app-config-read.service.ts`, and the `formatDatetime(date, locale, …)` thread-through this unit extends).
- **Decisions taken (sign-off, 2026-06-28):**
  - **Source = `APP_TIMEZONE` env var, read-only on the page** (not an editable `system_config` row — timezone governs billing-period/calendar boundaries; a runtime edit would re-bucket financial periods, too high a blast radius for an admin dialog). IANA names only; validated against a curated `SUPPORTED_TIMEZONES`.
  - **Storage unchanged** — every datetime column stays `timestamptz` (UTC instant). Timezone is a display + boundary concern, never a storage one.
  - **Audit Log display = local + UTC tooltip.** Render audit row timestamps in the configured zone with an `Intl`-standard offset suffix (e.g. `2026-06-17 17:14:22 (GMT+8)`) while keeping the raw UTC ISO instant in the hover `title`/`dateTime`. This **partially reverses** um24's "always UTC, never locale-formatted" — the local string is the human-visible value; the UTC instant remains available for forensics. **When the zone is `UTC` the cell keeps the exact existing `… UTC` suffix (no parentheses), byte-identical to today.** (Q1 → local + UTC tooltip.)
  - **Boundary helper = stdlib `Intl`, zero new dependencies** (offset computed via `Intl.DateTimeFormat`/`formatToParts`). **DST is NOT supported in v1** — a single offset is computed per request; for the three DST zones (`America/New_York`, `America/Los_Angeles`, `Australia/Sydney`) the audit day-boundary may be off by one hour for ~1 day around each transition. Accepted limitation; revisit if a DST zone becomes a primary deployment. (Q3 → stdlib.)
  - **`<time>` attributes:** `dateTime` stays ISO-8601 **UTC** (the HTML `<time>` machine-readable convention); the human-visible `title` shows the **local** zone. (Q2 → dateTime=UTC, title=local.)
  - **`SUPPORTED_TIMEZONES` = `Asia/Kuala_Lumpur`, `Asia/Singapore`, `Asia/Kolkata`, `Africa/Johannesburg`, `Asia/Dubai`, `America/New_York`, `America/Los_Angeles`, `Australia/Sydney`, `UTC`; default `UTC` when unset** (behavior-preserving), with `.env.example` seeded to `UTC`. (Q4/Q5.)
  - **Out of scope:** per-user timezone preference (single system-wide business zone only — Q7); switching any column to naive `timestamp`; any new RBAC permission, audit event, or Server Action.

> **Sequencing / dependency (architecture §7 of the source plan):** This unit is written as a **delta on um28**, which introduces `lib/locale.ts`, `services/system-config/app-config-read.service.ts`, and the `formatDatetime(date, locale, fallback?)` thread-through. **um28 has shipped, and um29 is now implemented as a delta on top of it** — `lib/formatters.ts` exports `formatDatetime(date, locale, timezone, fallback?)`, and the `lib/locale.ts` / `app-config-read.service.ts` files exist. um29 therefore only _extends_ the existing signature/service/constants module (a clean delta). The **standalone fallback** notes inline below (covering the hypothetical case where um29 had shipped before um28) are retained for historical context but no longer apply.

---

## 1. Goal

Introduce one configurable **business timezone** (`APP_TIMEZONE`, IANA, e.g. `Asia/Kuala_Lumpur` = UTC+8) so that every date the app shows or reasons about reflects that zone rather than UTC, while storage stays UTC. Concretely: (1) parse + validate `APP_TIMEZONE` against a curated `SUPPORTED_TIMEZONES` at boot in `lib/config.ts` (fail-fast on an unknown zone, exactly like the `PASSWORD_*` policy); (2) expose it via a `getAppTimezone()` resolver and thread it as a **required parameter** into `formatDatetime` so TypeScript forces every call site to update (the mechanism that guarantees no date surface is missed); (3) route the Audit Log's separate UTC-hardcoded timestamp formatter through the configured zone (local + UTC tooltip); (4) fix the Audit Log date filter so a picked `YYYY-MM-DD` is interpreted as a **local day in the configured zone**, converted to the correct UTC start/end instants — establishing the canonical local-day→UTC pattern every future "today"/cut-off feature (billing runs) reuses; (5) surface the active zone read-only on the System Configuration page. Default `UTC` so the change is behavior-preserving until the env var is set.

---

## 2. Design

### 2.1 Source — `APP_TIMEZONE` env var (`lib/config.ts`)

Timezone is an **operational parameter read once at boot**, not a `system_config` row — mirroring how `PASSWORD_*` and the Entra secret are handled (um25-spec "Policy source"; architecture §3 "secrets via `.env`"). It must be available before any DB read and must not change at runtime (Inv. #17 — stateless; no per-request mutable config), because the business zone defines billing-period and calendar boundaries: a live edit would silently re-bucket financial periods.

- Add `APP_TIMEZONE` to the existing Zod `envSchema` in `lib/config.ts`. It is **optional**; when absent it defaults to `DEFAULT_TIMEZONE` (`"UTC"`), so behavior is unchanged until set.
- Validate the value against `SUPPORTED_TIMEZONES` via `z.enum(SUPPORTED_TIMEZONES)` (or `.refine(isSupportedTimezone)`). An unsupported/misspelled zone throws at startup with a descriptive message — identical fail-fast posture to `PASSWORD_MIN_LENGTH=abc`. This catches misconfiguration immediately rather than rendering wrong-zone dates silently.
- Exposed as `config.APP_TIMEZONE` (the project's config object keys mirror the env var names — e.g. `config.PASSWORD_MIN_LENGTH`).

### 2.2 Constants module (`lib/locale.ts`)

The framework-agnostic constants live in `lib/locale.ts` (the module um28 introduces alongside `SUPPORTED_LOCALES`). **Standalone fallback:** if um28 has not shipped, create `lib/locale.ts` (or a dedicated `lib/timezone.ts`) for these constants — `lib/formatters.ts` already proves this module style is importable from both server and client.

```ts
// IANA names only — never raw offsets like "+08". Offsets don't encode DST
// and Intl expects IANA. Extend as the carrier's footprint grows (one-line
// edit, no migration).
export const SUPPORTED_TIMEZONES = [
  "Asia/Kuala_Lumpur", // UTC+8  (primary business zone)
  "Asia/Singapore", // UTC+8
  "Asia/Kolkata", // UTC+5:30 — non-integer offset (boundary test case)
  "Africa/Johannesburg", // UTC+2  (South Africa)
  "Asia/Dubai", // UTC+4  (UAE) — no DST
  "America/New_York", // US Eastern  — observes DST
  "America/Los_Angeles", // US Pacific  — observes DST
  "Australia/Sydney", // UTC+10/+11 (Australia Eastern) — observes DST
  "UTC",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export const DEFAULT_TIMEZONE: SupportedTimezone = "UTC"; // fallback when APP_TIMEZONE unset

export function isSupportedTimezone(tz: string): tz is SupportedTimezone {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(tz);
}
```

Note on offsets: the offset is computed **per request** from the IANA name (§2.8), so non-integer zones like `Asia/Kolkata` (UTC+5:30) render correctly. **DST is explicitly out of scope for v1:** the helper computes one offset and does not special-case the spring-forward/fall-back transition days, so for `America/New_York`, `America/Los_Angeles`, and `Australia/Sydney` an audit day-boundary may be off by one hour for roughly one day around each transition. The zones remain in the list for display use; the boundary limitation is documented and accepted. The half-hour (`Asia/Kolkata`) case is an explicit test case (§5); DST correctness is not tested because it is not supported.

### 2.3 Resolver (`services/system-config/app-config-read.service.ts`)

Add `getAppTimezone(): SupportedTimezone` next to um28's `getAppLocale()`/`getAppCurrency()`. It simply returns `config.APP_TIMEZONE` (validated and frozen at boot) — **not a DB read**, so no per-request work, no validation, no fallback, and **no `React.cache`** (caching a synchronous constant accessor buys nothing and misleads — reserve `React.cache` for um28's readers that actually hit the DB). It lives in the service file purely for call-site symmetry with `getAppLocale()` (a server component resolves locale + timezone together); it could equally read `config.APP_TIMEZONE` directly.

**Standalone fallback:** if um28 has not shipped, create `services/system-config/app-config-read.service.ts` with just `getAppTimezone()`; um28's locale readers layer in later.

### 2.4 Display layer — `formatDatetime` + every caller

`lib/formatters.ts → formatDatetime` currently hardcodes `Intl.DateTimeFormat("en-GB", { …, timeZone: "UTC" })`. After um28 the signature is `formatDatetime(date, locale, fallback?)` with `timeZone: "UTC"` still hardcoded. This unit:

- Changes the signature to `formatDatetime(date, locale, timezone, fallback?)` and replaces the hardcoded `timeZone: "UTC"` with the passed `timezone`. The formatter stays **pure** — it receives `locale`/`timezone`, never reads config.
- Because `timezone` is a **required** parameter, TypeScript forces every caller to update — this is the mechanism that guarantees no date surface is silently missed.
- **Standalone fallback** (um28 not shipped): the live signature is `formatDatetime(date, fallback = "Never")`. Change it to `formatDatetime(date, timezone, fallback?)`, dropping only the `timeZone` hardcode (keep `en-GB` literal, since locale is um28's concern). The verified call sites are identical either way.

**Verified call sites** (exact, from the codebase — all must pass the resolved `timezone`):

| File                               | Calls                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `components/users/user-detail.tsx` | ×4 (`lockedUntil`, `lastLoginDatetime`, `createdDatetime`, `lastModifiedDatetime`) |
| `components/users/user-table.tsx`  | ×1 (`lastLoginDatetime`)                                                           |
| `components/roles/role-detail.tsx` | ×2 (`createdDatetime`, `lastModifiedDatetime`)                                     |
| `components/roles/role-table.tsx`  | ×1 (`createdDatetime`)                                                             |

Each call site resolves `getAppTimezone()` **server-side** (in the server component, or the server parent) and passes `timezone` down as a prop. Client components receive `timezone` as a prop and never read config directly (architecture §2 — `components/` must not access config/DB; Inv. #14).

> `components/system-config/config-table.tsx` uses `formatRelativeTime` ("3 hours ago"), **not** `formatDatetime` — its visible text is timezone-agnostic and needs no zone for the displayed string. It is touched only for its `title` tooltip (§2.6) and the read-only strip (§2.7).

### 2.5 Audit Log table display — local + UTC tooltip (the gap the plan flagged)

`components/audit-log/audit-log-table.tsx` does **not** use `formatDatetime`. It has its own `formatAuditTimestamp(date)` returning `"2026-06-17 09:14:22 UTC"` (via `date.toISOString()`), and emits `title={row.createdDatetime.toISOString()}`. Threading `formatDatetime` does not touch it, so this unit explicitly:

- Parameterizes the row formatter with the configured zone and renders the **local** wall-clock plus an `Intl`-standard offset label, e.g. `2026-06-17 17:14:22 (GMT+8)` for `Asia/Kuala_Lumpur`. The suffix follows `Intl … timeZoneName: "shortOffset"` output (`GMT+8`, `GMT+5:30`) — we do **not** rewrite `GMT` to `UTC`, staying consistent with the platform formatter.
- **Special-case the `UTC` zone:** keep the exact existing format `"2026-06-17 09:14:22 UTC"` (literal ` UTC` suffix, no parentheses). This makes the default **byte-identical to today**, so um24's existing `audit-log-table` assertions for the default zone pass unchanged.
- Keeps the raw UTC instant in the hover `title` (and the `dateTime` attribute if the cell is wrapped in `<time>`), so the absolute instant remains available for forensics.
- **This is the partial reversal of um24-spec's "always UTC, never locale-formatted":** the human-visible value becomes local for non-UTC zones; the UTC instant is preserved in the tooltip; the UTC default is unchanged.

### 2.6 Date-boundary layer — Audit Log filter fix (`services/audit-log/audit-log-read.service.ts`)

Today `getAuditLog` builds bounds as fixed UTC strings:

```ts
dateFrom: params.dateFrom ? new Date(`${params.dateFrom}T00:00:00.000Z`) : null,
dateTo:   params.dateTo   ? new Date(`${params.dateTo}T23:59:59.999Z`)   : null,
```

For a +08 user, picking "27 Jun" actually queries `08:00 27 Jun – 07:59 28 Jun` local — **off by 8 hours** (the latent bug). The fix interprets the picked `YYYY-MM-DD` as a **local day in the configured zone**, then converts the local start (`00:00:00.000`) and end (`23:59:59.999`) to the correct **UTC instants** before querying. The columns stay UTC, so the repository's `gte`/`lte` comparisons are unchanged — only the boundary instants move.

- Example (`Asia/Kuala_Lumpur`, "2026-06-27"): `dateFrom → 2026-06-26T16:00:00.000Z`, `dateTo → 2026-06-27T15:59:59.999Z`.
- Example (`Asia/Kolkata`, "2026-06-27"): `dateFrom → 2026-06-26T18:30:00.000Z` (validates the half-hour offset).
- When the zone is `UTC`, the conversion is identity → the existing `…T00:00:00.000Z`/`…T23:59:59.999Z` bounds, preserving today's behavior exactly.
- **DST caveat:** for the three DST zones the bound may be off by one hour around a transition day (§2.2) — accepted v1 limitation.

**Preserve um24's "never 500s" filter contract.** The audit filter schema is deliberately lenient — `dateFrom`/`dateTo` are `z.string().date().nullable().catch(null)`, so a tampered/stale URL loads unfiltered rather than throwing. The boundary helper must therefore be **total**: it only ever receives a valid `YYYY-MM-DD` (guaranteed by `z.string().date()`) or `null`, and must **never throw** — `null` in → `null` out, and a valid date string always yields bounds. `getAuditLog` keeps the `params.dateFrom ? … : null` guard so a `null` filter stays `null` (unfiltered). A helper that can throw would reintroduce the 500 um24 designed out.

`getAuditLog` resolves the zone via `getAppTimezone()` and passes the day string + zone to the boundary helper (§2.8). This is the **canonical local-day→UTC pattern** every future "today"/cut-off feature (billing runs, invoice dates) must reuse — keep the helper general, not audit-specific.

### 2.7 Tooltips / `<time>` attributes (`config-table.tsx`, `audit-log-table.tsx`)

Both emit raw `toISOString()` (UTC `Z`) into `title=`/`dateTime=`. Resolution (Q2 → dateTime=UTC, title=local):

- `dateTime` stays **ISO-8601 UTC** — the correct machine-readable value for the HTML `<time>` contract; do not localize it.
- `title` (the human-visible hover) shows the **local-zone** string for the configured zone. `config-table.tsx` line ~124 (`title={row.lastModifiedDatetime.toISOString()}`) and `audit-log-table.tsx` line ~123 (`title={row.createdDatetime.toISOString()}`) change to a local-zone formatted string; the `dateTime` attribute (config-table line ~123) is left as ISO-UTC.

### 2.8 Boundary + offset helper (stdlib `Intl`, zero deps)

Add a small, pure, framework-agnostic helper (e.g. `lib/timezone.ts` or alongside the constants in `lib/locale.ts`) used by both the audit boundary fix (§2.6) and the audit display suffix (§2.5):

- `getZoneOffsetMinutes(date: Date, timeZone: string): number` — computes the zone's UTC offset via `Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })` + `formatToParts` (or the wall-clock-parts subtraction technique). Handles non-integer offsets (`Asia/Kolkata` +5:30). **DST is not specially handled** (§2.2): a single offset is derived; transition-day edge cases are accepted as the documented limitation.
- `localDayToUtcBounds(day: "YYYY-MM-DD", timeZone): { start: Date; end: Date }` — returns the UTC instants for the local day's `00:00:00.000`–`23:59:59.999`. **Total and pure: never throws** (precondition: `day` is a valid `YYYY-MM-DD`, which the caller guarantees via `z.string().date()`), preserving the audit filter's lenient contract (§2.6). Used by `getAuditLog`.
- `formatZoneSuffix(date, timeZone): string` — returns the **`Intl` `shortOffset` string** (`"GMT+8"`, `"GMT+5:30"`); special-cased to return `"UTC"` (matching the existing literal suffix) when `timeZone === "UTC"`, so the default audit display stays byte-identical (§2.5).

Zero new dependencies (Q3). Keep the helper self-contained and unit-tested in isolation, since it is the reusable boundary primitive for future modules.

### 2.9 Read-only display on the System Configuration page

Add a read-only "Application Settings" strip on `/administration/system-config` showing the active `APP_TIMEZONE`, mirroring the existing read-only "Entra ID Settings" env-derived section (um22). Admins can see the zone but cannot edit it in-app (it is env-sourced, not a `system_config` row). The page already renders a read-only env strip above the editable `ConfigTable`, so this is one more row in that pattern. Gated by the existing `system_config:READ` (architecture §6); no new permission.

### 2.10 What stays UTC (intentionally)

- DB storage — every `timestamptz` instant (architecture §3).
- `formatRelativeTime` text ("3 hours ago") — zone-agnostic by construction.
- `audit_log` monthly partition keys — keyed off the UTC instant, unaffected (um27).
- `lib/logger.ts` timestamps (`toISOString()`) — machine logs stay UTC.
- The `<time dateTime>` machine-readable attribute (§2.7).

---

## 3. Implementation

### 3.1 Config — `lib/config.ts`

- Import `SUPPORTED_TIMEZONES` / `DEFAULT_TIMEZONE` from `lib/locale.ts`.
- Add to `envSchema`: `APP_TIMEZONE: z.enum(SUPPORTED_TIMEZONES).default(DEFAULT_TIMEZONE)` (or `z.string().optional().refine(isSupportedTimezone)` with an explicit message for the unsupported-zone case). Throw at boot on an unsupported value (the existing `safeParse` → throw path already does this).
- Pass `APP_TIMEZONE: process.env.APP_TIMEZONE` into the `safeParse({...})` call (matching the `PASSWORD_*` wiring at lines ~74–79).
- `config.APP_TIMEZONE` is now available app-wide.

### 3.2 Constants + helper — `lib/locale.ts`, `lib/timezone.ts`

- `lib/locale.ts`: add `SUPPORTED_TIMEZONES`, `SupportedTimezone`, `DEFAULT_TIMEZONE`, `isSupportedTimezone` (§2.2). **Standalone fallback:** create this file if um28 hasn't.
- `lib/timezone.ts` (new): `getZoneOffsetMinutes`, `localDayToUtcBounds`, `formatZoneSuffix` (§2.8) — pure, stdlib `Intl` only.

### 3.3 Resolver — `services/system-config/app-config-read.service.ts`

- Add `getAppTimezone(): SupportedTimezone` returning `config.APP_TIMEZONE` — a plain synchronous accessor, **no `React.cache`** (§2.3). **Standalone fallback:** create the file with just this function.

### 3.4 Formatter — `lib/formatters.ts`

- `formatDatetime(date, locale, timezone, fallback?)` — `timeZone: timezone` replaces the hardcoded `"UTC"`. **Standalone fallback:** `formatDatetime(date, timezone, fallback?)` keeping `"en-GB"` literal.
- `formatRelativeTime`, `groupConfigRows`, `formatPasswordPolicyHints` unchanged.

### 3.5 Display call sites

- `components/users/user-detail.tsx` (×4), `components/users/user-table.tsx` (×1), `components/roles/role-detail.tsx` (×2), `components/roles/role-table.tsx` (×1): resolve `getAppTimezone()` server-side and pass `timezone` into each `formatDatetime` call (as a prop where the component is `"use client"`). Resolve it together with um28's `locale` from the same server parent to avoid double-threading.

### 3.6 Audit Log — display + boundary

- `components/audit-log/audit-log-table.tsx`: parameterize `formatAuditTimestamp` with the configured zone (or replace with `formatDatetime` + `formatZoneSuffix`), rendering `"… (UTC+8)"`; keep `title` = UTC ISO instant (§2.5). The page passes `timezone` down.
- `services/audit-log/audit-log-read.service.ts`: replace the fixed `…T00:00:00.000Z`/`…T23:59:59.999Z` construction with `localDayToUtcBounds(params.dateFrom/dateTo, getAppTimezone())` (§2.6). Repository filters unchanged.

### 3.7 Tooltips

- `components/system-config/config-table.tsx`: `title` → local-zone string; `dateTime` stays ISO-UTC (§2.7). Add the read-only **Application Settings** strip showing `APP_TIMEZONE` (§2.9).
- `components/audit-log/audit-log-table.tsx`: `title` → UTC ISO instant retained (forensic), local string is the cell text (§2.5).

### 3.8 Env templates

- Add `APP_TIMEZONE=UTC` to `.env.example` / `infra` env template, with a comment listing the supported zones and noting that an unset value also defaults to `UTC` (behavior-preserving) and that the value must be an IANA name from `SUPPORTED_TIMEZONES` (e.g. set `Asia/Kuala_Lumpur` for the business deployment).

### 3.9 No schema / RBAC / action changes

No DB migration, no schema change, no new `PERMISSIONS` row, no new audit event, no new Server Action. One env var; one optional new `lib/` helper file. The `audit_log` partitioning (um27) is untouched.

### 3.10 Test churn (the required-param change breaks these at compile/test time)

Making `timezone` a required parameter of `formatDatetime` (and changing `formatAuditTimestamp`) forces updates to every test that renders these. Plan the churn explicitly — each must pass the resolved `timezone` and update fixed-string assertions:

| Test file                                       | Why it changes                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/formatters.test.ts`                  | New `timezone` arg; add zone-shift + `null`-fallback cases.                                                            |
| `tests/components/user-detail.test.tsx`         | Renders `formatDatetime` ×4 — pass `timezone` prop, update asserted strings.                                           |
| `tests/components/role-detail.test.tsx`         | Renders `formatDatetime` ×2.                                                                                           |
| `tests/components/role-table.test.tsx`          | Renders `formatDatetime` ×1.                                                                                           |
| (`user-table` coverage)                         | Update wherever `UserTable`'s `lastLoginDatetime` cell is asserted.                                                    |
| `tests/components/audit-log-table.test.tsx`     | New display format; assert literal `… UTC` for the UTC default (byte-identical) and `(GMT+8)` form for a non-UTC zone. |
| `tests/components/config-table.test.tsx`        | `title` tooltip now local-zone; `dateTime` stays ISO-UTC.                                                              |
| `tests/services/audit-log-read.service.test.ts` | Assert local-day→UTC bounds per §2.6; identity for `UTC`; `null` passthrough.                                          |
| `tests/lib/timezone.test.ts` (**new**)          | Unit-test the helper (§5 — bounds, half-hour zone, no-throw, suffix).                                                  |

A new `tests/lib/config.test.ts` case covers `APP_TIMEZONE` parse/default/throw.

---

## 4. Dependencies

- **None.** No new runtime or dev dependency. Offset/boundary math uses the Node ≥ 22 built-in `Intl.DateTimeFormat` / `formatToParts` (stdlib). `zod` (already present) validates `APP_TIMEZONE`. One new env var (`APP_TIMEZONE`); no `next.config.ts` change; no new package.
- **Unit dependency:** um28 (preferred — provides `lib/locale.ts`, `app-config-read.service.ts`, and the `formatDatetime(date, locale, …)` signature this unit extends). Standalone fallbacks are noted throughout if um29 ships first.

---

## 5. Verification Checklist

### Config / boot

- [ ] No `APP_TIMEZONE` set → `config.APP_TIMEZONE === "UTC"`; all date output is byte-identical to today (behavior-preserving default).
- [ ] `APP_TIMEZONE=Asia/Kuala_Lumpur` → `config.APP_TIMEZONE` set to it.
- [ ] `APP_TIMEZONE=Mars/Olympus` (or `+08`, a raw offset) → boot throws a descriptive error (fail-fast, like `PASSWORD_MIN_LENGTH=abc`).
- [ ] `isSupportedTimezone` accepts every entry in `SUPPORTED_TIMEZONES` and rejects an unknown string.

### Boundary + offset helper (`lib/timezone.ts`)

- [ ] `localDayToUtcBounds("2026-06-27", "Asia/Kuala_Lumpur")` → start `2026-06-26T16:00:00.000Z`, end `2026-06-27T15:59:59.999Z`.
- [ ] `localDayToUtcBounds("2026-06-27", "Asia/Kolkata")` → start `2026-06-26T18:30:00.000Z` (half-hour / UTC+5:30 offset handled).
- [ ] `localDayToUtcBounds("2026-06-27", "UTC")` → identity (`…T00:00:00.000Z` / `…T23:59:59.999Z`).
- [ ] `localDayToUtcBounds` **never throws** for any valid `YYYY-MM-DD`; `getAuditLog` passes `null` straight through (unfiltered), preserving um24's "never 500s" filter contract.
- [ ] DST is **not** tested (out of scope, §2.2) — no assertion on transition-day correctness.
- [ ] `formatZoneSuffix` → `"GMT+8"` (KL), `"GMT+5:30"` (Kolkata, half-hour offset), `"UTC"` (UTC special-case).

### Display (`formatDatetime` + call sites)

- [ ] `formatDatetime` for the same instant renders an 8-hour-shifted wall clock for `Asia/Kuala_Lumpur` vs `UTC`; `locale` (um28) still honored; `null` → fallback.
- [ ] With `APP_TIMEZONE=Asia/Kuala_Lumpur`, Users (table + detail), Roles (table + detail) show +08 datetimes.
- [ ] No call site to `formatDatetime` is left passing the old arity (TypeScript `tsc --noEmit` enforces this).

### Audit Log display + filter

- [ ] Audit row timestamp renders local + `Intl` offset suffix (e.g. `2026-06-17 17:14:22 (GMT+8)`) when zone ≠ UTC; when zone = UTC it renders the exact literal `2026-06-17 09:14:22 UTC` (byte-identical to today — um24 default assertions hold).
- [ ] Audit row `title` (hover) still shows the raw UTC ISO instant (forensic value preserved).
- [ ] Audit Log date filter for "today" returns the correct **local** day across the UTC-midnight boundary (the off-by-8h bug is gone); with zone = UTC the result set is unchanged from today.
- [ ] `getAuditLog` produces local-day UTC bounds for the configured zone (unit test mirrors the §2.6 examples).

### Tooltips / `<time>`

- [ ] `config-table.tsx`: `dateTime` attribute stays ISO-8601 UTC; `title` shows the local-zone string.
- [ ] `audit-log-table.tsx`: machine-readable instant stays UTC; human-visible cell is local.

### Read-only config page

- [ ] `/administration/system-config` shows a read-only "Application Settings" strip with the active `APP_TIMEZONE`; it is not editable in-app; gated by `system_config:READ`.

### Regression / invariants

- [ ] DB columns remain `timestamptz`; no column switched to naive `timestamp`; no local wall-clock written to any column (architecture §3).
- [ ] `formatRelativeTime`, `logger.ts` timestamps, and `audit_log` partition keys remain UTC (§2.10).
- [ ] No new `PERMISSIONS` row, audit event, Server Action, or DB migration introduced.
- [ ] `tsc --noEmit`, ESLint (incl. import-boundary rules — `components/` does not import config/DB), Prettier all clean.
- [ ] `npm run build` passes.
- [ ] `/qa`: set `APP_TIMEZONE=Asia/Kuala_Lumpur`, click through Users, Roles, System Config, Audit Log; confirm +08 display everywhere and the Audit Log "today" filter returns the correct local day across UTC midnight.

---

## 6. Open items (resolved at sign-off 2026-06-28)

1. **Audit display vs um24 "always UTC"** → **local + UTC tooltip** for non-UTC zones (`Intl` `GMT±` suffix; UTC instant in `title`); **UTC zone keeps the exact literal `… UTC` suffix, byte-identical to today**. Partial reversal of um24, documented in §2.5.
2. **`<time dateTime>` attributes** → `dateTime` = ISO-8601 **UTC**; `title` = **local** (§2.7).
3. **Boundary helper** → **stdlib `Intl`**, zero dependencies; suffix follows `Intl` `shortOffset` (`GMT±`), not rewritten to `UTC±` (§2.8). **DST not supported in v1** — single offset, transition-day boundaries may be off by one hour for the three DST zones (§2.2); accepted limitation.
4. **`SUPPORTED_TIMEZONES`** → KL, SG, Kolkata, Johannesburg, Dubai, New_York, Los_Angeles, Sydney, UTC. (US and Australia span multiple zones; US Eastern + Pacific and Australia Eastern/Sydney seeded — extend with one constant edit, no migration.)
5. **Default when unset** → **`UTC`** (behavior-preserving); `.env.example` seeded `UTC` (set `Asia/Kuala_Lumpur` per deployment).
6. **Scope of boundary fix** → Audit Log filter only (the sole date-boundary logic today); the `localDayToUtcBounds` helper is the canonical pattern future billing/cut-off logic reuses.
7. **Per-user timezone** → **out of scope** (single system-wide business zone; a per-user display preference is a separate, larger feature).
