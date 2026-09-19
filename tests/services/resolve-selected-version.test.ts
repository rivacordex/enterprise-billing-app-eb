import { describe, expect, it } from "vitest";

import { resolveSelectedVersion } from "@/services/product/resolve-selected-version";
import type { LifecycleStatus, VersionSummary } from "@/types/product";

// pm40 I7 — the five D1 resolution cases, unit-tested on the pure helper so the
// branch coverage never depends on a page render.
function version(
  id: string,
  n: number,
  status: LifecycleStatus,
): VersionSummary {
  return {
    productOfferingId: id,
    version: n,
    lifecycleStatus: status,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("resolveSelectedVersion", () => {
  // Newest-first, as findFamilyVersions returns them (version DESC).
  const activeFamily: VersionSummary[] = [
    version("PRDOFR000003", 3, "DRAFT"),
    version("PRDOFR000002", 2, "ACTIVE"),
    version("PRDOFR000001", 1, "OBSOLETE"),
  ];

  it("D1 case 5 — an unknown family (no versions) resolves to null", () => {
    expect(resolveSelectedVersion([], "PRDOFR000009")).toBeNull();
    expect(resolveSelectedVersion([], null)).toBeNull();
  });

  it("D1 case 2 — version absent selects the family's primary (ACTIVE) version", () => {
    expect(resolveSelectedVersion(activeFamily, null)).toBe("PRDOFR000002");
  });

  it("D1 case 3 — a version that belongs to the family is selected", () => {
    expect(resolveSelectedVersion(activeFamily, "PRDOFR000003")).toBe(
      "PRDOFR000003",
    );
    expect(resolveSelectedVersion(activeFamily, "PRDOFR000001")).toBe(
      "PRDOFR000001",
    );
  });

  it("D1 case 4 — a version from another family falls back to the primary silently", () => {
    expect(resolveSelectedVersion(activeFamily, "PRDOFR000099")).toBe(
      "PRDOFR000002",
    );
  });

  // Primary sub-rules (pm39 D1): ACTIVE → open (DRAFT/TESTING) → highest.
  it("primary is the open version when there is no ACTIVE", () => {
    const openFamily: VersionSummary[] = [
      version("PRDOFR000012", 2, "TESTING"),
      version("PRDOFR000011", 1, "OBSOLETE"),
    ];
    expect(resolveSelectedVersion(openFamily, null)).toBe("PRDOFR000012");
  });

  it("primary is the highest version when there is neither ACTIVE nor an open version", () => {
    const terminalFamily: VersionSummary[] = [
      version("PRDOFR000022", 2, "RETIRED"),
      version("PRDOFR000021", 1, "OBSOLETE"),
    ];
    expect(resolveSelectedVersion(terminalFamily, null)).toBe("PRDOFR000022");
  });

  it("a foreign version falls back to the primary even when the primary is an open version", () => {
    const openFamily: VersionSummary[] = [
      version("PRDOFR000032", 2, "DRAFT"),
      version("PRDOFR000031", 1, "OBSOLETE"),
    ];
    expect(resolveSelectedVersion(openFamily, "PRDOFR000099")).toBe(
      "PRDOFR000032",
    );
  });
});
