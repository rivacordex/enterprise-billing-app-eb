import { describe, expect, it } from "vitest";

import { computeRunStatus } from "@/services/billing/compute-run-status";
import type { AccountStatus } from "@/types/billing";

// bm04-spec §Design/§Implementation §4/§8, architecture Inv. #12. Pure
// account-status-set → run-status derivation.
describe("computeRunStatus", () => {
  it("returns null (stay PROCESSING) when no accounts are terminal", () => {
    expect(computeRunStatus(["PENDING", "PROCESSING"])).toBeNull();
  });

  it("returns null when only some accounts are terminal", () => {
    expect(computeRunStatus(["PROCESSED", "PROCESSING"])).toBeNull();
  });

  it("returns PROCESSED when every account is PROCESSED", () => {
    expect(computeRunStatus(["PROCESSED", "PROCESSED"])).toBe("PROCESSED");
  });

  it("returns PROCESSED when accounts are a mix of PROCESSED/PROCESSING_FAILED", () => {
    expect(computeRunStatus(["PROCESSED", "PROCESSING_FAILED"])).toBe(
      "PROCESSED",
    );
  });

  it("treats a scoping-time EXCLUDED account as terminal", () => {
    expect(computeRunStatus(["PROCESSED", "EXCLUDED"])).toBe("PROCESSED");
  });

  it("returns null for an empty account set (never a false PROCESSED)", () => {
    expect(computeRunStatus([])).toBeNull();
  });

  it("returns PROCESSED for an all-EXCLUDED run (no eligible accounts)", () => {
    const statuses: AccountStatus[] = ["EXCLUDED", "EXCLUDED"];
    expect(computeRunStatus(statuses)).toBe("PROCESSED");
  });
});
