# Spec: um10 — Entra SSO sign-in + email-match linking

- **Boundary:** AUTH / ENTRA (external)
- **Dependencies:** Unit um08 (a pre-created `auth_method = SSO` APPUSER must exist to match; `writeAuditEvent`; `appUserRepository` write functions established); Unit um09 (`resolveAuthenticatedUser` session helper, `auth/session.ts` — extended here to ensure `force_password_change` guard does not apply to SSO users who cannot have that flag); Unit um06 (authenticated layout + session resolution established); Unit um03 (`writeAuditEvent` helper, `LOCAL_LOGIN` sign-in hook pattern — SSO hook mirrors its structure).
- **Source sections:** overview §"Core User Flow" item 4 (SSO first login: email-match, PENDING → ACTIVE, `SSO_LOGIN`), §"Authentication & sessions" (Entra SSO with email-match linking; Entra login with no matching SSO account rejected, nothing created), §"Audit Events" (`SSO_LOGIN`, `USER_FIRST_LOGIN`), §"Features — Authentication & sessions", §"In Scope" (Entra SSO), §"Out of Scope" (JIT provisioning, Entra-group-based access, self-registration); architecture §2 (folder ownership: `app/api/**` owns `/api/auth/*`; `auth/**` owns Better-Auth config + hooks), §3 (storage: `account.provider_id = 'microsoft'`, `account.provider_account_id` = Entra object id; `last_login_datetime` on APPUSER), §5 (auth-method exclusivity, PENDING → ACTIVE lifecycle), §6 (per-page permission matrix: Entra callback is public/provider-gated); code-standards §3 (Server Actions / Route Handlers as public endpoints), §7 (file organization). Invariants: **#2** (authz state never in session — status loaded per-request), **#9** (mutually exclusive auth methods; Entra login with no matching SSO email rejected, creates nothing), **#10** (no self-service creation — JIT is explicitly forbidden), **#11** (every successful sign-in writes `SSO_LOGIN`; first login also writes `USER_FIRST_LOGIN`), **#14** (DB only in `db/**`), **#17** (app is stateless — no in-memory session/user state), **#18** (secrets never in DB, repo, or image — `MICROSOFT_CLIENT_SECRET` in `.env` only), **#19** (Better-Auth field mapping declared once in `auth/`).

---

## Goal

Configure the Better-Auth Microsoft/OIDC provider with Entra credentials sourced from `.env`; on a successful Entra authentication, match the returned email to a pre-created `auth_method = SSO` APPUSER, capture the Entra object id into `account.provider_account_id`, flip PENDING → ACTIVE on the first sign-in, record `last_login_datetime`, and write `SSO_LOGIN` (plus `USER_FIRST_LOGIN` on first sign-in); reject any Entra identity whose email does not match a pre-created SSO APPUSER, creating nothing.

---

## Design

### Sign-in entry point

The existing `/login` page gains a **"Sign in with Microsoft"** button below the credential form, separated by a full-width horizontal rule with a centered "or" label (`<hr>` rendered as two lines flanking the text). The button is:

- Full-width, same horizontal extent as the email/password fields above
- `--surface-card` background, `--border-subtle` 1px border, `--radius-md`
- A 4-color Microsoft logo SVG (16×16 px, inline) to the left of the label "Sign in with Microsoft"
- On hover: `--surface-hover` background, `--border-default` border
- Implemented as a plain `<a>` tag (full page redirect to Entra), **not** a `<button>` or a form submission

The `href` targets `/api/auth/signin/microsoft` — Better-Auth's auto-registered sign-in route for the `microsoft` social provider.

When `MICROSOFT_CLIENT_ID` is absent from the environment, the button and divider are hidden entirely. The login page Server Component reads `!!process.env.MICROSOFT_CLIENT_ID` at render time.

### SSO rejection error display

After a rejected Entra sign-in, the callback redirects to `/login?error=sso_no_account`. The login page reads the `error` search param and renders a shadcn `Alert` (destructive variant, non-dismissible) **above** the form and the divider:

> "Your Microsoft account is not authorized to access this application. Contact your administrator."

No technical details are exposed. There is no difference in the message for "email not found" vs. "user disabled" — a uniform message prevents email enumeration.

Any other `error` query param value (from other Better-Auth error paths) renders a generic fallback:

> "Sign-in failed. Please try again or contact your administrator."

### Entra configuration — env vars

Three new env vars, all server-only:

| Var                       | Required for SSO | Notes                                                          |
| ------------------------- | ---------------- | -------------------------------------------------------------- |
| `MICROSOFT_CLIENT_ID`     | Yes              | App registration client ID — non-secret, but server-only       |
| `MICROSOFT_CLIENT_SECRET` | Yes              | Client secret — **never** in DB, repo, image, or client bundle |
| `ENTRA_TENANT_ID`         | Yes              | Directory (tenant) ID — non-secret, but server-only            |

The redirect URI is **derived at runtime** and never stored: `${NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft`. This value is shown read-only on the System Configuration page so an admin can copy it when registering the app in Entra.

If any of the three vars is absent, the Microsoft provider is not registered with Better-Auth (`isSsoConfigured = false`). Local sign-in continues to work; the SSO button is hidden. This is the expected state before Entra is configured, or when running tests.

### Better-Auth callback flow — first sign-in

