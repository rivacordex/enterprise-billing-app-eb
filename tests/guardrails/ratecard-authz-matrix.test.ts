import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSION_NAMES } from "@/types/rbac";

// pm65-spec I4 / I6.13 — guardrail 1, the authz matrix for `/products/rate-card`.
// Four rows in both directions (code-standards §8/§9): the page reaches the
// read surface at `ratecard : READ`; each of the three mutations reaches at
// `ratecard : EDIT` and is refused a READ-only user AT THE ACTION GUARD (the
// matrix tests actions, not buttons — pm65 D11/I4). Static-source style, the
// same precedent as `tests/accounts/route-level-matrix.test.ts`: a Next.js
// server component / server action can't be rendered in vitest without the full
// App Router runtime, so we assert the guard call each surface makes.
//
// The behavioral proof (a READ-only principal actually refused, no partial
// effect) already lives in each action's own test
// (`tests/actions/{upload,activate,rollback}-ratecard-version.action.test.ts`);
// this file is the single canonical place the whole route × level table is
// walked, plus the no-grant-overlap property. The full §8 grant sweep is pm68's.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

type MatrixRow = {
  surface: string;
  file: string;
  level: "READ" | "EDIT";
};

// The four rows. READ reaches the read surface (the page guard); EDIT reaches
// each of the three mutations (the action guards), which is where a READ-only
// user is refused.
const RATE_CARD_MATRIX: MatrixRow[] = [
  {
    surface: "/products/rate-card (version list, rows, diff)",
    file: "app/(app)/products/rate-card/page.tsx",
    level: "READ",
  },
  {
    surface: "upload a new version (creates a DRAFT)",
    file: "actions/product/upload-ratecard-version.action.ts",
    level: "EDIT",
  },
  {
    surface: "activate a DRAFT",
    file: "actions/product/activate-ratecard-version.action.ts",
    level: "EDIT",
  },
  {
    surface: "roll back to a SUPERSEDED version",
    file: "actions/product/rollback-ratecard-version.action.ts",
    level: "EDIT",
  },
];

describe("rate-card authz matrix (pm65 I4, guardrail 1)", () => {
  it.each(RATE_CARD_MATRIX)(
    "$surface guards on ratecard : $level via requirePermission",
    ({ file, level }) => {
      const src = read(file);
      expect(src).toContain("requirePermission");
      expect(src).toContain("PERMISSIONS.RATECARD");
      expect(src).toContain(`LEVELS.${level}`);
    },
  );

  it("the page's ENFORCEMENT guard is READ; EDIT is only a meetsLevel show/hide gate, never a second requirePermission", () => {
    const src = read("app/(app)/products/rate-card/page.tsx");
    // The one requirePermission guard is READ — the enforcement boundary.
    const guard = src.match(
      /requirePermission\(\s*PERMISSIONS\.RATECARD,\s*LEVELS\.(\w+)/,
    );
    expect(guard?.[1]).toBe("READ");
    // No requirePermission ever rises to EDIT/DELETE on this page — the three
    // mutations own that gate at their own action guards (D11).
    expect(src).not.toMatch(/requirePermission\([^)]*LEVELS\.EDIT/);
    expect(src).not.toContain("LEVELS.DELETE");
    // Where EDIT does appear (the canEdit control-visibility gate), it is a
    // meetsLevel show/hide check — never enforcement.
    if (src.includes("LEVELS.EDIT")) {
      expect(src).toMatch(/meetsLevel\([^)]*LEVELS\.EDIT/);
    }
  });

  it("`ratecard` is a distinct, closed PERMISSION_NAMES member (no overlap by construction)", () => {
    expect(PERMISSION_NAMES).toContain("ratecard");
    // The three sibling product permissions are separate members; a grant of
    // one is never a grant of another (the effective-permission map keys each
    // independently, types/permissions.ts).
    for (const name of ["products", "product_orders", "product_inventory"]) {
      expect(PERMISSION_NAMES).toContain(name);
      expect(name).not.toBe("ratecard");
    }
  });

  it("the rate-card surface guards on ratecard ALONE — never products/product_orders/product_inventory (no overlap, one direction)", () => {
    for (const { file } of RATE_CARD_MATRIX) {
      const src = read(file);
      expect(src).toContain("PERMISSIONS.RATECARD");
      expect(src).not.toContain("PERMISSIONS.PRODUCTS");
      expect(src).not.toContain("PERMISSIONS.PRODUCT_ORDERS");
      expect(src).not.toContain("PERMISSIONS.PRODUCT_INVENTORY");
    }
  });

  it("the catalog/orders/inventory write surface never guards on ratecard (no overlap, the other direction)", () => {
    // A representative sample of the three sibling modules' pages — holding
    // products/product_orders/product_inventory grants nothing here, and none
    // of them reaches for RATECARD.
    for (const file of [
      "app/(app)/products/manage-products/page.tsx",
      "app/(app)/products/product-offering/page.tsx",
      "app/(app)/products/orders/page.tsx",
      "app/(app)/products/subscriptions/page.tsx",
    ]) {
      expect(read(file)).not.toContain("PERMISSIONS.RATECARD");
    }
  });
});
