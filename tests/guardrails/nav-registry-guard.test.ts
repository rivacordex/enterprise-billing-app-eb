import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@/auth/permission-constants";
import { NAV_ICONS } from "@/components/nav-icons";
import { NAV_REGISTRY } from "@/lib/nav-registry";

// The load-bearing CI gate (plan §6.3), in the style of
// `tests/app/route-manifest.test.ts` and `tests/accounts/grep-gates.test.ts`.
// It makes the §2.3 class of drift — a nav entry whose declared permission no
// longer matches the page's own guard — permanently impossible, and keeps the
// two-file registry/icons split and the D2 "locked item deleted" decision from
// being quietly reverted.
const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_GROUP_DIR = path.join(REPO_ROOT, "app", "(app)");

// Registry `permission` values (e.g. "products") back to the PERMISSIONS
// constant key (e.g. "PRODUCTS") that every page's guard actually references.
const PERMISSION_NAME_TO_KEY = new Map(
  Object.entries(PERMISSIONS).map(([key, value]) => [value, key]),
);

// Non-dynamic pages under app/(app)/** that deliberately do NOT appear in the
// registry, each with the reason it is reached some other way. Adding a page
// without either a registry entry or an entry here fails the build.
const UNLISTED_BY_DESIGN: Record<string, string> = {
  "/": "Landing Homepage — session-gated directory (D3/D5); the list it renders IS the permission check, so it is not a registry entry.",
  "/no-access":
    "Session-gated fallback for a direct hit on an unpermitted page; not a module directory entry (D3).",
  "/customers/manage/new":
    "Child create route reached from Manage Customer; not a directory entry (§2.3).",
  "/administration/accounts-settings/flows":
    "Reached from the Accounts Settings parent (D7); readable at accounts_config:READ, so it needs no entry of its own.",
};

function collectPageFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const pages: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pages.push(...collectPageFiles(entryPath));
    } else if (entry.isFile() && entry.name === "page.tsx") {
      pages.push(entryPath);
    }
  }
  return pages;
}

// Mirror the route-manifest derivation: strip the "page.tsx" leaf and any
// route-group segment, yielding the public URL.
function deriveHref(pageFilePath: string): string {
  const relative = path.relative(APP_GROUP_DIR, pageFilePath);
  const segments = relative.split(path.sep);
  segments.pop();
  const urlSegments = segments.filter((s) => !/^\(.+\)$/.test(s));
  return "/" + urlSegments.join("/");
}

function isDynamic(href: string): boolean {
  return href.split("/").some((s) => /^\[.+\]$/.test(s));
}

const registryHrefs = NAV_REGISTRY.flatMap((s) => s.items.map((i) => i.href));

describe("nav-registry guardrail gate (plan §6.3)", () => {
  it("1. every registry entry's permission:level equals its page's own requirePermission guard", () => {
    const mismatches: string[] = [];

    for (const section of NAV_REGISTRY) {
      for (const item of section.items) {
        const pageFile = path.join(
          APP_GROUP_DIR,
          ...item.href.split("/").filter(Boolean),
          "page.tsx",
        );
        if (!fs.existsSync(pageFile)) {
          mismatches.push(`${item.href}: no page.tsx at ${pageFile}`);
          continue;
        }
        const src = fs.readFileSync(pageFile, "utf8");
        const call = src.match(/requirePermission\(\s*([\s\S]*?)\)/);
        if (!call) {
          // A page with no guard at all fails outright (Inv. #4).
          mismatches.push(`${item.href}: no requirePermission call found`);
          continue;
        }
        const args = call[1]!;
        const expectedKey = PERMISSION_NAME_TO_KEY.get(item.permission);
        if (!args.includes(`PERMISSIONS.${expectedKey}`)) {
          mismatches.push(
            `${item.href}: guard does not reference PERMISSIONS.${expectedKey} (registry permission "${item.permission}")`,
          );
        }
        if (!args.includes(`LEVELS.${item.level}`)) {
          mismatches.push(
            `${item.href}: guard does not reference LEVELS.${item.level}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("2. every non-dynamic page under app/(app)/** is in the registry or declared UNLISTED_BY_DESIGN", () => {
    const registrySet = new Set<string>(registryHrefs);
    const orphans: string[] = [];

    for (const pageFile of collectPageFiles(APP_GROUP_DIR)) {
      const href = deriveHref(pageFile);
      if (isDynamic(href)) continue;
      if (registrySet.has(href)) continue;
      if (href in UNLISTED_BY_DESIGN) continue;
      orphans.push(href);
    }

    expect(orphans).toEqual([]);
  });

  it("3. NAV_ICONS keys set-equal the registry hrefs", () => {
    const iconKeys = new Set(Object.keys(NAV_ICONS));
    const hrefSet = new Set<string>(registryHrefs);

    const missingIcon = [...hrefSet].filter((h) => !iconKeys.has(h));
    const strayIcon = [...iconKeys].filter((k) => !hrefSet.has(k));

    expect(missingIcon).toEqual([]);
    expect(strayIcon).toEqual([]);
  });

  it("4. no locked-item residue in components/admin-nav.tsx (D2)", () => {
    const navSrc = fs.readFileSync(
      path.join(REPO_ROOT, "components", "admin-nav.tsx"),
      "utf8",
    );
    expect(navSrc).not.toContain("aria-disabled");
    expect(navSrc).not.toMatch(/\bLock\b/);
  });
});
