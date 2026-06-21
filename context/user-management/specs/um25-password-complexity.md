# um25 — Password Complexity

**Boundary:** BACKEND · CONFIG  
**Depends on:** um06 (local auth / sign-in), um07 (forced first-login password change), um08 (admin password reset + temp password generation)

---

## Goal

Make the LOCAL password policy configurable via environment variables with enforced defaults (15-char minimum, 1 uppercase, 1 lowercase, 1 digit, 1 special character), and apply that policy uniformly at every point where a password is set or generated: first-login change, admin reset, and temp password generation.

---

## Design

### Policy source

Password policy is loaded from environment variables at startup via a typed config object in `lib/config.ts`. It is **not** stored in `SYSTEM_CONFIG` — it is an operational parameter that affects auth behaviour, requires a redeploy to change (consistent with how Entra secrets are handled), and must be available before any DB connection. There are no UI controls for this policy in v1.

Env vars (all optional; defaults apply when absent):

| Env var                      | Default                 | Description                       |
| ---------------------------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `PASSWORD_MIN_LENGTH`        | `15`                    | Minimum character count           |
| `PASSWORD_REQUIRE_UPPERCASE` | `true`                  | At least 1 uppercase letter (A–Z) |
| `PASSWORD_REQUIRE_LOWERCASE` | `true`                  | At least 1 lowercase letter (a–z) |
| `PASSWORD_REQUIRE_NUMBER`    | `true`                  | At least 1 digit (0–9)            |
| `PASSWORD_REQUIRE_SPECIAL`   | `true`                  | At least 1 special character      |
| `PASSWORD_SPECIAL_CHARS`     | `` !@#$%^&\*()\_+-=[]{} | ;':\",./<>? ``                    | Allowed special character set for both validation and generation |

The config object is a plain export (no singleton class) from `lib/config.ts`, parsed once at module load and typed with Zod.

### Validation shape

A single Zod schema factory `buildPasswordSchema(policy: PasswordPolicy): ZodString` in `validation/password.ts` returns a `z.string()` chain with `.min()`, `.refine()` checks for each enabled rule. This is the **single source of truth** — the same factory is called from all three entry points. Each `.refine()` carries a human-readable message naming the violated rule.

### Temp password generation

`services/password.ts` exports `generateTempPassword(policy: PasswordPolicy): string`. It guarantees the generated password satisfies every rule:

1. Draw one character randomly from each required character class (uppercase, lowercase, digit, special).
2. Fill remaining slots (up to `min_length`) from the full allowed set (union of all classes).
3. Shuffle the result using a cryptographically secure source (`crypto.randomBytes`).

This ensures generated temp passwords are always policy-compliant without a retry loop.

### Error messages

Validation errors are returned as field-level Zod messages on the `password` field. The UI aggregates and renders all failing rules simultaneously so the user sees everything at once, not one failure at a time. Messages are:

- `"Password must be at least {n} characters."`
- `"Password must contain at least one uppercase letter."`
- `"Password must contain at least one lowercase letter."`
- `"Password must contain at least one number."`
- `"Password must contain at least one special character ({chars})."`

