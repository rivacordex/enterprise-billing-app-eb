import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { systemConfig } from "@/db/schema/system-config";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("core.system_config", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(systemConfig).sort()).toEqual(
      [
        "config_id",
        "config_group",
        "config_version",
        "config_key",
        "config_value",
        "is_secret",
        "status",
        "modified_by",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});
