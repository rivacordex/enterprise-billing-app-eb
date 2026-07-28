import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// ac05-spec §3.6 — route × level guardrail tests.
// Verifies the structural invariants of the Accounts Overview page without
// needing to render it (Next.js server components can't be rendered in vitest
// without the full App Router runtime). Static file analysis is a reliable
// proxy for these invariants.
const PAGE_PATH = resolve(
  __dirname,
  "../../app/(app)/accounts/overview/page.tsx",
);
const pageSource = readFileSync(PAGE_PATH, "utf-8");

describe("Accounts Overview page — structural guardrails (ac05-spec §3.6)", () => {
  it('exports dynamic = "force-dynamic" (live balance requirement, code-standards §3.2)', () => {
    expect(pageSource).toMatch(
      /export const dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("calls requirePermission with ACCOUNTS_VIEW and READ", () => {
    expect(pageSource).toContain("PERMISSIONS.ACCOUNTS_VIEW");
    expect(pageSource).toContain("LEVELS.READ");
    expect(pageSource).toContain("requirePermission");
  });

  it("imports parseAccountsContext (sole context-strip URL parser, code-standards §3.1)", () => {
    expect(pageSource).toContain("parseAccountsContext");
  });

  it("has no server action declarations (read-only page, no write affordance)", () => {
    // No `"use server"` directive means no mutation entry points on this page.
    expect(pageSource).not.toContain('"use server"');
    expect(pageSource).not.toContain("'use server'");
  });

  it("has no form submissions with POST method (read-only page)", () => {
    // The search form uses GET. Any method="post" would be a write affordance.
    expect(pageSource).not.toMatch(/method\s*=\s*["']post["']/i);
  });

  it("imports AmountCell, ContextStrip, PaymentStatusBadge shared components", () => {
    expect(pageSource).toContain("AmountCell");
    expect(pageSource).toContain("ContextStrip");
    expect(pageSource).toContain("PaymentStatusBadge");
  });
});

// Verify the three shared components exist as files (structural contract for ac06+).
describe("Accounts shared components exist (reused by ac06/ac07)", () => {
  const componentRoot = resolve(__dirname, "../../components/accounts");

  it.each([
    ["amount-cell.tsx", "AmountCell"],
    ["payment-status-badge.tsx", "PaymentStatusBadge"],
    ["context-strip.tsx", "ContextStrip"],
  ])("%s exists and exports %s", (filename, exportName) => {
    const src = readFileSync(resolve(componentRoot, filename), "utf-8");
    expect(src).toContain(`export function ${exportName}`);
  });

  it("payment-status-badge accepts derivedOverdue prop without computing it", () => {
    const src = readFileSync(
      resolve(componentRoot, "payment-status-badge.tsx"),
      "utf-8",
    );
    // Prop declared
    expect(src).toContain("derivedOverdue: boolean");
    // Component does NOT do its own < 0 or date comparison
    expect(src).not.toContain("new Date()");
    expect(src).not.toContain("< 0");
  });
});