No `console.log` of the password at any point (Invariant #1).

---

## Implementation

### 1. Config — `lib/config.ts`

- Parse all `PASSWORD_*` env vars via Zod at module load.
- Coerce `PASSWORD_MIN_LENGTH` to an integer; reject values less than 1.
- Coerce boolean vars from the strings `"true"` / `"false"` (env vars are always strings).
- Export a frozen `passwordPolicy: PasswordPolicy` object.
- Export the `PasswordPolicy` type to `types/`.
- If any env var is malformed (e.g. `PASSWORD_MIN_LENGTH=abc`), throw at startup with a descriptive message so misconfiguration is caught immediately rather than silently falling back.

### 2. Validation schema — `validation/password.ts`

- Export `buildPasswordSchema(policy: PasswordPolicy): z.ZodString`.
- Chain in order: `.min(policy.minLength, message)`, then one `.refine()` per enabled rule.
- Use `superRefine` if collecting multiple errors simultaneously (Zod v3 pattern); otherwise chain `.refine()` calls — pick whichever yields all errors in one pass so the UI can show every violation at once.
- Export a `defaultPasswordSchema` convenience binding: `buildPasswordSchema(passwordPolicy)` using the app-level config. This is what action schemas import.

### 3. Temp password generator — `services/password.ts`

- Export `generateTempPassword(policy: PasswordPolicy): string`.
- Character pools:
  - Uppercase: `ABCDEFGHIJKLMNOPQRSTUVWXYZ`
  - Lowercase: `abcdefghijklmnopqrstuvwxyz`
  - Digits: `0123456789`
  - Special: `policy.specialChars`
- Implementation:
  1. Start with one char from each enabled required pool (secure random index via `crypto.randomInt`).
  2. Fill to `policy.minLength` from the union of all enabled pools.
  3. Shuffle result array with a Fisher-Yates shuffle using `crypto.randomInt` as the source.
  4. Return as string.
- Do **not** use `Math.random()` anywhere in this function.
- This function has no side effects and no DB access; it is pure and easily unit-tested.

### 4. Wire validation into affected actions

Three actions must use `defaultPasswordSchema` on their `password` input:

**`actions/auth/set-password.ts`** (forced first-login change, um07)

- Replace any existing ad-hoc length check with `defaultPasswordSchema` parsed via Zod's `.safeParse()`.
- Return field-level errors from the Zod result as a typed action response.

**`actions/users/reset-password.ts`** (admin resets a LOCAL user's password, um08)

- Same: replace ad-hoc check with `defaultPasswordSchema`.
- Admin-initiated; the new password is a temp password so `force_password_change` is set `true` after reset.

**`actions/users/create-user.ts`** (LOCAL user creation, um08)

- Remove any hardcoded temp password string.
- Call `generateTempPassword(passwordPolicy)` to produce the temp password.
- The temp password is passed to Better-Auth's credential creation (hashed by Better-Auth's scrypt path — never stored plain).
- The plain temp password is returned **once** in the action response for the admin to copy; it is never persisted, logged, or re-derived.

**`actions/users/update-user.ts`** (auth method switch SSO→LOCAL, um08)

- When `auth_method` changes to `LOCAL`, call `generateTempPassword(passwordPolicy)` rather than any hardcoded value.
- Same single-display, never-persisted pattern.

### 5. Zod action schemas — `validation/users.ts`, `validation/auth.ts`

- Import `defaultPasswordSchema` and use it as the `password` field type in:
  - `SetPasswordSchema` (first-login change form)
  - `ResetPasswordSchema` (admin reset form — if admin supplies the new password; see note below)
- For temp password generation actions (create user, auth method switch), no `password` field appears in the inbound schema — the password is generated server-side, not supplied by the caller.

> **Note on reset flow:** If the current um08 design has the admin supply the new password manually (rather than auto-generating), the reset action must validate it through `defaultPasswordSchema`. If um08 auto-generates it, no inbound validation is needed. Confirm um08's exact shape and align accordingly.

### 6. Frontend — error display

- The set-password page (`app/(auth)/set-password/page.tsx`) and admin password reset modal already have a password field.
- Update both to render **all** Zod field errors for the `password` field (not just the first), so every failing rule is visible simultaneously.
- Optionally add a static password requirements hint below the input (list of active policy rules read from a `/api/auth/password-policy` route or passed as a Server Component prop) so users know requirements before typing. This hint reads from `passwordPolicy` on the server; it never exposes internal config beyond the display rules.
- No client-side strength-check logic — server validation is the source of truth; the hint is informational only.

### 7. Env template — `infra/.env.template` (or equivalent)

Add the six `PASSWORD_*` vars with their defaults and a comment block explaining units and allowed values. This is the developer-facing reference.

---

## Dependencies

No new npm packages required. Uses:

- `zod` — already in the project for all validation schemas.
- Node built-in `crypto` (`crypto.randomInt`, `crypto.randomBytes`) — available in Node ≥ 22 (already the runtime per architecture). No external random library needed.

---

## Verification Checklist

### Policy config

- [ ] Starting the app with no `PASSWORD_*` env vars applies all defaults (15 chars, all rules on).
- [ ] Setting `PASSWORD_MIN_LENGTH=abc` throws a startup error with a descriptive message.
- [ ] Setting `PASSWORD_MIN_LENGTH=8` overrides the default (validated via a unit test on `buildPasswordSchema`).
- [ ] `PASSWORD_REQUIRE_SPECIAL=false` disables the special-char rule; `buildPasswordSchema` omits that refine.

### Validation schema

- [ ] A password of 14 characters fails with the length message.
- [ ] A password of 15+ characters with no uppercase fails with the uppercase message.
- [ ] A password satisfying all rules passes.
- [ ] All failing rules are returned in a single `.safeParse()` call (not just the first).
- [ ] `defaultPasswordSchema` and a custom-policy schema built from `buildPasswordSchema` produce the same result for the same input when policy matches.

### Temp password generation

- [ ] `generateTempPassword` always produces a string of at least `minLength` characters.
- [ ] Generated password always contains at least one char from each enabled required class.
- [ ] Generated password passes `defaultPasswordSchema.safeParse()`.
- [ ] Function never calls `Math.random()`.
- [ ] Over 1000 calls, generated passwords are unique (collision test; probabilistic).

### Affected flows

- [ ] First-login set-password action rejects a weak password and returns field-level errors.
- [ ] First-login set-password action accepts a policy-compliant password and completes normally.
- [ ] Admin password reset rejects a manually entered weak password.
- [ ] Admin user creation generates a temp password that satisfies the policy.
- [ ] SSO→LOCAL auth method switch generates a policy-compliant temp password.
- [ ] The temp password is shown once in the UI response and absent from server logs and DB rows (confirm by reading `account.password` — it is a scrypt hash, not the plaintext).

### UI

- [ ] The set-password form shows all rule violations at once when submitting a weak password.
- [ ] The password requirements hint (if implemented) reflects the active policy rules.

### Security / invariants

- [ ] No password value appears in `AUDIT_LOG` `before_data` or `after_data`.
- [ ] No password value is logged to stdout/stderr or GlitchTip.
- [ ] `generateTempPassword` uses `crypto.randomInt` exclusively (grep for `Math.random` in `services/password.ts` — must be absent).
