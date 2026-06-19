# Spec — Unit um04: Custom Per-Account Lockout (LOCAL)

**Unit:** um04  
**Boundary:** AUTH  
**Depends on:** um03  
**Status:** Spec only — no code

---

## Goal

Implement custom per-account lockout for LOCAL sign-in by wiring the Better-Auth sign-in hook to a repository-backed state machine: reject locked accounts before password verification, increment `failed_login_count` on each wrong password, lock the account for 15 minutes and emit a `USER_LOCKED` audit entry on the 5th consecutive failure, and reset the counter on success.

---

## Design

### State carried on `APPUSER`

Two columns on `APPUSER` carry all lockout state — no extra table.

| Column               | Type                         | Meaning                                                                                                                                                  |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed_login_count` | `integer NOT NULL DEFAULT 0` | Consecutive failures since the last successful sign-in or admin unlock.                                                                                  |
| `locked_until`       | `timestamptz NULL`           | NULL = not locked. A non-NULL value in the future means the account is locked. A non-NULL value in the past is treated as expired (account is unlocked). |

### Lock lifecycle

```
correct password  ─────────────────────────────────────────────────────►  count = 0, locked_until = NULL
                                                                               ▲
1st–4th wrong password  ────────────────────────────►  count++ (1–4)           │
                                                                               │ success at any point resets
5th wrong password  ─────────────────────────────────►  count = 5,             │
                                                         locked_until = NOW + 15 min,
                                                         audit USER_LOCKED
                                                               │
                    any attempt while locked_until > NOW ──────┤  reject before password check
                                                               │
                    locked_until ≤ NOW (expired)  ────────────►  treat as not locked; resume normal flow
                                                               │
                    admin unlock (um06/um07)  ─────────────────►  count = 0, locked_until = NULL, audit USER_UNLOCKED
