import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { billRunDistribution } from "@/db/schema/billing/bill-run-distribution";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

// bm20-spec §1. Structural typing-only assertions (audit_log/bill_run_account
// precedent, tests/db/bill-run-account-schema.test.ts) — the physical DDL of
// record is db/migrations/0038_bill_run_distribution.sql.
describe("billing.bill_run_distribution", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(billRunDistribution).sort()).toEqual(
      [
        "bill_run_distribution_id",
        "ref_bill_run_id",
        "target",
        "artifact_ref",
        "artifact_type",
        "is_mandatory",
        "outcome",
        "at",
        "distribution_attempt",
        "period_partition",
      ].sort(),
    );
  });

  it("has a composite primary key (bill_run_distribution_id, period_partition) — partition key", () => {
    const { primaryKeys } = getTableConfig(billRunDistribution);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "bill_run_distribution_id",
      "period_partition",
    ]);
  });

  it("bill_run_distribution_id is not a standalone primary key (composite PK lives in the table config)", () => {
    expect(
      getTableColumns(billRunDistribution).billRunDistributionId.primary,
    ).toBe(false);
  });

  // T1 — a rerun's outcome is a fresh row, never a dropped replay of the
  // prior attempt (the idempotency latch is keyed to the round).
  it("has the (ref_bill_run_id, target, artifact_ref, distribution_attempt, period_partition) UNIQUE", () => {
    const { uniqueConstraints } = getTableConfig(billRunDistribution);
    const key = uniqueConstraints.find(
      (u) =>
        u.name ===
        "bill_run_distribution_run_target_artifact_attempt_period_unique",
    );
    expect(key?.columns.map((c) => c.name).sort()).toEqual(
      [
        "ref_bill_run_id",
        "target",
        "artifact_ref",
        "distribution_attempt",
        "period_partition",
      ].sort(),
    );
  });

  it("has the artifact_type and outcome CHECK constraints", () => {
    expect(checkNames(billRunDistribution)).toEqual(
      expect.arrayContaining([
        "bill_run_distribution_artifact_type_check",
        "bill_run_distribution_outcome_check",
      ]),
    );
  });

  it("target is unconstrained text (no CHECK) — no target-catalog table exists to enumerate against", () => {
    const columns = getTableColumns(billRunDistribution);
    expect(columns.target.notNull).toBe(true);
    expect(checkNames(billRunDistribution)).not.toContain(
      "bill_run_distribution_target_check",
    );
  });

  it("is_mandatory/outcome/distribution_attempt are NOT NULL; at defaults to now()", () => {
    const columns = getTableColumns(billRunDistribution);
    expect(columns.isMandatory.notNull).toBe(true);
    expect(columns.outcome.notNull).toBe(true);
    expect(columns.distributionAttempt.notNull).toBe(true);
    expect(columns.at.hasDefault).toBe(true);
  });

  it("has no stored charge amount column (Module Inv. #1/#3, structural — transport-only)", () => {
    const columns = columnNames(billRunDistribution);
    expect(columns).not.toContain("amount");
    expect(columns).not.toContain("total_amount");
  });
});
