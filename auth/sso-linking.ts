import "server-only";

import { APIError } from "better-auth";
import type { GenericEndpointContext } from "@better-auth/core";

import { db } from "@/db/client";
import { findUserById } from "@/db/repositories/appuser.repository";
import { logger } from "@/lib/logger";

// um10-spec §10.3/§10.6 — auth-method exclusivity for Entra sign-in.
//
// Deviation from the spec's literal design: the spec assumes our
// `databaseHooks.account.create.before` hook resolves *which* APPUSER to
// link by looking up the Entra email itself (`findSsoUserByEmail`). In the
// installed Better-Auth version, that email→user resolution already
// happens natively (`handleOAuthUserInfo`/`findOAuthUser` in
// `better-auth/oauth2/link-account`) before this hook ever runs — by the
// time `account.create.before` fires, Better-Auth has already decided
// `account.userId` (matched by email, case-insensitively, against
// `appuser.user_email`). There is no email available at this hook point,
// so `findSsoUserByEmail` was not implemented (it would be dead code — see
// the progress tracker for the full account-linking flow this was verified
// against). This hook's actual job is the one piece Better-Auth's own
// `accountLinking` config can't express: re-validate that the user it
// already matched is in fact a non-deleted SSO appuser, rejecting a LOCAL
// user's or a DELETED user's email match (Invariant #9).
//
// Returning `false` here is unsafe (Better-Auth's `linkAccount` caller
// doesn't check the return value before continuing to create a session) —
// throwing is the only way to actually abort the sign-in.
export async function rejectNonSsoAccountLink(
  account: { providerId: string; userId: string } & Record<string, unknown>,
): Promise<void> {
  if (account.providerId !== "microsoft") return;

  const user = await findUserById(db, account.userId);

  if (!user || user.authMethod !== "SSO" || user.status === "DELETED") {
    logger.warn("SSO_REJECTION: no matching SSO account for Entra identity.", {
      userId: account.userId,
    });
    throw APIError.from("FORBIDDEN", {
      code: "SSO_NO_ACCOUNT",
      message:
        "Your Microsoft account is not authorized to access this application.",
    });
  }
}

// Distinguishes a Microsoft-provider OAuth callback request from every
// other request a `databaseHooks.session.create` hook can fire for
// (credential sign-in, other future providers) — `ctx.path` is the matched
// route *template* (`/callback/:id`), `ctx.params.id` the provider id,
// exactly like the existing `ctx.path === "/sign-in/email"` check in the
// um04 lockout hooks.
export function isMicrosoftCallback(
  context: GenericEndpointContext | null,
): boolean {
  return (
    context?.path === "/callback/:id" &&
    (context.params as { id?: string } | undefined)?.id === "microsoft"
  );
}
