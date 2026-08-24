import { beforeEach, describe, expect, it, vi } from "vitest";

// bm10-spec §Design/§Implementation §1. Each of the five pre-approval checks,
// unit-tested in isolation against a mocked `Database`/`tx` — the checks are
// pure-ish reads, so a fake "db" object identity is enough to assert the
// right repository calls happen and the right pass/fail + remediation comes
// back.

vi.mock("@/db/repositories/accounts/accounting-period.repository", () => ({
  accountingPeriodRepository: { findByPeriodAndCurrency: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/ledger.repository", () => ({
  ledgerRepository: { resolveGlCodeByName: vi.fn() },
}));
vi.mock("@/db/repositories/audit-log.repository", () => ({
  auditLogRepository: { listActorIdsForEvents: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listStatusesForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {
    listPostableCurrencies: vi.fn(),
    listPostableTaxCurrencies: vi.fn(),
    countNonPositivePostable: vi.fn(),
  },
}));

import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";

const mockFindPeriod = vi.mocked(
  accountingPeriodRepository.findByPeriodAndCurrency,
);
const mockResolveGlCode = vi.mocked(ledgerRepository.resolveGlCodeByName);
const mockListStatuses = vi.mocked(billRunAccountRepository.listStatusesForRun);
const mockListCurrencies = vi.mocked(
  customerBillRepository.listPostableCurrencies,
);
const mockListTaxCurrencies = vi.mocked(
  customerBillRepository.listPostableTaxCurrencies,
);
const mockCountNonPositive = vi.mocked(
  customerBillRepository.countNonPositivePostable,
);
const mockListTriggerActors = vi.mocked(
  auditLogRepository.listActorIdsForEvents,
);

const dbStub = {} as never;

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    glEventAt: "2026-07-01",
    triggeredBy: "user-trigger",
    status: "PROCESSED",
    ...overrides,
  } as never;
}

function byKey(
  checks: Awaited<ReturnType<typeof runPreApprovalChecks>>,
  key: string,
) {
  return checks.find((c) => c.check === key);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListCurrencies.mockResolvedValue(["MYR"]);
  mockListTaxCurrencies.mockResolvedValue(["MYR"]); // taxed by default
  mockListTriggerActors.mockResolvedValue([]); // no reruns by default
  mockFindPeriod.mockResolvedValue(null); // absent row = open
  mockResolveGlCode.mockResolvedValue("4000"); // resolved
  mockCountNonPositive.mockResolvedValue(0);
  mockListStatuses.mockResolvedValue([
    { billingAccountId: "BAN00000001", status: "PROCESSED" },
    { billingAccountId: "BAN00000002", status: "PROCESSING_FAILED" },
    { billingAccountId: "BAN00000003", status: "EXCLUDED" },
  ] as never);
});

describe("runPreApprovalChecks (bm10-spec §Design/§1)", () => {
  it("returns all five checks passing on a clean run", async () => {
    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(checks).toHaveLength(5);
    for (const c of checks) {
      expect(c.pass).toBe(true);
      expect(c.remediation).toBeNull();
    }
  });

  it("period_open fails when the accounting period is closed for a postable currency", async () => {
    mockFindPeriod.mockResolvedValue({ state: "closed" } as never);

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "period_open")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("closed"),
    });
  });

  it("period_open treats an absent period row as open", async () => {
    mockFindPeriod.mockResolvedValue(null);

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "period_open")).toMatchObject({ pass: true });
  });

  it("gl_mappings fails when a sys.revenue/sys.tax_payable account doesn't resolve", async () => {
    mockResolveGlCode.mockImplementation(async (_db, name: string) =>
      name.startsWith("sys.tax_payable") ? null : "4000",
    );

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "gl_mappings")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("sys.tax_payable.MYR"),
    });
  });

  it("gl_mappings checks both sys.revenue and sys.tax_payable for every postable currency", async () => {
    mockListCurrencies.mockResolvedValue(["MYR", "USD"]);
    mockListTaxCurrencies.mockResolvedValue(["MYR", "USD"]);

    await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(mockResolveGlCode).toHaveBeenCalledWith(dbStub, "sys.revenue.MYR");
    expect(mockResolveGlCode).toHaveBeenCalledWith(
      dbStub,
      "sys.tax_payable.MYR",
    );
    expect(mockResolveGlCode).toHaveBeenCalledWith(dbStub, "sys.revenue.USD");
    expect(mockResolveGlCode).toHaveBeenCalledWith(
      dbStub,
      "sys.tax_payable.USD",
    );
  });

  it("gl_mappings does NOT require sys.tax_payable for a tax-free (zero-rated) currency", async () => {
    // Currency has postable bills but none carry tax (tax_total = 0), so
    // posting never builds a tax leg — the tax mapping must not be required.
    mockListCurrencies.mockResolvedValue(["MYR"]);
    mockListTaxCurrencies.mockResolvedValue([]);
    mockResolveGlCode.mockImplementation(async (_db, name: string) =>
      name.startsWith("sys.tax_payable") ? null : "4000",
    );

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "gl_mappings")).toMatchObject({ pass: true });
    expect(mockResolveGlCode).toHaveBeenCalledWith(dbStub, "sys.revenue.MYR");
    expect(mockResolveGlCode).not.toHaveBeenCalledWith(
      dbStub,
      "sys.tax_payable.MYR",
    );
  });

  it("positive_totals fails when a postable bill is zero or negative", async () => {
    mockCountNonPositive.mockResolvedValue(2);

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "positive_totals")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("2 bills"),
    });
  });

  it("[CRITICAL] four_eyes fails when the approver is the run's trigger actor", async () => {
    const checks = await runPreApprovalChecks(
      dbStub,
      run({ triggeredBy: "user-approver" }),
      "user-approver",
    );

    expect(byKey(checks, "four_eyes")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("cannot also approve"),
    });
  });

  it("four_eyes passes for a different approver", async () => {
    const checks = await runPreApprovalChecks(
      dbStub,
      run({ triggeredBy: "user-trigger" }),
      "user-approver",
    );

    expect(byKey(checks, "four_eyes")).toMatchObject({ pass: true });
  });

  it("[CRITICAL] four_eyes fails when the approver RERAN the run (not just the original trigger)", async () => {
    // Ops A triggered (triggered_by=A), Ops B reran — B must not approve their
    // own rerun. The rerun actor comes from the trigger/rerun audit trail.
    mockListTriggerActors.mockResolvedValue(["user-rerun"]);

    const checks = await runPreApprovalChecks(
      dbStub,
      run({ triggeredBy: "user-trigger" }),
      "user-rerun",
    );

    expect(byKey(checks, "four_eyes")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("reran"),
    });
  });

  it("four_eyes passes for a manager who neither triggered nor reran the run", async () => {
    mockListTriggerActors.mockResolvedValue(["user-trigger", "user-rerun"]);

    const checks = await runPreApprovalChecks(
      dbStub,
      run({ triggeredBy: "user-trigger" }),
      "manager-1",
    );

    expect(byKey(checks, "four_eyes")).toMatchObject({ pass: true });
  });

  it("accounts_terminal fails when an account is still non-terminal", async () => {
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PENDING" },
    ] as never);

    const checks = await runPreApprovalChecks(dbStub, run(), "user-approver");

    expect(byKey(checks, "accounts_terminal")).toMatchObject({
      pass: false,
      remediation: expect.stringContaining("1 account"),
    });
  });
});