1. User clicks "Sign in with Microsoft" → browser performs a full redirect to `/api/auth/signin/microsoft`.
2. Better-Auth redirects to the tenant-specific Entra authorization endpoint (constructed from `tenantId`, `clientId`, `redirectUri`), requesting scopes `openid profile email`.
3. User authenticates with Entra. Entra enforces MFA per its own conditional access policy — the app does not configure MFA.
4. Entra redirects to `/api/auth/callback/microsoft` with the authorization code.
5. Better-Auth exchanges the code for tokens at Entra's token endpoint, validates the ID token signature and claims, and extracts the Microsoft profile: `email` (from the `email` claim), and the Entra object id (from the `oid` or `sub` claim — whichever Better-Auth exposes as `provider_account_id` for the `microsoft` provider; `oid` is preferred as it is stable across token issuances).
6. Better-Auth checks for an existing `account` row with `provider_id = 'microsoft'` and `provider_account_id = <oid>`. None found (first sign-in).
7. **`account.create.before` hook fires.** Our hook:
   a. Extracts `email` from the profile in the hook context.
   b. Calls `appUserRepository.findSsoUserByEmail(email)`.
   c. **No match** → throws a rejection error. Better-Auth redirects to the configured error URL (`/login?error=sso_no_account`). No `APPUSER`, no `account`, no `session` row is created.
   d. **Match found** → returns modified account data with `userId = existingUser.userId`. Better-Auth creates the `account` row tied to the existing user, not a new one.
8. **Post-sign-in hook fires** (on session creation or account creation — see §10.6 for the single-hook strategy). Our hook calls `ssoSignInService.handleSsoSignIn({ userId, email })`:
   - Loads current `status` from `APPUSER`.
   - Opens a transaction: calls `activateSsoUser` (PENDING → ACTIVE if applicable), `updateLastLoginDatetime`, writes `SSO_LOGIN`, writes `USER_FIRST_LOGIN` if the user was PENDING.
9. Better-Auth creates the `session` row, sets the HTTP-only session cookie.
10. User is redirected to `/` → root redirect → `/administration/users` (for ADMIN).

### Better-Auth callback flow — subsequent sign-ins

Steps 1–5 identical. At step 6, Better-Auth finds the existing `account` row. It signs the user in directly — no account creation, no `account.create.before` hook. The post-sign-in hook (step 8) still fires, runs `handleSsoSignIn`, writes `SSO_LOGIN`, updates `last_login_datetime`. No `USER_FIRST_LOGIN` (user is already ACTIVE).

### Auth-method exclusivity

`findSsoUserByEmail` filters `WHERE auth_method = 'SSO'`. A LOCAL user's email will not match, so a LOCAL user's Entra identity (if they have one at the same email) is rejected. The credential provider (um03) does not change. An SSO user who tries the local form is rejected by Better-Auth's credentials provider because their `account` row has `provider_id = 'microsoft'` and no `password` value. These two enforcement layers are independent.

### `APPUSER.last_login_datetime` and status

`last_login_datetime` is updated on **every** successful SSO sign-in, including subsequent sign-ins after activation. `status` is flipped PENDING → ACTIVE only once, on the first sign-in.

### System Configuration page — read-only Entra values

The existing `/administration/system-config` page gains a read-only section **"Entra ID Settings"** (visually separated with a section heading):

| Label        | Value source                                                     |
| ------------ | ---------------------------------------------------------------- |
| Tenant ID    | `process.env.ENTRA_TENANT_ID`                                    |
| Client ID    | `process.env.MICROSOFT_CLIENT_ID`                                |
| Redirect URI | `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft` |

If any value is absent (not configured): render "Not configured" in `--text-muted`.

`MICROSOFT_CLIENT_SECRET` is **never shown** — not present, not masked. Values are read server-side in the page Server Component and passed to the UI as props (not as env references in client code). No edit controls; no inputs.

---

## Implementation

### 10.1 — Env config module (`lib/config.ts`)

New file or extend if it exists. **`'server-only'`** at the top — this file must never be imported by client components.

```ts
// lib/config.ts
import "server-only";

export const entraConfig = {
  tenantId: process.env.ENTRA_TENANT_ID ?? null,
  clientId: process.env.MICROSOFT_CLIENT_ID ?? null,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? null,
  redirectUri: process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft`
    : null,
} as const;

/** True when all three Entra env vars are present. Controls provider registration. */
export const isSsoConfigured: boolean =
  !!entraConfig.tenantId &&
  !!entraConfig.clientId &&
  !!entraConfig.clientSecret;
```

`clientSecret` is defined here to feed into Better-Auth config only. It is not exported separately. `lib/config.ts` has no exports consumed by client bundles — the `'server-only'` guard enforces this at build time.

`NEXT_PUBLIC_APP_URL` is the only env var with the `NEXT_PUBLIC_` prefix in this context; it is already defined by the deployment environment and is non-secret. The `redirectUri` is computed from it, not from any secret.

### 10.2 — Better-Auth Microsoft provider registration (`auth/index.ts`)

Extend the existing Better-Auth config. The Microsoft provider is conditionally registered using `isSsoConfigured`.

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isSsoConfigured, entraConfig } from "@/lib/config";
import { ssoAccountHooks } from "@/auth/sso-linking";

export const auth = betterAuth({
  // ... existing config (credentials provider, field mapping, session hooks from um03/um06)

  socialProviders: isSsoConfigured
    ? {
        microsoft: {
          clientId: entraConfig.clientId!,
          clientSecret: entraConfig.clientSecret!,
          tenantId: entraConfig.tenantId!,
          // redirectURI: auto-derived by Better-Auth as
          // `${baseURL}/api/auth/callback/microsoft`
          // Set explicitly only if Better-Auth requires it:
          // redirectURI: entraConfig.redirectUri!,
        },
      }
    : {},

  databaseHooks: {
    ...ssoAccountHooks,
    // Merge with any existing databaseHooks from prior units (e.g., lockout hook from um04).
    // If Better-Auth merges databaseHooks by key, spread carefully to avoid overwriting.
  },
});
```

> **Implementer note — import path:** Confirm the Microsoft social provider import from the installed `better-auth` version. It may be `better-auth/social-providers` (named export `microsoft`), a plugin import (`better-auth/plugins/microsoft`), or exported directly from `better-auth`. Check `node_modules/better-auth` exports before assuming.

