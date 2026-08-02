import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac15-spec §3.7 — route × level guardrail tests, structural-analysis style
// (route-level-gl-journal.test.ts precedent).
const PAGE_ROOT = resolve(
  __dirname,
  "../../app/(app)/administration/accounts-settings",
);
const mainSource = readFileSync(resolve(PAGE_ROOT, "page.tsx"), "utf-8");
const flowsSource = readFileSync(resolve(PAGE_ROOT, "flows/page.tsx"), "utf-8");

describe("Accounts Settings main page — structural guardrails (ac15-spec §3.1)", () => {
  it('exports dynamic = "force-dynamic" (live read, code-standards §3.2)', () => {
    expect(mainSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_CONFIG and EDIT (write gate)", () => {
    expect(mainSource).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(mainSource).toContain("LEVELS.EDIT");
    expect(mainSource).toContain("requirePermission");
  });

  it("imports all three service list functions", () => {
    expect(mainSource).toContain("listReasonCodes");
    expect(mainSource).toContain("listBillCycles");
    expect(mainSource).toContain("getWizardDefaultsFull");
  });

  it("renders AddReasonCodeButton and ReasonCodeActions", () => {
    expect(mainSource).toContain("AddReasonCodeButton");
    expect(mainSource).toContain("ReasonCodeActions");
  });

  it("renders AddBillCycleButton and BillCycleActions", () => {
    expect(mainSource).toContain("AddBillCycleButton");
    expect(mainSource).toContain("BillCycleActions");
  });

  it("renders WizardDefaultsForm", () => {
    expect(mainSource).toContain("WizardDefaultsForm");
  });

  it("links to the flows sub-page", () => {
    expect(mainSource).toContain("accounts-settings/flows");
  });

  it("has no direct DB imports (service-layer boundary)", () => {
    expect(mainSource).not.toContain('from "@/db/');
  });

  it("has no TODO or console.* (diff hygiene, spec §5)", () => {
    expect(mainSource).not.toContain("TODO");
    expect(mainSource).not.toContain("console.");
  });
});

describe("Accounts Settings flows page — structural guardrails (ac15-spec §3.6)", () => {
  it('exports dynamic = "force-dynamic" (live read, code-standards §3.2)', () => {
    expect(flowsSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_CONFIG and READ (read-only gate)", () => {
    expect(flowsSource).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(flowsSource).toContain("LEVELS.READ");
    expect(flowsSource).toContain("requirePermission");
  });

  it("does NOT use LEVELS.EDIT (flows doc is read-only)", () => {
    expect(flowsSource).not.toContain("LEVELS.EDIT");
  });

  it("has no write affordance (no server actions, no mutations)", () => {
    expect(flowsSource).not.toContain('"use server"');
    expect(flowsSource).not.toContain("revalidatePath");
  });

  it("renders live reason codes from listReasonCodes", () => {
    expect(flowsSource).toContain("listReasonCodes");
  });

  it("renders live bill cycles from listBillCycles", () => {
    expect(flowsSource).toContain("listBillCycles");
  });

  it("documents the term resolution rule (V10 / Inv. #13)", () => {
    expect(flowsSource).toContain("resolveTerm");
  });

  it("has no TODO or console.* (diff hygiene, spec §5)", () => {
    expect(flowsSource).not.toContain("TODO");
    expect(flowsSource).not.toContain("console.");
  });
});

describe("Accounts Settings — action files exist (ac15-spec §3.4)", () => {
  const actionRoot = resolve(__dirname, "../../actions/accounts");

  it.each([
    "upsert-reason-code.action.ts",
    "retire-reason-code.action.ts",
    "upsert-bill-cycle.action.ts",
    "retire-bill-cycle.action.ts",
    "set-wizard-defaults.action.ts",
  ])("%s exists", (filename) => {
    expect(existsSync(resolve(actionRoot, filename))).toBe(true);
  });

  it.each([
    "upsert-reason-code.action.ts",
    "retire-reason-code.action.ts",
    "upsert-bill-cycle.action.ts",
    "retire-bill-cycle.action.ts",
    "set-wizard-defaults.action.ts",
  ])('%s declares "use server" and guards ACCOUNTS_CONFIG:EDIT', (filename) => {
    const src = readFileSync(resolve(actionRoot, filename), "utf-8");
    expect(src).toContain('"use server"');
    expect(src).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(src).toContain("LEVELS.EDIT");
  });
});

describe("Accounts Settings — service files exist (ac15-spec §3.2)", () => {
  const serviceRoot = resolve(__dirname, "../../services/accounts");

  it("reason-code.ts exports listReasonCodes, upsertReasonCode, retireReasonCode", () => {
    const src = readFileSync(resolve(serviceRoot, "reason-code.ts"), "utf-8");
    expect(src).toContain("listReasonCodes");
    expect(src).toContain("upsertReasonCode");
    expect(src).toContain("retireReasonCode");
  });

  it("bill-cycle.ts exports listBillCycles, upsertBillCycle, retireBillCycle", () => {
    const src = readFileSync(resolve(serviceRoot, "bill-cycle.ts"), "utf-8");
    expect(src).toContain("listBillCycles");
    expect(src).toContain("upsertBillCycle");
    expect(src).toContain("retireBillCycle");
  });

  it("wizard-defaults.ts exports getWizardDefaultsFull and setWizardDefaults", () => {
    const src = readFileSync(
      resolve(serviceRoot, "wizard-defaults.ts"),
      "utf-8",
    );
    expect(src).toContain("getWizardDefaultsFull");
    expect(src).toContain("setWizardDefaults");
  });
});

describe("Accounts Settings — no delete path (Module Inv. #11)", () => {
  const repoRoot = resolve(__dirname, "../../db/repositories/accounts");

  it("reason-code.repository.ts has no delete method", () => {
    const src = readFileSync(
      resolve(repoRoot, "reason-code.repository.ts"),
      "utf-8",
    );
    expect(src).not.toContain(".delete(");
    expect(src).not.toMatch(/\bDELETE FROM\b/i);
  });

  it("bill-cycle.repository.ts has no delete method", () => {
    const src = readFileSync(
      resolve(repoRoot, "bill-cycle.repository.ts"),
      "utf-8",
    );
    expect(src).not.toContain(".delete(");
    expect(src).not.toMatch(/\bDELETE FROM\b/i);
  });
});
