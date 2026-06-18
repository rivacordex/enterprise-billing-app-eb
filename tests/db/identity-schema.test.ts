import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { appuser, account, session, verification } from "@/db/schema/identity";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("core.appuser", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(appuser).sort()).toEqual(
      [
        "user_id",
        "user_name",
        "user_email",
        "email_verified",
        "user_phonenum",
        "auth_method",
        "status",
        "force_password_change",
        "failed_login_count",
        "locked_until",
        "last_login_datetime",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });

  it("does not carry an image column", () => {
    expect(columnNames(appuser)).not.toContain("image");
  });
});

describe("core.account", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(account).sort()).toEqual(
      [
        "account_id",
        "user_id",
        "provider_id",
        "provider_account_id",
        "password",
        "access_token",
        "refresh_token",
        "id_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "scope",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});

describe("core.session", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(session).sort()).toEqual(
      [
        "session_id",
        "user_id",
        "session_token",
        "expires_at",
        "ip_address",
        "user_agent",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});

describe("core.verification", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(verification).sort()).toEqual(
      [
        "verification_id",
        "identifier",
        "value",
        "expires_at",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});