> **Implementer note — redirect URI:** Better-Auth typically auto-derives the Microsoft callback URL as `{baseURL}/api/auth/callback/microsoft` where `baseURL` is configured in the Better-Auth options. If Better-Auth requires an explicit `redirectURI`, set it from `entraConfig.redirectUri`. The value shown on the System Config page must always match what is configured here.

> **Implementer note — databaseHooks merging:** If earlier units (um03, um04) already use `databaseHooks`, merge carefully — spread existing hooks and add the `ssoAccountHooks`. Better-Auth may support an array of hooks per model; check the installed version's API.

### 10.3 — SSO linking hook (`auth/sso-linking.ts`)

New file. **`'server-only'`** at top. Houses the `databaseHooks` callbacks for the Microsoft provider — email-match validation on account creation, and the post-sign-in audit/activation writes.

```ts
// auth/sso-linking.ts
import "server-only";
import { appUserRepository } from "@/db/repositories/app-user.repository";
import { handleSsoSignIn } from "@/services/users/users-auth.service";
import { logger } from "@/lib/logger";

export const ssoAccountHooks = {
  account: {
    create: {
      /**
       * Fires before Better-Auth writes a new `account` row.
       * For Microsoft accounts: validates email-match against a pre-created SSO APPUSER.
       * Rejects (throws) if no match. Returns modified data with the existing userId if match.
       * Non-Microsoft providers pass through unmodified.
       */
      before: async (
        accountData: Record<string, unknown>,
        ctx?: Record<string, unknown>, // shape varies by Better-Auth version — verify
      ) => {
        if (accountData.providerId !== "microsoft") {
          return accountData; // pass through non-SSO accounts unchanged
        }

        // Extract email from hook context. Verify exact field path from installed version.
        // Possible locations: ctx?.user?.email, accountData.email, ctx?.profile?.email
        const email: string | undefined =
          (ctx as any)?.user?.email ?? (accountData as any).email ?? undefined;

        if (!email) {
          logger.error("SSO_REJECTION: Microsoft profile missing email claim");
          throw new Error("SSO_REJECTION: no email in Microsoft profile");
        }

        const appUser = await appUserRepository.findSsoUserByEmail(email);

        if (!appUser) {
          // Invariant #9 + #10: no matching SSO APPUSER → reject entirely
          logger.warn(
            { email: "[redacted]" },
            "SSO_REJECTION: no matching SSO account",
          );
          throw new Error("SSO_REJECTION: no matching SSO account");
        }

        // Return the account data pointing at the existing APPUSER.
        // Better-Auth uses this userId instead of creating a new user row.
        return {
          data: {
            ...accountData,
            userId: appUser.userId,
          },
        };
      },
    },
  },
} satisfies Parameters<typeof betterAuth>[0]["databaseHooks"];
// Adjust the `satisfies` type to match Better-Auth's exported databaseHooks type.
```

> **Implementer note — hook context shape:** The exact shape of `accountData` and `ctx` (the second argument) must be confirmed from the installed Better-Auth version's TypeScript types or source. The fields `accountData.providerId`, `accountData.userId`, and the email location are the critical ones. Check `better-auth/types` or the `databaseHooks` interface in the installed package.

> **Implementer note — rejection mechanism:** If throwing a plain `Error` inside `databaseHooks.account.create.before` causes an unhandled 500 (instead of a clean redirect to the error URL), use Better-Auth's typed error classes (e.g., `APIError` from `better-auth/api`) or return a special value that Better-Auth treats as a rejection. Check the Better-Auth docs for the correct way to abort an account creation in a database hook.

> **Implementer note — error URL redirect:** After hook rejection, Better-Auth should redirect the browser to its configured error URL. Set the error URL to `/login?error=sso_no_account` via Better-Auth's `errorURL` option in the main `auth` config, or the Microsoft provider's `redirectURI` error-path config. If Better-Auth redirects to `/api/auth/error` by default, add a Route Handler at `app/api/auth/error/route.ts` that reads the error and redirects to `/login?error=sso_no_account`. Do **not** add a custom `/api/auth/callback/microsoft/route.ts` — this will conflict with Better-Auth's catch-all auth handler.

### 10.4 — Post-sign-in hook: single-hook strategy (`auth/sso-linking.ts`)

To write `SSO_LOGIN` and update `last_login_datetime` for **every** SSO sign-in (first and subsequent), use a single hook that fires after session creation. This avoids potential double-writes that would occur if both `account.create.after` and `session.create.after` fired for the first sign-in.

Extend `ssoAccountHooks` with a session hook:

```ts
export const ssoAccountHooks = {
  account: {
    create: {
      before: async (...) => { /* §10.3 */ },
    },
  },

  session: {
    create: {
      /**
       * Fires after Better-Auth creates any session.
       * For Microsoft-provider sessions: writes SSO_LOGIN, updates last_login_datetime,
       * and conditionally activates the user (PENDING → ACTIVE) + writes USER_FIRST_LOGIN.
       */
      after: async (
        session: Record<string, unknown>,
        ctx?: Record<string, unknown>,
      ) => {
        // Only handle Microsoft sign-ins.
        // The provider may be in ctx?.account?.providerId or ctx?.provider.
        // Verify from installed Better-Auth version.
        const providerId: string | undefined =
          (ctx as any)?.account?.providerId ??
          (ctx as any)?.provider ??
          undefined

        if (providerId !== 'microsoft') return   // local sign-ins pass through

        const userId = session.userId as string
        if (!userId) return

        const result = await handleSsoSignIn({ userId })

        if (!result.ok) {
          // Log but do not throw — session is already created at this point.
          // The user will hit the ACTIVE-status guard on the next request if DISABLED.
          logger.error({ code: result.code, userId }, 'SSO post-sign-in hook failed')
        }
      },
    },
  },
}
```

