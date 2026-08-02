import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac12-spec §3.7 — route × level guardrail tests, structural-analysis style
// (route-level-transactions.test.ts precedent).
const PAGE_PATH = resolve(
  __dirname,
  "../../app/(app)/accounts/chart-of-accounts/page.tsx",
);
const pageSource = readFileSync(PAGE_PATH, "utf-8");

describe("Chart of Accounts page — structural guardrails (ac12-spec §3.7)", () => {
  it('exports dynamic = "force-dynamic" (live balance requirement, code-standards §3.2)', () => {
    expect(pageSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_CONFIG and READ (view gate)", () => {
    expect(pageSource).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(pageSource).toContain("LEVELS.READ");
    expect(pageSource).toContain("requirePermission");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_VIEW");
    expect(pageSource).not.toContain("PERMISSIONS.ACCOUNTS_TRANSACTIONS");
  });

  it("gates mutation UI behind canEdit (EDIT level check before rendering forms)", () => {
    expect(pageSource).toContain("canEdit");
    expect(pageSource).toContain("LEVELS.EDIT");
    expect(pageSource).toContain("meetsLevel");
  });

  it("has no direct pgledger references (repository-only access, module inv. #4)", () => {
    expect(pageSource).not.toContain("pgledger_");
  });

  it("imports the health service (V5 live count, ac12-spec §2.4)", () => {
    expect(pageSource).toContain("getGlHealth");
  });

  it("imports CoA tree and mapping list services", () => {
    expect(pageSource).toContain("getGlAccountTree");
    expect(pageSource).toContain("listGlMappings");
  });

  it("imports GlCodeForm and GlMappingForm client components", () => {
    expect(pageSource).toContain("GlCodeForm");
    expect(pageSource).toContain("GlMappingForm");
  });

  it("imports retire button and mapping actions components", () => {
    expect(pageSource).toContain("RetireGlCodeButton");
    expect(pageSource).toContain("MappingActionsCell");
  });
});

describe("Chart of Accounts — action files exist (ac12-spec §3.4)", () => {
  const actionRoot = resolve(__dirname, "../../actions/accounts");

  it.each([
    ["create-gl-code.ts", "createGlCodeAction"],
    ["retire-gl-code.ts", "retireGlCodeAction"],
    ["upsert-gl-mapping.ts", "upsertGlMappingAction"],
    ["retire-gl-mapping.ts", "retireGlMappingAction"],
  ])("%s exports %s", (file, exportName) => {
    const src = readFileSync(resolve(actionRoot, file), "utf-8");
    expect(src).toContain(`"use server"`);
    expect(src).toContain(exportName);
    expect(src).toContain("PERMISSIONS.ACCOUNTS_CONFIG");
    expect(src).toContain("LEVELS.EDIT");
  });
});

describe("Chart of Accounts — service files exist (ac12-spec §3.2)", () => {
  const serviceRoot = resolve(__dirname, "../../services/accounts");

  it("gl-health.ts exports getGlHealth", () => {
    const src = readFileSync(resolve(serviceRoot, "gl-health.ts"), "utf-8");
    expect(src).toContain("getGlHealth");
    expect(src).toContain("countUnmappedAccounts");
  });

  it("gl-account.ts exports createGlCode and retireGlCode", () => {
    const src = readFileSync(resolve(serviceRoot, "gl-account.ts"), "utf-8");
    expect(src).toContain("createGlCode");
    expect(src).toContain("retireGlCode");
    expect(src).toContain("getGlAccountTree");
  });

  it("gl-mapping.ts exports upsertGlMapping with OrphanBlockError guard", () => {
    const src = readFileSync(resolve(serviceRoot, "gl-mapping.ts"), "utf-8");
    expect(src).toContain("upsertGlMapping");
    expect(src).toContain("retireGlMapping");
    expect(src).toContain("ORPHAN_BLOCK");
    expect(src).toContain("countUnmappedAccounts");
  });
});

describe("Chart of Accounts — no DELETE path (Module Inv. #11)", () => {
  const repoRoot = resolve(__dirname, "../../db/repositories/accounts");

  it("gl-account.repository.ts has no delete function", () => {
    const src = readFileSync(
      resolve(repoRoot, "gl-account.repository.ts"),
      "utf-8",
    );
    expect(src).not.toContain(".delete(");
  });

  it("gl-mapping.repository.ts has no delete function", () => {
    const src = readFileSync(
      resolve(repoRoot, "gl-mapping.repository.ts"),
      "utf-8",
    );
    expect(src).not.toContain(".delete(");
  });
});
