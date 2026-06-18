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
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { AUTH_ERROR_CODES } from "@/types/auth";

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
    session: {
      create: {
        // Status check (um03-spec §3.7, Inv. #4): runs after Better-Auth
        // verifies the credential, before the session row is committed.
        before: async (session) => {
          const user = await findUserById(db, session.userId);
          if (!user || user.status !== "ACTIVE") {
            throw APIError.from("FORBIDDEN", {
              code: AUTH_ERROR_CODES.USER_NOT_ACTIVE,
              message:
                "Your account is not currently active. Contact your administrator.",
            });
          }
        },
        // `last_login_datetime` + the `LOCAL_LOGIN` audit row, atomic with
        // each other (code-standards §1.7, §6.5). The session itself is
        // already committed by Better-Auth; a failure here is logged and
        // never undoes the sign-in (um03-spec §3.7).
        after: async (session) => {
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