> **Implementer note — session hook availability:** Better-Auth's `databaseHooks.session.create.after` may not exist in all versions. Alternatives if it is unavailable:
>
> - `hooks.after` middleware filtering on the session-creation context path
> - `events.session.created` callback (if Better-Auth exposes an events API)
> - A custom `signIn.social` callback on the Microsoft provider config
>
> If no session-creation hook is available, use `account.create.after` for first-sign-in writes, and a separate middleware-style hook that fires on every authenticated request **once per session lifetime** (check for a `sso_login_recorded` flag in a short-lived store — but this conflicts with Invariant #17 stateless rule). The cleanest fallback is to accept that subsequent-sign-in `SSO_LOGIN` writes happen on the next request by extending `resolveAuthenticatedUser` to detect and write the event when `last_login_datetime` is stale; however, this adds complexity. Prefer finding the correct Better-Auth session hook.

> **Implementer note — `ctx.account.providerId` for local sign-ins:** If the session hook fires for all session types and the `providerId` is not available in context, distinguish by checking whether the user has a `provider_id = 'microsoft'` account row in the DB. This is a fallback only — the provider context should be available.

### 10.5 — Repository additions (`db/repositories/app-user.repository.ts`)

Add three functions to the existing repository. All DB access uses Drizzle only — no raw SQL strings.

#### 10.5.1 — `findSsoUserByEmail`

```ts
export async function findSsoUserByEmail(email: string): Promise<{
  userId: string;
  status: "PENDING" | "ACTIVE" | "DISABLED";
} | null>;
```

Query (Drizzle):

```ts
db.select({ userId: appuser.userId, status: appuser.status })
  .from(appuser)
  .where(
    and(
      eq(appuser.userEmail, email.toLowerCase()),
      eq(appuser.authMethod, "SSO"),
      ne(appuser.status, "DELETED"),
    ),
  )
  .limit(1);
```

- Lowercases the input email before comparison. Emails are stored lowercase (enforced by um08's `createUserSchema`).
- `authMethod = 'SSO'` filter is mandatory — enforces auth-method exclusivity.
- `status != 'DELETED'` excludes tombstoned users. DISABLED users are included (returned); the service rejects them with a status guard.
- Returns `null` if no row.

#### 10.5.2 — `updateLastLoginDatetime`

```ts
export async function updateLastLoginDatetime(
  tx: DrizzleTransaction,
  userId: string,
): Promise<void>;
```

```ts
tx.update(appuser)
  .set({
    lastLoginDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  })
  .where(eq(appuser.userId, userId));
```

Called inside the service transaction on every successful SSO sign-in.

#### 10.5.3 — `activateSsoUser`

```ts
export async function activateSsoUser(
  tx: DrizzleTransaction,
  userId: string,
): Promise<{ wasActivated: boolean }>;
```

```ts
const result = await tx
  .update(appuser)
  .set({
    status: "ACTIVE",
    lastModifiedDatetime: new Date(),
  })
  .where(and(eq(appuser.userId, userId), eq(appuser.status, "PENDING")));

return { wasActivated: result.rowCount === 1 };
```

The `WHERE status = 'PENDING'` clause makes this a no-op for already-ACTIVE users. Returns `{ wasActivated: false }` for subsequent sign-ins. Analogous to `activateUser` from um09.

> **Implementer note:** Drizzle's update result shape (for affected row count) differs between drivers. For PostgreSQL with `postgres-js` or `node-postgres`, use `.returning()` or check `result.count`. Adapt to the Drizzle driver in use.

### 10.6 — Service: `handleSsoSignIn` (`services/users/users-auth.service.ts`)

Add to the existing service file (established in um09). Framework-agnostic — no `next/*`, `app/**`, or `actions/**` imports.

```ts
type SsoSignInInput = {
  userId: string;
};

type SsoSignInResult =
  | { ok: true; wasFirstLogin: boolean }
  | {
      ok: false;
      code: "USER_NOT_FOUND" | "USER_NOT_ELIGIBLE" | "AUTH_METHOD_MISMATCH";
    };

export async function handleSsoSignIn(
  input: SsoSignInInput,
): Promise<SsoSignInResult>;
```

Steps:

1. **Load user.** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Status guard.** If `status` is `DISABLED` or `DELETED` → return `{ ok: false, code: 'USER_NOT_ELIGIBLE' }`. A DISABLED user's `account` row exists (Better-Auth found it), but the user must not gain a session. The caller logs this and — since the session is already created at the point this hook fires — the session resolver will reject the user on the next request via the ACTIVE-status guard. Optionally: delete the session row here if Better-Auth exposes the session ID in context.

3. **Auth method guard.** If `authMethod !== 'SSO'` → return `{ ok: false, code: 'AUTH_METHOD_MISMATCH' }`. Defensive — `findSsoUserByEmail` already filters, but the `session.create.after` hook fires for all users, so a belt-and-suspenders check is required.

4. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `const { wasActivated } = await activateSsoUser(tx, input.userId)`.
   - `wasActivated = true` means status was PENDING → now ACTIVE (first sign-in).
   - `wasActivated = false` means status was already ACTIVE (subsequent sign-in).

   b. `await updateLastLoginDatetime(tx, input.userId)`.

   c. `await writeAuditEvent(tx, ssoLoginEvent(input.userId))` — see §10.6.1.

   d. If `wasActivated`: `await writeAuditEvent(tx, firstLoginEvent(input.userId))` — see §10.6.2.

5. **Return.** `{ ok: true, wasFirstLogin: wasActivated }`.

On any transaction error, propagate — transaction rolls back, no partial writes.

#### 10.6.1 — `SSO_LOGIN` audit event

```ts
function ssoLoginEvent(userId: string): WriteAuditEventInput {
  return {
    eventType: "SSO_LOGIN",
    actorUserId: userId,
    targetEntity: "APPUSER",
    targetId: userId,
    beforeData: null,
    afterData: { lastLoginDatetime: new Date().toISOString() },
  };
}
```

Written on every successful SSO sign-in. `afterData` records the timestamp — no identity token material, no secrets.

#### 10.6.2 — `USER_FIRST_LOGIN` audit event (SSO)

```ts
function firstLoginEvent(userId: string): WriteAuditEventInput {
  return {
    eventType: "USER_FIRST_LOGIN",
    actorUserId: userId,
    targetEntity: "APPUSER",
    targetId: userId,
    beforeData: { status: "PENDING" },
    afterData: { status: "ACTIVE" },
  };
}
```

Written only when `wasActivated = true` (status was PENDING at transaction start). Inside the same transaction as `SSO_LOGIN` — both rows appear or neither does.

### 10.7 — Login page (`app/(auth)/login/page.tsx` or login form component)

The login page is a Server Component. Read `isSsoConfigured` from `lib/config.ts` at render time and pass it down to the form component as a prop, or render the SSO button directly in the page.

**SSO button (rendered in the page or a `SsoSignInButton` component):**

```tsx
{
  isSsoConfigured && (
    <>
      <div className="relative flex items-center gap-3 py-2">
        <hr className="flex-1 border-t border-[--border-subtle]" />
        <span className="text-sm text-[--text-muted]">or</span>
        <hr className="flex-1 border-t border-[--border-subtle]" />
      </div>
      <a
        href="/api/auth/signin/microsoft"
        className="flex w-full items-center justify-center gap-2 rounded-[--radius-md] border border-[--border-subtle] bg-[--surface-card] px-4 py-2 text-sm font-medium text-[--text-primary] transition-colors hover:border-[--border-default] hover:bg-[--surface-hover]"
      >
        <MicrosoftLogoSvg /> {/* inline SVG component, 16×16, 4-color */}
        Sign in with Microsoft
      </a>
    </>
  );
}
```

`MicrosoftLogoSvg` is a small inline SVG component in `components/icons/microsoft-logo.tsx`. It uses the four official Microsoft colors (red `#F25022`, green `#7FBA00`, blue `#00A4EF`, yellow `#FFB900`) in a 2×2 grid of squares.

**Error display (above the form):**

```tsx
{
  searchParams?.error === "sso_no_account" && (
    <Alert variant="destructive">
      <AlertDescription>
        Your Microsoft account is not authorized to access this application.
        Contact your administrator.
      </AlertDescription>
    </Alert>
  );
}
{
  searchParams?.error && searchParams.error !== "sso_no_account" && (
    <Alert variant="destructive">
      <AlertDescription>
        Sign-in failed. Please try again or contact your administrator.
      </AlertDescription>
    </Alert>
  );
}
```

`searchParams` is available as a page prop in Next.js App Router Server Components. Do not expose the raw `error` value to the user — only map known values to safe messages.

### 10.8 — System Configuration page (`app/(admin)/administration/system-config/page.tsx`)

Add a "Entra ID Settings" section to the existing page. This is a Server Component — env vars are read server-side only.

```tsx
const entraDisplay = {
  tenantId: process.env.ENTRA_TENANT_ID ?? null,
  clientId: process.env.MICROSOFT_CLIENT_ID ?? null,
  redirectUri: process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft`
    : null,
};
```

Render below any existing config content:

```tsx
<section>
  <h2>Entra ID Settings</h2>
  <p className="text-sm text-[--text-muted]">
    Read-only. These values are sourced from environment variables. Use the
    Redirect URI when registering this application in Microsoft Entra.
  </p>
  <dl>
    <EntraConfigRow label="Tenant ID" value={entraDisplay.tenantId} />
    <EntraConfigRow label="Client ID" value={entraDisplay.clientId} />
    <EntraConfigRow label="Redirect URI" value={entraDisplay.redirectUri} />
  </dl>
  {/* MICROSOFT_CLIENT_SECRET is intentionally absent from this section */}
</section>
```

`EntraConfigRow` is a small presentational component: label on left, monospace value on right, "Not configured" (in `--text-muted`) when `value` is `null`. The redirect URI gets a copy-to-clipboard button (same pattern as `TempPasswordDisplay` from um08) since admins need to paste it into the Entra app registration. Copy button: `Copy` → `Check` icon, 2-second revert (client component).

No edit inputs. No form. No save action. `MICROSOFT_CLIENT_SECRET` never appears.

### 10.9 — `.env.example` / env template

Add the three new vars to `infra/env.example` (or wherever the project documents required env vars):

```
# Entra SSO (optional — omit to disable SSO and hide the "Sign in with Microsoft" button)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
ENTRA_TENANT_ID=
```

A comment noting that `MICROSOFT_CLIENT_SECRET` is a secret and must be provisioned via Key Vault / Managed Identity in production, not pasted into `.env` in deployed environments.

### 10.10 — Tests

#### Unit tests: `findSsoUserByEmail` (`tests/unit/db/repositories/app-user.repository.test.ts`)

Mock the Drizzle client.

| Scenario                        | DB state                                              | Expected                                                            |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Email matches SSO PENDING user  | `auth_method=SSO`, `status=PENDING`                   | Returns `{ userId, status:'PENDING' }`                              |
| Email matches SSO ACTIVE user   | `auth_method=SSO`, `status=ACTIVE`                    | Returns `{ userId, status:'ACTIVE' }`                               |
| Email matches SSO DISABLED user | `auth_method=SSO`, `status=DISABLED`                  | Returns `{ userId, status:'DISABLED' }` (included, service rejects) |
| Email matches LOCAL user        | `auth_method=LOCAL`, `status=ACTIVE`                  | Returns `null` (`auth_method` filter excludes)                      |
| Email matches DELETED SSO user  | `auth_method=SSO`, `status=DELETED`                   | Returns `null` (`status != 'DELETED'` filter excludes)              |
| No matching row                 | —                                                     | Returns `null`                                                      |
| Email case-insensitive          | Stored `test@example.com`, queried `TEST@EXAMPLE.COM` | Returns the user (query lowercases input)                           |

#### Unit tests: `handleSsoSignIn` (`tests/unit/services/users-auth.service.test.ts`)

Mock `appUserRepository`, `writeAuditEvent`. Extend the file from um09.

| Scenario                          | Setup                                                                                                  | Expected                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PENDING user, first sign-in       | `findUserById` → `{ status:'PENDING', authMethod:'SSO' }`; `activateSsoUser` → `{ wasActivated:true }` | `activateSsoUser` called; `updateLastLoginDatetime` called; `SSO_LOGIN` written; `USER_FIRST_LOGIN` written; returns `{ ok:true, wasFirstLogin:true }`                                |
| ACTIVE user, subsequent sign-in   | `findUserById` → `{ status:'ACTIVE', authMethod:'SSO' }`; `activateSsoUser` → `{ wasActivated:false }` | `activateSsoUser` called (no-op); `updateLastLoginDatetime` called; `SSO_LOGIN` written; `USER_FIRST_LOGIN` NOT written; returns `{ ok:true, wasFirstLogin:false }`                   |
| DISABLED user                     | `findUserById` → `{ status:'DISABLED', authMethod:'SSO' }`                                             | Returns `{ ok:false, code:'USER_NOT_ELIGIBLE' }`; no writes                                                                                                                           |
| DELETED user                      | `findUserById` → null                                                                                  | Returns `{ ok:false, code:'USER_NOT_FOUND' }`; no writes                                                                                                                              |
| LOCAL user (auth method mismatch) | `findUserById` → `{ status:'ACTIVE', authMethod:'LOCAL' }`                                             | Returns `{ ok:false, code:'AUTH_METHOD_MISMATCH' }`; no writes                                                                                                                        |
| Transaction rollback              | `updateLastLoginDatetime` throws mid-transaction                                                       | Exception propagates; neither `SSO_LOGIN` nor status change written; `last_login_datetime` unchanged                                                                                  |
| `SSO_LOGIN` audit shape           | ACTIVE user happy path                                                                                 | `writeAuditEvent` called with `eventType='SSO_LOGIN'`, `actorUserId=userId`, `targetEntity='APPUSER'`, `targetId=userId`, `beforeData=null`; `afterData` contains `lastLoginDatetime` |
| `USER_FIRST_LOGIN` audit shape    | PENDING user happy path                                                                                | Second `writeAuditEvent` called with `eventType='USER_FIRST_LOGIN'`, `beforeData={ status:'PENDING' }`, `afterData={ status:'ACTIVE' }`                                               |

#### Unit tests: SSO linking hook (`tests/unit/auth/sso-linking.test.ts`)

Mock `appUserRepository.findSsoUserByEmail` and construct mock hook context.

| Scenario                         | Setup                                                      | Expected                                                                                              |
| -------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Non-Microsoft account            | `accountData.providerId = 'credential'`                    | Returns `accountData` unmodified; `findSsoUserByEmail` not called                                     |
| Microsoft, match found (PENDING) | `findSsoUserByEmail` → `{ userId:'u1', status:'PENDING' }` | Returns `{ data: { ...accountData, userId:'u1' } }`                                                   |
| Microsoft, match found (ACTIVE)  | `findSsoUserByEmail` → `{ userId:'u2', status:'ACTIVE' }`  | Returns `{ data: { ...accountData, userId:'u2' } }`                                                   |
| Microsoft, no match              | `findSsoUserByEmail` → `null`                              | Throws (or returns rejection value); assert `findSsoUserByEmail` was called with the lowercased email |
| Missing email in profile         | `email = undefined` in context                             | Throws immediately; `findSsoUserByEmail` not called                                                   |

#### Unit tests: login page error display (`tests/unit/app/login.page.test.tsx`)

Use `@testing-library/react` + `vitest`. Mock `isSsoConfigured`.

- When `isSsoConfigured = false`: SSO button and divider are not rendered.
- When `isSsoConfigured = true`: SSO button with text "Sign in with Microsoft" is rendered; `href="/api/auth/signin/microsoft"`.
- When `searchParams.error = 'sso_no_account'`: destructive alert with "not authorized" text appears above the form.
- When `searchParams.error = 'some_other_error'`: generic failure alert appears.
- When `searchParams.error` is absent: no alert rendered.

#### Integration tests (`tests/integration/sso-sign-in.test.ts`)

Use the test DB. Fixtures:

- `sso_pending_user`: `auth_method='SSO'`, `status='PENDING'`, email `sso.pending@example.com`
- `sso_active_user`: `auth_method='SSO'`, `status='ACTIVE'`, email `sso.active@example.com`
- `sso_disabled_user`: `auth_method='SSO'`, `status='DISABLED'`, email `sso.disabled@example.com`
- `local_user`: `auth_method='LOCAL'`, `status='ACTIVE'`, email `local@example.com`
- `sso_deleted_user`: `auth_method='SSO'`, `status='DELETED'`, email `sso.deleted@example.com`

Since the full Entra OAuth roundtrip (click → Entra → callback) cannot run in CI, these tests call the repository and service directly.

**`findSsoUserByEmail` integration:**
Confirm the seven repository scenarios (§10.10 unit tests) against a real test Postgres instance with Drizzle.

**`handleSsoSignIn` integration:**

| Test                            | Assertion                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First SSO sign-in (PENDING)     | `appuser.status = 'ACTIVE'`; `appuser.last_login_datetime` is set and non-null; `AUDIT_LOG` has `SSO_LOGIN` row; `AUDIT_LOG` has `USER_FIRST_LOGIN` row |
| Subsequent SSO sign-in (ACTIVE) | `appuser.status` remains `'ACTIVE'`; `last_login_datetime` updated; `AUDIT_LOG` has `SSO_LOGIN`; no `USER_FIRST_LOGIN`                                  |
| DISABLED user rejected          | Returns `{ ok:false, code:'USER_NOT_ELIGIBLE' }`; `last_login_datetime` unchanged; no `AUDIT_LOG` rows written                                          |
| LOCAL user rejected             | Returns `{ ok:false, code:'AUTH_METHOD_MISMATCH' }`; no writes                                                                                          |
| Transaction atomicity           | Simulate a DB error mid-transaction; assert `appuser.status` unchanged, no `AUDIT_LOG` rows written                                                     |
| Deleted email reusable          | `findSsoUserByEmail('sso.deleted@example.com')` returns `null`; a new user with the same email (auth_method=SSO, status=PENDING) can be found           |

**Manual E2E note:** Full SSO (browser click → Entra auth → callback → session) requires a live Entra app registration and cannot run in automated CI. Document in `tests/README.md` that the SSO callback path is manually verified in the staging environment using a dedicated test account in the staging Entra tenant. The test account must be pre-created as an SSO APPUSER in the staging DB before the test.

---

## Dependencies

No new npm packages are required. The Better-Auth Microsoft/OIDC provider is included in the `better-auth` package (already installed in um03). Before implementation, verify:

- **`better-auth` Microsoft provider:** confirm the exact import path and exported config shape from `node_modules/better-auth`. The package likely exports `microsoft` from `better-auth/social-providers` or provides it as a plugin.
- **`databaseHooks` shape:** read the TypeScript types in the installed `better-auth` for `databaseHooks.account.create.before` and `databaseHooks.session.create.after` to confirm the argument signatures and expected return shapes.
- **Error URL configuration:** locate the Better-Auth option for configuring the redirect URL on auth errors (e.g., `errorURL` in the main config, or `callbackURL` / `onError` on the Microsoft provider).

**shadcn/ui components** — run the CLI only if not already added:

- `npx shadcn@latest add alert` — for the SSO rejection error on the login page. If added in um09, skip.

No new `PERMISSIONS` rows and no schema migrations required: the `account` table schema (`provider_id`, `provider_account_id`, `password`) and all `APPUSER` columns (`last_login_datetime`, `status`, `auth_method`) are in place from um02.

---

## Verification Checklist

### Env configuration

- [ ] `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `ENTRA_TENANT_ID` are documented in `infra/env.example`
- [ ] `lib/config.ts` is marked `'server-only'` — importing it in a client component fails at build time
- [ ] `isSsoConfigured` is `false` when any of the three vars is absent
- [ ] `isSsoConfigured` is `true` when all three vars are present
- [ ] `entraConfig.clientSecret` is never exported to a client-accessible module
- [ ] `MICROSOFT_CLIENT_SECRET` does not appear in any log output, server response, or client bundle
- [ ] The redirect URI is computed as `${NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft` — not hardcoded

### Better-Auth Microsoft provider registration

- [ ] When `isSsoConfigured = true`, the `microsoft` social provider is registered in the Better-Auth config
- [ ] When `isSsoConfigured = false`, `socialProviders` contains no `microsoft` key — local sign-in still works
- [ ] `/api/auth/signin/microsoft` returns a redirect to Entra when SSO is configured
- [ ] `/api/auth/signin/microsoft` returns 404 or an error when SSO is not configured (provider not registered)
- [ ] `/api/auth/callback/microsoft` is handled by Better-Auth's catch-all auth route (no conflicting custom route)
- [ ] `databaseHooks` from `ssoAccountHooks` are merged with any existing hooks without overwriting prior units' hooks

### Email-match hook — rejection

- [ ] An Entra identity with no matching SSO APPUSER causes the hook to throw (or return a rejection)
- [ ] After hook rejection, the browser is redirected to `/login?error=sso_no_account` (not to a 500 or a raw Better-Auth error page)
- [ ] No `APPUSER` row is created for an unmatched Entra identity
- [ ] No `account` row is created for an unmatched Entra identity
- [ ] No `session` row is created for an unmatched Entra identity
- [ ] A Entra identity matching a LOCAL user's email (auth_method='LOCAL') is rejected — no matching SSO user in `findSsoUserByEmail`
- [ ] A Entra identity matching a DELETED SSO user's email is rejected (`status='DELETED'` excluded from the query)

### Email-match hook — linking

- [ ] An Entra identity matching a PENDING SSO user's email causes the hook to return modified account data with that user's `userId`
- [ ] An Entra identity matching an ACTIVE SSO user's email (re-registration scenario) returns the correct `userId`
- [ ] The hook does not create a new `APPUSER` row — it reuses the existing one
- [ ] After linking, an `account` row exists with `provider_id = 'microsoft'` and `provider_account_id = <Entra OID>`
- [ ] The `account` row's `userId` matches the existing APPUSER's `userId`
- [ ] Non-Microsoft `account.create` calls (e.g., credential provider) pass through the hook without modification

### First sign-in — activation and audit

- [ ] After a PENDING SSO user's first sign-in: `appuser.status = 'ACTIVE'`
- [ ] `appuser.last_login_datetime` is set to a non-null datetime
- [ ] `AUDIT_LOG` contains an `SSO_LOGIN` row: `event_type='SSO_LOGIN'`, `actor_user_id = userId`, `target_entity='APPUSER'`, `target_id = userId`, `before_data = null`, `after_data` contains `lastLoginDatetime`
- [ ] `AUDIT_LOG` contains a `USER_FIRST_LOGIN` row: `before_data = { status:'PENDING' }`, `after_data = { status:'ACTIVE' }`
- [ ] Both audit rows are written in the same transaction — neither appears without the other
- [ ] `SSO_LOGIN` and `USER_FIRST_LOGIN` are written in the same transaction as the status update — a mid-transaction error leaves no partial writes

### Subsequent sign-in

- [ ] After a second (or later) Entra sign-in by an ACTIVE SSO user: `appuser.status` remains `ACTIVE`
- [ ] `appuser.last_login_datetime` is updated to the current datetime
- [ ] `AUDIT_LOG` contains an `SSO_LOGIN` row for the sign-in
- [ ] `AUDIT_LOG` does NOT contain a `USER_FIRST_LOGIN` row for the sign-in
- [ ] The `account` row `provider_account_id` is unchanged (same Entra OID)

### Auth-method exclusivity

- [ ] A LOCAL user cannot sign in via the Entra callback — `findSsoUserByEmail` excludes `auth_method='LOCAL'`
- [ ] An SSO user cannot sign in via the credential form — their `account` row has `provider_id='microsoft'` and no `password` value; Better-Auth's credentials provider rejects them
- [ ] After SSO activation, `auth_method` remains `'SSO'` on the `APPUSER` row — it is not changed by the sign-in flow

### DISABLED user handling

- [ ] A DISABLED SSO user's email-match succeeds in the hook (DISABLED is not excluded by `findSsoUserByEmail`)
- [ ] The session hook calls `handleSsoSignIn`, which returns `{ ok:false, code:'USER_NOT_ELIGIBLE' }`
- [ ] The service writes no audit events and makes no DB changes for a DISABLED user
- [ ] The DISABLED user is rejected on the next authenticated request by the `resolveAuthenticatedUser` ACTIVE-status guard (Invariant #4 — this is the primary revocation mechanism; session deletion on sign-in is a best-effort improvement, not required for correctness)

### Login page — SSO button

- [ ] The "Sign in with Microsoft" button is visible when `isSsoConfigured = true`
- [ ] The button is hidden (and the divider is hidden) when `isSsoConfigured = false`
- [ ] The button `href` is `/api/auth/signin/microsoft` — an anchor link, not a form submission
- [ ] The Microsoft 4-color logo SVG renders at 16×16 px to the left of the label
- [ ] Clicking the button initiates a full redirect (not a client-side navigation)
- [ ] The button is visually separated from the email/password form by a horizontal rule with "or" text

### Login page — SSO rejection error

- [ ] `searchParams.error = 'sso_no_account'` renders the "not authorized" destructive alert above the form
- [ ] Any other `error` value renders the generic failure alert
- [ ] Absent `error` param renders no alert
- [ ] The raw `error` value is not displayed to the user — only mapped messages
- [ ] The error alert does not expose whether the email is known or unknown to the system

### System Configuration page — Entra values

- [ ] The "Entra ID Settings" section is visible to ADMIN (`system_config:READ`)
- [ ] Tenant ID, Client ID, and Redirect URI are displayed as read-only text
- [ ] When values are absent from env: "Not configured" is shown in muted text
- [ ] `MICROSOFT_CLIENT_SECRET` does not appear anywhere on the page — not masked, not present
- [ ] The Redirect URI copy button copies the correct URL to the clipboard
- [ ] The section has no edit inputs, no form, and no save action
- [ ] Values are read from `process.env` server-side — not from `SYSTEM_CONFIG` DB rows

### Audit log

- [ ] App DB role can INSERT into `AUDIT_LOG` but cannot UPDATE or DELETE (invariant from um03)
- [ ] `SSO_LOGIN` event type is used (not `LOCAL_LOGIN` or any other value)
- [ ] `USER_FIRST_LOGIN` is used for the activation event (same as LOCAL's first login in um09)
- [ ] No audit event contains any Entra token, OID, or credential material beyond `lastLoginDatetime`

### Transaction atomicity

- [ ] If `activateSsoUser` fails mid-transaction, neither `last_login_datetime` nor audit rows are written
- [ ] If `updateLastLoginDatetime` fails mid-transaction, status change and audit rows are rolled back
- [ ] If `writeAuditEvent(SSO_LOGIN)` fails, the entire transaction rolls back — status and `last_login_datetime` are unchanged
- [ ] If `writeAuditEvent(USER_FIRST_LOGIN)` fails, the entire transaction rolls back — both audit rows and status change are reverted

### Boundary and TypeScript

- [ ] `lib/config.ts` has `'server-only'` at the top — build fails if imported by a client component
- [ ] `auth/sso-linking.ts` has `'server-only'` at the top
- [ ] `auth/sso-linking.ts` has no imports from `app/**`, `actions/**`, or `next/*`
- [ ] `services/users/users-auth.service.ts` (the `handleSsoSignIn` addition) has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `db/repositories/app-user.repository.ts` has no business logic — only Drizzle queries
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules
- [ ] `MICROSOFT_CLIENT_SECRET` does not appear in any `git diff` of committed files (only in `.env`, which is gitignored)

### Test suite

- [ ] `findSsoUserByEmail` unit tests pass (7 scenarios per §10.10)
- [ ] `handleSsoSignIn` unit tests pass (8 scenarios per §10.10)
- [ ] SSO linking hook unit tests pass (5 scenarios per §10.10)
- [ ] Login page unit tests pass (5 scenarios per §10.10)
- [ ] Integration tests pass: first sign-in PENDING (DB assertions, both audit events), subsequent sign-in ACTIVE (no `USER_FIRST_LOGIN`), DISABLED rejected, LOCAL rejected, atomicity rollback
- [ ] `findSsoUserByEmail` integration tests pass (7 scenarios against real test DB)
- [ ] Manual E2E test documented in `tests/README.md` with staging setup instructions

### Scope guard

- [ ] No JIT provisioning was implemented — an unmatched Entra identity creates nothing
- [ ] No Entra-group-based access was implemented — access is by pre-created APPUSER only
- [ ] No self-registration path was opened
- [ ] The `SYSTEM_CONFIG` table was not written to for Entra values — they remain env-only
- [ ] No new `PERMISSIONS` rows were added (SSO sign-in requires no permission; it is a pre-auth flow)
- [ ] No schema changes were made — `account`, `APPUSER`, and `AUDIT_LOG` tables are unchanged from um02
- [ ] The credential sign-in flow (um03), the lockout hook (um04), and the `/set-password` guard (um09) are unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
