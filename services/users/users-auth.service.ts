import { db } from "@/db/client";
import {
  activateUser,
  clearForcePasswordChange,
  findUserById,
  updateAccountPassword,
  updateLastLogin,
} from "@/db/repositories/appuser.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { hashTempPassword } from "@/lib/temp-password";

export type SetPasswordResult =
  | { ok: true; wasFirstLogin: boolean }
  | { ok: false; code: "FORCE_CHANGE_NOT_REQUIRED" }
  | { ok: false; code: "USER_NOT_FOUND" };

// um09-spec §9.5. The action is the page-level guard; this function is the
// authoritative enforcement point (Inv. #3) — it re-checks `forcePasswordChange`
// itself rather than trusting the caller already did.
export async function setPassword(
  userId: string,
  newPasswordPlaintext: string,
): Promise<SetPasswordResult> {
  const user = await findUserById(db, userId);
  if (!user || user.status === "DISABLED" || user.status === "DELETED") {
    return { ok: false, code: "USER_NOT_FOUND" };
  }

  if (!user.forcePasswordChange) {
    return { ok: false, code: "FORCE_CHANGE_NOT_REQUIRED" };
  }

  const passwordHash = await hashTempPassword(newPasswordPlaintext);

  const wasActivated = await db.transaction(async (tx) => {
    await updateAccountPassword(tx, userId, passwordHash);
    await clearForcePasswordChange(tx, userId);

    const { wasActivated } = await activateUser(tx, userId);

    await insertAuditEvent(tx, {
      eventType: "USER_PASSWORD_CHANGED",
      actorUserId: userId,
      targetEntity: "APPUSER",
      targetId: userId,
      beforeData: null,
      afterData: { forcePasswordChange: false },
    });

    if (wasActivated) {
      await insertAuditEvent(tx, {
        eventType: "USER_FIRST_LOGIN",
        actorUserId: userId,
        targetEntity: "APPUSER",
        targetId: userId,
        beforeData: { status: "PENDING" },
        afterData: { status: "ACTIVE" },
      });
    }

    return wasActivated;
  });

  return { ok: true, wasFirstLogin: wasActivated };
}

export type HandleSsoSignInResult =
  | { ok: true; wasFirstLogin: boolean }
  | {
      ok: false;
      code: "USER_NOT_FOUND" | "USER_NOT_ELIGIBLE" | "AUTH_METHOD_MISMATCH";
    };

// um10-spec §10.6. Called from the `databaseHooks.session.create.after`
// hook (auth/index.ts) on every Microsoft-provider sign-in. Re-checks
// status/auth-method itself rather than trusting the caller, matching
// `setPassword`'s "authoritative enforcement point" precedent above —
// belt-and-suspenders, since the session's own `before` hook (Inv. #4)
// already rejects non-ACTIVE/PENDING users before a session can exist, and
// `rejectNonSsoAccountLink` (auth/sso-linking.ts) already rejected a
// non-SSO/DELETED email match before the account row could be created.
//
// Reuses `activateUser`/`updateLastLogin` from um09 rather than adding
// `activateSsoUser`/`updateLastLoginDatetime` duplicates — both are
// identical in behavior to the existing PENDING→ACTIVE transition and
// last-login timestamp write; see the progress tracker.
export async function handleSsoSignIn(input: {
  userId: string;
}): Promise<HandleSsoSignInResult> {
  const user = await findUserById(db, input.userId);
  if (!user) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (user.status === "DISABLED" || user.status === "DELETED") {
    return { ok: false, code: "USER_NOT_ELIGIBLE" };
  }
  if (user.authMethod !== "SSO") {
    return { ok: false, code: "AUTH_METHOD_MISMATCH" };
  }

  const wasActivated = await db.transaction(async (tx) => {
    const { wasActivated } = await activateUser(tx, input.userId);
    await updateLastLogin(tx, input.userId, new Date());

    await insertAuditEvent(tx, {
      eventType: "SSO_LOGIN",
      actorUserId: input.userId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: null,
      afterData: { lastLoginDatetime: new Date().toISOString() },
    });

    if (wasActivated) {
      await insertAuditEvent(tx, {
        eventType: "USER_FIRST_LOGIN",
        actorUserId: input.userId,
        targetEntity: "APPUSER",
        targetId: input.userId,
        beforeData: { status: "PENDING" },
        afterData: { status: "ACTIVE" },
      });
    }

    return wasActivated;
  });

  return { ok: true, wasFirstLogin: wasActivated };
}