```

Key decisions:

- The lock check happens **before** password verification. A locked account never reaches the hash comparison regardless of whether the supplied password would be correct.
- Lock expiry is passive — there is no background job to clear `locked_until`. The hook evaluates `locked_until` against `NOW()` on each attempt. If `locked_until` is in the past the account is treated as unlocked and the attempt proceeds normally.
- The 5th-failure lock write and the `USER_LOCKED` audit entry are written in a **single repository call** that executes one transaction, keeping the state and the log consistent.
- A successful login resets `failed_login_count` to `0` and sets `locked_until` to `NULL` (clears any past-expired lock value). This write is also a single repository call.
- Only LOCAL sign-in is subject to lockout. SSO sign-in does not read or write these columns.

### Rejection response

A locked account must not reveal whether the password was correct. The hook returns the same generic "invalid credentials" error whether the account is locked or the password is wrong. Error string: `"Invalid email or password."` (same wording as a normal failure — no "account is locked" signal in the public error).

---

## Implementation

### 1. Lockout repository (`db/repositories/lockout.repository.ts`)

Create a dedicated repository file. No SQL is written anywhere in `auth/`.

**Method: `getLockoutState(userId: string): Promise<LockoutState>`**

- Selects `failed_login_count` and `locked_until` from `APPUSER` for the given `user_id`.
- Returns a typed object `{ failedLoginCount: number; lockedUntil: Date | null }`.
- Used by the hook before any password check.

**Method: `recordFailedAttempt(userId: string): Promise<void>`**

- Increments `failed_login_count` by 1.
- Evaluates the **new** count:
  - If `new_count < 5`: updates only `failed_login_count`; leaves `locked_until` untouched.
  - If `new_count >= 5` (i.e., this is the 5th-or-later failure): sets `failed_login_count = new_count` AND `locked_until = NOW() + interval '15 minutes'`, then inserts a `USER_LOCKED` audit row — all within one database transaction.
- The transaction atomicity guarantee: `locked_until` and the `USER_LOCKED` `AUDIT_LOG` row are always written together or not at all.
- `AUDIT_LOG` entry for `USER_LOCKED`:
  - `event_type`: `'USER_LOCKED'`
  - `actor_user_id`: `null` (the system, not a human actor — the lock is automatic)
  - `target_entity`: `'APPUSER'`
  - `target_id`: the user's `user_id`
  - `before_data`: `{ failed_login_count: <count before this attempt>, locked_until: null }`
  - `after_data`: `{ failed_login_count: <new count>, locked_until: <ISO timestamp> }`
  - `created_datetime`: `NOW()`

**Method: `clearLockout(userId: string): Promise<void>`**

- Sets `failed_login_count = 0` and `locked_until = NULL` for the given user.
- No audit entry — this is called on successful login. The `LOCAL_LOGIN` audit written by the sign-in hook (um03) constitutes the success record.
- Single `UPDATE` statement; no transaction needed (one row, one statement).

### 2. Lockout types (`types/lockout.ts`)

Define and export:

```typescript
export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}
```

This prevents the repository and hook from coupling on raw DB row shapes.

### 3. Lockout helper (`auth/lockout.ts`)

A pure, side-effect-free helper module that encodes the lockout decision logic so the hook stays readable.

**Function: `isCurrentlyLocked(state: LockoutState): boolean`**

- Returns `true` if `state.lockedUntil` is non-null and `state.lockedUntil > new Date()`.
- Returns `false` if `lockedUntil` is null or is in the past.
- No DB access; fully unit-testable.

### 4. Sign-in hook integration (`auth/index.ts` — existing Better-Auth config)

The sign-in hook already exists from um03 (handles `LOCAL_LOGIN` audit and `force_password_change` redirect). Extend it with the lockout steps.

**Hook execution order for LOCAL credential sign-in:**

1. Look up the user by email. If no user found → return generic error (existing um03 behaviour).
2. Confirm `auth_method === 'LOCAL'`. If SSO → reject (existing um03 behaviour).
3. **[um04]** Call `getLockoutState(userId)`. If `isCurrentlyLocked(state)` → return `"Invalid email or password."` and stop. Do not increment the counter on a locked-account attempt (the account is already locked; incrementing adds noise with no state change).
4. Proceed with Better-Auth's built-in scrypt password verification.
5. **[um04 — on failure]** Call `recordFailedAttempt(userId)`.
6. Return the generic error to the caller.
7. **[um04 — on success]** Call `clearLockout(userId)`.
8. Continue existing um03 success logic (write `LOCAL_LOGIN` audit, handle `force_password_change`, etc.).

**Note on step 3:** When `locked_until` is in the past (expired lock), `isCurrentlyLocked` returns `false` and the attempt proceeds to password check. If the password is wrong, `recordFailedAttempt` increments the counter from wherever it was (which may be 5 from the previous lock). The 5th-or-later failure condition (`new_count >= 5`) sets a new `locked_until`, which means a failed attempt on an expired lock immediately re-locks. This is intentional and correct — a user who was locked, waited 15 minutes, and enters the wrong password gets locked again.

### 5. Error handling and edge cases

| Scenario                                           | Behaviour                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getLockoutState` fails (DB error)                 | Propagate the error; do not proceed to password verification. Log via GlitchTip/OpenTelemetry.                                                                                                                         |
| `recordFailedAttempt` fails after a wrong password | The failure is still surfaced to the caller as an auth failure. The DB error is logged. The count may be inconsistent but this is acceptable — the alternative (ignoring the error) would silently lose lockout state. |
| `clearLockout` fails after a correct password      | The sign-in is still treated as successful (Better-Auth proceeds). The error is logged. The counter will be cleaned up on the next successful login.                                                                   |
| Account has no `locked_until` set (NULL)           | `isCurrentlyLocked` returns `false`. Normal flow.                                                                                                                                                                      |
| SSO user attempts local sign-in                    | Rejected at step 2 (existing um03 guard); lockout columns are never read or written.                                                                                                                                   |

### 6. Drizzle schema alignment

No migration is required for um04 — `failed_login_count` and `locked_until` were added to the `APPUSER` Drizzle schema in um01. Confirm both columns are present in `db/schema/appuser.ts`:

- `failed_login_count`: `integer('failed_login_count').notNull().default(0)`
- `locked_until`: `timestamp('locked_until', { withTimezone: true })`

If either is absent, add them and generate a migration before proceeding. This is a pre-condition, not um04 work.

### 7. Telemetry

On each `USER_LOCKED` event, emit a structured log line via the existing OpenTelemetry setup in `lib/telemetry.ts`:

```
level: warn
message: "Account locked after consecutive failed login attempts"
fields: { userId, failedLoginCount: newCount, lockedUntil: <ISO string> }
```

This feeds the Azure Monitor alert on failed-login spikes (see architecture §1).

---

## Dependencies

No new packages are required. All implementation uses:

