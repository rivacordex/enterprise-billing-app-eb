import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { auditLog } from "@/db/schema/audit";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("core.audit_log", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(auditLog).sort()).toEqual(
      [
        "audit_id",
        "event_type",
        "actor_user_id",
        "target_entity",
        "target_id",
        "before_data",
        "after_data",
        "created_datetime",
      ].sort(),
    );
  });

  it("does not carry an updated_at column (append-only, Inv. #11)", () => {
    expect(columnNames(auditLog)).not.toContain("updated_at");
    expect(columnNames(auditLog)).not.toContain("last_modified_datetime");
  });
});
