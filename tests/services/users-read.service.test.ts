import { beforeEach, describe, expect, it, vi } from "vitest";

// `users-read.service.ts` imports the runtime `db` instance to pass into
// the mocked repository below — mock `@/db/client` too so importing it
// never triggers `lib/config`'s eager env validation (no DATABASE_URL
// needed for this DB-free unit suite), mirroring tests/auth/resolver.test.ts.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/appuser.repository", () => ({
  findAllWithRoles: vi.fn(),
  findByIdWithRoles: vi.fn(),
}));

import {
  findAllWithRoles,
  findByIdWithRoles,
} from "@/db/repositories/appuser.repository";
import { getUserById, listUsers } from "@/services/users/users-read.service";

const mockFindAllWithRoles = vi.mocked(findAllWithRoles);
const mockFindByIdWithRoles = vi.mocked(findByIdWithRoles);

beforeEach(() => {
  mockFindAllWithRoles.mockReset();
  mockFindByIdWithRoles.mockReset();
});

const BASE_ROW = {
  userId: "user-1",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  authMethod: "LOCAL",
  status: "ACTIVE",
  lastLoginDatetime: null,
  roles: [],
};

describe("listUsers", () => {
  it("sets isLocked: false when lockedUntil is null", async () => {
    mockFindAllWithRoles.mockResolvedValue([
      { ...BASE_ROW, lockedUntil: null },
    ]);

    const result = await listUsers();

    expect(result[0]?.isLocked).toBe(false);
  });

  it("sets isLocked: true when lockedUntil is in the future", async () => {
    mockFindAllWithRoles.mockResolvedValue([
      { ...BASE_ROW, lockedUntil: new Date(Date.now() + 60_000) },
    ]);

    const result = await listUsers();

    expect(result[0]?.isLocked).toBe(true);
  });

  it("sets isLocked: false when lockedUntil is in the past", async () => {
    mockFindAllWithRoles.mockResolvedValue([
      { ...BASE_ROW, lockedUntil: new Date(Date.now() - 60_000) },
    ]);

    const result = await listUsers();

    expect(result[0]?.isLocked).toBe(false);
  });

  it("includes DELETED users in the returned array", async () => {
    mockFindAllWithRoles.mockResolvedValue([
      { ...BASE_ROW, lockedUntil: null },
      { ...BASE_ROW, userId: "user-2", status: "DELETED", lockedUntil: null },
    ]);

    const result = await listUsers();

    expect(result).toHaveLength(2);
    expect(result.map((u) => u.status)).toContain("DELETED");
  });

  it("returns [] when there are no rows", async () => {
    mockFindAllWithRoles.mockResolvedValue([]);

    const result = await listUsers();

    expect(result).toEqual([]);
  });
});

describe("getUserById", () => {
  const DETAIL_ROW = {
    ...BASE_ROW,
    userPhonenum: null,
    createdDatetime: new Date("2026-01-01T00:00:00Z"),
    lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
    lockedUntil: null,
  };

  it("returns a UserDetailView when found", async () => {
    mockFindByIdWithRoles.mockResolvedValue(DETAIL_ROW);

    const result = await getUserById("user-1");

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-1");
    expect(result?.isLocked).toBe(false);
  });

  it("returns null when the repository returns null", async () => {
    mockFindByIdWithRoles.mockResolvedValue(null);

    const result = await getUserById("nonexistent-uuid");

    expect(result).toBeNull();
  });
});
