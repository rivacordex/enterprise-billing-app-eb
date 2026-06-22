import { betterAuth, APIError } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "@better-auth/core/api";

import { db } from "@/db/client";
import * as schema from "@/db/schema";
import {
  findUserByEmail,
  findUserById,
  updateLastLogin,
} from "@/db/repositories/appuser.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  clearLockout,
  getLockoutState,
  recordFailedAttempt,
} from "@/db/repositories/lockout.repository";
import { isCurrentlyLocked } from "@/auth/lockout";
import {
  isMicrosoftCallback,
  rejectNonSsoAccountLink,
} from "@/auth/sso-linking";
import { config, entraConfig, isSsoConfigured } from "@/lib/config";
import { logger } from "@/lib/logger";
import { AUTH_ERROR_CODES } from "@/types/auth";
import { handleSsoSignIn } from "@/services/users/users-auth.service";

// um03-spec §2.1 deliberately surfaces a distinct message for a locked
// account (unlike um04-spec §"Rejection response", which calls for an
// identical, non-disclosing message) — `LoginForm` already keys off
// `AUTH_ERROR_CODES.USER_LOCKED` to render this exact string.
const LOCKED_ACCOUNT_MESSAGE =
  "Your account has been temporarily locked. Contact your administrator.";

// The single Better-Auth config (um03-spec §2.3). Field mapping for all four
// managed models is declared here, once (Inv. #19) — never re-declared or
// bypassed by hand-written SQL.
export const auth = betterAuth({
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  user: {
    modelName: "appuser",
    fields: {
      name: "userName",
      email: "userEmail",
      createdAt: "createdDatetime",
      updatedAt: "lastModifiedDatetime",
    },
  },
  session: {
    fields: {
      token: "sessionToken",
      createdAt: "createdDatetime",
      updatedAt: "lastModifiedDatetime",
    },
  },
  account: {
    fields: {
      accountId: "providerAccountId",
      createdAt: "createdDatetime",
      updatedAt: "lastModifiedDatetime",
    },
    accountLinking: {
      // Entra is a corporate IdP we configure ourselves (um10-spec §"Auth-
      // method exclusivity") — trusting it bypasses Better-Auth's default
      // `userInfo.emailVerified` gate on implicit linking. Microsoft Entra
      // ID does not return the `email_verified` claim unless separately
      // configured as an optional claim, so without this, every Entra
      // sign-in would otherwise be rejected as "account not linked".
      // `requireLocalEmailVerified` (default true) still requires the
      // pre-created APPUSER itself to have `email_verified = true`, which
      // um08's `insertAppUser` always sets.
      trustedProviders: ["microsoft"],
    },
  },
  verification: {
    fields: {
      createdAt: "createdDatetime",
      updatedAt: "lastModifiedDatetime",
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  // um10-spec §"SSO rejection error display": redirect-driven flows (the
  // Entra OAuth callback) land back on `/login` with `?error=<code>` on
  // failure instead of Better-Auth's default `/api/auth/error` page.
  onAPIError: {
    errorURL: "/login",
  },
  // Better-Auth resolves the `microsoft` key to its built-in provider
  // factory internally — `socialProviders.microsoft` takes the provider's
  // raw options directly, not the result of calling a factory function
  // (confirmed via the installed package's types; no import needed here).
  socialProviders: isSsoConfigured
    ? {
        microsoft: {
          clientId: entraConfig.clientId!,
          clientSecret: entraConfig.clientSecret!,
          tenantId: entraConfig.tenantId!,
          // No JIT provisioning (Inv. #10) — an Entra identity with no
          // pre-created SSO APPUSER must create nothing at all. Without
          // this, Better-Auth's default OAuth flow would create a brand
          // new `appuser` row for any unmatched email.
          disableSignUp: true,
          // `getUserInfo`'s default `id` is the `sub` claim. The spec
          // prefers `oid` (stable across token issuances within a tenant);
          // `mapProfileToUser`'s return is spread last over the default
          // shape, so this overrides just `id` and `email`.
          //
          // `email` fallback: Better-Auth's Microsoft provider maps the user
          // email from the `email` claim alone (`getUserInfo` →
          // `email: user.email`), but Entra omits that claim for accounts with
          // no mailbox — notably `*.onmicrosoft.com` test users. Without an
          // email, Better-Auth's native email→APPUSER matching (which our
          // account-linking relies on, see auth/sso-linking.ts) finds nothing
          // and `disableSignUp` rejects the sign-in as "not authorized". The
          // `preferred_username`/`upn` claim carries the UPN in that case,
          // which is what such users are provisioned under. `email` is used
          // only for allowlist matching here — the stable identity key is
          // still `oid` (`id` above) — so the UPN fallback is safe.
          mapProfileToUser: (profile) => {
            // TEMP DIAGNOSTIC (remove after SSO debugging): dump the
            // email-relevant Entra claims so we can see exactly what the
            // matcher receives vs. the stored `user_email`.
            logger.warn("SSO_DEBUG entra profile claims", {
              email: profile.email,
              preferred_username: profile.preferred_username,
              upn: profile.upn,
              oid: profile.oid,
              sub: profile.sub,
              tid: profile.tid,
            });
            return {
              id: profile.oid,
              email: profile.email ?? profile.preferred_username ?? profile.upn,
            };
          },
        },
      }
    : {},
  advanced: {
    useSecureCookies: config.NODE_ENV === "production",
  },
  // Per-account lockout (um04-spec §4). These are top-level request hooks,
  // not `databaseHooks`: Better-Auth's `/sign-in/email` route (installed
  // version) verifies the password and calls `internalAdapter.createSession`
  // itself, with no callback in between — `databaseHooks.session.create`
  // (used above for the um03 status check) only fires *after* the password
  // is already verified. A `hooks.before` matched on the request path is the
  // only point that runs ahead of password verification.
  hooks: {
    // Step 3 (um04-spec §4): reject an already-locked account before
    // Better-Auth verifies the password. Every other path (no such user,
    // SSO user, not locked) falls through to Better-Auth's own flow.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const { email } = ctx.body as { email: string };

      try {
        const user = await findUserByEmail(db, email);
        if (!user || user.authMethod !== "LOCAL") return;

        const state = await getLockoutState(db, user.id);
        if (isCurrentlyLocked(state)) {
          throw APIError.from("UNAUTHORIZED", {
            code: AUTH_ERROR_CODES.USER_LOCKED,
            message: LOCKED_ACCOUNT_MESSAGE,
          });
        }
      } catch (err) {
        if (err instanceof APIError) throw err;
        logger.error("Lockout check failed before sign-in.", {
          message: err instanceof Error ? err.message : "Unknown error",
        });
        throw err;
      }
    }),
    // Steps 5 & 7 (um04-spec §4): runs after Better-Auth's own sign-in
    // endpoint resolves, whether it succeeded or failed. A failure here must
    // never change the response the caller already received (§5 error
    // table) — both branches catch and log rather than rethrow.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const returned = ctx.context.returned;

      if (returned instanceof APIError) {
        // Only a wrong-password/unknown-email/no-credential failure counts
        // as a failed *attempt* — other failures (e.g. the um03
        // USER_NOT_ACTIVE check) are unrelated to password correctness.
        if (returned.body?.code !== "INVALID_EMAIL_OR_PASSWORD") return;

        try {
          const { email } = ctx.body as { email: string };
          const user = await findUserByEmail(db, email);
          if (!user || user.authMethod !== "LOCAL") return;

          const state = await getLockoutState(db, user.id);
          if (!isCurrentlyLocked(state)) {
            await recordFailedAttempt(db, user.id);
          }
        } catch (err) {
          logger.error("Failed to record a failed login attempt.", {
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        return;
      }

      const userId = (returned as { user?: { id?: string } } | undefined)?.user
        ?.id;
      if (!userId) return;

      try {
        await clearLockout(db, userId);
      } catch (err) {
        logger.error("Failed to clear lockout state after sign-in.", {
          userId,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }),
  },
  databaseHooks: {
    // Email-match exclusivity for Entra sign-in (um10-spec §10.3, Inv. #9).
    // Better-Auth's own `accountLinking` (above) already resolved *which*
    // user this Microsoft identity matched by email before this fires —
    // see auth/sso-linking.ts for why this hook validates rather than
    // resolves the match.
    account: {
      create: {
        before: rejectNonSsoAccountLink,
      },
    },
    session: {
      create: {
        // Status check (um03-spec §3.7, Inv. #4), widened by um09: a PENDING
        // LOCAL user (um08) must be able to sign in with their temp password
        // to reach the forced first-login `/set-password` flow — the
        // product overview's Core User Flow #4 and um09-spec's own
        // integration fixtures presuppose this. DISABLED/DELETED remain
        // rejected. Applies to every provider (incl. Microsoft) since it's
        // keyed only on `session.userId`.
        before: async (session) => {
          const user = await findUserById(db, session.userId);
          if (
            !user ||
            (user.status !== "ACTIVE" && user.status !== "PENDING")
          ) {
            throw APIError.from("FORBIDDEN", {
              code: AUTH_ERROR_CODES.USER_NOT_ACTIVE,
              message:
                "Your account is not currently active. Contact your administrator.",
            });
          }
        },
        // Branches on provider (um10-spec §10.4's "single-hook strategy"):
        // a Microsoft-provider session runs the SSO activation/audit path
        // (`SSO_LOGIN` + conditional `USER_FIRST_LOGIN`) instead of writing
        // `LOCAL_LOGIN` — `handleSsoSignIn` owns its own atomic transaction.
        // The session itself is already committed by Better-Auth either
        // way; a failure here is logged and never undoes the sign-in.
        after: async (session, context) => {
          if (isMicrosoftCallback(context)) {
            const result = await handleSsoSignIn({ userId: session.userId });
            if (!result.ok) {
              logger.error("SSO post-sign-in hook failed.", {
                code: result.code,
                userId: session.userId,
              });
            }
            return;
          }

          const loginDatetime = new Date();
          try {
            await db.transaction(async (tx) => {
              await updateLastLogin(tx, session.userId, loginDatetime);
              await insertAuditEvent(tx, {
                eventType: "LOCAL_LOGIN",
                actorUserId: session.userId,
                targetEntity: "appuser",
                targetId: session.userId,
                beforeData: null,
                afterData: { last_login_datetime: loginDatetime.toISOString() },
              });
            });
          } catch (err) {
            logger.error("Failed to record LOCAL_LOGIN audit event.", {
              message: err instanceof Error ? err.message : "Unknown error",
              userId: session.userId,
            });
          }
        },
      },
    },
  },
});