- **Drizzle ORM** — already installed; used for the repository queries.
- **Better-Auth** — already installed; hook integration is additive to existing um03 hook.
- **TypeScript** — strict mode, already configured.

---

## Verification Checklist

### Repository unit tests (`tests/unit/lockout.repository.test.ts`)

- [ ] `getLockoutState` returns `{ failedLoginCount: 0, lockedUntil: null }` for a fresh user.
- [ ] `getLockoutState` returns the correct `lockedUntil` Date for a locked user.
- [ ] `recordFailedAttempt` increments `failed_login_count` from 0 → 1 without setting `locked_until`.
- [ ] `recordFailedAttempt` increments from 1 → 4 without setting `locked_until`.
- [ ] `recordFailedAttempt` on the 5th call sets `locked_until` to approximately `NOW + 15 min` (within ±2 seconds).
- [ ] `recordFailedAttempt` on the 5th call writes exactly one `USER_LOCKED` `AUDIT_LOG` row with correct fields.
- [ ] `recordFailedAttempt` on a 6th call (already locked, expired-lock scenario) re-locks and writes another `USER_LOCKED` entry.
- [ ] `clearLockout` sets `failed_login_count = 0` and `locked_until = NULL`.
- [ ] `USER_LOCKED` write and `locked_until` update are atomic: simulate a transaction rollback and confirm neither the column change nor the audit row persist.

### Lockout helper unit tests (`tests/unit/lockout.test.ts`)

- [ ] `isCurrentlyLocked` returns `false` when `lockedUntil` is null.
- [ ] `isCurrentlyLocked` returns `false` when `lockedUntil` is a timestamp in the past.
- [ ] `isCurrentlyLocked` returns `true` when `lockedUntil` is a timestamp in the future.
- [ ] `isCurrentlyLocked` returns `false` when `lockedUntil` equals exactly `new Date()` (boundary — not locked at the exact millisecond of expiry).

### Sign-in hook integration tests (`tests/integration/signin-lockout.test.ts`)

All tests use a real test database seeded with a LOCAL user.

- [ ] 1–4 wrong passwords: sign-in returns an error, `failed_login_count` increments correctly after each, `locked_until` remains NULL, no `USER_LOCKED` audit row.
- [ ] 5th wrong password: sign-in returns an error, `locked_until` is set ~15 min ahead, exactly one `USER_LOCKED` audit row is written.
- [ ] 6th–nth attempt while locked: returns the generic error without changing `failed_login_count` or `locked_until` further.
- [ ] Attempt after lock expiry (set `locked_until` to 1 second in the past): sign-in proceeds to password check. Wrong password re-locks immediately and writes a new `USER_LOCKED` entry.
- [ ] Correct password before the 5th failure (e.g., 3 failures then correct): sign-in succeeds, `failed_login_count` resets to 0, `locked_until` is NULL, `LOCAL_LOGIN` audit row is written.
- [ ] Correct password resets a past-expired lock: `failed_login_count = 0`, `locked_until = NULL`.
- [ ] A locked account with the correct password still returns the generic error (password is never checked while locked).
- [ ] SSO user attempting local sign-in is rejected before lockout logic is reached; `failed_login_count` and `locked_until` are not modified.

### Audit log correctness

- [ ] `USER_LOCKED` row has `actor_user_id = null`.
- [ ] `USER_LOCKED` `before_data.locked_until` is null on first lock; `after_data.locked_until` matches the column value written.
- [ ] `USER_LOCKED` `before_data.failed_login_count` = 4 on the first lock (value before the 5th attempt was processed).
- [ ] No `USER_LOCKED` entry on failures 1–4.
- [ ] No extra `USER_LOCKED` entries written for attempts made while still locked.

### Error message verification

- [ ] Wrong password returns `"Invalid email or password."`.
- [ ] Locked account (correct or wrong password) returns `"Invalid email or password."` — identical wording, no lock disclosure.
- [ ] No stack trace, userId, or internal detail is returned to the client in any error path.

### Invariant compliance

- [ ] No raw SQL or direct DB client import in `auth/index.ts` or `auth/lockout.ts` — all DB access goes through `db/repositories/lockout.repository.ts`.
- [ ] `isCurrentlyLocked` has zero DB imports — it is a pure function.
- [ ] `locked_until` is never evaluated client-side; all lock checks occur inside the server-side hook.
- [ ] OpenTelemetry warn log is emitted on each `USER_LOCKED` event (verified by log capture in integration test).
