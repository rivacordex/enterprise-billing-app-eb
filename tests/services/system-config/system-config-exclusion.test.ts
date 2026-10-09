import { beforeEach, describe, expect, it, vi } from "vitest";

// bm56-spec §Tests / §Design D4: the generic System Config page must not edit
// the company profile. `findAllNonSecret` filters the `invoice.profile` group
// out (asserted on the built WHERE clause) and `updateConfigValue` refuses a
// row in it with GROUP_NOT_EDITABLE: no write, no audit.

import type * as RepoModule from "@/db/repositories/system-config.repository";

const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock(
  "@/db/repositories/system-config.repository",
  async (importOriginal) => {
    const original = await importOriginal<typeof RepoModule>();
    return {
      systemConfigRepository: {
        ...original.systemConfigRepository,
        findById: vi.fn(),
        updateValue: vi.fn(),
      },
    };
  },
);

import { PgDialect } from "drizzle-orm/pg-core";

import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { updateConfigValue } from "@/services/system-config/system-config-write.service";
import { INVOICE_PROFILE_CONFIG_GROUP } from "@/types/billing";
import type { SystemConfigDisplayRow } from "@/types/system-config";

const mockFindById = vi.mocked(systemConfigRepository.findById);
const mockUpdateValue = vi.mocked(systemConfigRepository.updateValue);
const mockAudit = vi.mocked(insertAuditEvent);

const CONFIG_ID = "11111111-1111-1111-1111-111111111111";

function row(
  overrides: Partial<SystemConfigDisplayRow> = {},
): SystemConfigDisplayRow {
  return {
    configId: CONFIG_ID,
    configGroup: INVOICE_PROFILE_CONFIG_GROUP,
    configVersion: 1,
    configKey: "company_name",
    configValue: "Digital Billing Sdn Bhd",
    description: null,
    isSecret: false,
    status: "ACTIVE",
    modifiedByUserId: "u1",
    modifiedByName: "U One",
    lastModifiedDatetime: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mockFindById.mockReset();
  mockUpdateValue.mockReset();
  mockAudit.mockReset();
});

describe("updateConfigValue: invoice.profile exclusion", () => {
  it("refuses a company-profile row with GROUP_NOT_EDITABLE, writing nothing", async () => {
    mockFindById.mockResolvedValue(row());

    const result = await updateConfigValue(
      { configId: CONFIG_ID, configValue: "Hijacked" },
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "GROUP_NOT_EDITABLE" });
    expect(mockUpdateValue).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("still edits an ordinary group", async () => {
    mockFindById.mockResolvedValue(
      row({ configGroup: "app", configKey: "app_name" }),
    );
    const result = await updateConfigValue(
      { configId: CONFIG_ID, configValue: "New" },
      "actor-1",
    );
    expect(result).toEqual({ ok: true });
    expect(mockUpdateValue).toHaveBeenCalledOnce();
    expect(mockAudit).toHaveBeenCalledOnce();
  });
});

describe("findAllNonSecret: invoice.profile exclusion", () => {
  it("filters the invoice.profile group out in the query", async () => {
    const dialect = new PgDialect();
    let captured: { sql: string; params: unknown[] } | undefined;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "orderBy"]) chain[m] = () => chain;
    chain.where = (cond: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      captured = dialect.sqlToQuery(cond);
      return chain;
    };
    // The chain is awaited; resolve to no rows.
    chain.then = (resolve: (v: unknown[]) => void) => resolve([]);
    const fakeDb = { select: () => chain };

    const original = await vi.importActual<typeof RepoModule>(
      "@/db/repositories/system-config.repository",
    );
    await original.systemConfigRepository.findAllNonSecret(fakeDb as never);

    expect(captured?.sql).toMatch(/"config_group" <> \$/);
    expect(captured?.sql).toMatch(/"is_secret" = \$/);
    expect(captured?.params).toContain(INVOICE_PROFILE_CONFIG_GROUP);
  });
});
